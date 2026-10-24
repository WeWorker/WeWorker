import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { validatePublicConfig } from '../check-public-config.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PUBLIC_SITE_URL = 'https://www.weworker.cc'
const PUBLIC_REPO_URL = 'https://github.com/WeWorker/WeWorker'
const PUBLIC_RELEASES_URL = `${PUBLIC_REPO_URL}/releases`
const PUBLIC_UPDATE_URL = `${PUBLIC_RELEASES_URL}/latest/download/`

test('public Adapter registry, build profile, and versions stay consistent', () => {
  assert.deepEqual(validatePublicConfig(repoRoot), [])
})

function buildFixtureRepo({ webcliVersion = '1.0.4', ledgerOverrides = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-public-config-'))
  const writeJson = (relativePath, value) => {
    const target = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`)
  }
  const appVersion = '1.0.0'
  fs.mkdirSync(path.join(root, 'adapters'), { recursive: true })
  writeJson('weworker/build-profile.json', { adapters: [] })
  for (const relativePath of [
    'weworker/renderer/package.json',
    'weworker/backend-ts/package.json',
    'officialWeb/package.json',
    'metrics-server/package.json',
  ]) {
    writeJson(relativePath, { version: appVersion })
  }
  writeJson('weworker/package.json', {
    version: appVersion,
    build: { publish: [{ provider: 'generic', url: PUBLIC_UPDATE_URL }] },
  })
  writeJson('weworker/renderer/src/config/deployment.json', {
    officialUrl: PUBLIC_SITE_URL,
    downloadUrl: PUBLIC_RELEASES_URL,
  })
  writeJson('extension/manifest.json', { version: appVersion })
  writeJson('weworker/changelog.json', [{ version: appVersion }])
  const downloadConfig = path.join(root, 'officialWeb', 'src', 'lib', 'downloadConfig.js')
  fs.mkdirSync(path.dirname(downloadConfig), { recursive: true })
  fs.writeFileSync(downloadConfig, `export const APP_VERSION = '${appVersion}'\n`)
  const writeText = (relativePath, value) => {
    const target = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, value)
  }
  writeText('weworker/electron/update-manager.js', `const updateUrl = '${PUBLIC_UPDATE_URL}'\n`)
  writeText('weworker/renderer/src/components/settings/SettingsModal.jsx', `const updateUrl = '${PUBLIC_UPDATE_URL}'\n`)
  writeText('officialWeb/src/lib/siteConfig.js', `export const GITHUB_REPO = '${PUBLIC_REPO_URL}'\n`)
  writeText('officialWeb/index.html', `<link rel="canonical" href="${PUBLIC_SITE_URL}/">\n`)
  writeText('docs/github-repo-settings.md', `${PUBLIC_REPO_URL}\n${PUBLIC_SITE_URL}\n`)
  writeText('docs/assets/social-preview.html', `${PUBLIC_SITE_URL}\n`)
  writeText('docs/assets/social-preview.svg', `${PUBLIC_SITE_URL}\n`)

  writeJson('webcli/package.json', { version: webcliVersion })
  writeJson('webcli/version.json', { version: ledgerOverrides.versionJson ?? webcliVersion })
  writeJson('webcli/.claude-plugin/plugin.json', { version: ledgerOverrides.pluginJson ?? webcliVersion })
  const skill = path.join(root, 'webcli', 'skills', 'webcli', 'SKILL.md')
  fs.mkdirSync(path.dirname(skill), { recursive: true })
  fs.writeFileSync(skill, `---\nname: webcli\nversion: ${ledgerOverrides.skillMd ?? webcliVersion}\n---\n`)
  return root
}

test('webcli version may diverge from the app version but its release ledger must match', () => {
  const root = buildFixtureRepo()
  try {
    assert.deepEqual(validatePublicConfig(root), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('webcli ledger drift is reported per file', () => {
  const root = buildFixtureRepo({ ledgerOverrides: { versionJson: '1.0.3', skillMd: '1.0.2' } })
  try {
    assert.deepEqual(validatePublicConfig(root), [
      'webcli/version.json version is 1.0.3, expected 1.0.4',
      'webcli/skills/webcli/SKILL.md version must be 1.0.4',
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('retired public addresses are rejected', () => {
  const root = buildFixtureRepo()
  try {
    fs.writeFileSync(
      path.join(root, 'weworker', 'electron', 'update-manager.js'),
      `const updateUrls = ['${PUBLIC_UPDATE_URL}', 'http://weworker.example.com/downloads/']\n`,
    )
    fs.writeFileSync(
      path.join(root, 'docs', 'github-repo-settings.md'),
      `${PUBLIC_REPO_URL}\nhttps://github.com/aiceflower/WeWorker\n`,
    )
    assert.deepEqual(validatePublicConfig(root), [
      'weworker/electron/update-manager.js still references retired address weworker.example.com',
      'docs/github-repo-settings.md still references retired address github.com/aiceflower/WeWorker',
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
