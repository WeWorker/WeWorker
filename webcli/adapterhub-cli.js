/**
 * AdapterHub CLI — Adapter 目录与分发（唯一规范实现）
 *
 * 被 webcli/index.js 直接 import；index.js → `webcli adapterhub <...>`。
 *
 * 架构：
 * - HTTP/端点/PAT：走 ./adapterhub-client.js（端点来自部署 Profile，
 *   joinUrl 保留 /adapterhub 前缀，POST 不走 curl 回退避免令牌进进程参数）
 * - v2 .adapt 校验：走 ./adapterhub-package-v2.js 的 readAdapterPackage（唯一权威校验）
 * - v1 冻结存量：走 ./adapterhub-package.js 的 readAdapt（站点维度，只读兼容）
 * - 安装目录：installDir() = WEBCLI_ADAPTERS_DIR || resolveUserAdaptersDir()
 * - install/update/remove 委托统一安装管理器；执行使用注册表固定的内容摘要
 *
 * 约定：
 * - 退出码：0 成功；1 运行错误（网络/服务端/校验失败）；2 参数错误（UsageError）
 * - --json：stdout 仅一个 JSON 对象；人类可读消息走 stderr 或省略
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve, sep } from "path";
import { zipSync } from "fflate";
import { formatCallOutput, resolveOutputFormat } from "./output-format.js";
import { readAdapt } from "./adapterhub-package.js";
import { readAdapterPackage } from "./adapterhub-package-v2.js";
import { resolveAdaptersDir, resolveBuiltinAdaptersDir, resolveUserAdaptersDir, resolveAdapterPaths } from "./paths.js";
import { readAdapterState } from "./adapter-state.js";
import { installAdapter, removeInstalledAdapter, assertInstalledAdapterOrigin } from "./adapter-install-store.js";
import { adapterHubCredentialStatus, readHiddenToken, removeAdapterHubToken, saveAdapterHubToken } from "./adapterhub-credentials.js";
import {
  compareVersions,
  downloadAdapter,
  downloadSite,
  getAdapter,
  getAdapterCommands,
  getAdapterVersions,
  getSite,
  listAdapters,
  listSites,
  publishAdapter,
  resolveEndpoint,
  UsageError,
} from "./adapterhub-client.js";

// ── 安装目录 ─────────────────────────────────────────────────────────────────

/** 安装目标目录：测试用 WEBCLI_ADAPTERS_DIR 重定向，生产用用户目录（扩展 bridge 原生读取）。 */
function installDir() {
  return resolveUserAdaptersDir();
}

// ── 参数解析（表驱动）────────────────────────────────────────────────────────

/**
 * 表驱动参数解析：彻底解决「选项值劫持 positional」（`info --json --origin user <t>` 曾把 user 当目标）。
 * - flags: 布尔选项集合
 * - values: 带值选项 {name: {choices?, default?}}
 * - maxPositional / minPositional: 位置参数数量约束（null 不限）
 * 返回 { flags:Set, values:Map, positionals:string[] }；非法输入抛 UsageError（exit 2）。
 */
function parseArgs(rawArgs, { flags = [], values = {}, positionalUsage = "", maxPositional = 1, minPositional = 0 } = {}) {
  const flagSet = new Set(flags);
  const valueSpecs = new Map(Object.entries(values));
  const parsed = { flags: new Set(), values: new Map(), positionals: [] };
  const args = [...rawArgs];

  const takeValue = (name, spec) => {
    const current = parsed.values.get(name);
    if (current === undefined) {
      if (spec.default !== undefined) parsed.values.set(name, spec.default);
      return;
    }
    if (spec.choices && !spec.choices.includes(current)) {
      throw new UsageError(`--${name} 的值 "${current}" 无效。可选：${spec.choices.join(" | ")}`);
    }
  };
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--") { parsed.positionals.push(...args.slice(i + 1)); break; }
    if (!token.startsWith("-") || token === "-") { parsed.positionals.push(token); continue; }

    const eqIndex = token.indexOf("=");
    const hasEq = eqIndex !== -1;
    const name = (hasEq ? token.slice(0, eqIndex) : token).replace(/^--?/, "");
    const inlineValue = hasEq ? token.slice(eqIndex + 1) : undefined;

    if (valueSpecs.has(name)) {
      const spec0 = valueSpecs.get(name);
      const target = spec0.alias || name;
      const v = inlineValue !== undefined ? inlineValue : (args[i + 1] && !args[i + 1].startsWith("-") || args[i + 1] === undefined ? args[++i] : undefined);
      if (v === undefined || v === "") throw new UsageError(`--${name} 需要一个值。${spec(target, valueSpecs)}`);
      parsed.values.set(target, v);
      continue;
    }
    if (flagSet.has(name)) {
      if (hasEq) throw new UsageError(`--${name} 是布尔选项，不接受 = 值。`);
      parsed.flags.add(name);
      continue;
    }
    throw new UsageError(`未知选项: ${token}${nearestOption(name, flagSet, valueSpecs)}`);
  }
  for (const [name, spec] of valueSpecs) takeValue(name, spec);

  if (parsed.positionals.length < minPositional) throw new UsageError(`缺少${positionalUsage || "必要参数"}。`);
  if (maxPositional !== null && parsed.positionals.length > maxPositional) {
    throw new UsageError(`参数过多: ${parsed.positionals.slice(maxPositional).join(" ")}${positionalUsage ? `（${positionalUsage}）` : ""}`);
  }
  return parsed;
}

function spec(name, valueSpecs) {
  const s = valueSpecs.get(name);
  return s?.choices ? ` 可选值：${s.choices.join(" | ")}` : "";
}

function nearestOption(input, flagSet, valueSpecs) {
  const all = [...flagSet, ...valueSpecs.keys()];
  let best = null, bestDist = Infinity;
  for (const cand of all) {
    const dist = levenshtein(input, cand);
    if (dist < bestDist) { best = cand; bestDist = dist; }
  }
  return best && bestDist <= 2 ? `（是不是 --${best}?）` : "";
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[n];
}

// ── v1 冻结 state（站点维度存量，仅 v1 site 安装记账）──────────────────────

function storeRoot() { return join(homedir(), ".weworker", "adapterhub"); }
function statePath() { return join(storeRoot(), "state.json"); }
function state() {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8"));
    return { adapters: {}, sites: {}, ...parsed };
  } catch { return { adapters: {}, sites: {} }; }
}
function saveState(value) {
  const file = statePath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// ── 本地已安装（以宿主安装记录为准，不自动接管手工复制的旧目录）─────────────

function localAdapterIds() {
  return Object.keys(readAdapterState(resolveAdapterPaths()).installations);
}
function readLocalManifest(id) {
  return readAdapterState(resolveAdapterPaths()).installations[id] || null;
}
function findLocalAdapterByTarget(target) {
  const ids = localAdapterIds();
  if (ids.includes(target)) return target;
  return ids.find((id) => id.toLowerCase() === String(target).toLowerCase()) || null;
}

/** 打包内置 Adapter（随宿主/包分发的 adapters 目录，不占安装记录）。 */
function builtinAdapterIds() {
  try {
    const dir = resolveBuiltinAdaptersDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "manifest.json")))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
function readBuiltinManifestVersion(id) {
  try {
    return JSON.parse(readFileSync(join(resolveBuiltinAdaptersDir(), id, "manifest.json"), "utf8")).version || "?";
  } catch {
    return "?";
  }
}

/** 本地已有的 Adapter 名集合（内置 ∪ 自装，小写归一），供 list 标记未安装。 */
function knownLocalAdapterNames() {
  return new Set([...localAdapterIds(), ...builtinAdapterIds()].map((id) => id.toLowerCase()));
}

// ── 通用工具 ─────────────────────────────────────────────────────────────────

function rejectCommandTarget(target) {
  if (typeof target === "string" && (target.startsWith("c-") || target.includes("/"))) {
    throw new UsageError(`命令维度已下线（Adapter 是唯一分发单位）：${target}。请用 "webcli adapterhub install <adapter>" 整站安装。`);
  }
}

/** runtimes 归一化：服务端历史数据可能返回数组 ['extension'] 或对象 {extension:{...}} */
function normalizeRuntimes(runtimes) {
  if (Array.isArray(runtimes)) return runtimes;
  if (runtimes && typeof runtimes === "object") return Object.keys(runtimes);
  return [];
}

function sanitizeFileName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "adapter";
}

/** 解析 <name>@<version> 目标（如 example.com@1.2.0）。返回 {name, version?} */
function parseTarget(target) {
  const at = target.lastIndexOf("@");
  if (at <= 0) return { name: target, version: undefined }; // 不含 @ 或以 @ 开头（不含名字）都视为纯名
  return { name: target.slice(0, at), version: target.slice(at + 1) || undefined };
}

/** 判断是否本地包路径（./x.adapt、D:\dir\x.adapt、x.adapt 存在于 cwd） */
function isLocalPackagePath(target) {
  if (/[\\/]|\.(adapt|zip)$/i.test(target)) return true;
  return existsSync(resolve(target));
}

async function reloadExtensionBestEffort({ json = false } = {}) {
  try {
    const { reloadExtension } = await import("./adapter-cli.js");
    if (typeof reloadExtension !== "function") throw new Error("reloadExtension unavailable");
    const reloaded = await reloadExtension({ quiet: json });
    if (reloaded === false) {
      if (json) return { reloaded: false, reloadWarning: "Bridge 未连接，请在 chrome://extensions 手动重载扩展" };
      return;
    }
    if (json) return { reloaded: true };
    console.log("→ 扩展已重载");
  } catch {
    if (json) return { reloaded: false, reloadWarning: "Bridge 未连接，请在 chrome://extensions 手动重载扩展" };
    console.error("→ 无法自动重载扩展（Bridge 未连接/离线）。请在 chrome://extensions 手动重载。");
  }
}

// ─── v2 adapter 包安装 ────────────────────────────────────────────────────────

/**
 * 校验并安装 .adapt 包到 installDir/<name>/（原子替换）。
 * @param {Buffer} bytes 下载/本地的 .adapt 字节
 * @param {{name?,version?,sha256hex?}} expected 与目录元数据绑定校验（防错装/降级绕过）
 */
function installAdapterPackage(bytes, expected = {}, decisions = {}) {
  const pkg = readAdapterPackage(bytes); // 完整校验：结构+禁入文件+module 存在+路径安全
  if (expected.name && pkg.manifest.name !== expected.name) {
    throw new Error(`包名不匹配：期望 ${expected.name}，实际 ${pkg.manifest.name}`);
  }
  if (expected.version && pkg.manifest.version !== expected.version) {
    throw new Error(`包版本不符：期望 v${expected.version}，实际 v${pkg.manifest.version}`);
  }
  if (expected.sha256hex) {
    const actualHex = pkg.sha256.replace("sha256:", "");
    if (actualHex !== expected.sha256hex) {
      throw new Error(`包哈希不匹配：目录声明 ${expected.sha256hex.slice(0, 16)}…，实际 ${actualHex.slice(0, 16)}…。请重试或联系 Adapter 管理员。`);
    }
  }

  const result = installAdapter({ ...decisions, files: pkg.files });
  return { pkg, ...result };
}

// ─── v1 冻结存量：站点维度安装（命令维度已下线）──────────────────────────────

function installedSiteFor(manifest, current) {
  const site = manifest.scope === "command" ? manifest.site : manifest;
  return current.sites[site.hub_id] || { id: site.hub_id, domain: site.domain, baseHash: site.base_hash, commands: {} };
}
function packageFile(scope, id) { return join(storeRoot(), "packages", scope, `${id}.adapt`); }
function persistPackage(scope, id, bytes) {
  const file = packageFile(scope, id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

function materializeExtension(site) {
  const base = readAdapt(readFileSync(site.basePackage));
  if (!base.manifest.runtimes.extension) return;
  const builtIn = join(resolveAdaptersDir(), site.domain);
  if (existsSync(join(builtIn, "manifest.json"))) return;
  const source = base.files["extension/site-entry.js"];
  if (!source) throw new Error("Extension site base is missing extension/site-entry.js.");
  const allowed = Object.values(site.commands).map((command) => command.fullName);
  const wrapped = `/* Generated by webcli adapterhub. */\n{\nconst __hubAllowed = new Set(${JSON.stringify(allowed)});\nconst __hubRegister = window.__webmcpRegister;\nwindow.__webmcpRegister = adapter => __hubRegister({...adapter, tools: (adapter.tools || []).filter(tool => __hubAllowed.has(tool.publicName || tool.name))});\ntry {\n${source.toString("utf8")}\n} finally { window.__webmcpRegister = __hubRegister; }\n}\n`;
  const root = installDir(), target = join(root, site.domain), staging = join(root, `.${site.domain}.${process.pid}.tmp`), backup = join(root, `.${site.domain}.${process.pid}.bak`);
  mkdirSync(staging, { recursive: true });
  try {
    writeFileSync(join(staging, "index.js"), wrapped);
    const supportFiles = [];
    for (const [name, content] of Object.entries(base.files)) {
      if (!name.startsWith("extension/shared/")) continue;
      const relative = name.slice("extension/".length);
      const file = resolve(staging, relative);
      if (!file.startsWith(`${resolve(staging)}${sep}`)) throw new Error("Unsafe support file path.");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      supportFiles.push(relative.replace(/\\/g, "/"));
    }
    writeFileSync(join(staging, "manifest.json"), `${JSON.stringify({ id: site.domain, name: base.manifest.name, description: base.manifest.description, match: base.manifest.allowed_domains, version: base.manifest.version, support_files: supportFiles, adapterhub: { site_id: site.id, commands: Object.keys(site.commands) } }, null, 2)}\n`);
    mkdirSync(root, { recursive: true });
    if (existsSync(target)) renameSync(target, backup);
    renameSync(staging, target);
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
  } catch (err) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
    throw err;
  }
}

async function installSite(target) {
  const bytes = (await downloadSite(target)).buffer;
  const pkg = readAdapt(bytes), current = state(), site = installedSiteFor(pkg.manifest, current);
  site.domain = pkg.manifest.domain;
  site.baseHash = pkg.manifest.base_hash;
  site.basePackage = persistPackage("base", site.id, bytes);
  site.commands = Object.fromEntries((pkg.manifest.tools || []).map((command) => [command.hub_id, { id: command.hub_id, commandName: command.command_name, fullName: command.name, runtime: command.runtime }]));
  persistPackage("sites", site.id, bytes);
  current.sites[site.id] = site;
  materializeExtension(site);
  saveState(current);
  return { domain: site.domain };
}

function findInstalledSite(current, target) {
  if (current.sites[target]) return { site: current.sites[target] };
  for (const site of Object.values(current.sites)) if (site.domain === target) return { site };
  return null;
}

// ─── 翻页拉取全部 adapter ─────────────────────────────────────────────────────

async function listAllAdapters(params = {}) {
  const items = [];
  let total = 0, page = 1, pageSize = 100;
  for (let guard = 0; guard < 100; guard++) {
    const data = await listAdapters({ ...params, page });
    items.push(...(data.items || []));
    total = data.total ?? items.length;
    pageSize = data.pageSize || 100;
    if (!(data.items || []).length || page * pageSize >= total) break;
    page++;
  }
  return { items, total };
}

// ─── 推荐提示词输出 ───────────────────────────────────────────────────────────

function printScenarios(adapter, indent = "") {
  const scenarios = adapter.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0) return;
  console.log(`${indent}推荐提示词（${scenarios.length} 个场景，\${} 为占位符）：`);
  for (const s of scenarios) {
    console.log(`${indent}  ▸ ${s.title || "未命名"}${s.summary ? " — " + s.summary : ""}`);
    for (const p of s.prompts || []) {
      const text = String(p.text || "").replace(/\n/g, "\n" + indent + "      ");
      console.log(`${indent}      ${text}`);
    }
  }
}

// ─── 命令实现 ─────────────────────────────────────────────────────────────────

async function cmdList(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, {
    flags: ["json", "installed"],
    values: { q: {}, origin: { choices: ["official", "user"] }, runtime: { choices: ["extension", "wewright"] }, sort: { choices: ["favorites", "downloads", "recent", "name"] } },
    positionalUsage: "（可省略）", maxPositional: 1,
  });
  if (p.flags.has("installed")) return cmdInstalled(args.filter((a) => a !== "--installed"), emit);
  if (p.positionals.length) {
    const t = p.positionals[0];
    if (t === "commands") throw new UsageError("命令维度已下线：Adapter（站点）是唯一分发单位。使用 webcli adapterhub list 查看全部 adapter。");
    if (t === "sites") {
      const data = await listSites({ q: p.values.get("q") || "" });
      if (p.flags.has("json")) return emit(data);
      const items = data.items || [];
      console.log(`v1 站点存量（冻结）：${data.total ?? items.length} 项`);
      for (const s of items) console.log(`  ${s.domain || s.id || ""}`);
      return;
    }
    throw new UsageError(`未知子命令: ${t}`);
  }
  const origin = p.values.get("origin") || "";
  const sort = p.values.get("sort") || "";
  const runtime = p.values.get("runtime") || "";
  const { items, total } = await listAllAdapters(origin || runtime || sort ? { origin, runtime, sort } : {});
  if (p.flags.has("json")) return emit({ total, items });
  if (!items.length) { console.log("AdapterHub 目录为空。"); return; }
  // 本地默认已内置/已安装大部分 Adapter，仅标记缺的；不再展示命令数/下载量。
  const localNames = knownLocalAdapterNames();
  let missing = 0;
  const lines = items.map((item) => {
    const originTag = item.origin === "user" ? " [用户上传]" : "";
    const installedTag = localNames.has(String(item.name || "").toLowerCase()) ? "" : " [未安装]";
    if (installedTag) missing++;
    return `  ${String(item.name || "").padEnd(30)} ${item.display || ""} v${item.version}${originTag}${installedTag}`;
  });
  console.log(`AdapterHub Adapter（共 ${total} 个，未安装 ${missing} 个）：\n`);
  for (const line of lines) console.log(line);
}

async function cmdFind(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, { flags: ["json"], positionalUsage: "关键词", maxPositional: 1, minPositional: 1 });
  const keyword = p.positionals[0];
  rejectCommandTarget(keyword);
  const { items, total } = await listAllAdapters({ q: keyword });
  if (p.flags.has("json")) return emit({ total, items });
  if (!items.length) { console.log(`没有找到匹配「${keyword}」的 Adapter。`); return; }
  console.log(`「${keyword}」匹配 ${total} 个 Adapter：\n`);
  for (const item of items) {
    console.log(`  ${String(item.name || "").padEnd(30)} ${item.display || ""} — ${item.description || "无描述"}`);
  }
}

async function cmdInfo(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, { flags: ["json"], positionalUsage: "adapter 名称", maxPositional: 1, minPositional: 1 });
  const target = p.positionals[0];
  rejectCommandTarget(target);
  const { name } = parseTarget(target);
  let adapter;
  try {
    adapter = await getAdapter(name);
  } catch (err) {
    if (err.status !== 404) throw err;
    const site = await getSite(name); // v1 冻结回退
    if (p.flags.has("json")) return emit(site);
    console.log(`Site(v1): ${site.domain || name}`);
    return;
  }
  if (p.flags.has("json")) return emit(adapter);
  console.log(`Adapter: ${adapter.display || adapter.name}${adapter.origin === "user" ? "（用户上传）" : "（官方内置）"}`);
  console.log(`  名称/域名: ${adapter.name}`);
  console.log(`  版本: v${adapter.version}`);
  if (adapter.origin === "user" && adapter.author) console.log(`  作者: ${adapter.author}`);
  console.log(`  描述: ${adapter.description || "无"}`);
  console.log(`  命令数: ${adapter.commandCount ?? 0} · 下载: ${adapter.downloads ?? 0} · 收藏: ${adapter.favoriteCount ?? 0}`);
  console.log(`  匹配域名: ${(adapter.match || []).join(", ") || "—"}`);
  console.log(`  运行时: ${normalizeRuntimes(adapter.runtimes).join(", ") || "—"}`);
  console.log(`  包: sha256=${String(adapter.artifact?.sha256 || "").slice(7, 23) || "—"}… ${Math.max(1, Math.round((adapter.artifact?.size || 0) / 1024))} KB`);
  if (adapter.installable === false) console.log(`  ⚠ 该 Adapter 暂无可下载制品（官方占位）`);
  printScenarios(adapter, "  ");
  console.log(`\n安装: webcli adapterhub install ${adapter.name}`);
}

async function cmdVersions(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, { flags: ["json"], positionalUsage: "adapter 名称", maxPositional: 1, minPositional: 1 });
  const target = p.positionals[0];
  rejectCommandTarget(target);
  const { name } = parseTarget(target);
  let data;
  try {
    data = await getAdapterVersions(name);
  } catch (err) {
    if (err.status === 404) {
      // 两种可能：adapter 不存在 / 服务端旧版无 versions 路由 —— 用 getAdapter 区分
      await getAdapter(name).catch((e2) => { throw e2.status === 404 ? new Error(`Adapter "${name}" 不存在。`) : e2; });
      throw new Error(`当前服务端暂不支持版本历史（${name}）。请升级 AdapterHub 服务端。`);
    }
    throw err;
  }
  if (p.flags.has("json")) return emit(data);
  const items = data.items || [];
  console.log(`Adapter ${name} 版本历史（${items.length} 个）：\n`);
  for (const v of items) {
    console.log(`  v${v.version}  ${v.publishedAt || ""}  ${Math.max(1, Math.round((v.size || v.artifactSize || 0) / 1024))} KB${v.sha256 ? `  sha256:${String(v.sha256).replace("sha256:", "").slice(0, 12)}…` : ""}`);
  }
}

async function cmdCommands(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, { flags: ["json"], positionalUsage: "adapter 名称", maxPositional: 1, minPositional: 1 });
  const target = p.positionals[0];
  rejectCommandTarget(target);
  const { name } = parseTarget(target);
  const data = await getAdapterCommands(name);
  if (p.flags.has("json")) return emit(data);
  const items = data.items || [];
  console.log(`Adapter ${name} 命令清单（${items.length} 个）：\n`);
  for (const c of items) {
    const runtime = c.runtime === "toolkit" ? "wewright" : c.runtime;
    console.log(`  ${c.fullName || `${name}.${c.id}`}  [${runtime}]  ${c.description || ""}`);
    const schema = c.parametersSchema || c.schema || {};
    const props = schema.properties || {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [pname, prop] of Object.entries(props)) {
      const req = required.has(pname) ? "必填" : "可选";
      const type = Array.isArray(prop?.enum) ? `enum(${prop.enum.join("|")})` : prop?.type || "string";
      console.log(`      --${pname}  <${type}>  ${req}  ${prop?.description || ""}`);
    }
  }
  console.log(`\n安装: webcli adapterhub install ${name}`);
}

async function cmdDownload(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, {
    flags: ["json"],
    values: { output: {}, "o": { alias: "output" }, version: {} },
    positionalUsage: "adapter 名称", maxPositional: 1, minPositional: 1,
  });
  const target = p.positionals[0];
  rejectCommandTarget(target);
  const { name, version } = parseTarget(target);
  const outFile = p.values.get("output");
  const versionArg = p.values.get("version") || version;
  let buffer;
  try {
    buffer = (await downloadAdapter(name, { version: versionArg })).buffer;
  } catch (err) {
    if (err.status !== 404 || versionArg) throw err;
    buffer = (await downloadSite(name)).buffer; // v1 冻结回退（仅未指定版本）
  }
  let downloaded;
  try {
    downloaded = readAdapterPackage(buffer);
    if (downloaded.manifest.name !== name) throw new Error(`下载包名不匹配：期望 ${name}，实际 ${downloaded.manifest.name}`);
    if (versionArg && downloaded.manifest.version !== versionArg) throw new Error(`下载包版本不符：期望 v${versionArg}，实际 v${downloaded.manifest.version}`);
  } catch (v2Error) {
    if (versionArg) throw v2Error;
    try { downloaded = readAdapt(buffer); } catch { throw v2Error; }
  }
  let fallback = `${sanitizeFileName(name)}.adapt`;
  fallback = downloaded.manifest.name || downloaded.manifest.domain ? `${sanitizeFileName(downloaded.manifest.name || downloaded.manifest.domain)}.adapt` : fallback;
  const dest = outFile || fallback;
  writeFileSync(dest, buffer);
  if (p.flags.has("json")) return emit({ path: resolve(dest), size: buffer.length, name: downloaded.manifest.name || downloaded.manifest.domain || name, ...(downloaded.manifest.version ? { version: downloaded.manifest.version } : {}) });
  console.log(`✓ 已下载: ${dest}（${Math.round(buffer.length / 1024)} KB${versionArg ? `，指定版本 v${versionArg}` : ""}）`);
}

async function cmdValidate(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, { flags: ["json"], positionalUsage: "包文件 .adapt", maxPositional: 1, minPositional: 1 });
  const file = p.positionals[0];
  const abs = resolve(file);
  if (!existsSync(abs)) throw new Error(`文件不存在: ${abs}`);
  const bytes = readFileSync(abs);
  try {
    const pkg = readAdapterPackage(bytes);
    if (p.flags.has("json")) return emit({ valid: true, schemaVersion: 2, name: pkg.manifest.name, version: pkg.manifest.version, files: pkg.files.size, sha256: pkg.sha256, commands: (pkg.manifest.commands || []).map((c) => c.id) });
    console.log(`✓ 包校验通过: ${pkg.manifest.name} v${pkg.manifest.version}（${pkg.files.size} 个文件, sha256:${pkg.sha256.slice(7, 23)}…）`);
    console.log(`  命令: ${(pkg.manifest.commands || []).map((c) => c.id).join(", ")}`);
  } catch (v2Error) {
    try {
      const pkg = readAdapt(bytes);
      if (p.flags.has("json")) return emit({ valid: true, schemaVersion: 1, scope: pkg.manifest.scope, path: abs, sha256: pkg.sha256 });
      console.log(`Valid v1 ${pkg.manifest.scope} package (frozen): ${basename(abs)} (${pkg.sha256})`);
    } catch { throw v2Error; }
  }
}

async function cmdInstall(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, {
    flags: ["force", "reload", "json", "allow-permission-change", "change-source"],
    values: { version: {} },
    positionalUsage: "adapter 名称 / name@version / 本地 .adapt 路径", maxPositional: 1, minPositional: 1,
  });
  const rawTarget = p.positionals[0];
  const decisions = {
    allowDowngrade: p.flags.has("force"),
    allowPermissionChange: p.flags.has("allow-permission-change"),
    allowSourceChange: p.flags.has("change-source"),
  };
  const force = p.flags.has("force");
  const reload = p.flags.has("reload");
  const json = p.flags.has("json");

  // 本地 .adapt 包安装（离线）
  if (isLocalPackagePath(rawTarget)) {
    const abs = resolve(rawTarget);
    if (!existsSync(abs)) throw new Error(`文件不存在: ${abs}`);
    if (!/\.adapt$/i.test(abs)) throw new UsageError(`本地安装仅支持 .adapt 包: ${abs}`);
    const bytes = readFileSync(abs);
    const pre = readAdapterPackage(bytes);
    const local = readLocalManifest(pre.manifest.name);
    if (!decisions.allowSourceChange) assertInstalledAdapterOrigin(pre.manifest.name, { kind: "local" });
    if (local?.version && !force && !decisions.allowSourceChange) {
      const cmp = compareVersions(pre.manifest.version, local.version);
      if (cmp === 0) {
        if (json) { emit({ name: pre.manifest.name, version: local.version, action: "already-latest" }); return; }
        console.log(`✓ ${pre.manifest.name} 已是同版本（v${local.version}）。用 --force 强制重装。`);
        return;
      }
      if (cmp < 0) {
        if (json) { process.exitCode = 1; emit({ name: pre.manifest.name, localVersion: local.version, packageVersion: pre.manifest.version, action: "downgrade-blocked" }); return; }
        console.error(`! 包版本 v${pre.manifest.version} 低于本地 v${local.version}（降级）。用 --force 确认降级安装。`);
        process.exitCode = 1;
        return;
      }
    }
    const { pkg } = installAdapterPackage(bytes, {}, { ...decisions, origin: { kind: "local" } });
    const localResult = { name: pkg.manifest.name, version: pkg.manifest.version, action: local ? "upgraded" : "installed", source: "local", path: join(installDir(), pkg.manifest.name) };
    if (reload) Object.assign(localResult, await reloadExtensionBestEffort({ json }));
    if (json) { emit(localResult); return; }
    console.log(`✓ 已从本地包安装: ${pkg.manifest.name} v${pkg.manifest.version} → ${join(installDir(), pkg.manifest.name)}`);
    if (!reload) console.log("→ 请在 chrome://extensions 重载扩展生效");
    return;
  }

  rejectCommandTarget(rawTarget);
  const { name, version } = parseTarget(rawTarget);
  const origin = { kind: "hub", service: resolveEndpoint() };
  if (!decisions.allowSourceChange) assertInstalledAdapterOrigin(name, origin);
  const versionArg = p.values.get("version") || version;

  // v2 优先；404 回退 v1 站点冻结存量
  let remote;
  try {
    remote = await getAdapter(name);
  } catch (err) {
    if (err.status !== 404 || versionArg) throw err;
    await installSite(name);
    const siteResult = { name, action: "installed", source: "v1-site" };
    if (reload) Object.assign(siteResult, await reloadExtensionBestEffort({ json }));
    if (json) { emit(siteResult); return; }
    return;
  }

  if (remote.installable === false && !versionArg) {
    throw new Error(`Adapter "${name}" 暂无可下载制品（官方占位，尚未发布 .adapt 包）。`);
  }
  if (remote.name !== name) throw new Error("Adapter metadata identity does not match the requested package.");
  if (versionArg && versionArg === remote.version && remote.installable === false) {
    throw new Error(`Adapter "${name}" 的 v${versionArg} 暂无可下载制品。`);
  }

  const targetVersion = versionArg || remote.version;
  if (versionArg && versionArg !== remote.version) {
    // 指定版本：确认历史版本存在（服务端支持时）；旧服务端 download?version= 404 时由下载环节报错
    const versions = await getAdapterVersions(name).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
    if (versions && !versions.items?.some((v) => v.version === versionArg)) {
      throw new Error(`Adapter "${name}" 不存在版本 v${versionArg}。用 webcli adapterhub versions ${name} 查看历史版本。`);
    }
  }

  const local = readLocalManifest(remote.name);
  const result = { name: remote.name };
  if (local?.version) {
    const cmp = compareVersions(targetVersion, local.version);
    if (cmp === 0 && !force && !decisions.allowSourceChange) {
      if (json) return emit({ ...result, version: local.version, action: "already-latest" });
      console.log(`✓ ${remote.name} 已是最新（v${local.version}）。用 --force 强制重装。`);
      return;
    }
    if (cmp < 0 && !force) {
      if (json) { process.exitCode = 1; emit({ ...result, localVersion: local.version, remoteVersion: targetVersion, action: "downgrade-blocked" }); return; }
      console.error(`! 线上版本 v${targetVersion} 低于本地 v${local.version}（降级）。用 --force 确认降级安装。`);
      process.exitCode = 1;
      return;
    }
    if (cmp > 0 && !json) console.log(`升级 ${remote.name}: v${local.version} → v${targetVersion}`);
    result.action = "upgraded";
    result.fromVersion = local.version;
  } else {
    if (!json) console.log(`安装 ${remote.display || remote.name}（${remote.name}）v${targetVersion}，含 ${remote.commandCount ?? 0} 个命令`);
    result.action = "installed";
  }
  result.version = targetVersion;

  let expectedSha = String(remote.artifact?.sha256 || "").replace("sha256:", "");
  const downloadVersion = versionArg || undefined;
  if (downloadVersion && downloadVersion !== remote.version) {
    const versions = await getAdapterVersions(remote.name).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
    expectedSha = String(versions?.items?.find((v) => v.version === downloadVersion)?.sha256 || "").replace("sha256:", "");
  }
  const { buffer } = await downloadAdapter(remote.name, { version: downloadVersion });
  const { pkg } = installAdapterPackage(buffer, { name: remote.name, version: targetVersion, sha256hex: expectedSha || undefined }, { ...decisions, origin });
  result.installedAt = join(installDir(), pkg.manifest.name);

  if (json) {
    if (reload) Object.assign(result, await reloadExtensionBestEffort({ json }));
    emit(result);
  } else {
    console.log(`✓ Adapter 已安装: ${pkg.manifest.name} v${pkg.manifest.version} → ${result.installedAt}`);
    printScenarios(remote);
    if (Array.isArray(remote.scenarios) && remote.scenarios.length) {
      console.log("（提示词已列出，装好后直接对 AI 助手说即可；${} 为占位符）");
    }
  }
  if (reload && !json) await reloadExtensionBestEffort();
  else if (!reload && !json) console.log("→ 请在 chrome://extensions 重载扩展生效");
}

async function cmdUpdate(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, { flags: ["all", "force", "json", "dry-run", "allow-permission-change"], positionalUsage: "adapter 名称或 --all", maxPositional: 1 });
  const force = p.flags.has("force");
  const dryRun = p.flags.has("dry-run");
  const json = p.flags.has("json");
  const target = p.positionals[0] || null;
  if (!p.flags.has("all") && !target) throw new UsageError("请指定 Adapter 或使用 --all。用法: webcli adapterhub update [<目标>|--all]");
  const installed = target ? [findLocalAdapterByTarget(target)].filter(Boolean) : localAdapterIds();
  if (target && !installed.length) throw new Error(`本地未安装 "${target}"。`);
  let upToDate = 0, updated = 0, newer = 0, delisted = 0, skipped = 0;
  const plan = [];
  for (const id of installed) {
    const local = readLocalManifest(id);
    if (!local) continue;
    const origin = { kind: "hub", service: resolveEndpoint() };
    if (local.origin?.kind !== "hub") {
      if (target) throw new Error("This Adapter has no Hub update source; explicitly install from a Hub to change its source.");
      plan.push({ name: id, action: "skipped-local-source" }); skipped++; continue;
    }
    // Check before requesting metadata: a changed endpoint must not learn private package names.
    assertInstalledAdapterOrigin(id, origin);
    let remote;
    try {
      remote = await getAdapter(id);
    } catch (err) {
      if (err.status === 404) { plan.push({ name: id, action: "delisted-kept" }); delisted++; if (!json) console.log(`- ${id}: 线上已下架，保留本地版本`); continue; }
      throw err;
    }
    if (remote.installable === false) { plan.push({ name: id, action: "skipped-placeholder" }); skipped++; if (!json) console.log(`- ${id}: 暂无可下载制品（官方占位），跳过`); continue; }
    const cmp = compareVersions(remote.version, local.version);
    if (cmp > 0 || (cmp < 0 && force)) {
      plan.push({ name: id, localVersion: local.version, remoteVersion: remote.version, action: cmp < 0 ? "downgrade" : "upgrade" });
      if (!json) console.log(`↑ ${id}: v${local.version} → v${remote.version}${cmp < 0 ? "（--force 降级）" : ""}`);
      if (dryRun) { updated++; continue; }
      const expectedSha = String(remote.artifact?.sha256 || "").replace("sha256:", "");
      const { buffer } = await downloadAdapter(id);
      const { pkg } = installAdapterPackage(buffer, { name: id, version: remote.version, sha256hex: expectedSha }, {
        origin, allowDowngrade: force, allowPermissionChange: p.flags.has("allow-permission-change"),
      });
      updated++;
      if (json) plan[plan.length - 1].installedAt = join(installDir(), pkg.manifest.name);
    } else if (cmp < 0) {
      plan.push({ name: id, localVersion: local.version, remoteVersion: remote.version, action: "local-newer" });
      newer++; if (!json) console.log(`- ${id}: 本地 v${local.version} 比线上 v${remote.version} 新，跳过（--force 可降级）`);
    } else {
      plan.push({ name: id, localVersion: local.version, remoteVersion: remote.version, action: "up-to-date" });
      upToDate++;
    }
  }
  const summary = { updated, upToDate, newer, delisted, skipped, dryRun };
  if (json) return emit({ summary, plan });
  console.log(`\n完成：${updated} 更新 · ${upToDate} 已最新${newer ? ` · ${newer} 本地更新` : ""}${delisted ? ` · ${delisted} 已下架` : ""}${skipped ? ` · ${skipped} 占位跳过` : ""}${dryRun ? "（--dry-run，未实际执行）" : ""}`);
}

function cmdInstalled(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, { flags: ["json"], maxPositional: 0 });
  // 内置 Adapter 随包分发、不占安装记录；自装 Adapter 以安装记录为准，重名时自装覆盖内置。
  const installedIds = localAdapterIds();
  const items = [
    ...builtinAdapterIds()
      .filter((id) => !installedIds.includes(id))
      .map((id) => ({ name: id, version: readBuiltinManifestVersion(id), source: "builtin" })),
    ...installedIds.map((id) => ({ name: id, version: readLocalManifest(id)?.version || "?", source: "installed" })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const builtinCount = items.filter((item) => item.source === "builtin").length;
  const installedCount = items.length - builtinCount;
  if (p.flags.has("json")) return emit({ items, total: items.length, builtin: builtinCount, installed: installedCount });
  console.log(`本地 Adapter ${items.length} 个（内置 ${builtinCount} · 自装 ${installedCount}）：\n`);
  for (const item of items) {
    const sourceTag = item.source === "builtin" ? "[内置]" : "[自装]";
    console.log(`  ${item.name.padEnd(30)} v${item.version} ${sourceTag}`);
  }
}

async function cmdRemove(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, { flags: ["reload", "json"], positionalUsage: "adapter 名称", maxPositional: 1, minPositional: 1 });
  const target = p.positionals[0];
  rejectCommandTarget(target);
  const json = p.flags.has("json");
  const id = findLocalAdapterByTarget(target);
  if (id) {
    const removal = removeInstalledAdapter(id);
    if (p.flags.has("reload")) Object.assign(removal, await reloadExtensionBestEffort({ json }));
    if (json) { emit(removal); return; }
    console.log(`✓ Adapter 已卸载: ${id}`);
    if (!p.flags.has("reload")) console.log("→ 请在 chrome://extensions 重载扩展生效");
    return;
  }
  // v1 site 冻结存量
  const current = state();
  const match = findInstalledSite(current, target);
  if (!match) throw new Error(`Not installed: ${target}`);
  const adapterDir = join(installDir(), match.site.domain);
  if (existsSync(adapterDir)) rmSync(adapterDir, { recursive: true, force: true });
  delete current.sites[match.site.id];
  saveState(current);
  const removal = { name: match.site.domain, action: "removed", source: "v1-site" };
  if (p.flags.has("reload")) Object.assign(removal, await reloadExtensionBestEffort({ json }));
  if (json) { emit(removal); return; }
  console.log(`Removed ${match.site.domain}`);
  if (!p.flags.has("reload")) console.log("→ 请在 chrome://extensions 重载扩展生效");
}

// ─── pack / publish ──────────────────────────────────────────────────────────

const PACK_FORBIDDEN_BASENAMES = new Set([
  "index.js", "SKILL.md", "SKILL.generated.md", "WEBCLI_KNOWLEDGE.md", "WEBCLI_KNOWLEDGE.json", "wecli.generated.json",
  "toolkit_runtime.py", "toolkit.py", "requirements.txt",
]);
const PACK_FIXED_MTIME = new Date("1980-01-01T00:00:00Z");

/**
 * 将目录打成 .adapt（manifest.json + extension/ + wewright/）。
 * - 确定性输出：固定 mtime + 排序条目，同内容重打包哈希一致（保障同版本幂等发布）
 * - 排除服务端禁止的文件（v2 包规范：无 index.js/SKILL.md/生成文件等）
 * - 排除本地安装产物目录（兼容层/元数据），只打包源码
 */
function packDirectory(dir) {
  const files = {};
  const walk = (current, rel = "") => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__" || entry.name === "node_modules" || entry.name.startsWith(".") || entry.name.endsWith(".staging") || entry.name.includes(".backup-")) continue;
        walk(full, relPath);
      } else {
        if (PACK_FORBIDDEN_BASENAMES.has(entry.name) || /\.generated\.(js|py|md|txt)$/.test(entry.name)) continue;
        files[relPath] = [new Uint8Array(readFileSync(full)), { mtime: PACK_FIXED_MTIME }];
      }
    }
  };
  walk(dir);
  return Buffer.from(zipSync(files, { level: 9 }));
}

function cmdPack(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, {
    flags: ["json"],
    values: { output: {}, "o": { alias: "output" } },
    positionalUsage: "目录", maxPositional: 1, minPositional: 1,
  });
  const abs = resolve(p.positionals[0]);
  if (!existsSync(abs)) throw new Error(`路径不存在: ${abs}`);
  if (!existsSync(join(abs, "manifest.json"))) throw new Error(`目录缺少 manifest.json: ${abs}`);
  const bytes = packDirectory(abs);
  const pkg = readAdapterPackage(bytes); // 打包后立刻校验
  const dest = p.values.get("output") || `${pkg.manifest.name}.adapt`;
  writeFileSync(dest, bytes);
  if (p.flags.has("json")) {
    return emit({ path: resolve(dest), name: pkg.manifest.name, version: pkg.manifest.version, files: pkg.files.size, size: bytes.length, sha256: pkg.sha256 });
  }
  console.log(`✓ 已打包: ${dest}（${pkg.manifest.name} v${pkg.manifest.version}, ${pkg.files.size} 文件, ${Math.round(bytes.length / 1024)} KB, sha256:${pkg.sha256.slice(7, 23)}…）`);
}

async function cmdInit(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, { flags: ["json"], positionalUsage: "[PAT]", maxPositional: 1 });
  const provided = p.positionals[0];
  if (provided !== undefined && !/^ahp_[A-Za-z0-9_-]{16,}$/.test(provided)) {
    throw new UsageError("PAT 格式无效：应以 ahp_ 开头（AdapterHub 网页「令牌」处创建）。");
  }
  // 位置参数直接保存（非交互/脚本场景）；省略时保持隐藏输入交互。
  const token = provided !== undefined ? provided : await readHiddenToken();
  const file = await saveAdapterHubToken(token);
  if (p.flags.has("json")) return emit({ configured: true, source: "windows-dpapi" });
  console.log("✓ AdapterHub PAT 已使用 Windows DPAPI 加密保存。后续 publish 无需重复设置。");
  console.log(`  凭据文件（仅密文）: ${file}`);
}

async function cmdAuthStatus(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, { flags: ["json"], maxPositional: 0 });
  const status = await adapterHubCredentialStatus();
  if (p.flags.has("json")) return emit(status);
  console.log(status.configured ? `AdapterHub PAT 已配置（${status.source}）` : "AdapterHub PAT 未配置。运行 webcli adapterhub init。")
}

async function cmdLogout(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, { flags: ["json"], maxPositional: 0 });
  const removed = await removeAdapterHubToken();
  if (p.flags.has("json")) return emit({ removed });
  console.log(removed ? "✓ AdapterHub 已保存 PAT 已删除。" : "AdapterHub 没有已保存的 PAT。")
}

async function cmdPublish(args, emit = value => console.log(JSON.stringify(value, null, 2))) {
  const p = parseArgs(args, { flags: ["yes", "y", "json"], positionalUsage: "目录或 .adapt", maxPositional: 1, minPositional: 1 });
  const yes = p.flags.has("yes") || p.flags.has("y");
  const json = p.flags.has("json");
  const abs = resolve(p.positionals[0]);
  if (!existsSync(abs)) throw new Error(`路径不存在: ${abs}`);

  const buffer = existsSync(join(abs, "manifest.json")) ? packDirectory(abs) : readFileSync(abs);
  const pkg = readAdapterPackage(buffer); // 上传前完整本地校验
  if (!json) {
    console.log(`包校验通过: ${pkg.manifest.name} v${pkg.manifest.version}（${pkg.files.size} 个文件, ${Math.round(buffer.length / 1024)} KB, sha256:${pkg.sha256.slice(7, 16)}…）`);
    console.log(`目标: ${resolveEndpoint()}`);
  }

  if (!yes) {
    if (!process.stdin.isTTY) throw new UsageError("非交互环境请加 --yes 确认发布。");
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`确认发布 ${pkg.manifest.name} v${pkg.manifest.version}? [y/N] `);
      if (!/^y(es)?$/i.test(answer.trim())) {
        if (json) emit({ name: pkg.manifest.name, version: pkg.manifest.version, action: "cancelled" });
        else console.log("已取消。");
        return;
      }
    } finally {
      rl.close();
    }
  }

  const result = await publishAdapter(buffer);
  if (json) return emit(result);
  if (result.duplicate) {
    console.log(`✓ 内容未变化（v${result.version} 已存在且哈希一致），无需重复发布。`);
  } else {
    console.log(`✓ 发布成功: ${result.name} v${result.version}`);
    console.log(`  安装: webcli adapterhub install ${result.name}`);
  }
}

// ─── help / dispatch ─────────────────────────────────────────────────────────

/** help/usage 展示用：端点未配置或非法时不抛错，显示占位（帮助应永远可用）。 */
function endpointLabel() {
  try { return resolveEndpoint() || "端点未配置"; } catch { return "端点未配置"; }
}

function endpointOrNull() {
  try { return resolveEndpoint() || null; } catch { return null; }
}

function help() {
  console.log(`webcli adapterhub — Adapter 目录与分发（${endpointLabel()}）

用法:
  webcli adapterhub list [--origin official|user] [--runtime extension|wewright] [--sort …] [--json]
                                                          列出线上 Adapter（默认收藏排序）
  webcli adapterhub find <关键词> [--json]               按名称、域名、用途检索
  webcli adapterhub info <adapter> [--json]              查看 Adapter 详情（含推荐提示词）
  webcli adapterhub versions <adapter> [--json]          查看版本历史
  webcli adapterhub commands <adapter> [--json]          查看命令清单与参数
  webcli adapterhub download <adapter>[@<版本>] [-o <文件>] [--json]
                                                          下载 .adapt 包（可指定历史版本）
  webcli adapterhub validate <文件.adapt>                离线校验包结构与哈希
  webcli adapterhub pack <目录> [-o <文件.adapt>] [--json] 将目录打包为 .adapt
  webcli adapterhub install <adapter>[@<版本>] | <本地.adapt> [--force] [--reload] [--json]
                                                          安装/升级整个 Adapter
    --change-source                                       显式更换安装来源
    --allow-permission-change                             接受新增权限（不包含在 --force 中）
  webcli adapterhub update [<adapter>|--all] [--force] [--dry-run] [--json]
                                                          检查并更新已安装 Adapter
    --allow-permission-change                             接受新增权限
  webcli adapterhub installed [--json]                   列出本地 Adapter（内置 + 自装）
  webcli adapterhub remove <adapter> [--reload] [--json] 卸载 Adapter
  webcli adapterhub init [PAT] [--json]                 安全保存发布 PAT（Windows DPAPI；省略 PAT 时交互输入）
  webcli adapterhub status [--json]                     查看 PAT 是否已配置（不显示令牌）
  webcli adapterhub logout [--json]                     删除已保存 PAT
  webcli adapterhub publish <目录或.adapt> [--yes] [--json]  发布/更新 Adapter
  webcli adapterhub endpoint [--json]                    打印当前 AdapterHub 端点

说明:
  - 官方地址已内置，无需配置；自建时设 WEBCLI_ADAPTERHUB_ENDPOINT
  - <adapter> 通常是站点域名；name@version 可安装/下载指定历史版本
  - install 支持 ./xxx.adapt 本地包离线安装
  - install/update 覆盖本地已有版本时会做版本比对确认
  - 首次发布前运行 adapterhub init；PAT 使用 Windows DPAPI 加密保存
  - 非交互/脚本场景可 webcli adapterhub init ahp_xxx 直接保存 PAT
  - ADAPTERHUB_TOKEN 仅作为临时覆盖，优先于已保存凭据`);
}

const COMMANDS = {
  list: cmdList, find: cmdFind, search: cmdFind, info: cmdInfo, versions: cmdVersions,
  commands: cmdCommands, download: cmdDownload, validate: cmdValidate, pack: cmdPack,
  install: cmdInstall, update: cmdUpdate, installed: cmdInstalled, remove: cmdRemove,
  uninstall: cmdRemove, init: cmdInit, login: cmdInit, status: cmdAuthStatus, logout: cmdLogout, publish: cmdPublish,
  endpoint: (args, emit) => {
    const p = parseArgs(args, { flags: ["json"], maxPositional: 0 });
    const ep = resolveEndpoint();
    if (p.flags.has("json")) emit({ endpoint: ep });
    else console.log(ep);
  },
};

export async function runAdapterHubCli(args, { outputFormat } = {}) {
  const command = args[0];
  const rest = args.slice(1);
  let explicitFormat;
  try { if (outputFormat !== undefined) explicitFormat = resolveOutputFormat(outputFormat); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  const emit = value => console.log(formatCallOutput(value, explicitFormat ?? 'json'));
  try {
    if (command === undefined || ["--help", "-h", "help"].includes(command)) {
      if (explicitFormat !== undefined || rest.includes('--json')) return emit({
        usage: 'webcli adapterhub <command> [options]', endpoint: endpointOrNull(),
        commands: Object.keys(COMMANDS), formats: ['json', 'markdown', 'table', 'plain', 'csv', 'yaml'],
        confirmation: 'Output format does not grant installation permissions or confirm publication.',
      });
      return help();
    }
    const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
    if (!handler) throw new UsageError(`未知命令: ${command}`);
    // Reuse each command's existing JSON data path. Formatting never changes
    // its confirmation, source-change or permission decisions.
    return await handler(explicitFormat === undefined ? rest : ['--json', ...rest], emit);
  } catch (err) {
    process.exitCode = err instanceof UsageError ? 2 : 1;
    if (explicitFormat !== undefined) {
      emit({ error: err.message, code: err.code || (err instanceof UsageError ? 'USAGE_ERROR' : 'ADAPTERHUB_ERROR') });
    } else if (err instanceof UsageError) {
      console.error(`参数错误: ${err.message}`);
      console.error("运行 webcli adapterhub --help 查看用法。");
    } else console.error(`Error: ${err.message}`);
  }
}
