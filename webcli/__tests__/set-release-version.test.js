import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyReleaseVersion } from '../scripts/set-release-version.mjs'

const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-release-version-'))
  temporaryDirectories.push(root)
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'skills', 'webcli'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"weworker-webcli","version":"1.0.0"}\n')
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"name":"weworker-webcli","version":"1.0.0","packages":{"":{"name":"weworker-webcli","version":"1.0.0"}}}\n')
  fs.writeFileSync(path.join(root, 'version.json'), '{"version":"1.0.0"}\n')
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), '{"name":"webcli","version":"1.0.0"}\n')
  fs.writeFileSync(path.join(root, 'skills', 'webcli', 'SKILL.md'), '---\nname: webcli\nversion: 1.0.0\ndescription: fixture\n---\n')
  return root
}

describe('set-release-version', () => {
  it('applies one build version to every published version ledger', () => {
    const root = fixture()
    applyReleaseVersion('2.3.4-rc.1', root)

    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version).toBe('2.3.4-rc.1')
    const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')))
    expect(packageLock.version).toBe('2.3.4-rc.1')
    expect(packageLock.packages[''].version).toBe('2.3.4-rc.1')
    expect(JSON.parse(fs.readFileSync(path.join(root, 'version.json'))).version).toBe('2.3.4-rc.1')
    expect(JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'))).version).toBe('2.3.4-rc.1')
    expect(fs.readFileSync(path.join(root, 'skills', 'webcli', 'SKILL.md'), 'utf8')).toContain('version: 2.3.4-rc.1')
  })

  it('rejects invalid versions without changing files', () => {
    const root = fixture()
    expect(() => applyReleaseVersion('latest', root)).toThrow(/Invalid WebCLI version/)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version).toBe('1.0.0')
  })

  it('validates every ledger before writing any version', () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"version":"1.0.0","packages":{}}\n')
    expect(() => applyReleaseVersion('2.0.0', root)).toThrow(/root package entry/)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version).toBe('1.0.0')
  })
})
