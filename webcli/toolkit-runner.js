import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { constants as osConstants } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { buildUploadConfig, reportMetric } from "./metrics.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export function toolkitRuntimeCandidates(baseDir = moduleDir, platform = process.platform) {
  const executable = platform === "win32" ? "Webwright.exe" : "Webwright";
  return [
    join(baseDir, "..", "webwright", executable),
    join(baseDir, "..", "webwright-dist", "dist", "Webwright", executable),
    join(baseDir, "..", "weworker", "build", "webwright-dist", "dist", "Webwright", executable),
  ];
}

export function resolveToolkitRuntime(options = {}) {
  const candidates = options.candidates || toolkitRuntimeCandidates(options.baseDir, options.platform);
  const runtime = candidates.find((candidate) => existsSync(candidate));
  if (runtime) return runtime;
  throw new Error(
    "Toolkit Runtime 不可用。当前 WebCLI 未包含 WeWorker 内嵌网站自动化运行环境，请在 WeWorker 开发态完成 build:webwright，或重新安装 WeWorker。",
  );
}

function toolkitEnvironment(source = process.env) {
  const env = { ...source };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  env.PYTHONNOUSERSITE = "1";
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.WEBWRIGHT_PARAMETERS_STDIN = "1";
  return env;
}

function exitCodeForSignal(signal) {
  return 128 + (osConstants.signals[signal] || 1);
}

async function webcliVersion() {
  try {
    return JSON.parse(await readFile(join(moduleDir, "package.json"), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

export async function runToolkitTool(match, parameters, options = {}) {
  const runtime = options.runtimePath || resolveToolkitRuntime(options);
  const traceID = options.traceID || randomUUID().replace(/-/g, "").slice(0, 12);
  const startedAt = Date.now();
  const runtimeArgs = options.runtimeArgs || [];
  const child = (options.spawn || spawn)(
    runtime,
    [...runtimeArgs, "--internal-script", match.adapter.entryPath, match.tool.id],
    {
      cwd: match.adapter.root,
      env: toolkitEnvironment(options.env || process.env),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stdout = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  const signals = ["SIGINT", "SIGTERM"];
  const signalHandlers = new Map(signals.map((signal) => [
    signal,
    () => {
      if (!child.killed) child.kill(signal);
    },
  ]));
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);

  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(parameters));
  const completed = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  });

  const stdoutText = Buffer.concat(stdout).toString("utf8");
  const lines = stdoutText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let result;
  try {
    result = JSON.parse(lines.at(-1) || "");
  } catch {
    throw new Error("Toolkit Adapter 未返回有效的 JSON 结果。");
  }
  const exitCode = completed.code ?? exitCodeForSignal(completed.signal);
  const ok = exitCode === 0;
  const metrics = options.metricsConfig || await buildUploadConfig({ webcliVersion: await webcliVersion() });
  reportMetric(
    metrics,
    match.tool.name,
    ok,
    Date.now() - startedAt,
    traceID,
    ok ? null : `Toolkit Adapter exited with code ${exitCode}`,
  );
  return { result, exitCode, traceID, signal: completed.signal || null };
}

export { toolkitEnvironment };
