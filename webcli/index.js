#!/usr/bin/env node
/**
 * WebCLI Adapter — CLI entry point
 *
 * Commands:
 *   webcli service start [-d]   Start WebSocket bridge (foreground or daemon)
 *   webcli service stop         Stop background service
 *   webcli service status       Show service status
 *   webcli service logs [-f]    View service logs
 *
 *   webcli browser <...>        WeWorker 浏览器 managed by the Bridge (status / show / hide / start / stop / restart / mode)
 *
 *   webcli adapter <...>        Manage adapters (install / list / remove / refresh)
 *   webcli adapterhub <...>     Browse and install AdapterHub packages
 *   webcli call <tool_name>     Call an adapter tool (for debugging)
 *   webcli extension-path       Print bundled extension directory
 *
 *   webcli --version            Show version
 *   webcli --help               Show help
 */

import { spawn } from "child_process";
import { openSync, existsSync, statSync, readSync, closeSync, realpathSync } from "fs";
import { mkdir, writeFile, readFile, unlink } from "fs/promises";
import { homedir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import { resolveToolCallTimeout } from "./tool-timeouts.js";
import { formatCallOutput, resolveOutputFormat } from "./output-format.js";
import { readBrowserMode } from "./dedicated-browser.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// CLI 进程启动时刻：随 call_tool 一起发给 bridge，用于把「内置 shell → CLI 启动」
// 与「bridge 派发」「扩展内部执行」分开观测（bridge 侧的调用分段日志）。
const CLI_STARTED_AT = Date.now();

const WS_PORT    = 3711;
const WEBCLI_DIR = join(homedir(), ".webcli");
const WEBMCP_DIR = join(homedir(), ".webmcp"); // backward compat

function getConfigDir() {
  if (existsSync(join(homedir(), ".webcli"))) return join(homedir(), ".webcli");
  if (existsSync(join(homedir(), ".webmcp"))) return join(homedir(), ".webmcp");
  return join(homedir(), ".webcli"); // new install default
}

const PID_FILE   = join(getConfigDir(), "service.pid");
const LOG_FILE   = join(getConfigDir(), "service.log");
const TRACE_LOG_READ_BYTES = 2 * 1024 * 1024;

// ─── Help & version ──────────────────────────────────────────────────────────

const HELP = `
webcli <command> [options]

Service:
  service start [-d, --daemon]   启动 WebSocket bridge（-d 后台运行）
  service stop                   停止后台服务
  service status                 查看服务状态
  service logs [-f, --follow]    查看服务日志

Browser（WeWorker 浏览器：Bridge 管理的独立 Chrome，窗口在屏幕外，不打扰你）:
  browser status [--json]        查看 WeWorker 浏览器状态
  browser show                   把窗口移到屏幕内（登录网站、查看页面）
  browser hide                   把窗口移回屏幕外
  browser start | stop | restart 启动 / 停止 / 重启（调用工具时会自动启动，空闲 30 分钟自动停止）
  browser mode [dedicated|system] 查看或切换模式：dedicated=WeWorker 浏览器（默认），system=我自己的 Chrome

Login（网站登录由 WeWorker 自动处理：命令遇到未登录时打开登录页、等待你完成、再自动重试）:
  login <网站> [--login-wait=<秒>]  主动登录（已登录则直接返回）；支持扫码、短信验证码或账号密码
  auth status [--json]           各网站登录状态与自动登录设置
  auth check <网站>              检查当前是否已登录
  auth save <网站>               保存账号密码并开启自动登录（需确认；Windows 系统密钥加密）
  auth autologin <网站> on|off   开启或暂停自动登录
  auth forget <网站>             删除保存的账号密码
  call ... --login-wait=<秒>     本次调用最多等待登录的时间（终端默认 300 秒，脚本/AI 默认 75 秒）

API exploration (standalone, no desktop/model key required):
  call exploration.help                    探索、草稿编辑、验证与安装命令
  call browser.help                        浏览器会话、页面操作与网络检查
  call profile.help                        多浏览器连接、别名与默认选择

Adapters:
  list                                     列出已安装的 adapter（adapter list 的简写）
  help                                     已安装 adapter 摘要（渐进式 help 第一级）
  <adapter> help                           单个 adapter 的命令列表（第二级）
  <adapter> <command> help                 单个命令参数说明（第三级）
  adapter validate <dir>                   校验 v2 adapter 包（结构+禁入文件，规范 docs/adapter_package_spec.md）
  adapter convention-audit <dir>           静态规范审计（不执行命令；--installed [id] 检查已安装包）
  adapter list                             列出已安装的 adapter
  adapter list --json                      JSON 格式输出（含工具定义）
  adapter info <id>                        查看 adapter 的工具列表
  adapter skill <id>                       输出 SKILL.md 内容
  adapter skill <id> --generated           输出 SKILL.generated.md 内容
  adapter skill <id> --regenerate          重新生成 skill（生成式 adapter 默认写 SKILL.generated.md）
  adapter skill <id> --regenerate --overwrite 覆盖写入 SKILL.md
  adapter knowledge <id>                   输出 WEBCLI_KNOWLEDGE.md 内容
  adapter knowledge <id> --json            输出 WEBCLI_KNOWLEDGE.json 内容
  adapter skills-path                      输出 adapters 目录路径
  adapter install --url <url> [--reload]   从 URL 安装（仅 https）
  adapter install --directory <dir>       安装解包后的 v2 目录
  adapter install --file <path.adapt>      安装 v2 归档（旧式 .js 仍兼容）
  adapter remove  <id>  [--reload]         移除 adapter

AdapterHub:
  adapterhub list [--origin official|user] [--installed] [--json]   列出线上 / 本地已安装 Adapter
  adapterhub find <keyword> [--json]                   按名称、域名、用途检索
  adapterhub info <adapter> [--json]                  查看 Adapter 详情（含推荐提示词）
  adapterhub versions <adapter> [--json]              查看版本历史
  adapterhub commands <adapter> [--json]              查看命令清单与参数
  adapterhub download <adapter>[@<版本>] [-o <file>] [--json]  下载 .adapt 包
  adapterhub validate <file.adapt>                    离线校验包结构与哈希
  adapterhub pack <目录> [-o <file.adapt>] [--json]   将目录打包为 .adapt
  adapterhub install <adapter>[@<版本>] | <本地.adapt> [--force] [--reload] [--json]
                                                       安装/升级整个 Adapter
  adapterhub update [<adapter>|--all] [--force] [--dry-run] [--json]
                                                       检查并更新已安装 Adapter
  adapterhub installed [--json]                       列出本地已安装 Adapter
  adapterhub remove <adapter> [--reload] [--json]     卸载 Adapter
  adapterhub publish <目录或.adapt> [--yes] [--json]  发布/更新 Adapter（需 ADAPTERHUB_TOKEN）
  adapterhub endpoint [--json]                        打印当前 AdapterHub 端点

Tools:
  skills list | skills read <skill[/path]>  列出或读取随包 Skill（不安装、不执行）
  completion bash|zsh|fish                 输出动态 shell 补全脚本（不修改 shell 配置）
  call <tool_name> [--key=value ...] [-v, --verbose] [--output-format=json|markdown|table|plain|csv|yaml]
                                  调用 Adapter 工具（Extension 自动启动 Bridge；Toolkit 直接运行）
                                  参数直接以 --key=value 形式传递：
                                    webcli call open_browser --url=http://jd.com
                                    webcli call jd.com.search_products --keyword=手机 --limit=5
                                  数组/对象用 JSON 字面量：
                                    webcli call tool --fields='{"标题":"xxx"}'
                                    webcli call tool --approvers='["zhangsan","lisi"]'
                                  同名 flag 重复出现会聚合成数组：
                                    webcli call tool --tags=web --tags=api
                                  兼容旧格式：--args '{"url":"http://jd.com"}'
                                  输出格式：终端默认 markdown（按站点列名映射渲染），管道/脚本默认 json；
                                  需要结构化数据时显式用 --output-format=json
  webcli <site> <command...> [--key=value ...] [-v, --verbose] [--output-format=json|markdown|table|plain|csv|yaml]
                                  按 WeCLI 风格调用 site.command 工具
  webcli <site> [-help] [-f json]
                                  查看某站点的全部工具（-f json 结构化输出）

Stats:
  stats                          各 domain 调用频次（本地），按次数倒序
  stats --by tool                按具体工具聚合
  stats --since 7d               近 7 天（支持 d/h/m，默认 30d）
  stats --kind adapter           只看 adapter（或 builtin）
  stats --top 10                 只展示 top N
  stats --json                   JSON 输出
  stats --remote                 查询服务端全团队汇总（需配置 WEBCLI_METRICS_ENDPOINT）

Skills:
  install --skills [adapter-id]          安装 skill 到 ~/.claude/skills/
  install --skills --target <dir>        安装 skill 到指定目录

Extension:
  extension-path                 输出扩展目录路径

Routing:
  route [<adapter>] <request>    用自然语言推荐命令（不执行）

Tracing:
  trace <traceID>                按 traceID 查询服务日志

Options:
  --version        显示版本（兼容：单独执行 webcli -v）
  --profile <id|alias>  选择浏览器（优先于 WEBCLI_PROFILE 和保存的默认值）
  -v, --verbose    调用工具时输出 trace 日志
  --output-format=json|markdown|table|plain|csv|yaml  调用工具输出格式（终端默认 markdown，管道/脚本默认 json）
  -h, --help       显示帮助
`.trim();

/**
 * 全局帮助：动态显示已安装站点列表 + Agent tip。
 * - 文本模式：HELP 顶部插入 Site adapters 列表
 * - JSON 模式（-f json）：输出结构化数据（agent 可解析）
 */
async function printGlobalHelp({ json = false, outputFormat } = {}) {
  let adapters = [];
  try {
    const { loadAdapterViews } = await import("./adapter-cli.js");
    adapters = await loadAdapterViews();
  } catch {
    adapters = [];
  }
  const sites = adapters
    .map((a) => ({ id: a.id, name: a.name || a.id }))
    .sort((x, y) => x.id.localeCompare(y.id));

  if (json || outputFormat !== undefined) {
    const data = {
      name: "webcli",
      usage: "webcli <command> [options]",
      description: "WeWorker 网站工具 CLI：调用浏览器站点自动化工具，管理适配器与统计",
      commands: [
        { name: "call <tool>", usage: "webcli call <tool_name> [--key=value ...]", description: "调用站点工具" },
        { name: "completion", usage: "webcli completion bash|zsh|fish", description: "输出 shell 补全脚本" },
        { name: "skills", usage: "webcli skills list | read <skill[/path]>", description: "读取随包 Skill 和参考文件" },
        { name: "profile", usage: "webcli call profile.help", description: "浏览器连接、别名和默认选择" },
        { name: "exploration", usage: "webcli call exploration.help", description: "独立 API 探索、Agent 草稿编辑、验证与本地安装" },
        { name: "adapter", usage: "webcli adapter <command>", description: "管理网站适配器" },
        { name: "service", usage: "webcli service <start|stop|status|logs>", description: "管理 WebSocket bridge 服务" },
        { name: "browser", usage: "webcli browser <status|show|hide|start|stop|restart|mode>", description: "管理 WeWorker 浏览器（需要登录时用 show 打开）" },
        { name: "login <site>", usage: "webcli login <site>", description: "主动登录网站（工具遇到未登录时也会自动发起）" },
        { name: "auth", usage: "webcli auth <status|check|save|forget|autologin>", description: "网站登录状态与自动登录" },
        { name: "stats", usage: "webcli stats", description: "调用频次统计" },
        { name: "install --skills", usage: "webcli install --skills [adapter-id]", description: "安装 adapter skills" },
        { name: "route", usage: "webcli route [<adapter>] <request>", description: "用自然语言推荐命令（不执行）" },
        { name: "trace <id>", usage: "webcli trace <traceID>", description: "按 traceID 查日志" },
        { name: "extension-path", usage: "webcli extension-path", description: "输出扩展目录路径" },
      ],
      site_adapters: {
        count: sites.length,
        sites,
      },
      next: [
        "webcli call <tool> --key=value ...",
        "webcli adapter -help",
        "webcli adapter <id> -help -f json",
      ],
    };
    console.log(formatCallOutput(data, outputFormat ?? 'json'));
    return;
  }

  const siteText = sites.length
    ? `Site adapters (${sites.length}): ${sites.map((s) => s.id).join(", ")}`
    : "Site adapters (0): 未安装 adapter";
  const agentTip = `
Agent tip: use 'webcli call <tool> --key=value ...' to invoke a tool.
           use 'webcli adapter -help' to manage adapters.
           use 'webcli adapter <id> -help -f json' for structured tools.
`;
  // wecli 风格：站点列表紧跟 Usage 行（HELP 首行），Agent tip 在末尾
  const helpLines = HELP.split("\n");
  const usageLine = helpLines[0]; // "webcli <command> [options]"
  const rest = helpLines.slice(1).join("\n");
  console.log(`${usageLine}\n\n${siteText}\n${rest}${agentTip}`);
}

async function printVersion() {
  if (typeof __WEBCLI_VERSION__ !== "undefined") {
    console.log(`webcli ${__WEBCLI_VERSION__}`);
    return;
  }
  try {
    const pkgPath = join(__dirname, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    console.log(`webcli ${pkg.version}`);
  } catch {
    console.log("webcli (unknown version)");
  }
}

// ─── Service helpers ──────────────────────────────────────────────────────────

async function checkPortListening() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
    const t = setTimeout(() => { ws.terminate(); resolve(false); }, 2000);
    ws.on("open",  () => { clearTimeout(t); ws.close(); resolve(true);  });
    ws.on("error", () => { clearTimeout(t);              resolve(false); });
  });
}

async function readPid() {
  try { return parseInt(await readFile(PID_FILE, "utf8"), 10); }
  catch { return null; }
}

function isPidRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function getServiceNodeArgs() {
  const args = [...process.execArgv];
  if (process.allowedNodeEnvironmentFlags?.has("--use-system-ca")
      && !args.includes("--use-system-ca")
      && !args.includes("--use-bundled-ca")
      && !args.includes("--use-openssl-ca")) {
    args.push("--use-system-ca");
  }
  args.push(__filename, "--service");
  return args;
}

// ─── Command: service start ──────────────────────────────────────────────────

async function cmdServiceStart(daemon, report = console.log) {
  if (daemon) {
    await mkdir(WEBCLI_DIR, { recursive: true });

    // Check if already running
    const existing = await readPid();
    if (existing && isPidRunning(existing)) {
      report(`WebCLI service is already running (PID: ${existing})`);
      return;
    }

    const logFd  = openSync(LOG_FILE, "a");
    const child  = spawn(process.execPath, getServiceNodeArgs(), {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    await writeFile(PID_FILE, String(child.pid));

    report(`✓ WebCLI service started in background (PID: ${child.pid})`);
    report(`  Logs:   ${LOG_FILE}`);
    report(`  Stop:   webcli service stop`);
    report(`  Status: webcli service status`);
  } else {
    // Foreground — hand off to service mode
    await runServiceMode();
  }
}

// ─── Command: service stop ───────────────────────────────────────────────────

async function cmdServiceStop() {
  const pid = await readPid();
  if (!pid) {
    console.log("WebCLI service is not running (no PID file found)");
    return;
  }
  if (!isPidRunning(pid)) {
    console.log(`PID ${pid} is no longer running — cleaning up stale PID file`);
    await unlink(PID_FILE).catch(() => {});
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    await unlink(PID_FILE).catch(() => {});
    console.log(`✓ WebCLI service stopped (PID: ${pid})`);
  } catch (e) {
    console.error(`Failed to stop service: ${e.message}`);
  }
}

// ─── Command: service status ─────────────────────────────────────────────────

async function cmdServiceStatus() {
  const listening = await checkPortListening();
  const pid = await readPid();
  const pidRunning = pid ? isPidRunning(pid) : false;

  if (listening) {
    const pidStr = pidRunning ? ` (PID: ${pid})` : "";
    console.log(`✓ WebCLI service is running on ws://localhost:${WS_PORT}${pidStr}`);
  } else {
    console.log("✗ WebCLI service is not running");
    if (pid && !pidRunning) {
      console.log("  (stale PID file found — run 'webcli service stop' to clean up)");
    }
    console.log("  Start with: webcli service start -d");
  }
}

// ─── Command: service logs ───────────────────────────────────────────────────

async function cmdServiceLogs(follow) {
  if (!existsSync(LOG_FILE)) {
    console.log(`No log file found at ${LOG_FILE}`);
    console.log("Start the service first: webcli service start -d");
    return;
  }
  if (follow) {
    const tail = spawn("tail", ["-f", LOG_FILE], { stdio: "inherit" });
    process.on("SIGINT", () => { tail.kill(); process.exit(0); });
    await new Promise(() => {}); // keep alive
  } else {
    process.stdout.write(await readFile(LOG_FILE, "utf8"));
  }
}

// ─── Service mode (WebSocket bridge only) ────────────────────────────────────

async function runServiceMode() {
  const { WebSocketBridge } = await import("./bridge.js");

  process.stderr.write("[WebCLI] Starting WebSocket bridge...\n");
  const bridge = new WebSocketBridge();

  // 初始化埋点上报配置（whoami / clientId / 版本号）；实时上报无需定时器。
  // 仅当 WEBCLI_METRICS_UPLOAD=on 且配置了 endpoint 才启用，失败一律静默。
  let version = "unknown";
  try { version = JSON.parse(await readFile(join(__dirname, "package.json"), "utf8")).version; } catch {}
  await bridge.init({ webcliVersion: version });

  await new Promise(resolve => setTimeout(resolve, 500));
  process.stderr.write(`[WebCLI] WebSocket server listening on ws://localhost:${WS_PORT}\n`);
  process.stderr.write("[WebCLI] Waiting for Chrome extension to connect...\n");

  setInterval(() => {
    process.stderr.write(`[WebCLI] Alive — extension ${bridge.isExtensionConnected() ? 'connected' : 'disconnected'}\n`);
  }, 60_000);

  // Close WeWorker 浏览器 cleanly where signals are delivered (POSIX, Ctrl+C).
  // A force-killed Bridge closes the browser's CDP pipe, and Chrome then exits by itself.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[WebCLI] ${signal} — stopping WeWorker browser\n`);
    const forceExit = setTimeout(() => process.exit(0), 8000);
    forceExit.unref?.();
    bridge.shutdownBrowser().catch(() => {}).finally(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

// ─── Command: browser <status|start|stop|show|hide|restart|mode> ─────────────

/** One fixed `browser_control` action against the running Bridge. */
function browserControl(action, extra = {}, timeoutMs = 45_000) {
  return bridgeControl("browser_control", action, extra, timeoutMs);
}

const BROWSER_STATE_TEXT = {
  running: "正在后台运行",
  starting: "正在启动",
  stopped: "未运行",
  profile_in_use: "配置正被另一个浏览器进程使用，稍后自动重试",
  unavailable: "无法启动",
  error: "多次启动失败",
};

function describeBrowserStatus(browser) {
  if (!browser) return "WeWorker 浏览器：未运行";
  if (browser.mode === "system") return "浏览器模式：我自己的 Chrome（不使用 WeWorker 浏览器）";
  const name = browser.browser ? `（${browser.browser}）` : "";
  const state = BROWSER_STATE_TEXT[browser.status] || browser.status;
  const extension = browser.status === "running" ? `，扩展${browser.extensionConnected ? "已连接" : "未连接"}` : "";
  return `WeWorker 浏览器${name}：${state}${extension}${browser.detail ? `；${browser.detail}` : ""}`;
}

async function cmdBrowser(sub, value, { json = false } = {}) {
  const { BROWSER_MODES, writeBrowserMode } = await import("./dedicated-browser.js");
  const print = (browser, text) => {
    if (json) console.log(JSON.stringify(browser ?? null, null, 2));
    else console.log(text ?? describeBrowserStatus(browser));
  };
  const fail = (error) => {
    if (json) console.log(JSON.stringify({ error: error.message, browser: error.browser ?? null }, null, 2));
    else console.error(`Error: ${error.message}`);
    process.exit(1);
  };
  const action = sub || "status";

  try {
    if (action === "mode") {
      if (!value) {
        const listening = await checkPortListening();
        const browser = listening ? await browserControl("status") : { ...readBrowserMode(), status: "stopped" };
        print(browser, `浏览器模式：${browser.mode}${browser.modeLocked || browser.locked ? "（由环境变量固定）" : ""}`);
        return;
      }
      if (!BROWSER_MODES.includes(value)) throw new Error(`未知模式：${value}（可选：${BROWSER_MODES.join(" / ")}）`);
      if (await checkPortListening()) {
        const browser = await browserControl("set_mode", { mode: value });
        print(browser, `✓ 浏览器模式已切换为 ${browser.mode}`);
      } else {
        if (readBrowserMode().locked) throw new Error("浏览器模式由环境变量 WEWORKER_BROWSER_MODE 固定，无法修改");
        print({ mode: writeBrowserMode(value) }, `✓ 浏览器模式已切换为 ${value}`);
      }
      return;
    }
    if (!["status", "start", "stop", "show", "hide", "restart"].includes(action)) {
      console.error(`Unknown browser subcommand: ${action}`);
      console.log("Available: status, start, stop, show, hide, restart, mode [dedicated|system]");
      process.exit(1);
    }
    // Reading, stopping or hiding never starts a Bridge.
    if (["status", "stop", "hide"].includes(action) && !(await checkPortListening())) {
      print({ ...readBrowserMode(), status: "stopped" });
      return;
    }
    if (["start", "show", "restart"].includes(action)) await ensureBridgeRunning();
    print(await browserControl(action));
  } catch (error) {
    fail(error);
  }
}

/** Best effort: let the Bridge close WeWorker 浏览器 before the service stops. */
async function stopBrowserBeforeService() {
  if (!(await checkPortListening())) return;
  try { await browserControl("stop", {}, 10_000); } catch { /* Older Bridge or already gone. */ }
}

// ─── Website login ───────────────────────────────────────────────────────────

/** A person at a terminal gets 5 minutes to sign in; scripts and agents 75 seconds (under a 2-minute tool timeout). */
function resolveLoginWaitMs(seconds) {
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(15 * 60, seconds)) * 1000;
  return process.stdin.isTTY && process.stderr.isTTY ? 300_000 : 75_000;
}

const AUTH_EVENT_TEXT = {
  waiting_user: (e) => `需要登录 ${e.name}：已在 WeWorker 浏览器中打开登录页（支持扫码、短信验证码或账号密码），登录完成后自动继续…${e.screenshot ? `\n  登录页截图（可用于扫码）：${e.screenshot}` : ""}`,
  autologin_started: (e) => `正在自动登录 ${e.name}…`,
  autologin_failed: (e) => `自动登录 ${e.name} 未成功：${e.message || "原因未知"}；请在浏览器中手动完成登录`,
  logged_in: (e) => `已登录 ${e.name}${e.autologin ? "（自动登录）" : ""}，继续执行`,
  cancelled: (e) => `已取消 ${e.name} 登录`,
  timeout: (e) => `${e.name} 登录等待超时`,
  failed: (e) => `无法打开 ${e.name} 登录页：${e.message || "原因未知"}`,
};

function printAuthEvent(event) {
  const text = AUTH_EVENT_TEXT[event.status]?.(event);
  if (text) process.stderr.write(`[WebCLI] ${text}\n`);
}

/** One fixed control action against the running Bridge (`browser_control` / `auth_control`). */
async function bridgeControl(type, action, extra = {}, timeoutMs = 45_000, onEvent = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
    const id = `cli-${type}-${Date.now()}`;
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("Bridge 未响应（可能是旧版本）")); }, timeoutMs);
    ws.on("open", () => ws.send(JSON.stringify({ type, id, action, ...extra })));
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "auth_event" && onEvent) { onEvent(msg); return; }
      if (msg.type !== `${type}_result` || msg.id !== id) return;
      clearTimeout(timer);
      ws.close();
      if (msg.ok) resolve(msg.result ?? msg.browser);
      else reject(Object.assign(new Error(msg.error || "操作失败"), { browser: msg.browser }));
    });
    ws.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function loadLoginSites() {
  const { describeAdapterCatalog } = await import("./adapter-host.js");
  return describeAdapterCatalog().adapters.filter((adapter) => adapter.auth);
}

async function requireLoginSite(site) {
  if (!site) throw new Error("请指定网站，例如 webcli login ctrip.com");
  const manifest = (await loadLoginSites()).find((adapter) => adapter.name === site);
  if (!manifest) throw new Error(`"${site}" 没有声明登录（manifest auth）；可用 webcli auth status 查看支持登录管理的网站`);
  return manifest;
}

const LOGIN_STATE_TEXT = { logged_in: "已登录", logged_out: "未登录", unknown: "未知" };

async function cmdLogin(site, { json = false, loginWaitSeconds, profile } = {}) {
  try {
    await requireLoginSite(site);
    await ensureBridgeRunning();
    const waitMs = resolveLoginWaitMs(loginWaitSeconds);
    const result = await bridgeControl("auth_control", "login", { site, waitMs, browserProfile: profile }, waitMs + 60_000, json ? null : printAuthEvent);
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (result.status === "already_logged_in") console.log(`✓ ${site} 已登录`);
    else if (result.status === "logged_in") console.log(`✓ ${site} 登录完成`);
    else if (result.status === "waiting_user") console.log(`登录页仍在 WeWorker 浏览器中等待；完成后无需再次运行此命令${result.screenshot ? `\n登录页截图：${result.screenshot}` : ""}`);
    else console.log(`${site} 登录未完成（${result.status}）`);
    if (!["already_logged_in", "logged_in", "waiting_user"].includes(result.status)) process.exitCode = 1;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

async function readVisibleLine(prompt) {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return await new Promise((resolve) => rl.question(prompt, resolve)); } finally { rl.close(); }
}

const AUTOLOGIN_NOTICE = [
  "开启「自动登录」后，该网站需要登录时，WeWorker 会在 WeWorker 浏览器中替你填写账号密码并点击登录。",
  "  · 密码用本机系统密钥（Windows DPAPI）加密保存在 ~/.weworker/browser/credentials/，只有本机当前用户能解密；",
  "  · WeWorker 的 AI、网站适配器和扩展都读不到明文密码，日志中也不会出现；",
  "  · 只在该网站声明的 HTTPS 登录页上填写；遇到验证码、短信、扫码或登录失败会交给你处理；",
  "  · 随时可用 webcli auth forget <网站> 删除，或 webcli auth autologin <网站> off 暂停。",
].join("\n");

async function cmdAuth(sub, rest = [], { json = false, profile } = {}) {
  const { CredentialVault } = await import("./credential-vault.js");
  const vault = new CredentialVault();
  const site = rest[0];
  try {
    if (!sub || sub === "status") {
      let status;
      if (await checkPortListening()) {
        status = await bridgeControl("auth_control", "status", { refresh: true, browserProfile: profile }, 60_000);
      } else {
        const sites = await loadLoginSites();
        status = {
          autologinSupported: vault.supported,
          sites: sites.map((manifest) => ({
            site: manifest.name, name: manifest.auth.display_name || manifest.i18n?.zh?.name || manifest.name,
            state: "unknown", autologin: { supported: vault.supported, ...vault.site(manifest.name) },
          })),
        };
      }
      if (json) { console.log(JSON.stringify(status, null, 2)); return; }
      for (const entry of status.sites) {
        const auto = entry.autologin?.enabled ? `自动登录：开（${entry.autologin.username}）` : entry.autologin?.configured ? "自动登录：已暂停" : "自动登录：关";
        console.log(`${entry.site.padEnd(18)} ${entry.name.padEnd(10)} ${(LOGIN_STATE_TEXT[entry.state] || entry.state).padEnd(4)} ${auto}${entry.flow ? `  登录中（${entry.flow}）` : ""}`);
      }
      if (!status.autologinSupported) console.log("\n当前系统暂不支持安全保存密码（目前支持 Windows），自动登录不可用。");
      return;
    }
    if (sub === "check") {
      await requireLoginSite(site);
      await ensureBridgeRunning();
      const result = await bridgeControl("auth_control", "check", { site, browserProfile: profile }, 60_000);
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(`${site}：${result.logged_in === true ? "已登录" : result.logged_in === false ? "未登录" : "无法确定"}（检查方式：${result.method}）`);
      return;
    }
    if (sub === "save") {
      await requireLoginSite(site);
      if (!vault.supported) throw new Error("当前系统暂不支持安全保存密码（目前支持 Windows）。");
      if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("保存密码需要在本机交互式终端中运行。");
      process.stderr.write(`${AUTOLOGIN_NOTICE}\n\n`);
      const confirm = (await readVisibleLine(`为 ${site} 保存账号密码并开启自动登录？[y/N] `)).trim().toLowerCase();
      if (confirm !== "y" && confirm !== "yes") { console.log("已取消，未保存任何内容。"); return; }
      const username = (await readVisibleLine("账号（手机号/邮箱/用户名）: ")).trim();
      const { readHiddenToken } = await import("./adapterhub-credentials.js");
      const password = await readHiddenToken("密码（输入不显示）: ");
      const saved = await vault.save(site, { username, password });
      console.log(`✓ 已为 ${site} 开启自动登录（${saved.username}）`);
      return;
    }
    if (sub === "forget") {
      await requireLoginSite(site);
      console.log(vault.remove(site) ? `✓ 已删除 ${site} 保存的账号密码` : `${site} 没有保存的账号密码`);
      return;
    }
    if (sub === "autologin") {
      await requireLoginSite(site);
      const value = rest[1];
      if (!["on", "off"].includes(value)) throw new Error("用法：webcli auth autologin <网站> on|off");
      if (value === "on" && !vault.hasCredential(site)) throw new Error(`请先运行 webcli auth save ${site} 保存账号密码`);
      vault.updateSite(site, { enabled: value === "on" });
      console.log(`✓ ${site} 自动登录已${value === "on" ? "开启" : "关闭"}`);
      return;
    }
    console.error(`Unknown auth subcommand: ${sub}`);
    console.log("Available: status, check <site>, save <site>, forget <site>, autologin <site> on|off");
    process.exit(1);
  } catch (error) {
    if (json) console.log(JSON.stringify({ error: error.message }, null, 2));
    else console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

function dedicatedBrowserHint() {
  // Read by the model too: desktop users open the browser from the app, not from a terminal.
  return readBrowserMode().mode === "dedicated"
    ? "；如需登录或查看页面，请打开 WeWorker 浏览器（WeWorker 桌面端：左侧栏底部的浏览器图标；命令行：webcli browser show）"
    : "";
}

// ─── Command: call <tool_name> ────────────────────────────────────────────────

async function ensureBridgeRunning() {
  const isRunning = await checkPortListening();
  if (isRunning) return;

  process.stderr.write("Bridge not running, starting...\n");
  await cmdServiceStart(true, message => process.stderr.write(message + '\n'));

  // Wait for Bridge to be ready (max 5s)
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await checkPortListening()) return;
  }
  console.error("Error: Bridge failed to start within 5 seconds");
  process.exit(1);
}

async function cmdCall(toolName, argsStr, options = {}) {
  const verbose = !!options.verbose;
  const flagArgs = options.flagArgs || {};
  let outputFormat;
  try {
    outputFormat = resolveOutputFormat(options.outputFormat);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  // markdown 输出时按工具名查「站点列名映射」（字段 → 中文列名，WECLI 沉淀层）；
  // 无映射的站点/命令渲染为全字段 table；JSON 保持全量
  let columnMapping;
  if (outputFormat === "markdown") {
    columnMapping = (await import("./column-mappings.js")).lookupColumnMapping(toolName);
  }
  if (isLegacyWecliHandlerName(toolName)) {
    console.error(`Error: "${toolName}" is an internal handler name. Use the public WebCLI command name without "wecli_".`);
    process.exit(1);
  }
  let args;
  try { args = parseArgsJson(argsStr); }
  catch (error) { console.error(`Error: ${error.message}`); process.exit(1); }
  // 合并 --key=value 标志参数（优先级低于 --args 中的同名字段）
  args = { ...flagArgs, ...args };
  // Management defaults remain machine-readable; explicit formats use the same
  // renderer as Adapter calls, without changing the transport envelope.
  const printManagement = value => console.log(formatCallOutput(value, options.outputFormat === undefined ? 'json' : outputFormat));

  if (toolName.startsWith('profile.')) {
    const command = toolName.slice('profile.'.length);
    const { profileHelp } = await import('./browser-profiles.js');
    if (command === 'help') { printManagement(profileHelp()); return; }
    await ensureBridgeRunning();
    const { callLocalCommand } = await import('./exploration-client.js');
    const result = await callLocalCommand('profile', command, args);
    printManagement(result); if (!result.ok) process.exitCode = 1; return;
  }
  if (toolName.startsWith('browser.')) {
    const command = toolName.slice('browser.'.length);
    const { browserCommands, browserHelp } = await import('./browser-commands.js');
    if (command === 'help') { printManagement(browserHelp()); return; }
    if (!Object.hasOwn(browserCommands, command)) {
      printManagement({ schemaVersion: 1, ok: false, error: { code: 'UNKNOWN_COMMAND', message: 'Use webcli call browser.help.' } });
      process.exitCode = 1; return;
    }
    if (['console', 'network'].includes(command) && (args.follow === true || args.follow === 'true')) {
      if (options.outputFormat !== undefined && outputFormat !== 'json') throw new Error('Browser follow uses JSON Lines; omit --output-format or use json.');
      await ensureBridgeRunning();
      const { runBrowserFollow } = await import('./browser-follow.js');
      process.exitCode = await runBrowserFollow(command, args, { profile: options.profile }); return;
    }
    await ensureBridgeRunning();
    if (['console', 'network'].includes(command) && (args.follow === false || args.follow === 'false')) delete args.follow;
    const { callLocalCommand } = await import('./exploration-client.js');
    const result = await callLocalCommand('browser', command, args, { timeoutMs: 50000, profile: options.profile });
    printManagement(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  // Reserved management namespace. It never resolves a website/Toolkit package.
  if (toolName.startsWith('exploration.')) {
    const command = toolName.slice('exploration.'.length);
    const { explorationCommands, explorationHelp } = await import('./exploration-commands.js');
    if (command === 'help') {
      printManagement(explorationHelp());
      return;
    }
    if (!Object.hasOwn(explorationCommands, command)) {
      printManagement({ schemaVersion: 1, ok: false, error: { code: 'UNKNOWN_COMMAND', message: 'Use webcli call exploration.help.' } });
      process.exitCode = 1;
      return;
    }
    await ensureBridgeRunning();
    const { callExploration } = await import('./exploration-client.js');
    const result = await callExploration(command, args, { profile: options.profile });
    printManagement(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const { resolveToolkitTool } = await import("./adapter-registry.js");
  const { resolveAdapterCall } = await import("./adapter-host.js");
  const v2Match = resolveAdapterCall(toolName);
  if (v2Match) {
    if ((v2Match.command.runtime === 'http' || v2Match.command.pageWrite || v2Match.command.uiWrite) && (v2Match.command.safety === 'write' || v2Match.command.requires_confirmation) && args.__confirmed !== true) {
      console.log(formatCallOutput({ error: 'Explicit confirmation is required for this command.', code: (v2Match.command.pageWrite || v2Match.command.uiWrite) ? 'CONFIRMATION_REQUIRED' : 'HTTP_CONFIRMATION_REQUIRED', trace_id: null }, outputFormat));
      process.exitCode = 1;
      return;
    }
    if ((v2Match.command.requires_confirmation ?? v2Match.command.safety === "write") && args.__confirmed !== true) throw new Error("Explicit confirmation is required for this command.");
    if (v2Match.command.runtime === 'http' && !v2Match.command.http.cookies) {
      try {
        const { runHttpTool } = await import('./http-runner.js');
        const completed = await runHttpTool(v2Match, args);
        const value = completed.result;
        const output = value && typeof value === 'object' && !Array.isArray(value)
          ? { ...value, trace_id: completed.traceID } : { result: value, trace_id: completed.traceID };
        console.log(formatCallOutput(output, outputFormat, { mapping: columnMapping }));
      } catch (error) {
        console.log(formatCallOutput({ error: error.message, code: error.code || 'HTTP_COMMAND_FAILED', trace_id: null }, outputFormat));
        process.exitCode = 1;
      }
      return;
    }
    if (v2Match.command.runtime === "wewright") {
      // v2 wewright 命令：内嵌 Runtime --internal-script，入口取 manifest module（现有合同不变）
      try {
        const { runToolkitTool } = await import("./toolkit-runner.js");
        const toolkitMatch = {
          adapter: { root: v2Match.adapter.root, entryPath: join(v2Match.adapter.root, v2Match.command.module) },
          tool: { id: v2Match.command.id, name: toolName },
        };
        const completed = await runToolkitTool(toolkitMatch, args);
        const isPlainObject = completed.result && typeof completed.result === "object" && !Array.isArray(completed.result);
        const output = isPlainObject
          ? { ...completed.result, trace_id: completed.traceID }
          : { result: completed.result, trace_id: completed.traceID };
        console.log(formatCallOutput(output, outputFormat, { mapping: columnMapping }));
        process.exit(completed.exitCode);
      } catch (error) {
        console.log(formatCallOutput({ error: error.message, trace_id: null }, outputFormat));
        process.exit(1);
      }
    }
    // v2 extension 命令：走 Bridge 转发，toolName = <name>.<command-id>（extension loader v2 负责注入）
  }
  const toolkitMatch = v2Match ? null : resolveToolkitTool(toolName);
  if (toolkitMatch) {
    const { findExtensionTool, loadExtensionAdapters } = await import("./adapter-cli.js");
    const extensionAdapters = await loadExtensionAdapters();
    if (extensionAdapters.some((adapter) => adapter.id === toolkitMatch.adapter.id)) {
      console.error(`Error: Duplicate Adapter registration: "${toolkitMatch.adapter.id}".`);
      process.exit(1);
    }
    if (await findExtensionTool(toolName)) {
      console.error(`Error: Duplicate Adapter tool registration: "${toolName}".`);
      process.exit(1);
    }
    try {
      const { runToolkitTool } = await import("./toolkit-runner.js");
      const completed = await runToolkitTool(toolkitMatch, args);
      const isPlainObject = completed.result && typeof completed.result === "object" && !Array.isArray(completed.result);
      const output = isPlainObject
        ? { ...completed.result, trace_id: completed.traceID }
        : { result: completed.result, trace_id: completed.traceID };
      console.log(formatCallOutput(output, outputFormat, { mapping: columnMapping }));
      process.exit(completed.exitCode);
    } catch (error) {
      console.log(formatCallOutput({ error: error.message, trace_id: null }, outputFormat));
      process.exit(1);
    }
  }

  await ensureBridgeRunning();

  const ws = new WebSocket(`ws://localhost:${WS_PORT}`);

  const callTimeoutMs = resolveToolCallTimeout(toolName);
  const loginWaitMs = resolveLoginWaitMs(options.loginWaitSeconds);
  const site = v2Match?.adapter?.name || "";

  const onTimeout = () => {
    console.log(formatCallOutput({ error: "工具调用超时", trace_id: null }, outputFormat));
    ws.terminate();
    process.exit(1);
  };
  let timeout = setTimeout(onTimeout, callTimeoutMs);

  ws.on("open", () => {
    const id = "cli-" + Date.now();
    const traceID = randomUUID().replace(/-/g, "").slice(0, 12);
    ws.send(JSON.stringify({
      type: "call_tool", toolName, args, id, traceID,
      browserProfile: options.profile,
      adapterSnapshot: v2Match?.snapshot,
      clientStartedAt: CLI_STARTED_AT,
      loginWaitMs,
    }));

    ws.on("message", async (data) => {
      const msg = JSON.parse(data.toString());
      // The Bridge runs the login flow for this site: report progress, and allow the login time.
      if (msg.type === "auth_event" && site && msg.site === site) {
        printAuthEvent(msg);
        if (msg.status === "login_required") {
          clearTimeout(timeout);
          timeout = setTimeout(onTimeout, loginWaitMs + callTimeoutMs + 10_000);
        }
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timeout);
      if (msg.contextId) options.profile = msg.contextId;
      if (msg.type === "call_tool_result") {
        const isPlainObject = msg.result && typeof msg.result === "object" && !Array.isArray(msg.result);
        const output = isPlainObject
          ? { ...msg.result, trace_id: traceID }
          : { result: msg.result, trace_id: traceID };
        console.log(formatCallOutput(output, outputFormat, { mapping: columnMapping }));
        await printVerboseTrace(traceID, verbose, options.profile);
        ws.close();
        process.exit(0);
      } else if (msg.type === "call_tool_error") {
        const output = {
          error: msg.error,
          ...(msg.code ? { code: msg.code } : {}),
          ...(msg.auth ? { auth: msg.auth } : {}),
          trace_id: traceID,
          hint: `用 webcli trace ${traceID} 查看完整链路日志${dedicatedBrowserHint()}`,
        };
        console.log(formatCallOutput(output, outputFormat));
        await printVerboseTrace(traceID, verbose, options.profile);
        ws.close();
        process.exit(1);
      }
    });
  });

  ws.on("error", () => {
    clearTimeout(timeout);
    console.log(formatCallOutput({ error: "无法连接到 WebSocket bridge，请先运行 webcli service start -d", trace_id: null }, outputFormat));
    process.exit(1);
  });
}

// ─── Command: trace <traceID> ─────────────────────────────────────────────────

async function printVerboseTrace(traceID, verbose, profile) {
  if (!verbose) return;
  process.stderr.write("\n");
  await cmdTrace(traceID, { stderr: true, profile });
}

async function cmdTrace(traceID, options = {}) {
  const write = options.stderr
    ? (line) => process.stderr.write(`${line}\n`)
    : (line) => console.log(line);
  let foundAny = false;

  // 1. 从 service.log 读取 Bridge 日志
  if (existsSync(LOG_FILE)) {
    const logContent = readRecentLogFile(LOG_FILE, TRACE_LOG_READ_BYTES);
    const lines = logContent.split("\n").filter(line => line.includes(`[${traceID}]`));
    if (lines.length > 0) {
      write("── Bridge 日志 ──");
      for (const line of lines) {
        write(line);
      }
      foundAny = true;
    }
  }

  // 2. 从 Chrome 扩展拉取 Service Worker + Content Script 日志
  const isBridgeRunning = await checkPortListening();
  if (isBridgeRunning) {
    const extLogs = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
      const timeout = setTimeout(() => {
        ws.terminate();
        resolve(null);
      }, 5000);

      ws.on("open", () => {
        const id = "trace-" + Date.now();
        ws.send(JSON.stringify({ type: "get_trace_logs", traceID, id, browserProfile: options.profile }));
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.id !== id) return;
          if (msg.type === 'call_tool_error') {
            clearTimeout(timeout); ws.close(); resolve({ error: { code: msg.code || 'TRACE_FAILED', message: msg.error } }); return;
          }
          if (msg.type !== "get_trace_logs_result") return;
          clearTimeout(timeout);
          ws.close();
          resolve(msg.logs || []);
        });
      });

      ws.on("error", () => {
        clearTimeout(timeout);
        resolve(null);
      });
    });

    if (extLogs?.error) { write(JSON.stringify({ ok: false, error: extLogs.error })); foundAny = true; if (!options.stderr) process.exitCode = 1; }
    if (Array.isArray(extLogs) && extLogs.length > 0) {
      write("── Extension 日志 ──");
      for (const line of extLogs) {
        write(line);
      }
      foundAny = true;
    }
  }

  if (!foundAny) {
    write(`未找到 traceID: ${traceID} 的日志`);
  }
}

function readRecentLogFile(filePath, maxBytes) {
  const stat = statSync(filePath);
  const size = Math.min(stat.size, maxBytes);
  const start = Math.max(0, stat.size - size);
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(size);
    readSync(fd, buffer, 0, size, start);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const BUILTIN_COMMANDS = new Set([
  "--version", "-v", "--help", "-h", "-help", "--service",
  "extension-path", "adapter", "service", "call", "route", "trace", "install",
  "list", "skills", "completion", "mcp", "mcp-logs", "browser", "login", "auth",
]);
// 渐进式 help 不拦截的顶层命令（其 <sub> help 属于自身命令域）
const BUILTIN_HELP_EXEMPT = new Set(["adapterhub", "stats"]);

function parseArgsJson(argsStr) {
  if (!argsStr) return {};
  try {
    return JSON.parse(argsStr);
  } catch {
    // JSON 解析失败，尝试 key=value 格式
    const parsed = parseArgsKeyValue(argsStr);
    if (parsed !== null) return parsed;
    throw new Error("--args 必须是有效的 JSON 或 key=value 格式（如 url=http://example.com keyword=test）");
  }
}

/**
 * 解析 key=value 格式参数字符串。
 * 规则：
 *   - 空格分隔多个参数
 *   - 值自动推断类型：纯数字 → number，true/false → boolean，其余 → string
 *   - 值可以用单引号或双引号包裹以包含空格：name="hello world" 或 name='hello world'
 *   - 解析失败返回 null
 */
function parseArgsKeyValue(argsStr) {
  const trimmed = argsStr.trim();
  if (!trimmed) return {};

  const result = {};
  // 使用状态机解析，支持引号包裹的值
  let i = 0;
  while (i < trimmed.length) {
    // 跳过前导空白
    while (i < trimmed.length && trimmed[i] === ' ') i++;
    if (i >= trimmed.length) break;

    // 读取 key
    const keyStart = i;
    while (i < trimmed.length && trimmed[i] !== '=') i++;
    if (i >= trimmed.length) return null; // 没有 = 号，不是合法的 key=value
    const key = trimmed.slice(keyStart, i).trim();
    if (!key) return null; // 空 key
    i++; // 跳过 =

    // 读取 value
    let value;
    if (i >= trimmed.length) {
      // key= 后面没有值，视为空字符串
      value = '';
    } else if (trimmed[i] === '"' || trimmed[i] === "'") {
      // 引号包裹的值
      const quote = trimmed[i];
      i++; // 跳过开头引号
      const valueStart = i;
      while (i < trimmed.length && trimmed[i] !== quote) i++;
      if (i >= trimmed.length) return null; // 未闭合的引号
      value = trimmed.slice(valueStart, i);
      i++; // 跳过结尾引号
    } else {
      // 无引号的值，读到空白为止
      const valueStart = i;
      while (i < trimmed.length && trimmed[i] !== ' ') i++;
      value = trimmed.slice(valueStart, i);
    }

    // 类型推断（只推断布尔；数字不推断，否则 string 参数如 --floor=11 会变成 number 报错）
    if (value === 'true') {
      result[key] = true;
    } else if (value === 'false') {
      result[key] = false;
    } else {
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function isLegacyWecliHandlerName(toolName) {
  return typeof toolName === "string" && /\.wecli_/.test(toolName);
}

function extractRuntimeFlags(args) {
  const rest = [];
  let verbose = false;
  let outputFormat;
  let loginWaitSeconds;
  let profile = process.env.WEBCLI_PROFILE;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      profile = arg === '--profile' ? args[++i] : arg.slice(10);
      if (!profile || profile.startsWith('--')) throw new Error('--profile requires a contextId or alias.');
      continue;
    }
    if (arg === "--verbose" || (arg === "-v" && !(i === 0 && args.length === 1))) {
      verbose = true;
      continue;
    }
    // 登录等待秒数（Bridge 打开登录页后最多等待用户完成登录的时间），不作为业务参数传给工具
    const loginWait = arg.match(/^--login-wait=(\d+)$/);
    if (loginWait) {
      loginWaitSeconds = Number(loginWait[1]);
      continue;
    }
    // 输出格式用 --output-format，避免与业务参数 --format（如发票下载 format=pdf）冲突
    if (arg === "--output-format") {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        outputFormat = next;
        i += 1;
      } else {
        outputFormat = "";
      }
      continue;
    }
    const formatMatch = arg.match(/^--output-format=(.*)$/);
    if (formatMatch) {
      outputFormat = formatMatch[1];
      continue;
    }
    rest.push(arg);
  }
  return {
    args: rest,
    verbose,
    outputFormat,
    ...(profile !== undefined ? { profile } : {}),
    ...(loginWaitSeconds !== undefined ? { loginWaitSeconds } : {}),
  };
}

function normalizeCliExecutionPath(filePath, realpath = realpathSync) {
  if (!filePath) return "";
  try {
    return resolve(realpath(filePath)).toLowerCase();
  } catch {
    return resolve(filePath).toLowerCase();
  }
}

function isDirectCliExecution(argvPath = process.argv[1], modulePath = __filename, realpath = realpathSync) {
  return Boolean(argvPath) && normalizeCliExecutionPath(argvPath, realpath) === normalizeCliExecutionPath(modulePath, realpath);
}

function inferType(value) {
  // 方案 A：值以 { 或 [ 开头时尝试 JSON.parse，支持嵌套对象和数组字面量
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "{" && last === "}") || (first === "[" && last === "]")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // 解析失败按普通字符串处理
    }
  }
  // 只推断布尔类型；数字不推断（扩展侧 normalizeToolArgsForSchema 会做 string→integer 转换，
  // 但 string 参数传数字会导致类型验证失败，如 --floor=11）
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

/**
 * 将值写入 args 对象。
 * 方案 C：同名 flag 多次出现时自动聚合成数组。
 */
function assignArg(args, key, value) {
  if (!(key in args)) {
    args[key] = value;
    return;
  }
  if (Array.isArray(args[key])) {
    args[key].push(value);
  } else {
    args[key] = [args[key], value];
  }
}

/**
 * 从 argv 数组中提取 --key=value 标志参数，返回 { args, rest }。
 * - --key=value 形式的参数被收集为 args 对象（方案 A：JSON 字面量自动解析）
 * - 同名 --key=value 多次出现时聚合成数组（方案 C）
 * - --args 'json' 形式的参数被解析合并
 * - 其他参数保留在 rest 中
 */
function extractFlagArgs(argv, startIndex = 0) {
  const args = {};
  const rest = [];
  for (let i = startIndex; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--args") {
      // 兼容旧格式：--args 'JSON'
      i++;
      if (i < argv.length) {
        const parsed = parseArgsJson(argv[i]);
        for (const [k, v] of Object.entries(parsed)) assignArg(args, k, v);
      }
      continue;
    }
    const flagMatch = arg.match(/^--([^=]+)=(.*)$/);
    if (flagMatch) {
      const [, key, value] = flagMatch;
      assignArg(args, key, inferType(value));
      continue;
    }
    rest.push(arg);
  }
  return { args, rest };
}

function resolveCliInvocation(args) {
  const cmd = args[0];
  if (cmd === "call") {
    if (['browser.console', 'browser.network'].includes(args[1])) args = args.map(arg => arg === '--follow' ? '--follow=true' : arg);
    const { args: flagArgs, rest } = extractFlagArgs(args, 2);
    const argsIdx = args.indexOf("--args");
    return {
      type: "call",
      toolName: rest[0] || args[1],
      argsJson: argsIdx !== -1 ? args[argsIdx + 1] : undefined,
      flagArgs,
    };
  }
  if (BUILTIN_COMMANDS.has(cmd)) {
    return { type: "builtin", command: cmd };
  }

  // shorthand: site command [--key=value | --args '...']
  const argsIdx = args.indexOf("--args");
  const { args: flagArgs, rest: commandTokens } = extractFlagArgs(args, 0);
  if (commandTokens.length < 2) {
    return { type: "unknown", command: cmd, flagArgs };
  }

  const [site, ...commandParts] = commandTokens;
  return {
    type: "shorthand",
    toolName: `${site}.${commandParts.join(" ")}`,
    argsJson: argsIdx !== -1 ? args[argsIdx + 1] : undefined,
    flagArgs,
  };
}

async function runProgressiveHelp(args, outputFormat) {
  const { runAdapterHelp } = await import('./progressive-help.js');
  console.log(await runAdapterHelp(args, { outputFormat }));
}

async function main() {
  // Route has its own natural-language argument parser, including a literal --.
  if (process.argv[2] === 'route') {
    const { runRouteCommand } = await import('./route-command.js');
    await runRouteCommand(process.argv.slice(3));
    return;
  }
  if (['completion', '--get-completions'].includes(process.argv[2])) {
    const { runCompletion } = await import('./completion.js');
    process.stdout.write(await runCompletion(process.argv.slice(2)));
    return;
  }
  const { args, verbose, outputFormat, profile, loginWaitSeconds } = extractRuntimeFlags(process.argv.slice(2));
  const cmd  = args[0];
  const sub  = args[1];
  if (cmd === 'route') {
    const { runRouteCommand } = await import('./route-command.js');
    await runRouteCommand(args.slice(1), { verbose, outputFormat });
    return;
  }
  if (cmd === 'skills') {
    const { runSkillsCli } = await import('./skills-cli.js');
    runSkillsCli(args.slice(1), { outputFormat }); return;
  }
  const invocation = resolveCliInvocation(args);

  if ((cmd === 'profile' && (sub === 'help' || args.some(arg => ['--help', '-h'].includes(arg))))
      || (cmd === 'call' && sub?.startsWith('profile.') && args.some(arg => ['--help', '-h'].includes(arg)))) {
    const { profileHelp } = await import('./browser-profiles.js');
    console.log(formatCallOutput(profileHelp(), outputFormat ?? 'json')); return;
  }
  if ((cmd === 'browser' && (sub === 'help' || args.some(arg => ['--help', '-h'].includes(arg))))
      || (cmd === 'call' && sub?.startsWith('browser.') && args.some(arg => ['--help', '-h'].includes(arg)))) {
    const { browserHelp } = await import('./browser-commands.js');
    console.log(formatCallOutput(browserHelp(), outputFormat ?? 'json')); return;
  }

  if ((cmd === 'exploration' && (sub === 'help' || args.some(arg => ['--help', '-h'].includes(arg))))
      || (cmd === 'call' && sub?.startsWith('exploration.') && args.some(arg => ['--help', '-h'].includes(arg)))) {
    const { explorationHelp } = await import('./exploration-commands.js');
    console.log(formatCallOutput(explorationHelp(), outputFormat ?? 'json'));
    return;
  }

  // --version / -v
  if (cmd === "--version" || cmd === "-v") {
    await printVersion();
    return;
  }

  // --help / -h / -help / no command
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "-help") {
    const jsonMode = args.includes("--json") || (args.includes("-f") && args[args.indexOf("-f") + 1] === "json");
    await printGlobalHelp({ json: jsonMode, outputFormat });
    return;
  }

  // extension-path
  if (cmd === "extension-path") {
    const { resolveExtensionDir } = await import("./paths.js");
    console.log(resolveExtensionDir());
    return;
  }

  // Internal one-shot AI transport. Model SDK/TLS/native failures are isolated
  // in this subprocess so they cannot terminate the long-lived Bridge.
  if (cmd === "internal-ai-call") {
    const { runAiCallWorker } = await import("./ai-worker.js");
    await runAiCallWorker();
    return;
  }

  if (cmd === "internal-ai-session") {
    const { runAiSessionWorker } = await import("./ai-worker.js");
    await runAiSessionWorker();
    return;
  }

  // Internal one-run Harness worker. The full generation and publishing
  // lifecycle lives here so a native/V8 failure cannot terminate the Bridge.
  if (cmd === "internal-generation-worker") {
    const { runGenerationWorker } = await import("./generation-worker.js");
    await runGenerationWorker();
    return;
  }

  // adapter <...>
  if (cmd === "adapter") {
    const { runAdapterCli } = await import("./adapter-cli.js");
    await runAdapterCli(args.slice(1), { outputFormat });
    return;
  }

  // list —— adapter list 的简写（对齐 wecli 的 `wecli list` 心智）
  if (cmd === "list") {
    const { runAdapterCli } = await import("./adapter-cli.js");
    await runAdapterCli(["list", ...args.slice(1)], { outputFormat });
    return;
  }

  // adapterhub <...>
  if (cmd === "adapterhub") {
    const { runAdapterHubCli } = await import("./adapterhub-cli.js");
    await runAdapterHubCli(args.slice(1), { outputFormat });
    return;
  }

  // service <start|stop|status|logs>
  if (cmd === "service") {
    if (!sub || sub === "start") {
      const daemon = args.includes("-d") || args.includes("--daemon");
      await cmdServiceStart(daemon);
    } else if (sub === "stop") {
      await stopBrowserBeforeService();
      await cmdServiceStop();
    } else if (sub === "status") {
      await cmdServiceStatus();
    } else if (sub === "logs") {
      const follow = args.includes("-f") || args.includes("--follow");
      await cmdServiceLogs(follow);
    } else {
      console.error(`Unknown service subcommand: ${sub}`);
      console.log('Available: start, stop, status, logs');
      process.exit(1);
    }
    return;
  }

  // browser <status|start|stop|show|hide|restart|mode [dedicated|system]> [--json]
  if (cmd === "browser") {
    const positional = args.slice(1).filter((item) => !item.startsWith("-"));
    await cmdBrowser(positional[0], positional[1], { json: args.includes("--json") });
    return;
  }

  // call <tool_name> [--key=value ...] [--args '{}']
  if (cmd === "call") {
    if (args.slice(2).some(arg => ['-h', '--help', '-help'].includes(arg))) {
      const split = (args[1] || '').lastIndexOf('.');
      if (split < 1) throw new Error('Use webcli call <adapter>.<command> --help');
      await runProgressiveHelp([args[1].slice(0, split), args[1].slice(split + 1), 'help'], outputFormat ?? (args.includes('--json') || (args.includes('-f') && args[args.indexOf('-f') + 1] === 'json') ? 'json' : undefined));
      return;
    }

    const { toolName, argsJson, flagArgs } = resolveCliInvocation(args);
    if (!toolName) {
      console.error("Error: 请指定工具名称");
      console.error("Usage: webcli call <tool_name> [--key=value ...]");
      process.exit(1);
    }
    await cmdCall(toolName, argsJson, { verbose, flagArgs, outputFormat, profile, loginWaitSeconds });
    return;
  }

  // login <site> [--login-wait=<秒>]
  if (cmd === "login") {
    await cmdLogin(sub, { json: args.includes("--json"), loginWaitSeconds, profile });
    return;
  }

  // auth <status|check|save|forget|autologin> ...
  if (cmd === "auth") {
    const positional = args.slice(1).filter((item) => !item.startsWith("-"));
    await cmdAuth(positional[0], positional.slice(1), { json: args.includes("--json"), profile });
    return;
  }

  // stats [--by tool] [--since 7d] [--kind adapter] [--top N] [--json] [--remote]
  if (cmd === "stats") {
    const { runStats } = await import("./stats.js");
    await runStats(args.slice(1));
    return;
  }

  // trace <traceID>
  if (cmd === "trace") {    const traceID = args[1];
    if (!traceID) {
      console.error("Error: 请指定 traceID");
      console.error("Usage: webcli trace <traceID>");
      process.exit(1);
    }
    await cmdTrace(traceID, { profile });
    return;
  }

  // install --skills [adapter-id] [--target <dir>]
  if (cmd === "install" && args.includes("--skills")) {
    const { installSkills } = await import("./skill-installer.js");
    const targetIdx = args.indexOf("--target");
    const target = targetIdx !== -1 ? args[targetIdx + 1] : join(homedir(), ".claude", "skills");
    const adapterId = args.find((a, i) => i > 0 && !a.startsWith("--") && i !== targetIdx + 1) || null;
    const { installed, total, retired = 0, preserved = [] } = await installSkills({ target, adapterId });
    if (preserved.length) console.log(`Preserved user-owned or edited Skills: ${preserved.join(", ")}`);
    if (retired) console.log(`Marked ${retired} unavailable Adapter Skills inactive.`);
    if (adapterId) {
      console.log(installed ? `Installed skill for "${adapterId}" to ${target}` : `No active Skill installed for "${adapterId}".`);
    } else {
      console.log(`Installed ${installed} adapter skills (of ${total} adapters) + base webcli skill to ${target}`);
    }
    return;
  }

  // mcp — deprecated, MCP server has been removed
  if (cmd === "mcp") {
    console.error("Error: MCP 服务器已被移除。");
    console.error("请使用 WeWorker 桌面应用作为 AI 工具调用入口。");
    console.error("详情请访问: https://weworker.dev");
    process.exit(1);
  }

  // mcp-logs — deprecated, MCP logging removed
  if (cmd === "mcp-logs") {
    console.error("MCP 日志功能已随 MCP 服务器一起移除。");
    process.exit(1);
  }

  // --service (internal flag used by daemon spawn)
  if (cmd === "--service") {
    process.on("uncaughtException",  e => process.stderr.write(`[WebCLI] ${e.message}\n`));
    process.on("unhandledRejection", r => process.stderr.write(`[WebCLI] ${r}\n`));
    await runServiceMode();
    return;
  }

  // 渐进式 help：webcli help / webcli <adapter> help / webcli <adapter> <command> help
  const isHelpRequest =
    (cmd === "help" && args.length === 1) ||
    (sub === "help" && args.length === 2) ||
    (args[2] === "help" && args.length === 3);
  if (isHelpRequest && !BUILTIN_COMMANDS.has(cmd) && !BUILTIN_HELP_EXEMPT.has(cmd)) {
    await runProgressiveHelp(args, outputFormat);
    return;
  }

  // 站点级 help：webcli <site> [-help|--help|-h] [-f json]
  // （对齐 wecli 的 `wecli <site> --help` 心智；也拦截 `webcli <site> <cmd> --help`，
  //   避免其被当作无参工具调用）
  const SITE_HELP_FLAGS = new Set(["-help", "--help", "-h"]);
  if (!BUILTIN_COMMANDS.has(cmd) && args.slice(1).some((a) => SITE_HELP_FLAGS.has(a))) {
    const jsonMode = args.includes("--json") || (args.includes("-f") && args[args.indexOf("-f") + 1] === "json");
    const { runAdapterCli } = await import("./adapter-cli.js");
    const command = args[1] && !args[1].startsWith('-') ? args[1] : null;
    if (command) await runProgressiveHelp([cmd, command, 'help'], outputFormat ?? (jsonMode || args.includes('--json') ? 'json' : undefined));
    else await runAdapterCli([cmd, "-help", ...(jsonMode ? ["-f", "json"] : [])], { outputFormat });
    return;
  }

  if (invocation.type === "shorthand") {
    await cmdCall(invocation.toolName, invocation.argsJson, { verbose, flagArgs: invocation.flagArgs || {}, outputFormat, loginWaitSeconds });
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  console.log('Run "webcli --help" for usage.');
  process.exit(1);
}

const isDirectExecution = isDirectCliExecution();
if (isDirectExecution) {
  main().catch(e => {
    process.stderr.write(`[WebCLI] Fatal: ${e.message}\n`);
    process.exitCode = 1;
  });
}

export { getConfigDir, cmdCall, parseArgsJson, parseArgsKeyValue, inferType, assignArg, extractFlagArgs, resolveCliInvocation, extractRuntimeFlags, isDirectCliExecution };
