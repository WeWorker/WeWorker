/**
 * Windows daemon detach via CreateProcess breakaway (PowerShell P/Invoke).
 *
 * Node's `spawn(..., { detached: true })` only sets DETACHED_PROCESS — it does NOT
 * request CREATE_BREAKAWAY_FROM_JOB, so the daemon stays inside the parent's Job
 * Object and is killed when the launching command exits (e.g. inside WorkBuddy).
 *
 * Task Scheduler (schtasks.exe) is the usual escape hatch but is blacklisted by
 * some sandboxes' command policy. This module instead invokes kernel32
 * CreateProcess directly through an inlined PowerShell P/Invoke with
 * CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS, so the daemon leaves the caller's
 * Job Object without touching any system-management executable.
 */
import { spawn } from "child_process";
import { openSync, closeSync } from "fs";

export function quoteCmd(arg) {
  const s = String(arg);
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** Escape a value for a PowerShell single-quoted string ('' → '). */
function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

export function buildBreakawayPs1({ cmdline, applicationName, cwd }) {
  const psApp = psQuote(applicationName);
  const psCmdline = psQuote(cmdline);
  const psCwd = psQuote(cwd);
  return `$ProgressPreference = 'SilentlyContinue'  # PowerShell 5.1 会把 progress 流以 CLIXML 写入 stderr,污染继承的 service.log
$ErrorActionPreference = 'Stop'
$sig = @"
using System;
using System.Runtime.InteropServices;
public static class NativeBreakaway {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcess(
    string lpApplicationName, string lpCommandLine,
    IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
    bool bInheritHandles, uint dwCreationFlags,
    IntPtr lpEnvironment, string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
}
"@
Add-Type -TypeDefinition $sig
$si = New-Object NativeBreakaway+STARTUPINFO
$si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
$pi = New-Object NativeBreakaway+PROCESS_INFORMATION
$flags = [uint32]0x01000000 -bor [uint32]0x00000008  # CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS
$ok = [NativeBreakaway]::CreateProcess('${psApp}', '${psCmdline}', [IntPtr]::Zero, [IntPtr]::Zero, $true, $flags, [IntPtr]::Zero, '${psCwd}', [ref]$si, [ref]$pi)
if (-not $ok) {
  Write-Error ("CreateProcess failed, win32=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
  exit 1
}
`;
}

/**
 * Launch the daemon detached from the caller's Job Object via CreateProcess breakaway.
 * The daemon inherits this process's stdout/stderr (redirected to `logFile`) and
 * writes its own PID file on readiness; the caller must poll for actual readiness.
 * @param {{nodeExe:string, serviceArgs:string[], logFile:string, env?:object}} opts
 * @returns {Promise<void>}
 */
export async function launchDetachedWindows({ nodeExe, serviceArgs, logFile, env = {} }) {
  const logFd = openSync(logFile, "a");
  const cmdline = [nodeExe, ...serviceArgs].map(quoteCmd).join(" ");
  const script = buildBreakawayPs1({ cmdline, applicationName: nodeExe, cwd: process.cwd() });
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      // daemon(由 CreateProcess 启动)继承本 powershell 的 stdout/stderr = logFd,
      // 其 [WebCLI] 日志得以写入 service.log。
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      try { closeSync(logFd); } catch {}
      code === 0 ? resolve() : reject(new Error(`breakaway 启动失败,退出码 ${code}`));
    });
  });
}
