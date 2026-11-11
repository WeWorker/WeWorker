/**
 * Windows daemon detach via Task Scheduler (schtasks).
 *
 * Node's `spawn(..., { detached: true })` only sets DETACHED_PROCESS on Windows —
 * it does NOT request CREATE_BREAKAWAY_FROM_JOB, so the daemon stays inside the
 * parent's Job Object / process tree and is killed when the launching command
 * exits (e.g. inside WorkBuddy). Launching through the Task Scheduler service
 * instead makes the daemon belong to the Scheduler, not the caller, so it survives.
 */
import { spawn } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import path from "path";

export function quoteCmd(arg) {
  const s = String(arg);
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

export function buildSchtasksArgs({ taskName, scriptPath }) {
  return {
    create: ["schtasks", "/create", "/tn", taskName, "/tr", `"${scriptPath}"`, "/sc", "once", "/st", "00:00", "/f"],
    run: ["schtasks", "/run", "/tn", taskName],
    delete: ["schtasks", "/delete", "/tn", taskName, "/f"],
  };
}

export function buildDaemonLaunchScript({ nodeExe, serviceArgs, logFile, env = {} }) {
  const setLines = Object.entries(env).map(([k, v]) => `set "${k}=${v}"`).join("\r\n");
  const cmd = [nodeExe, ...serviceArgs].map(quoteCmd).join(" ");
  return `@echo off\r\n${setLines ? setLines + "\r\n" : ""}${cmd} >> "${logFile}" 2>&1\r\n`;
}

function run(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${argv[0]} 退出码 ${code}`))));
  });
}

/**
 * Launch the daemon detached from the caller's Job Object.
 * @param {{nodeExe:string, serviceArgs:string[], logFile:string, stateDir:string, env?:object}} opts
 * @returns {Promise<void>} resolves once schtasks has been told to run (async); the
 *   caller must poll the daemon's PID file / port for actual readiness.
 */
export async function launchDetachedWindows({ nodeExe, serviceArgs, logFile, stateDir, env = {} }) {
  const taskName = `weworker-webcli-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const scriptPath = path.join(stateDir, `${taskName}.cmd`);
  await writeFile(scriptPath, buildDaemonLaunchScript({ nodeExe, serviceArgs, logFile, env }));
  const args = buildSchtasksArgs({ taskName, scriptPath });
  try {
    await run(args.create);
    await run(args.run);
  } finally {
    await run(args.delete).catch(() => {});
    // 任务由调度器异步启动:立即 unlink 会在任务读到 .cmd 前删掉它。延迟到启动窗口后清理。
    setTimeout(() => unlink(scriptPath).catch(() => {}), 30_000).unref?.();
  }
}
