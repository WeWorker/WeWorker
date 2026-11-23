import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runRepairCli, parseProposal } from '../repair/cli.js'

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

describe('parseProposal 提案解析', () => {
  it('stdout 末行 JSON 优先', () => {
    expect(parseProposal('思考中...\n{"rootCause":"logic-bug"}')).toEqual({ rootCause: 'logic-bug' })
    expect(parseProposal('{"rootCause":"logic-bug"}\r\n')).toEqual({ rootCause: 'logic-bug' })
  })
  it('末行带说明文字时回退首个平衡 JSON 块(花括号在字符串字面量内不干扰配对)', () => {
    const out = '结论如下:\n提案 {"patchedFiles":{"a.py":"x{y}z"},"rootCause":"logic-bug"} 以上。'
    expect(parseProposal(out)).toEqual({ patchedFiles: { 'a.py': 'x{y}z' }, rootCause: 'logic-bug' })
  })
  it('无合法 JSON 抛错(由调用方 llm-error/catch 兜底)', () => {
    expect(() => parseProposal('完全不是 JSON')).toThrow(/不是合法 JSON/)
    expect(() => parseProposal('前缀 {"truncated": "没有闭合')).toThrow(/不是合法 JSON/)
  })
})
