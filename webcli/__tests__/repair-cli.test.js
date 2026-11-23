import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runRepairCli } from '../repair/cli.js'

// vitest 与 CLI 共享进程,退出码现场保存/恢复
let savedExitCode
beforeEach(() => { savedExitCode = process.exitCode })
afterEach(() => { process.exitCode = savedExitCode })

describe('runRepairCli 退出码', () => {
  it('无参(用法错误)→ exitCode 2', async () => {
    await runRepairCli([])
    expect(process.exitCode).toBe(2)
  })
  it('运行错误(任务不存在)→ exitCode 1', async () => {
    await runRepairCli(['run', 'rt-1970-01-01-no-such-task'])
    expect(process.exitCode).toBe(1)
  })
})
