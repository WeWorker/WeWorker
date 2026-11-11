// Feature: service-spawn, Windows daemon detach via CreateProcess breakaway(脱离 Job Object)
import { describe, it, expect } from 'vitest'
import { buildBreakawayPs1, quoteCmd } from '../service-spawn.js'

describe('quoteCmd', () => {
  it('无空格不加引号', () => {
    expect(quoteCmd('node.exe')).toBe('node.exe')
  })
  it('含空格加双引号', () => {
    expect(quoteCmd('C:\\Program Files\\nodejs\\node.exe')).toBe('"C:\\Program Files\\nodejs\\node.exe"')
  })
})

describe('buildBreakawayPs1', () => {
  it('生成含 CreateProcess breakaway 的 PowerShell 脚本', () => {
    const script = buildBreakawayPs1({
      cmdline: '"C:\\Program Files\\nodejs\\node.exe" "C:\\app\\index.js" --service',
      applicationName: 'C:\\Program Files\\nodejs\\node.exe',
      cwd: 'C:\\',
    })
    expect(script).toContain("$ProgressPreference = 'SilentlyContinue'")
    expect(script).toContain('CreateProcess')
    expect(script).toContain('CREATE_BREAKAWAY_FROM_JOB')
    expect(script).toContain('0x01000000')           // CREATE_BREAKAWAY_FROM_JOB
    expect(script).toContain('DETACHED_PROCESS')
    expect(script).toContain('"C:\\Program Files\\nodejs\\node.exe" "C:\\app\\index.js" --service')
  })
  it('cmdline 中的单引号按 PowerShell 规则转义', () => {
    const script = buildBreakawayPs1({ cmdline: "node.exe a'b.js", applicationName: 'node.exe', cwd: 'C:\\' })
    expect(script).toContain("node.exe a''b.js")
  })
})
