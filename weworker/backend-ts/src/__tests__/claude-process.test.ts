import { once } from 'node:events'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { spawnManagedClaudeCodeProcess } from '../claude-process.js'

async function expectProcessGone(pid: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(() => process.kill(pid, 0)).toThrow()
}

describe('managed Claude process', () => {
  it.runIf(process.platform !== 'win32')('terminates the complete detached process group', async () => {
    const child = spawnManagedClaudeCodeProcess({
      command: '/bin/sh',
      args: ['-c', 'sleep 30 & wait'],
      env: process.env as Record<string, string>,
    })
    const pid = child.pid
    expect(pid).toBeTypeOf('number')

    child.kill('SIGTERM')
    await once(child, 'exit')

    // The shell's exit event can arrive before all group members are reaped.
    await expectProcessGone(-pid!)
  })

  it.runIf(process.platform !== 'win32')('terminates descendants that create their own process group', async () => {
    const script = [
      'const { spawn } = require("node:child_process")',
      'const child = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" })',
      'console.log(child.pid)',
      'setInterval(() => {}, 1000)',
    ].join(';')
    const child = spawnManagedClaudeCodeProcess({
      command: process.execPath,
      args: ['-e', script],
      env: process.env,
    })
    const [chunk] = await once(child.stdout!, 'data')
    const detachedDescendantPid = Number(String(chunk).trim())
    expect(detachedDescendantPid).toBeGreaterThan(0)

    child.kill('SIGTERM')
    await once(child, 'exit')

    await expectProcessGone(detachedDescendantPid)
  })

  it.runIf(process.platform !== 'win32')('reaps active Claude descendants when the backend receives SIGTERM', async () => {
    const dirname = path.dirname(fileURLToPath(import.meta.url))
    const tsxCli = path.resolve(dirname, '../../node_modules/tsx/dist/cli.mjs')
    const fixture = path.resolve(dirname, 'fixtures/claude-process-signal-fixture.ts')
    const backend = spawn(process.execPath, [tsxCli, fixture], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const [chunk] = await once(backend.stdout!, 'data')
    const match = String(chunk).match(/READY:(\d+)/)
    expect(match).not.toBeNull()
    const detachedDescendantPid = Number(match![1])

    backend.kill('SIGTERM')
    const [exitCode] = await once(backend, 'exit')

    expect(exitCode).toBe(143)
    await expectProcessGone(detachedDescendantPid)
  })
})
