/**
 * 内置 shell 工具临时根预检（`claude-temp.ts`）。
 *
 * 这层守的是一条实测事故：`<tmp>/claude` 偶发不可写时，内置 PowerShell 会把**整轮所有命令**
 * 一起判失败，`webcli call` 一次也没执行，而用户只看到「查询未能执行」。所以两个不变量：
 *   ① 可写时不改 env（零行为变化，不能因为一次预检就改变子进程的临时目录）；
 *   ② 不可写时换到自有目录；连自有目录也不可写就**原样返回**，绝不阻断对话。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureClaudeTempEnv } from '../claude-temp.js'

const tempDirs: string[] = []

function tempDir(prefix = 'weworker-claude-temp-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言
    }
  }
})

describe('ensureClaudeTempEnv', () => {
  it('系统临时目录可写：不改 env，并且幂等创建 <tmp>/claude', () => {
    const base = tempDir()
    const env = { PATH: 'x', TEMP: 'kept' }
    const result = ensureClaudeTempEnv(env, { tmpdir: base, fallbackDir: path.join(base, 'fallback') })
    expect(result.mode).toBe('primary')
    expect(result.env).toBe(env)
    expect(result.env.TEMP).toBe('kept')
    expect(fs.existsSync(path.join(base, 'claude'))).toBe(true)
  })

  it('系统临时目录建不出来（EPERM）：回退到自有目录并注入 TEMP/TMP/TMPDIR', () => {
    const fallback = path.join(tempDir(), 'claude-temp')
    const result = ensureClaudeTempEnv(
      { PATH: 'x' },
      {
        tmpdir: tempDir(),
        fallbackDir: fallback,
        // 第一次调用（系统临时目录）拒绝，之后放行。
        mkdirSync: ((calls) => (dir: string) => {
          calls.push(dir)
          if (calls.length === 1) {
            const error = new Error('denied') as NodeJS.ErrnoException
            error.code = 'EPERM'
            throw error
          }
          fs.mkdirSync(dir, { recursive: true })
        })([] as string[]),
      },
    )
    expect(result.mode).toBe('fallback')
    expect(result.reason).toBe('EPERM')
    expect(result.env.TEMP).toBe(fallback)
    expect(result.env.TMP).toBe(fallback)
    expect(result.env.TMPDIR).toBe(fallback)
    expect(result.env.PATH).toBe('x')
    expect(fs.existsSync(fallback)).toBe(true)
  })

  it('目录建得出但写不进去：同样回退（探针失败而不是只看 mkdir）', () => {
    const base = tempDir()
    const fallback = path.join(tempDir(), 'claude-temp')
    let probes = 0
    const result = ensureClaudeTempEnv(
      {},
      {
        tmpdir: base,
        fallbackDir: fallback,
        probeWrite: (file) => {
          probes += 1
          if (probes === 1) {
            const error = new Error('denied') as NodeJS.ErrnoException
            error.code = 'EACCES'
            throw error
          }
          fs.writeFileSync(file, '')
          fs.rmSync(file, { force: true })
        },
      },
    )
    expect(probes).toBe(2)
    expect(result.mode).toBe('fallback')
    expect(result.reason).toBe('EACCES')
    expect(result.env.TEMP).toBe(fallback)
  })

  it('两边都不可写：原样返回 env，只记错误码，绝不抛', () => {
    const messages: string[] = []
    const env = { PATH: 'x' }
    const result = ensureClaudeTempEnv(env, {
      tmpdir: tempDir(),
      fallbackDir: path.join(tempDir(), 'claude-temp'),
      mkdirSync: () => {
        const error = new Error('denied') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      },
      log: (message) => messages.push(message),
    })
    expect(result.mode).toBe('unavailable')
    expect(result.reason).toBe('EPERM')
    expect(result.env).toBe(env)
    expect(result.env.TEMP).toBeUndefined()
    expect(messages.join(' ')).toContain('unavailable')
    // 日志不写用户路径
    expect(messages.join(' ')).not.toContain('AppData')
  })

  it('探针文件按进程写入后即删，不留残留', () => {
    const base = tempDir()
    ensureClaudeTempEnv({}, { tmpdir: base, fallbackDir: path.join(base, 'fallback') })
    const leftovers = fs.readdirSync(path.join(base, 'claude')).filter((name) => name.includes('probe'))
    expect(leftovers).toEqual([])
  })
})
