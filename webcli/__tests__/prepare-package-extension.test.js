import fs from 'node:fs'
import { symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { checkPackageResources, syncPackageExtension, syncPackageMetrics } from '../scripts/prepare-package-extension.js'

const tempDirs = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('prepare package extension', () => {
  it('copies exactly the prepared profile and detects stale package content before packaging', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-profile-pack-'))
    tempDirs.push(root)
    const webcliDir = path.join(root, 'webcli')
    const sourceExtensionDir = path.join(root, 'prepared/extension')
    const sourceBuiltinDir = path.join(root, 'prepared/adapters')
    fs.mkdirSync(path.join(sourceExtensionDir, 'background'), { recursive: true })
    fs.mkdirSync(sourceBuiltinDir, { recursive: true })
    fs.writeFileSync(path.join(sourceExtensionDir, 'manifest.json'), '{"version":"1"}')
    fs.writeFileSync(path.join(sourceExtensionDir, 'background', 'service-worker.js'), 'const WS_URL = "ws://localhost:3711";\n')
    fs.writeFileSync(path.join(sourceBuiltinDir, '.profile.json'), JSON.stringify({ schema_version: 1, profile: 'internal', adapters: [], legacy: [] }))
    fs.mkdirSync(path.join(webcliDir, 'adapters/stale'), { recursive: true })
    const options = { webcliDir, sourceExtensionDir, sourceBuiltinDir }
    syncPackageExtension(options)
    expect(fs.readdirSync(path.join(webcliDir, 'adapters'))).toEqual(['.profile.json'])
    expect(() => checkPackageResources(options)).not.toThrow()
    fs.writeFileSync(path.join(webcliDir, 'extension/manifest.json'), '{"version":"2"}')
    expect(() => checkPackageResources(options)).toThrow(/content is stale/)
    fs.writeFileSync(path.join(sourceBuiltinDir, '.profile.json'), '{}')
    expect(() => syncPackageExtension(options)).toThrow(/metadata/)
    expect(fs.readFileSync(path.join(webcliDir, 'extension/manifest.json'), 'utf8')).toBe('{"version":"2"}')
  })
  it('copies the sibling extension into the webcli package without dependencies or scaffold artifacts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-pack-'))
    tempDirs.push(root)
    const webcliDir = path.join(root, 'webcli')
    const sourceExtensionDir = path.join(root, 'extension')
    const siteGeneratedDir = path.join(sourceExtensionDir, 'adapters', 'site.test', 'webcli-generated')
    fs.mkdirSync(path.join(sourceExtensionDir, 'adapters', 'site.test'), { recursive: true })
    fs.mkdirSync(siteGeneratedDir, { recursive: true })
    fs.mkdirSync(path.join(sourceExtensionDir, 'node_modules', 'left-pad'), { recursive: true })
    fs.mkdirSync(path.join(sourceExtensionDir, 'test'), { recursive: true })
    fs.mkdirSync(path.join(sourceExtensionDir, 'background'), { recursive: true })
    fs.writeFileSync(path.join(sourceExtensionDir, 'manifest.json'), '{"version":"1"}\n')
    fs.writeFileSync(path.join(sourceExtensionDir, 'background', 'service-worker.js'), 'const WS_URL = "ws://localhost:3711";\n')
    fs.writeFileSync(path.join(sourceExtensionDir, 'adapters', 'site.test', 'manifest.json'), '{"id":"site.test"}\n')
    fs.writeFileSync(path.join(siteGeneratedDir, 'site.test.index-snippet.generated.txt'), 'snippet')
    fs.writeFileSync(path.join(siteGeneratedDir, 'site.test.integration.generated.md'), '# integration\n')
    fs.writeFileSync(path.join(sourceExtensionDir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = null\n')
    fs.writeFileSync(path.join(sourceExtensionDir, 'test', 'site.test.mjs'), 'import test from "node:test"\n')
    fs.mkdirSync(path.join(webcliDir, 'extension', 'stale'), { recursive: true })
    fs.writeFileSync(path.join(webcliDir, 'extension', 'stale', 'old.txt'), 'old')

    const result = syncPackageExtension({ webcliDir, sourceExtensionDir })

    expect(result.fileCount).toBe(3)
    expect(fs.existsSync(path.join(webcliDir, 'extension', 'manifest.json'))).toBe(true)
    expect(fs.existsSync(path.join(webcliDir, 'extension', 'adapters', 'site.test', 'manifest.json'))).toBe(true)
    expect(fs.existsSync(path.join(webcliDir, 'extension', 'adapters', 'site.test', 'webcli-generated', 'site.test.index-snippet.generated.txt'))).toBe(false)
    expect(fs.existsSync(path.join(webcliDir, 'extension', 'adapters', 'site.test', 'webcli-generated', 'site.test.integration.generated.md'))).toBe(false)
    expect(fs.existsSync(path.join(webcliDir, 'extension', 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(webcliDir, 'extension', 'test'))).toBe(false)
    expect(fs.existsSync(path.join(webcliDir, 'extension', 'stale'))).toBe(false)
  })
  it('generates disabled packaged metrics for a public model and requires a token when enabled', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-npm-metrics-pack-'))
    tempDirs.push(root)
    const webcliDir = path.join(root, 'webcli')
    const publicModel = path.join(root, 'public-model.json')
    fs.writeFileSync(publicModel, JSON.stringify({ providers: [] }))

    expect(syncPackageMetrics({ webcliDir, modelPath: publicModel, env: {} })).toEqual({ enabled: false })
    expect(JSON.parse(fs.readFileSync(path.join(webcliDir, 'metrics-client.json'), 'utf8'))).toEqual({ enabled: false })

    const enabledModel = path.join(root, 'enabled-model.json')
    fs.writeFileSync(enabledModel, JSON.stringify({ environment: { WEBCLI_METRICS_ENDPOINT: 'https://example.com/v1/metrics/batch', WEBCLI_METRICS_UPLOAD: 'on' } }))
    expect(() => syncPackageMetrics({ webcliDir, modelPath: enabledModel, env: {} })).toThrow(/token/)
    expect(syncPackageMetrics({ webcliDir, modelPath: enabledModel, env: { WEWORKER_METRICS_TEST_BUILD: '1' } })).toEqual({ enabled: false })
    expect(syncPackageMetrics({ webcliDir, modelPath: enabledModel, env: { WEBCLI_METRICS_CLIENT_TOKEN: 'fixture-metrics-client-token-123456' } }))
      .toEqual({ enabled: true, endpoint: 'https://example.com/v1/metrics/batch', token: 'fixture-metrics-client-token-123456' })
  })
  it('rewrites only the packaged npm worker to the npm Bridge port', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-npm-worker-'))
    tempDirs.push(root)
    const webcliDir = path.join(root, 'webcli')
    const sourceExtensionDir = path.join(root, 'prepared/extension')
    const sourceBuiltinDir = path.join(root, 'prepared/adapters')
    fs.mkdirSync(path.join(sourceExtensionDir, 'background'), { recursive: true })
    fs.mkdirSync(sourceBuiltinDir, { recursive: true })
    fs.writeFileSync(path.join(sourceBuiltinDir, '.profile.json'), JSON.stringify({ schema_version: 1, profile: 'public', adapters: [], legacy: [] }))
    fs.writeFileSync(path.join(sourceExtensionDir, 'manifest.json'), '{"version":"1"}\n')
    fs.writeFileSync(path.join(sourceExtensionDir, 'background', 'service-worker.js'),
      'const WS_URL = "ws://localhost:3711";\nconst other = "unchanged";\n')
    const options = { webcliDir, sourceExtensionDir, sourceBuiltinDir }
    syncPackageExtension(options)
    const packagedWorker = fs.readFileSync(path.join(webcliDir, 'extension', 'background', 'service-worker.js'), 'utf8')
    expect(packagedWorker).toContain('ws://127.0.0.1:3712')
    expect(packagedWorker).not.toContain('ws://localhost:3711')
    expect(fs.readFileSync(path.join(sourceExtensionDir, 'background', 'service-worker.js'), 'utf8'))
      .toContain('ws://localhost:3711')
    expect(() => checkPackageResources(options)).not.toThrow()
    fs.writeFileSync(path.join(webcliDir, 'extension', 'background', 'service-worker.js'),
      'const WS_URL = "ws://localhost:3711";\nconst other = "unchanged";\n')
    expect(() => checkPackageResources(options)).toThrow(/content is stale/)
  })
  it('rejects linked package resources instead of silently omitting or following them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-package-link-'))
    tempDirs.push(root)
    const webcliDir = path.join(root, 'webcli')
    const sourceExtensionDir = path.join(root, 'prepared/extension')
    const sourceBuiltinDir = path.join(root, 'prepared/adapters')
    const linkedTarget = path.join(root, 'linked-target')
    fs.mkdirSync(path.join(sourceExtensionDir, 'regular'), { recursive: true })
    fs.mkdirSync(path.join(sourceExtensionDir, 'background'), { recursive: true })
    fs.mkdirSync(sourceBuiltinDir, { recursive: true })
    fs.writeFileSync(path.join(sourceExtensionDir, 'background', 'service-worker.js'), 'const WS_URL = "ws://localhost:3711";\n')
    fs.mkdirSync(linkedTarget, { recursive: true })
    fs.writeFileSync(path.join(linkedTarget, 'manifest.json'), '{"version":"1"}')
    fs.writeFileSync(path.join(sourceBuiltinDir, '.profile.json'), JSON.stringify({ schema_version: 1, profile: 'public', adapters: [], legacy: [] }))
    symlinkSync(linkedTarget, path.join(sourceExtensionDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => syncPackageExtension({ webcliDir, sourceExtensionDir, sourceBuiltinDir })).toThrow(/symbolic link/)
  })
})
