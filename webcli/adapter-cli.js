/**
 * Adapter CLI — inspect both Adapter types and manage Extension Adapters
 *
 * Usage:
 *   webcli adapter install <id>                 # from Hub (CDN)
 *   webcli adapter install --url <url>          # from custom URL (e.g. internal GitLab)
 *   webcli adapter install --file <path>        # from local file
 *   webcli adapter list                         # list installed adapters
 *   webcli adapter remove <id>                  # remove adapter
 *
 * Options:
 *   --name <id>    Adapter id (filename without .js). Required for --url / --file
 *                  when the id cannot be inferred from the source.
 *   --reload       After install/remove, send a reload signal to the Chrome
 *                  extension via the running WebCLI service (ws://localhost:3711).
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { WebSocket } from "ws";
import vm from "vm";
import {
  API_BACKGROUND_EXECUTION,
  isCatalogApiBackgroundCommand,
  isApiBackgroundExecution,
} from "./direct-execution-metadata.js";
import { generateSkillContent } from "./skill-writer.js";
import { resolveAdaptersDir, resolveUserAdaptersDir } from "./paths.js";
import { findToolkitAdapter, loadToolkitAdapters } from "./adapter-registry.js";
import { managedAdapterViews, managedAdapterView, managedAdapterSkill } from './adapter-views.js';
import { runManagedAdapterCommand } from './managed-adapter-cli.js';
import { formatCallOutput, resolveOutputFormat } from './output-format.js';
import { bridgeUrl, resolveBridgeInstance } from './bridge-instance.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXTENSION_ADAPTERS_DIR = resolveAdaptersDir();
const USER_ADAPTERS_DIR = resolveUserAdaptersDir();
function resolveManagedAdapterView(identifier) {
  const direct = managedAdapterView(identifier);
  if (direct) return direct;
  return managedAdapterViews().adapters.find((adapter) =>
    adapter.tools.some((tool) => tool.aliases?.includes(identifier))) || null;
}


// Hub URL 配置
// - 默认使用官方 Hub: https://webmcphub.dev
// - 企业内网或私有部署可设置环境变量覆盖:
//   export WEBMCP_HUB="https://your-hub.company.com"
//   export WEBMCP_HUB="https://github.com/WeWorker/WeWorker"
//   export WEBMCP_HUB="https://gitlab.company.com/user/repo"
const HUB_URL = process.env.WEBMCP_HUB || "https://webmcphub.dev";

// Registry 和 Adapters URL 自动构建
const HUB_REGISTRY_URL = `${HUB_URL}/hub/registry.json`;
const HUB_ADAPTER_BASE_URL = `${HUB_URL}/hub/adapters`;
const BRIDGE_INSTANCE = resolveBridgeInstance();
const WS_PORT = BRIDGE_INSTANCE.port;

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * adapter -help 的结构化数据（-f json）。
 * 返回 namespace 层：命令列表 + 已安装站点。
 */
export async function adapterHelpJson() {
  const adapters = await loadAdapterViews();
  const sites = adapters
    .map((a) => ({ id: a.id, name: a.name || a.id, source: a.source }))
    .sort((x, y) => x.id.localeCompare(y.id));
  return {
    name: "adapter",
    usage: "webcli adapter <command> [args] [options]",
    description: "管理已安装的网站适配器（install / list / info / skill / knowledge / remove）",
    commands: [
      { name: "list", usage: "webcli adapter list [--json]", description: "列出已安装 adapter" },
      { name: "info <id>", usage: "webcli adapter info <id>", description: "查看 adapter 的工具列表" },
      { name: "status", usage: "webcli adapter status [id]", description: "只读检查 v2 包候选、当前选择和失效诊断" },
      { name: "verify", usage: "webcli adapter verify <dir> | --installed [id]", description: "静态校验与历史证据汇总；--runtime legacy|toolkit 诊断兼容包，不执行工具" },
      { name: "source", usage: "webcli adapter source <local-repository> --ref <full-sha>", description: "读取固定 Git 提交并发现 v2 子包，不改变 checkout" },
      { name: "validate", usage: "webcli adapter validate <dir> | --installed [id]", description: "静态检查 v2 包和 JavaScript，不执行命令" },
      { name: "convention-audit", usage: "webcli adapter convention-audit <dir> | --installed [id]", description: "只读规范提示；不证明运行或副作用正确" },
      { name: "eject", usage: "webcli adapter eject <id> --directory <new-dir>", description: "复制内置 v2 包到新的编辑目录；用 develop 显式选择" },
      { name: "install", usage: "webcli adapter install <id> | --url <url> | --file <path>", description: "安装 adapter（Hub/URL/本地文件）" },
      { name: "remove <id>", usage: "webcli adapter remove <id>", description: "移除 adapter" },
      { name: "skill <id>", usage: "webcli adapter skill <id> [--generated|--regenerate]", description: "输出/重新生成 SKILL.md" },
      { name: "knowledge <id>", usage: "webcli adapter knowledge <id> [--json]", description: "输出 WEBCLI_KNOWLEDGE" },
      { name: "skills-path", usage: "webcli adapter skills-path", description: "输出 adapters 目录路径" },
      { name: "refresh", usage: "webcli adapter refresh", description: "强制刷新 Hub registry 缓存" },
    ],
    site_adapters: {
      count: sites.length,
      sites,
    },
    next: [
      "webcli adapter <id> -help",
      "webcli adapter <id> -help -f json",
    ],
  };
}

/**
 * adapter <id> -help 的结构化数据（-f json）。
 * 返回 site 层：工具摘要；具体参数在命令级帮助展示。
 */
export async function adapterSiteHelpJson(adapterId) {
  const adapters = await loadAdapterViews();
  const adapter = adapters.find((a) => a.id === adapterId)
    || adapters.find((a) => (a.tools || []).some((tool) => tool.aliases?.includes(adapterId)));
  if (!adapter) {
    return { site: adapterId, error: `Adapter "${adapterId}" is not installed.` };
  }
  const tools = (adapter.tools || []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    directCapable: tool.directCapable === true,
    executionMode: tool.executionMode,
    execution: tool.execution ? { type: tool.execution.type, runtime: tool.execution.runtime } : undefined,
  }));
  return {
    site: adapterId,
    name: adapter.name || adapterId,
    source: adapter.source,
    tool_count: tools.length,
    tools,
    next: [
      `webcli ${adapterId} <command> --help`,
    ],
  };
}

export async function runAdapterCli(args, { outputFormat } = {}) {
  if (args[0] === 'verify') {
    const { runAdapterVerify } = await import('./adapter-verification.js');
    return runAdapterVerify(args.slice(1), { outputFormat });
  }
  if (args[0] === 'source') {
    const { runGitSource } = await import('./adapter-git-source.js');
    return runGitSource(args.slice(1), { outputFormat });
  }
  if (args[0] === 'install' && args.includes('--git')) {
    if (outputFormat !== undefined) resolveOutputFormat(outputFormat);
    console.log(formatCallOutput(runManagedAdapterCommand(args), outputFormat ?? 'json')); return;
  }
  const managerCommands = new Set(['install', 'list', 'remove', 'uninstall', 'refresh', 'info', 'skill', 'knowledge', 'skills-path', 'help', 'status', 'validate', 'eject', 'develop', 'use', 'convention-audit']);
  if (args[0] && !args[0].startsWith('-') && !managerCommands.has(args[0]) && args[1] && !args[1].startsWith('-')
      && args.slice(2).some(arg => ['-h', '--help', '-help'].includes(arg))) {
    const { runAdapterHelp } = await import('./progressive-help.js');
    const helpFormat = outputFormat ?? (args.includes('--json') || (args.includes('-f') && args[args.indexOf('-f') + 1] === 'json') ? 'json' : undefined);
    console.log(await runAdapterHelp([args[0], args[1], 'help'], { outputFormat: helpFormat }));
    return;
  }
  if (args[0] === 'convention-audit') {
    const { runConventionAudit } = await import('./adapter-conventions.js');
    return runConventionAudit(args.slice(1), { outputFormat });
  }
  if (['status', 'validate'].includes(args[0])) {
    const { runAdapterDiagnostics } = await import('./adapter-diagnostics.js');
    return runAdapterDiagnostics(args, { outputFormat });
  }
  if (['eject', 'develop', 'use'].includes(args[0])) {
    if (outputFormat !== undefined) resolveOutputFormat(outputFormat);
    if (args.some(arg => ['--help', '-h'].includes(arg))) {
      console.log(formatCallOutput({ usage: { eject: 'webcli adapter eject <id> --directory <new-directory-named-after-adapter>',
        develop: 'webcli adapter develop <directory>', use: 'webcli adapter use <id> <builtin|user|development|disabled>' }[args[0]],
      scope: 'Eject copies the built-in package without activation. Develop/use explicitly selects a source.' }, outputFormat ?? 'json')); return;
    }
    console.log(formatCallOutput(runManagedAdapterCommand(args), outputFormat ?? 'json')); return;
  }
  if (outputFormat !== undefined) {
    resolveOutputFormat(outputFormat);
    if (args[0] === 'list') return cmdList(args.slice(1), outputFormat);
    if (args[0] === 'info') {
      const adapters = await loadAdapterViews();
      const matches = adapters.filter(adapter => adapter.id === args[1]);
      if (matches.length !== 1) throw new Error('Adapter unavailable or ambiguous: ' + (args[1] || ''));
      console.log(formatCallOutput(matches[0], outputFormat)); return;
    }
    if (['help', '-help', '--help', '-h'].includes(args[0])) {
      console.log(formatCallOutput(await adapterHelpJson(), outputFormat)); return;
    }
    if (args[0] && (args.length === 1 || ['-help', '--help', '-h'].includes(args[1]))) {
      console.log(formatCallOutput(await adapterSiteHelpJson(args[0]), outputFormat)); return;
    }
    throw new Error('Explicit output formats are supported for Adapter list, info and help.');
  }
  const managed = runManagedAdapterCommand(args);
  if (managed) {
    console.log(JSON.stringify(managed, null, 2));
    return;
  }
  const subcommand = args[0];
  const isHelpFlag = (a) => a === "-help" || a === "--help" || a === "-h";

  switch (subcommand) {
    case "install":
      await cmdInstall(args.slice(1));
      break;
    case "list":
      await cmdList(args.slice(1));
      break;
    case "remove":
    case "uninstall":
      await cmdRemove(args.slice(1));
      break;
    case "refresh":
      await cmdRefresh();
      break;
    case "info":
      await cmdInfo(args.slice(1));
      break;
    case "skill":
      await cmdSkill(args.slice(1));
      break;
    case "knowledge":
      await cmdKnowledge(args.slice(1));
      break;
    case "skills-path":
      cmdSkillsPath();
      break;
    case "help":
    case "-help":
    case "--help":
    case "-h":
      // webcli adapter -help：显示 adapter 管理帮助（支持 -f json）
      if (args.includes("--json") || (args.includes("-f") && args[args.indexOf("-f") + 1] === "json")) {
        const data = await adapterHelpJson();
        console.log(JSON.stringify(data, null, 2));
      } else {
        await printHelp();
      }
      break;
    case "validate":
      await cmdValidate(args.slice(1));
      break;
    default:
      // webcli adapter <id> [-help]：显示该 adapter 提供的工具（支持 -f json）
      if (subcommand) {
        const idArg = args.find((a) => !a.startsWith("-"));
        const isIdHelp = isHelpFlag(args[1]) || (args.length === 1 && !isHelpFlag(subcommand));
        if (idArg && isIdHelp) {
          if (args.includes("--json") || (args.includes("-f") && args[args.indexOf("-f") + 1] === "json")) {
            const data = await adapterSiteHelpJson(idArg);
            console.log(JSON.stringify(data, null, 2));
          } else {
            const { runAdapterHelp } = await import('./progressive-help.js');
            console.log(await runAdapterHelp([idArg, 'help']));
          }
          break;
        }
      }
      await printHelp();
  }
}

async function printHelp() {
  const adapters = await loadAdapterViews().catch(() => []);
  const siteNames = adapters.map((a) => a.id).sort();
  const siteText = siteNames.length
    ? `Site adapters (${siteNames.length}): ${siteNames.join(", ")}`
    : "Site adapters (0): 未安装 adapter";
  console.log(`
WebCLI Adapter Manager

Usage:
  webcli adapter <command> [args] [options]

${siteText}

Commands:
  webcli adapter install --directory <dir>   Install a validated v2 package
  webcli adapter develop <dir>               Register a development package
  webcli adapter eject <id> --directory <new-dir>  Copy a built-in v2 package for editing
  webcli adapter use <id> <source>           Select builtin/user/development/disabled
  webcli adapter install --url <url>         Install from URL (https only)
  webcli adapter install --file <path>       Install from local file
  webcli adapter list                        List installed adapters
  webcli adapter list --json                 List adapters with tools (JSON)
  webcli adapter info <id>                   Show adapter tools
  webcli adapter status [id]                 Inspect active, disabled and invalid v2 packages
  webcli adapter verify <dir>                Static checks and historical evidence; --installed [id] selects installed packages
  webcli adapter source <repo> --ref <sha>    Discover committed v2 packages in a local Git repository
  webcli adapter install --git <repo> --ref <sha> --package <path> --digest <digest>  Install one reviewed snapshot
  webcli adapter validate <dir>              Validate package structure and JavaScript without executing it
  webcli adapter validate --installed [id]   Validate active v2 catalog packages
  webcli adapter skill <id>                  Print SKILL.md content
  webcli adapter skill <id> --generated      Print SKILL.generated.md content
  webcli adapter skill <id> --regenerate     Regenerate skill (generated adapters write SKILL.generated.md)
  webcli adapter skill <id> --regenerate --overwrite
                                             Regenerate and overwrite SKILL.md
  webcli adapter knowledge <id>              Print WEBCLI_KNOWLEDGE.md content
  webcli adapter knowledge <id> --json       Print WEBCLI_KNOWLEDGE.json content
  webcli adapter skills-path                 Print adapters directory path
  webcli adapter remove <id>                 Remove adapter
  webcli adapter refresh                     Force-refresh Hub registry cache

Options:
  --allow-downgrade          Explicitly allow a local package downgrade.
  --allow-permission-change Approve added permissions in a local package update.
  --change-source           Approve replacing another recorded source with local.
  --inactive                Install a local package without enabling it.
  --name <id>   Adapter id (used as directory name).
                Auto-inferred from --file when possible.
                Required for --url if hostname is not the desired id.
  --reload      Send reload signal to Chrome extension via the running service.
                Falls back to a manual reminder if service is not running.
  -f json       Structured help output (agent-friendly)

Agent tip: use 'webcli adapter <id> -help' to inspect one site.
           use 'webcli adapter <id> -help -f json' for structured tools.

Examples:
  webcli adapter install --file ~/projects/my-adapter.js --name my.site.com
  webcli adapter install --url https://cdn.example.com/oa.js --name company.oa --reload
  webcli adapter list --json
  webcli adapter skill mail.163.com
  webcli adapter knowledge meeting.example.com
  webcli adapter info mail.163.com
  webcli adapter remove mail.163.com --reload
`);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdInstall(args) {
  const reload = args.includes("--reload");
  const urlIdx = args.indexOf("--url");
  const fileIdx = args.indexOf("--file");
  const nameIdx = args.indexOf("--name");
  const explicitName = nameIdx !== -1 ? args[nameIdx + 1] : null;

  let adapterId, code;

  if (fileIdx !== -1) {
    // ── Source: local file ──
    const filePath = args[fileIdx + 1];
    if (!filePath) {
      die("--file requires a path argument");
    }
    const absPath = resolve(process.cwd(), filePath);
    if (!existsSync(absPath)) {
      die(`File not found: ${absPath}`);
    }
    adapterId = explicitName ?? inferIdFromPath(filePath);
    if (!adapterId) {
      die("Cannot infer adapter id from filename. Use --name <id> to specify.");
    }
    console.log(`Installing from local file: ${absPath}`);
    code = await readFile(absPath, "utf-8");

  } else if (urlIdx !== -1) {
    // ── Source: custom URL ──
    const url = args[urlIdx + 1];
    if (!url) {
      die("--url requires a URL argument");
    }
    // Only allow https:// — reject http, file, data, etc.
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { die(`Invalid URL: ${url}`); }
    if (parsedUrl.protocol !== "https:") {
      die(`Only https:// URLs are allowed for adapter installation (got "${parsedUrl.protocol}")`);
    }
    adapterId = explicitName ?? inferIdFromUrl(url);
    if (!adapterId) {
      die(
        `Cannot infer adapter id from URL "${url}". Use --name <id> to specify.`
      );
    }
    console.log(`Installing from URL: ${url}`);
    code = await fetchText(url);

  } else {
    // ── Source: Hub (CDN) ──
    adapterId = explicitName ?? args.find((a) => !a.startsWith("--"));
    if (!adapterId) {
      die("Adapter id required.\nUsage: webcli adapter install <id>");
    }
    await installFromHub(adapterId);
    // installFromHub writes the file itself; just handle --reload and return
    if (reload) {
      await reloadExtension();
    } else {
      console.log("→ Please reload the extension at chrome://extensions");
    }
    return;
  }

  await writeAdapter(adapterId, code);

  if (reload) {
    await reloadExtension();
  } else {
    console.log("→ Please reload the extension at chrome://extensions");
  }
}

async function loadLegacyExtensionAdapters(excluded = new Set(), namesOnly = false) {
  const result = [];
  for (const { id: directoryName, dir: adapterDir, source } of listAllAdapterDirs()) {
    if (excluded.has(directoryName)) continue;
    const manifestPath = join(adapterDir, "manifest.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
      if (manifest.schema_version === 2) continue;
      if (excluded.has(manifest.id)) continue;
      const tools = (await loadAdapterTools(directoryName, { adapterDir, namesOnly })).map((tool) => ({
        name: tool.name,
        description: tool.description,
        adapterId: tool.adapterId || manifest.id,
        routeDomain: tool.routeDomain,
        tabDomain: tool.tabDomain,
        excludeTabDomain: tool.excludeTabDomain,
        aliases: tool.aliases,
        execution: tool.execution,
        directCapable: tool.directCapable === true,
        executionMode: tool.executionMode,
        parameters: {
          type: "object",
          properties: tool.parameters?.properties || Object.fromEntries(
            (tool.params || []).map((parameter) => [parameter.name, {
              type: parameter.type,
              description: parameter.description,
            }]),
          ),
          required: tool.parameters?.required || (tool.params || [])
            .filter((parameter) => parameter.required)
            .map((parameter) => parameter.name),
        },
      }));
      result.push({ ...manifest, adapter_type: manifest.adapter_type || "extension", source, tools });
    } catch {
      // Existing Extension manifests remain best-effort for backward compatibility.
    }
  }
  return result;
}

export async function loadAdapterViews({ extensionOnly = false, namesOnly = false, snapshot = managedAdapterViews() } = {}) {
  const legacy = await loadLegacyExtensionAdapters(snapshot.managedNames, namesOnly);
  const toolkit = extensionOnly ? [] : loadToolkitAdapters({ ignoreInvalid: true }).map((adapter) => adapter.manifest);
  const managed = extensionOnly ? snapshot.adapters
    .filter((adapter) => adapter.tools.some((tool) => tool.runtime === 'extension'))
    .map((adapter) => ({ ...adapter, tools: adapter.tools.filter((tool) => tool.runtime === 'extension') })) : snapshot.adapters;
  return [...legacy, ...toolkit, ...managed];
}

export async function loadExtensionAdapters() {
  return loadAdapterViews({ extensionOnly: true });
}

export async function findExtensionTool(toolName) {
  const matches = [];
  for (const adapter of await loadExtensionAdapters()) {
    for (const tool of adapter.tools) {
      if (tool.name === toolName || tool.aliases?.includes(toolName)) matches.push({ adapter, tool });
    }
  }
  if (matches.length > 1) throw new Error(`Duplicate Extension tool registration: "${toolName}".`);
  return matches[0] || null;
}

async function cmdList(args, outputFormat) {
  const jsonMode = args.includes("--json");
  const result = await loadAdapterViews();
  const adapterIds = new Set();
  const toolNames = new Set();
  for (const adapter of result) {
    if (adapterIds.has(adapter.id)) throw new Error(`Duplicate Adapter registration: "${adapter.id}".`);
    adapterIds.add(adapter.id);
    for (const tool of adapter.tools) {
      if (toolNames.has(tool.name)) throw new Error(`Duplicate Adapter tool registration: "${tool.name}".`);
      toolNames.add(tool.name);
    }
  }

  if (jsonMode || outputFormat !== undefined) {
    console.log(formatCallOutput(result, outputFormat ?? 'json'));
    return;
  }
  if (result.length === 0) {
    console.log("No adapters installed.");
    return;
  }
  console.log("Installed adapters:");
  for (const adapter of result) {
    const tag = adapter.source === "user" ? " [user]" : "";
    console.log(`  - ${adapter.id}${tag} (${adapter.name || adapter.id}) [${adapter.adapter_type}]`);
  }
}

async function cmdValidate(args) {
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    die("Adapter directory required.\nUsage: webcli adapter validate <dir>\n规范：docs/adapter_package_spec.md");
  }
  const { validateV2AdapterDir } = await import("./adapter-package-v2.js");
  const root = resolve(process.cwd(), dir);
  if (!existsSync(root)) die(`Directory not found: ${root}`);
  try {
    const adapter = validateV2AdapterDir(root);
    console.log(`✓ Valid v2 adapter: ${adapter.name} (${adapter.manifest.version}, ${adapter.commands.length} cmd, runtime=[${[...new Set(adapter.commands.map((c) => c.runtime))].join(",")}])`);
  } catch (error) {
    die(`Validation failed: ${error.message}`);
  }
}

async function cmdInfo(args) {
  const adapterId = args.find((a) => !a.startsWith("--"));
  if (!adapterId) {
    die("Adapter id required.\nUsage: webcli adapter info <id>");
  }

  const managed = resolveManagedAdapterView(adapterId);
  if (managed) {
    if (args.includes('--json')) console.log(JSON.stringify(managed, null, 2));
    else {
      console.log(`Adapter: ${managed.id}\nType: ${managed.adapter_type}\nVersion: ${managed.version}\nSource: ${managed.source}\nDigest: ${managed.digest}\n`);
      console.log(`Tools (${managed.tools.length}):`);
      for (const tool of managed.tools) {
        console.log(`${tool.name} [${{ wewright: 'Toolkit', extension: 'Extension', http: 'HTTP' }[tool.runtime] || tool.runtime}] safety=${tool.safety}`);
        console.log(`  ${tool.description}`);
        if (tool.aliases.length) console.log('  Compatible names: ' + tool.aliases.join(', '));
        for (const param of tool.params) console.log(`  - ${param.name}: ${param.type}${param.required ? ' (required)' : ''}`);
      }
    }
    return;
  }
  const toolkitAdapter = findToolkitAdapter(adapterId);
  const adapterDir = findAdapterDir(adapterId);
  if (toolkitAdapter) {
    if (adapterDir) {
      throw new Error(`Duplicate Adapter registration: "${adapterId}".`);
    }
    console.log(`Adapter: ${adapterId}`);
    console.log("Type: toolkit");
    console.log(`Tools (${toolkitAdapter.tools.length}):\n`);
    for (const tool of toolkitAdapter.tools) {
      console.log(`  ${tool.name}`);
      if (tool.description) console.log(`    ${tool.description}`);
      for (const parameter of normalizeToolParamsForDisplay(tool)) {
        const req = parameter.required ? " (required)" : "";
        const enumText = parameter.enum?.length ? ` enum=${parameter.enum.join("|")}` : "";
        console.log(`    - ${parameter.name}: ${parameter.type}${req}${enumText}${parameter.description ? " — " + parameter.description : ""}`);
      }
      console.log();
    }
    return;
  }

  if (!adapterDir) {
    die(`Adapter "${adapterId}" is not installed.`);
  }

  const tools = await loadAdapterTools(adapterId);

  if (tools.length === 0) {
    console.log(`Adapter "${adapterId}" — no tools found.`);
    return;
  }

  console.log(`Adapter: ${adapterId}`);
  console.log(`Tools (${tools.length}):\n`);

  for (const t of tools) {
    console.log(`  ${t.name}`);
    if (t.directCapable === true || t.executionMode === "direct") {
      console.log("    execution: mode=direct");
    }
    if (t.execution?.type || t.execution?.runtime) {
      console.log(`    execution: type=${t.execution.type || "dom"}, runtime=${t.execution.runtime || "page"}`);
    }
    if (t.description) {
      console.log(`    ${t.description}`);
    }
    const params = normalizeToolParamsForDisplay(t);
    if (params.length > 0) {
      for (const p of params) {
        const req = p.required ? " (required)" : "";
        const enumText = p.enum?.length ? ` enum=${p.enum.join("|")}` : "";
        console.log(`    - ${p.name}: ${p.type}${req}${enumText}${p.description ? " — " + p.description : ""}`);
      }
    }
    console.log();
  }
}

async function cmdSkill(args) {
  const regenerate = args.includes("--regenerate") || args.includes("--regen");
  const generatedMode = args.includes("--generated");
  const overwrite = args.includes("--overwrite");
  const adapterId = args.find((a) => !a.startsWith("--"));
  if (!adapterId) {
    die("Adapter id required.\nUsage: webcli adapter skill <id> [--generated|--regenerate]");
  }

  const managed = resolveManagedAdapterView(adapterId);
  if (managed) {
    process.stdout.write(managedAdapterSkill(managed));
    return;
  }
  const toolkitAdapter = findToolkitAdapter(adapterId);
  const adapterDir = findAdapterDir(adapterId);
  if (toolkitAdapter) {
    if (adapterDir) {
      throw new Error(`Duplicate Adapter registration: "${adapterId}".`);
    }
    if (regenerate || generatedMode || overwrite) {
      die(`Toolkit Adapter "${adapterId}" 的 SKILL.md 由网站探索发布，不能通过 WebCLI 重新生成。`);
    }
    process.stdout.write(await readFile(join(toolkitAdapter.root, "SKILL.md"), "utf-8"));
    return;
  }

  const extensionAdapterDir = adapterDir || join(EXTENSION_ADAPTERS_DIR, adapterId);
  const skillPath = join(extensionAdapterDir, "SKILL.md");
  const generatedSkillPath = join(extensionAdapterDir, "SKILL.generated.md");
  const indexPath = join(extensionAdapterDir, "index.js");
  const manifestPath = join(extensionAdapterDir, "manifest.json");

  if (generatedMode) {
    if (!existsSync(generatedSkillPath)) {
      die(`SKILL.generated.md not found for adapter "${adapterId}".`);
    }
    const content = await readFile(generatedSkillPath, "utf-8");
    process.stdout.write(content);
    return;
  }

  if (regenerate) {
    // Regenerate skill from index.js + manifest.json. For generated modular
    // adapters, preserve hand-refined SKILL.md unless explicitly overwritten.
    if (!existsSync(indexPath)) {
      die(`Adapter "${adapterId}" has no index.js — cannot regenerate skill.`);
    }
    if (!existsSync(manifestPath)) {
      die(`Adapter "${adapterId}" has no manifest.json — cannot regenerate skill.`);
    }

    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    const tools = await loadAdapterTools(adapterId);
    const skillContent = generateSkillContent(manifest, tools);
    const outputPath = !overwrite && isGeneratedAdapterManifest(manifest) ? generatedSkillPath : skillPath;
    await writeFile(outputPath, skillContent, "utf-8");
    process.stderr.write(`Regenerated skill written to ${outputPath}\n`);
    process.stdout.write(skillContent);
    return;
  }

  // Default: just print existing SKILL.md
  if (!existsSync(skillPath)) {
    die(`SKILL.md not found for adapter "${adapterId}". Use --regenerate to generate one.`);
  }

  const content = await readFile(skillPath, "utf-8");
  process.stdout.write(content);
}

async function cmdKnowledge(args) {
  const jsonMode = args.includes("--json");
  const adapterId = args.find((a) => !a.startsWith("--"));
  if (!adapterId) {
    die("Adapter id required.\nUsage: webcli adapter knowledge <id> [--json]");
  }

  if (managedAdapterView(adapterId)) {
    throw new Error('Managed package guidance is derived from its manifest. Use webcli adapter skill ' + adapterId + '.');
  }

  const adapterDir = findAdapterDir(adapterId);
  if (!adapterDir) {
    die(`Adapter "${adapterId}" is not installed.`);
  }

  const filename = jsonMode ? "WEBCLI_KNOWLEDGE.json" : "WEBCLI_KNOWLEDGE.md";
  const filePath = join(adapterDir, filename);
  if (!existsSync(filePath)) {
    die(`${filename} not found for adapter "${adapterId}". Generate the adapter from extension exploration first.`);
  }

  const content = await readFile(filePath, "utf-8");
  process.stdout.write(content);
}

function cmdSkillsPath() {
  console.log(EXTENSION_ADAPTERS_DIR);
}

function isGeneratedAdapterManifest(manifest = {}) {
  return (Array.isArray(manifest.support_files) ? manifest.support_files : [])
    .some((item) => typeof item === "string" && item.includes("webcli-generated/"));
}

export async function loadAdapterTools(adapterId, options = {}) {
  if (!options.adapterDir) {
    const managed = resolveManagedAdapterView(adapterId);
    if (managed) return managed.tools;
  }
  const includeSupportFiles = options.includeSupportFiles !== false;
  const adapterDir = options.adapterDir || findAdapterDir(adapterId) || join(EXTENSION_ADAPTERS_DIR, adapterId);
  const indexPath = join(adapterDir, "index.js");
  const manifestPath = join(adapterDir, "manifest.json");
  const tools = [];
  let manifest = {};

  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    } catch {
      manifest = {};
    }
  }

  if (existsSync(indexPath)) {
    const source = await readFile(indexPath, "utf-8");
    tools.push(...parseToolsFromSource(source, manifest, { namesOnly: options.namesOnly }));
  }

  if (!includeSupportFiles || !existsSync(manifestPath)) {
    return applyDirectExecutionMetadata(dedupeToolsByName(tools), adapterDir, manifest);
  }

  for (const supportFile of manifest.support_files || []) {
    if (typeof supportFile !== "string") continue;
    if (!supportFile.includes("webcli-generated/tools/") || !supportFile.endsWith(".js")) continue;
    if (supportFile.includes("..") || supportFile.startsWith("/")) continue;
    const supportPath = join(adapterDir, supportFile);
    if (!existsSync(supportPath)) continue;
    const source = await readFile(supportPath, "utf-8");
    tools.push(...parseGeneratedToolsFromSource(source, { namesOnly: options.namesOnly }));
  }

  return applyDirectExecutionMetadata(dedupeToolsByName(tools), adapterDir, manifest);
}

async function applyDirectExecutionMetadata(tools, adapterDir, manifest = {}) {
  const catalogPath = join(adapterDir, "wecli.generated.json");
  const directNames = new Set();
  if (existsSync(catalogPath)) {
    try {
      const catalog = JSON.parse(await readFile(catalogPath, "utf-8"));
      for (const command of Array.isArray(catalog?.registeredCommands) ? catalog.registeredCommands : []) {
        if (!isCatalogApiBackgroundCommand(command)) continue;
        for (const name of [command.publicName, command.handlerName, ...(Array.isArray(command.aliases) ? command.aliases : [])]) {
          if (typeof name === "string" && name.trim()) directNames.add(name.trim());
        }
      }
    } catch {
      // Direct metadata is advisory; malformed catalogs must not hide tools.
    }
  }

  return tools.map((tool) => {
    const names = [tool.name, tool.canonicalName, tool.handlerName, ...(Array.isArray(tool.aliases) ? tool.aliases : [])];
    const manifestExecution = names
      .map((name) => manifest?.tool_execution?.[name])
      .find((execution) => execution && typeof execution === "object");
    const manifestDirect = isApiBackgroundExecution(manifestExecution);
    if (tool.directCapable === true || tool.executionMode === "direct" || manifestDirect) {
      return {
        ...tool,
        execution: manifestExecution || { ...API_BACKGROUND_EXECUTION },
        directCapable: true,
        executionMode: "direct",
      };
    }
    if (!names.some((name) => directNames.has(name))) return tool;
    return {
      ...tool,
      execution: { ...API_BACKGROUND_EXECUTION },
      directCapable: true,
      executionMode: "direct",
    };
  });
}

function dedupeToolsByName(tools) {
  const byName = new Map();
  for (const tool of tools) {
    if (!tool?.name || byName.has(tool.name)) continue;
    byName.set(tool.name, tool);
  }
  return [...byName.values()];
}

function normalizeToolParamsForDisplay(tool) {
  if (tool.parameters?.properties && typeof tool.parameters.properties === "object") {
    const required = new Set(Array.isArray(tool.parameters.required) ? tool.parameters.required : []);
    return Object.entries(tool.parameters.properties).map(([name, schema]) => ({
      name,
      type: Array.isArray(schema?.enum) ? "enum" : schema?.type || "string",
      description: schema?.description || "",
      required: required.has(name),
      enum: Array.isArray(schema?.enum) ? schema.enum.map(String) : [],
    }));
  }
  return tool.params || [];
}

function parseHiddenToolNamesFromSource(source) {
  const hidden = new Set();
  const setRe = /(?:apiReplacedDomTools|hiddenDomTools|disabledTools)\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/g;
  let setMatch;
  while ((setMatch = setRe.exec(source)) !== null) {
    const entries = setMatch[1];
    const nameRe = /['"`]([^'"`]+)['"`]/g;
    let nameMatch;
    while ((nameMatch = nameRe.exec(entries)) !== null) {
      hidden.add(nameMatch[1]);
    }
  }
  return hidden;
}

/**
 * Parse tool definitions from adapter source code (regex-based, no eval).
 */
export function parseToolsFromSource(source, manifest = {}, { namesOnly = false } = {}) {
  const tools = [];
  const hiddenToolNames = parseHiddenToolNamesFromSource(source);

  const registerMatch = source.match(/window\.__webmcpRegister\s*\(\s*\{/);
  if (!registerMatch) return tools;

  const afterRegister = source.slice(registerMatch.index);
  const toolsArrayMatch = afterRegister.match(/tools\s*:\s*\[/);
  if (!toolsArrayMatch) return tools;

  const toolsOpenIndex = registerMatch.index + toolsArrayMatch.index + toolsArrayMatch[0].lastIndexOf("[");
  const toolsCloseIndex = findMatchingDelimiter(source, toolsOpenIndex, "[", "]");
  const toolsArraySource = toolsCloseIndex === -1
    ? source.slice(toolsOpenIndex + 1)
    : source.slice(toolsOpenIndex + 1, toolsCloseIndex);
  const expandedToolsSource = expandSpreadToolArrays(source, toolsArraySource, registerMatch.index);

  const toolNameRe = /\{\s*\n?\s*name\s*:\s*['"`]([^'"`]+)['"`]/g;
  let match;

  // Collect all tool start positions
  const toolPositions = [];
  while ((match = toolNameRe.exec(expandedToolsSource)) !== null) {
    if (isTopLevelToolObjectStart(expandedToolsSource, match.index)) {
      toolPositions.push({ index: match.index, name: match[1] });
    }
  }

  for (let i = 0; i < toolPositions.length; i++) {
    const { index, name: rawName } = toolPositions[i];
    if (hiddenToolNames.has(rawName)) continue;
    // Limit block to the region before the next tool starts
    const end = i + 1 < toolPositions.length ? toolPositions[i + 1].index : expandedToolsSource.length;
    const block = expandedToolsSource.slice(index, end);

    if (namesOnly) {
      const name = staticCompletionName(block, 'publicName') || staticCompletionName(block, 'name');
      if (name) tools.push({ name, aliases: [...staticCompletionAliases(block), ...aliasesForCanonical(manifest, name)] });
      continue;
    }

    // Extract description
    let description = "";
    const descSingle = block.match(/description\s*:\s*\n?\s*'([^']*(?:'\s*\+\s*'[^']*)*)'/);
    const descDouble = block.match(/description\s*:\s*\n?\s*"([^"]*)"/);
    const descTmpl = block.match(/description\s*:\s*\n?\s*`([^`]*)`/);
    if (descSingle) description = descSingle[1].replace(/'\s*\+\s*'/g, "");
    else if (descDouble) description = descDouble[1];
    else if (descTmpl) description = descTmpl[1].replace(/\s+/g, " ").trim();

    // Extract parameters
    const params = parseParams(block);
    const publicName = parseStringField(block, "publicName") || rawName;
    const aliases = uniqueStrings([
      ...parseStringArrayField(block, "aliases"),
      ...aliasesForCanonical(manifest, publicName),
    ]);
    tools.push({
      name: publicName,
      canonicalName: publicName,
      handlerName: parseStringField(block, "handlerName") || rawName,
      adapterId: parseStringField(block, "adapterId") || manifest.id,
      routeDomain: parseStringField(block, "routeDomain") || parseStringField(block, "domain"),
      tabDomain: parseStringField(block, "tabDomain"),
      excludeTabDomain: parseStringField(block, "excludeTabDomain"),
      aliases,
      safety: parseStringField(block, "safety"),
      requiresConfirmation: parseBooleanField(block, "requiresConfirmation") || parseBooleanField(block, "x-webcli-requires-confirmation"),
      confirmationMessage: parseStringField(block, "confirmationMessage") || parseStringField(block, "x-webcli-confirmation-message"),
      description,
      params,
      parameters: parseParameterSchemaFromBlock(block, params),
    });
  }

  return tools;
}

function isTopLevelToolObjectStart(source, index) {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < index; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n" || ch === "\r") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === "'" || ch === "\"" || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
  }

  return !quote && !inLineComment && !inBlockComment && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0;
}

function expandSpreadToolArrays(source, toolsArraySource, maxDeclarationIndex) {
  return toolsArraySource.replace(/\.\.\.\s*([A-Za-z_$][\w$]*)/g, (spread, identifier) => {
    return findLocalArrayInitializer(source, identifier, maxDeclarationIndex) ?? spread;
  });
}

function findLocalArrayInitializer(source, identifier, maxDeclarationIndex) {
  const declarationRe = new RegExp(`(?:const|let|var)\\s+${escapeRegExp(identifier)}\\s*=\\s*\\[`, "g");
  let match;
  let selected = null;

  while ((match = declarationRe.exec(source)) !== null) {
    if (match.index > maxDeclarationIndex) break;
    selected = match;
  }

  if (!selected) return null;
  const openIndex = selected.index + selected[0].lastIndexOf("[");
  const closeIndex = findMatchingDelimiter(source, openIndex, "[", "]");
  if (closeIndex === -1) return null;
  return source.slice(openIndex + 1, closeIndex);
}

function findMatchingDelimiter(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n" || ch === "\r") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === "'" || ch === "\"" || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function staticCompletionName(objectSource, field) {
  // Only portable literal names at object depth zero. Never accept string
  // concatenation, template interpolation or a name inside a handler/schema.
  const body = objectSource.slice(objectSource.indexOf('{') + 1);
  const re = new RegExp(`(?:^|[,\\s])(?:${field}|["']${field}["'])\\s*:\\s*(["'\u0060])([A-Za-z0-9][A-Za-z0-9_.:-]*)\\1\\s*(?=[,}])`, 'g');
  let match;
  while ((match = re.exec(body))) {
    const index = match.index + (match[0][0] === ',' || /\s/.test(match[0][0]) ? 1 : 0);
    if (isTopLevelToolObjectStart(body, index)) return match[2];
  }
  return null;
}

function staticCompletionAliases(objectSource) {
  const body = objectSource.slice(objectSource.indexOf('{') + 1);
  const re = /(?:^|[,\s])(?:aliases|["']aliases["'])\s*:\s*\[([^\]]*)\]/g;
  let match;
  while ((match = re.exec(body))) {
    if (!isTopLevelToolObjectStart(body, match.index + 1)) continue;
    const items = match[1].split(',');
    if (!items.at(-1).trim()) items.pop();
    const literals = items.map(item => item.trim().match(/^(["'`])([A-Za-z0-9][A-Za-z0-9_.:-]*)\1$/));
    if (literals.every(Boolean)) return literals.map(item => item[2]);
  }
  return [];
}

function parseGeneratedToolsFromSource(source, { namesOnly = false } = {}) {
  const tools = [];
  const callRe = /registerTool\s*\(\s*[^,]+,\s*\{/g;
  let match;
  while ((match = callRe.exec(source)) !== null) {
    const objectStart = source.indexOf("{", match.index);
    const objectEnd = findMatchingDelimiter(source, objectStart, "{", "}");
    if (objectEnd <= objectStart) continue;
    const objectSource = source.slice(objectStart, objectEnd + 1);
    // Completion must never evaluate an author expression, including metadata
    // getters and parameter schemas. Dynamic registrations are not guessed.
    if (namesOnly) {
      const name = staticCompletionName(objectSource, 'name');
      if (name) tools.push({ name, aliases: staticCompletionAliases(objectSource) });
      continue;
    }
    const metadata = evaluateToolMetadataObject(objectSource);
    if (!metadata?.name) continue;
    tools.push({
      name: String(metadata.name),
      description: typeof metadata.description === "string" ? metadata.description : "",
      ...(typeof metadata.safety === "string" ? { safety: metadata.safety } : {}),
      ...((metadata.requiresConfirmation === true || metadata.parameters?.["x-webcli-requires-confirmation"] === true)
        ? { requiresConfirmation: true }
        : {}),
      ...(typeof metadata.confirmationMessage === "string"
        ? { confirmationMessage: metadata.confirmationMessage }
        : (typeof metadata.parameters?.["x-webcli-confirmation-message"] === "string"
          ? { confirmationMessage: metadata.parameters["x-webcli-confirmation-message"] }
          : {})),
      ...(metadata.execution && typeof metadata.execution === "object" ? { execution: metadata.execution } : {}),
      ...(metadata.directCapable === true ? { directCapable: true } : {}),
      ...(typeof metadata.executionMode === "string" ? { executionMode: metadata.executionMode } : {}),
      params: parametersSchemaToParams(metadata.parameters),
      parameters: sanitizeParametersSchema(metadata.parameters),
    });
  }
  return tools;
}

function evaluateToolMetadataObject(objectSource) {
  try {
    return vm.runInNewContext(`(${objectSource})`, Object.create(null), {
      timeout: 100,
      displayErrors: false,
    });
  } catch {
    return null;
  }
}

function sanitizeParametersSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((item) => typeof item === "string") : [];
  return {
    type: schema.type || "object",
    properties,
    required,
  };
}

function parametersSchemaToParams(schema) {
  const sanitized = sanitizeParametersSchema(schema);
  if (!sanitized) return [];
  const required = new Set(sanitized.required);
  return Object.entries(sanitized.properties || {}).map(([name, property]) => ({
    name,
    type: Array.isArray(property?.enum) ? "enum" : property?.type || "string",
    description: property?.description || "",
    required: required.has(name),
    enum: Array.isArray(property?.enum) ? property.enum.map(String) : [],
  }));
}

function parseStringField(block, fieldName) {
  const pattern = new RegExp(`(?:['"\`]?${escapeRegExp(fieldName)}['"\`]?\\s*:\\s*)(['"\`])([\\s\\S]*?)\\1`);
  const match = block.match(pattern);
  return match ? match[2].replace(/\s+/g, " ").trim() : undefined;
}

function parseStringArrayField(block, fieldName) {
  const pattern = new RegExp(`(?:['"\`]?${escapeRegExp(fieldName)}['"\`]?\\s*:\\s*)\\[([\\s\\S]*?)\\]`);
  const match = block.match(pattern);
  if (!match) return [];
  return [...match[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
}

function parseBooleanField(block, fieldName) {
  const pattern = new RegExp(`(?:['"\`]?${escapeRegExp(fieldName)}['"\`]?\\s*:\\s*)(true|false)`);
  const match = block.match(pattern);
  return match ? match[1] === "true" : false;
}

function aliasesForCanonical(manifest, canonicalName) {
  const aliases = manifest?.command_aliases || manifest?.commandAliases || {};
  return Object.entries(aliases)
    .filter(([, target]) => target === canonicalName)
    .map(([alias]) => alias);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseParameterSchemaFromBlock(block, params = []) {
  const match = block.match(/parameters\s*:\s*\{/);
  if (match) {
    const start = match.index + match[0].length - 1;
    const end = findMatchingDelimiter(block, start, "{", "}");
    if (end >= start) {
      try {
        const parsed = vm.runInNewContext(`(${block.slice(start, end + 1)})`, Object.create(null), { timeout: 100, displayErrors: false });
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return sanitizeParametersSchema(parsed);
      } catch {
        // Fall back to the regex-derived schema below for dynamic/legacy definitions.
      }
    }
  }
  const properties = Object.fromEntries(params.map((parameter) => [parameter.name, {
    type: parameter.type || "string",
    description: parameter.description || "",
  }]));
  return { type: "object", properties, required: params.filter((parameter) => parameter.required).map((parameter) => parameter.name) };
}

function parseParams(block) {
  const params = [];
  const propsMatch = block.match(/properties\s*:\s*\{/);
  if (!propsMatch) return params;

  // Find the closing brace of properties
  const start = propsMatch.index + propsMatch[0].length - 1;
  let depth = 0, end = start;
  for (let i = start; i < block.length; i++) {
    if (block[i] === "{") depth++;
    else if (block[i] === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const propsBlock = block.slice(start + 1, end - 1);

  // Extract each property
  const propRe = /(?:['"`]([^'"`]+)['"`]|([A-Za-z_$][\w$]*))\s*:\s*\{([^}]*)\}/g;
  let m;
  while ((m = propRe.exec(propsBlock)) !== null) {
    const propName = m[1] || m[2];
    const propBody = m[3];
    const typeMatch = propBody.match(/type\s*:\s*['"`](\w+)['"`]/);
    const descMatch = propBody.match(/description\s*:\s*['"`]([^'"`]*)['"`]/);
    params.push({
      name: propName,
      type: typeMatch ? typeMatch[1] : "string",
      description: descMatch ? descMatch[1] : "",
      required: false,
    });
  }

  // Mark required params
  const reqMatch = block.match(/required\s*:\s*\[([^\]]*)\]/);
  if (reqMatch) {
    const reqNames = reqMatch[1].split(",").map((s) => s.trim().replace(/^['"`]|['"`]$/g, "")).filter(Boolean);
    for (const p of params) {
      if (reqNames.includes(p.name)) p.required = true;
    }
  }

  return params;
}

/**
 * 判断某 adapter id 是否为内置 adapter（存在于打包的 extension/adapters/<id>/）。
 * @param {string} adapterId
 * @returns {Promise<boolean>}
 */
async function isBuiltinAdapter(adapterId) {
  return existsSync(join(EXTENSION_ADAPTERS_DIR, adapterId, "manifest.json"))
    || existsSync(join(EXTENSION_ADAPTERS_DIR, adapterId, "index.js"));
}

/**
 * 解析用户安装后的实际 id。
 * - 与内置同名：加 `.user` 后缀共存
 * - 与用户目录已存在的 id 同名：覆盖（视为更新）
 * @param {string} adapterId
 * @returns {Promise<string>}
 */
async function resolveInstallId(adapterId) {
  if (await isBuiltinAdapter(adapterId)) {
    const suffixed = `${adapterId}.user`;
    console.log(`⚠ Adapter "${adapterId}" 是内置 adapter，将以 "${suffixed}" 安装（后缀共存）`);
    return suffixed;
  }
  return adapterId;
}

/**
 * 返回所有 adapter 目录列表（内置 + 用户），每个条目带 source 标记。
 * @returns {Array<{id: string, dir: string, source: 'builtin'|'user'}>}
 */
function listAllAdapterDirs() {
  const result = [];
  for (const dir of [EXTENSION_ADAPTERS_DIR, USER_ADAPTERS_DIR]) {
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir)) {
      const manifestPath = join(dir, d, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      result.push({ id: d, dir: join(dir, d), source: dir === EXTENSION_ADAPTERS_DIR ? 'builtin' : 'user' });
    }
  }
  return result;
}

/**
 * 按 adapter id 查找 adapter 目录（内置优先，其次用户目录）。
 * @param {string} adapterId
 * @returns {string|null}
 */
function findAdapterDir(adapterId) {
  const matches = [];
  for (const dir of [EXTENSION_ADAPTERS_DIR, USER_ADAPTERS_DIR]) {
    if (existsSync(join(dir, adapterId, "manifest.json")) || existsSync(join(dir, adapterId, "index.js"))) {
      matches.push(join(dir, adapterId));
    }
  }
  if (matches.length > 1) {
    throw new Error(`Duplicate Extension Adapter registration: "${adapterId}".`);
  }
  return matches[0] || null;
}

async function cmdRemove(args) {
  const reload = args.includes("--reload");
  const adapterId = args.find((a) => !a.startsWith("--"));

  if (!adapterId) {
    die("Adapter id required.\nUsage: webcli adapter remove <id>");
  }

  const toolkitAdapter = findToolkitAdapter(adapterId);
  const adapterDir = findAdapterDir(adapterId);
  if (toolkitAdapter && adapterDir) {
    throw new Error(`Duplicate Adapter registration: "${adapterId}".`);
  }
  if (toolkitAdapter) {
    die(`Toolkit Adapter "${adapterId}" 由网站探索管理，不能通过 WebCLI 移除。`);
  }

  if (adapterDir === join(EXTENSION_ADAPTERS_DIR, adapterId)) {
    die(`Built-in Extension Adapter "${adapterId}" 不能通过 WebCLI 移除。`);
  }
  if (!adapterDir) {
    die(`Adapter "${adapterId}" is not installed.`);
  }

  rmSync(adapterDir, { recursive: true });
  console.log(`✓ Adapter removed: ${adapterId}`);

  if (reload) {
    await reloadExtension();
  } else {
    console.log("→ Please reload the extension at chrome://extensions");
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch a Hub adapter by id, verify against registry, write to extension/adapters/.
 */
async function installFromHub(adapterId) {
  // Verify adapter exists in registry
  try {
    const registry = await fetchJson(HUB_REGISTRY_URL);
    const meta = registry.adapters?.find((a) => a.id === adapterId);
    if (!meta) {
      const available = (registry.adapters ?? []).map((a) => `  - ${a.id} (${a.name})`).join("\n");
      die(`Adapter "${adapterId}" not found in Hub registry.\n\nAvailable adapters:\n${available}`);
    }
    console.log(`Installing "${adapterId}" (${meta.name}) from Hub...`);
  } catch (err) {
    if (err.message.startsWith("Adapter")) throw err; // re-throw our own errors
    console.warn(`Warning: could not fetch registry (${err.message}). Proceeding anyway...`);
    console.log(`Installing "${adapterId}" from Hub...`);
  }

  const hubUrl = `${HUB_ADAPTER_BASE_URL}/${adapterId}/index.js`;
  console.log(`  Source: ${hubUrl}`);
  const code = await fetchText(hubUrl);
  await writeAdapter(adapterId, code);
}

/**
 * Write adapter code to the user adapters directory (<userAdaptrsDir>/<id>/index.js).
 * - 与内置同名时自动加 `.user` 后缀共存
 * - 生成 manifest.json（若无）和 SKILL.md
 * - 用户目录可写，应用更新不会覆盖用户安装的 adapter
 */
async function writeAdapter(adapterId, code) {
  if (managedAdapterViews().managedNames.has(adapterId)) {
    throw new Error('This Adapter uses managed packages. Install its v2 package with --directory.');
  }
  const actualId = await resolveInstallId(adapterId);
  if (managedAdapterViews().managedNames.has(actualId)) throw new Error('Cannot overwrite a managed Adapter with a legacy file.');
  const adapterDir = join(USER_ADAPTERS_DIR, actualId);
  mkdirSync(adapterDir, { recursive: true });
  const destPath = join(adapterDir, "index.js");
  await writeFile(destPath, code, "utf-8");

  // Generate manifest.json if not already present
  const manifestPath = join(adapterDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    const manifest = {
      id: actualId,
      name: actualId,
      description: "",
      match: [actualId],
      requires_auth: false,
      version: "1.0.0",
      author: "unknown",
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  }

  // Generate SKILL.md from parsed tools
  const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  const tools = parseToolsFromSource(code, manifest);
  const skillContent = generateSkillContent(manifest, tools);
  await writeFile(join(adapterDir, "SKILL.md"), skillContent, "utf-8");

  console.log(`✓ Adapter installed: ${USER_ADAPTERS_DIR}/${actualId}/`);
}

/**
 * Force-clear the extension's registry cache and re-fetch from Hub.
 * Sends a refresh_registry message to the extension via the running service.
 */
async function cmdRefresh() {
  console.log("Refreshing Hub adapter registry...");
  return new Promise((resolve) => {
    const ws = new WebSocket(bridgeUrl(BRIDGE_INSTANCE));

    const timeout = setTimeout(() => {
      ws.terminate();
      console.warn(
        "Warning: WebCLI service is not running.\n" +
          "→ To refresh manually: reload the extension at chrome://extensions"
      );
      resolve();
    }, 3000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "refresh_registry" }));
      setTimeout(() => {
        clearTimeout(timeout);
        ws.close();
        console.log("✓ Refresh signal sent — extension will re-fetch registry shortly");
        resolve();
      }, 500);
    });

    ws.on("error", () => {
      clearTimeout(timeout);
      console.warn(
        "Warning: WebCLI service is not running.\n" +
          "→ To refresh manually: reload the extension at chrome://extensions"
      );
      resolve();
    });
  });
}

/**
 * Send a reload_extension message to the Chrome extension via the bridge.
 * Gracefully falls back to a manual reminder if service is not running.
 */
export async function reloadExtension({ quiet = false } = {}) {
  if (!quiet) process.stdout.write("Sending reload signal to Chrome extension... ");

  return new Promise((resolve) => {
    const ws = new WebSocket(bridgeUrl(BRIDGE_INSTANCE));

    const timeout = setTimeout(() => {
      ws.terminate();
      if (!quiet) console.log("");
      console.warn(
        "Warning: WebCLI service is not running.\n" +
          "→ Please reload the extension manually at chrome://extensions"
      );
      resolve(false);
    }, 3000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "reload_extension" }));
      setTimeout(() => {
        clearTimeout(timeout);
        ws.close();
        if (!quiet) {
          console.log("done");
          console.log("✓ Extension reloading...");
        }
        resolve(true);
      }, 500);
    });

    ws.on("error", () => {
      clearTimeout(timeout);
      if (!quiet) console.log("");
      console.warn(
        "Warning: WebCLI service is not running.\n" +
          "→ Please reload the extension manually at chrome://extensions"
      );
      resolve(false);
    });
  });
}

/**
 * Try to infer an adapter id from a URL.
 * e.g. "https://gitlab.company.com/adapters/oa.js" → null (ambiguous, user should specify --name)
 * e.g. "https://cdn.example.com/mail.163.com.js" → "mail.163.com"
 */
function inferIdFromUrl(url) {
  try {
    const u = new URL(url);
    const filename = u.pathname.split("/").pop();
    if (filename && filename.endsWith(".js")) {
      return filename.replace(/\.js$/, "");
    }
  } catch {}
  return null;
}

/**
 * Infer adapter id from a local file path.
 * e.g. "~/adapters/mail.163.com.js" → "mail.163.com"
 */
function inferIdFromPath(filePath) {
  const filename = filePath.split("/").pop();
  if (filename && filename.endsWith(".js")) {
    return filename.replace(/\.js$/, "");
  }
  return null;
}

/**
 * Fetch URL as text.
 * First tries native fetch (no proxy); on failure falls back to curl which
 * respects macOS/Linux system proxy settings and HTTPS_PROXY env vars.
 */
async function fetchText(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    return resp.text();
  } catch {
    return fetchViaCurl(url);
  }
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

async function fetchViaCurl(url) {
  try {
    // Use execFile (not exec) to pass url as a separate arg — avoids shell injection
    const { stdout } = await execFileAsync("curl", ["-sLf", "--max-time", "30", url]);
    return stdout;
  } catch (err) {
    throw new Error(
      `Network request failed: ${url}\n` +
      `  Node.js fetch and curl both failed. Common fixes:\n` +
      `  1. Set proxy env var:  export HTTPS_PROXY=http://127.0.0.1:<port>\n` +
      `  2. Or run curl manually to verify:  curl -v "${url}"\n` +
      `  curl error: ${err.stderr?.trim() || err.message}`
    );
  }
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}
