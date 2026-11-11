// Feature: service-spawn, Windows daemon detach via schtasks(脱离 Job Object)
import { describe, it, expect } from 'vitest'
import { buildSchtasksArgs, buildDaemonLaunchScript, quoteCmd } from '../service-spawn.js'

describe('quoteCmd', () => {
  it('无空格不加引号', () => {
    expect(quoteCmd('node.exe')).toBe('node.exe')
  })
  it('含空格加双引号', () => {
    expect(quoteCmd('C:\\Program Files\\nodejs\\node.exe')).toBe('"C:\\Program Files\\nodejs\\node.exe"')
  })
})

describe('buildSchtasksArgs', () => {
  it('生成 create/run/delete 三组 argv', () => {
    const args = buildSchtasksArgs({ taskName: 'webcli-ab12', scriptPath: 'C:\\tmp\\webcli-ab12.cmd' })
    expect(args.create).toEqual(['schtasks', '/create', '/tn', 'webcli-ab12', '/tr', '"C:\\tmp\\webcli-ab12.cmd"', '/sc', 'once', '/st', '00:00', '/f'])
    expect(args.run).toEqual(['schtasks', '/run', '/tn', 'webcli-ab12'])
    expect(args.delete).toEqual(['schtasks', '/delete', '/tn', 'webcli-ab12', '/f'])
  })
})

describe('buildDaemonLaunchScript', () => {
  it('生成带引号与日志重定向的 .cmd 内容', () => {
    const script = buildDaemonLaunchScript({
      nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
      serviceArgs: ['C:\\Program Files\\webcli\\index.js', '--service'],
      logFile: 'C:\\tmp\\service.log',
    })
    expect(script).toContain('"C:\\Program Files\\nodejs\\node.exe"')
    expect(script).toContain('"C:\\Program Files\\webcli\\index.js" --service')
    expect(script).toContain('>> "C:\\tmp\\service.log" 2>&1')
  })
  it('注入 set 环境变量(如 WEBCLI_SERVICE_TOKEN)', () => {
    const script = buildDaemonLaunchScript({
      nodeExe: 'node.exe', serviceArgs: ['index.js', '--service'], logFile: 'log.txt',
      env: { WEBCLI_SERVICE_TOKEN: 'abc123' },
    })
    expect(script).toContain('set "WEBCLI_SERVICE_TOKEN=abc123"')
  })
})
