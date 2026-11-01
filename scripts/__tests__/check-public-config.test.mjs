import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { validatePublicConfig } from '../check-public-config.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PUBLIC_SITE_URL = 'https://www.weworker.cc'
const PUBLIC_DOWNLOAD_URL = `${PUBLIC_SITE_URL}/download/`
const PUBLIC_REPO_URL = 'https://github.com/WeWorker/WeWorker'
const PUBLIC_UPDATE_URL = `${PUBLIC_REPO_URL}/releases/latest/download/`

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
  const writeText = (relativePath, value) => {
    const target = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, value)
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
  writeJson('weworker/deployment.json', {
    officialUrl: PUBLIC_SITE_URL,
    downloadUrl: PUBLIC_DOWNLOAD_URL,
    githubUrl: PUBLIC_UPDATE_URL,
  })
  writeJson('extension/manifest.json', { version: appVersion })
  writeJson('weworker/changelog.json', [{ version: appVersion }])
  const downloadConfig = path.join(root, 'officialWeb', 'src', 'lib', 'downloadConfig.js')
  fs.mkdirSync(path.dirname(downloadConfig), { recursive: true })
  fs.writeFileSync(downloadConfig, `export const APP_VERSION = '${appVersion}'\n`)
  writeText('weworker/electron/update-manager.js', 'const source = { url: DEPLOYMENT.githubUrl }\n')
  writeText('weworker/renderer/src/components/settings/SettingsModal.jsx', 'const updateUrl = deploymentConfig.githubUrl\n')
  writeText('weworker/scripts/build-electron-current-arch.cjs', 'const publish = { url: deployment.githubUrl }\n')
  writeText('officialWeb/src/lib/siteConfig.js', `export const OFFICIAL_SITE = '${PUBLIC_SITE_URL}'\nexport const GITHUB_REPO = '${PUBLIC_REPO_URL}'\n`)
  writeText('officialWeb/index.html', `<link rel="canonical" href="${PUBLIC_SITE_URL}/"><meta property="og:image" content="${PUBLIC_SITE_URL}/logo.png">\n`)
  const fixtureLogo = Buffer.from('fixture-logo')
  const publicLogo = path.join(root, 'officialWeb', 'public', 'logo.png')
  fs.mkdirSync(path.dirname(publicLogo), { recursive: true })
  fs.writeFileSync(publicLogo, fixtureLogo)
  writeText('docs/github-repo-settings.md', `${PUBLIC_REPO_URL}\n${PUBLIC_SITE_URL}\n`)
  writeText('docs/assets/social-preview.html', `${PUBLIC_SITE_URL}\n../../officialWeb/public/logo.png\n`)
  writeText('docs/assets/social-preview.svg', `${PUBLIC_SITE_URL}\n<image href="data:image/png;base64,${fixtureLogo.toString('base64')}"/>\n`)

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

test('retired public addresses and website updater sources are rejected', () => {
  const root = buildFixtureRepo()
  try {
    fs.writeFileSync(
      path.join(root, 'weworker', 'electron', 'update-manager.js'),
      'const sources = [{ url: DEPLOYMENT.githubUrl }, { url: DEPLOYMENT.downloadUrl }]\n',
    )
    fs.writeFileSync(
      path.join(root, 'docs', 'github-repo-settings.md'),
      `${PUBLIC_REPO_URL}\nhttps://github.com/aiceflower/WeWorker\n`,
    )
    assert.deepEqual(validatePublicConfig(root), [
      'desktop updater must not use the website download page as a metadata source',
      'docs/github-repo-settings.md still references retired address github.com/aiceflower/WeWorker',
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('social preview embedded logo must match the public product logo', () => {
  const root = buildFixtureRepo()
  try {
    fs.writeFileSync(
      path.join(root, 'docs', 'assets', 'social-preview.svg'),
      `${PUBLIC_SITE_URL}\n<image href="data:image/png;base64,${Buffer.from('different-logo').toString('base64')}"/>\n`,
    )
    assert.deepEqual(validatePublicConfig(root), [
      'docs/assets/social-preview.svg embedded logo must match officialWeb/public/logo.png',
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
