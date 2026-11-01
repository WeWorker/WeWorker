/**
 * 内置 PowerShell 工具的临时根预检与回退。
 *
 * 事实（客户端实测）：Claude Code 的内置 PowerShell 工具在执行任何命令前，会在
 * `<系统临时目录>/claude/<cwd-key>` 下展开脚本；这个目录**创建失败（EPERM）时整轮所有命令
 * 一起失败**——现象是「执行了 N 个命令」但 `webcli call` 一次都没真正跑，用户只看到
 * 「查询未能执行」。本机复查该目录：存在、所有者是当前用户、ACL 正常继承、写探针成功，
 * 说明不是持久性权限问题，而是偶发（并发清理 / 终端安全软件 / 父进程 TEMP 异常）。
 *
 * 这里做两件事，都只作用于本进程拉起的子进程：
 *   ① 每轮 spawn 前幂等创建 `<tmp>/claude` 并做一次写探针，把「第一次 mkdir 失败」挪到
 *      一个可以回退的位置；
 *   ② 探针不可写时回退到 WeWorker 自有目录（`<config>/claude-temp`），并注入
 *      `TEMP`/`TMP`/`TMPDIR`，让工具链换到一个确定可写的位置继续工作。
 *
 * 两侧都不可写时**不改 env**：临时目录坏掉不该阻断对话，最多回到今天的行为。
 * 日志只写判定结果与错误码，不写用户数据路径。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getConfigDirectory } from './config.js'

export type ClaudeTempMode = 'primary' | 'fallback' | 'unavailable'

export interface ClaudeTempResult {
  /** 交给子进程的环境变量（只有回退时才改写 TEMP/TMP/TMPDIR） */
  env: NodeJS.ProcessEnv
  mode: ClaudeTempMode
  /** 不可写时的错误码（仅日志用，不含路径） */
  reason?: string
}

export interface ClaudeTempDeps {
  /** 系统临时目录（缺省 `os.tmpdir()`；测试注入） */
  tmpdir?: string
  /** 回退目录（缺省 `<config>/claude-temp`；测试注入） */
  fallbackDir?: string
  mkdirSync?: (dir: string) => void
  /** 写探针：应当创建并删除一个文件，失败即抛 */
  probeWrite?: (file: string) => void
  log?: (message: string) => void
}

const PROBE_PREFIX = '.weworker-write-probe-'

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && code ? code : 'unknown'
}

function defaultProbeWrite(file: string): void {
  fs.writeFileSync(file, '')
  fs.rmSync(file, { force: true })
}

/** 建目录 + 写探针；成功返回 null，失败返回错误码。永不抛。 */
function ensureWritable(root: string, mkdir: (dir: string) => void, probe: (file: string) => void): string | null {
  try {
    mkdir(root)
  } catch (error) {
    return errorCode(error)
  }
  try {
    probe(path.join(root, `${PROBE_PREFIX}${process.pid}`))
  } catch (error) {
    return errorCode(error)
  }
  return null
}

/**
 * 为内置 shell 工具准备可写临时根。纯判定 + 幂等 IO，**不抛异常**。
 */
export function ensureClaudeTempEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: ClaudeTempDeps = {},
): ClaudeTempResult {
  const mkdir = deps.mkdirSync ?? ((dir: string) => { fs.mkdirSync(dir, { recursive: true }) })
  const probe = deps.probeWrite ?? defaultProbeWrite

  const primary = path.join(deps.tmpdir ?? os.tmpdir(), 'claude')
  const primaryError = ensureWritable(primary, mkdir, probe)
  if (!primaryError) return { env, mode: 'primary' }

  const fallback = deps.fallbackDir ?? path.join(getConfigDirectory(), 'claude-temp')
  const fallbackError = ensureWritable(fallback, mkdir, probe)
  if (fallbackError) {
    deps.log?.(`claude temp unavailable: primary=${primaryError} fallback=${fallbackError}`)
    return { env, mode: 'unavailable', reason: fallbackError }
  }
  deps.log?.(`claude temp fallback enabled: primary=${primaryError}`)
  return {
    env: { ...env, TEMP: fallback, TMP: fallback, TMPDIR: fallback },
    mode: 'fallback',
    reason: primaryError,
  }
}
