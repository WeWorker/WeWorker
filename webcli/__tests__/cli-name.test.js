// Feature: cli-name, 命令名按包身份派生(webgo vs webcli)
import { describe, it, expect } from 'vitest'
import { cliNameFromPkgName, cliName } from '../cli-name.js'

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
