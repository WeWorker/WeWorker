// Feature: cli-name, 命令名按包身份派生(webgo vs webcli)
import { describe, it, expect, vi } from 'vitest'
import { cliNameFromPkgName, cliName, cliLabel } from '../cli-name.js'

describe('cliNameFromPkgName', () => {
  it('@webank/webgo → webgo', () => {
    expect(cliNameFromPkgName('@webank/webgo')).toBe('webgo')
  })
  it('行内 @webank/webcli → webcli', () => {
    expect(cliNameFromPkgName('@webank/webcli')).toBe('webcli')
  })
  it('公开 weworker-webcli → webcli', () => {
    expect(cliNameFromPkgName('weworker-webcli')).toBe('webcli')
  })
  it('未知包名安全回落 webcli', () => {
    expect(cliNameFromPkgName(undefined)).toBe('webcli')
    expect(cliNameFromPkgName('')).toBe('webcli')
  })
})

describe('cliName', () => {
  it('源码树(公开包)读到 weworker-webcli → webcli', () => {
    expect(cliName()).toBe('webcli')
  })
})

describe('env 覆盖(桌面端内嵌 webgo 化)', () => {
  it('WEBCLI_CLI_NAME=webgo 覆盖 package.json 判定', async () => {
    vi.resetModules()
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal()
      return {
        ...actual,
        readFileSync: (p, enc) => {
          if (String(p).endsWith('package.json')) return JSON.stringify({ name: 'weworker-webcli', version: '1.1.7' })
          return actual.readFileSync(p, enc)
        },
        existsSync: actual.existsSync,
      }
    })
    const { cliName } = await import('../cli-name.js')
    expect(cliName({ env: { WEBCLI_CLI_NAME: 'webgo' } })).toBe('webgo')
    vi.doUnmock('node:fs')
  })
})

describe('WEBCLI_CLI_NAME env 覆盖(桌面端内嵌 webgo 化)', () => {
  it('公开包身份 + WEBCLI_CLI_NAME=webgo → 输出 webgo', () => {
    expect(cliName({ env: { WEBCLI_CLI_NAME: 'webgo' } })).toBe('webgo')
    expect(cliLabel({ env: { WEBCLI_CLI_NAME: 'webgo' } })).toBe('WebGo')
  })
  it('无覆盖 → 回落 package.json 判定(源码树为 webcli)', () => {
    expect(cliName({ env: {} })).toBe('webcli')
    expect(cliLabel({ env: {} })).toBe('WebCLI')
  })
})
