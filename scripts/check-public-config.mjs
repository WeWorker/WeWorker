import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC_SITE_URL = 'https://www.weworker.cc'
const PUBLIC_DOWNLOAD_URL = `${PUBLIC_SITE_URL}/download/`
const PUBLIC_REPO_URL = 'https://github.com/WeWorker/WeWorker'
const PUBLIC_RELEASES_URL = `${PUBLIC_REPO_URL}/releases`
const PUBLIC_UPDATE_URL = `${PUBLIC_RELEASES_URL}/latest/download/`

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function duplicates(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

export function validatePublicConfig(repoRoot) {
  const errors = []
  const managedAdaptersRoot = path.join(repoRoot, 'adapters')
  const profilePath = path.join(repoRoot, 'weworker', 'build-profile.json')
  const profile = readJson(profilePath)

  if (!Array.isArray(profile.adapters)) errors.push('weworker/build-profile.json adapters must be an array')
  if (errors.length) return errors

  for (const id of duplicates(profile.adapters)) errors.push(`duplicate packaged Adapter: ${id}`)

  for (const id of profile.adapters) {
    const managedManifestPath = path.join(managedAdaptersRoot, id, 'manifest.json')
    if (!fs.existsSync(managedManifestPath)) {
      errors.push(`build profile references missing Adapter: ${id}`)
      continue
    }
    const manifest = readJson(managedManifestPath)
    if (manifest.schema_version !== 2) {
      errors.push(`managed Adapter ${id} manifest must use schema_version 2`)
    }
    if (manifest.name !== id) {
      errors.push(`managed Adapter name mismatch in adapters/${id}/manifest.json`)
    }
  }

  const versionFiles = [
    'weworker/package.json',
    'weworker/renderer/package.json',
    'weworker/backend-ts/package.json',
    'officialWeb/package.json',
    'metrics-server/package.json',
    'extension/manifest.json',
  ]
  const publicVersion = readJson(path.join(repoRoot, 'weworker', 'package.json')).version
  for (const relativePath of versionFiles) {
    const value = readJson(path.join(repoRoot, relativePath)).version
    if (value !== publicVersion) errors.push(`${relativePath} version is ${value}, expected ${publicVersion}`)
  }

  const changelog = readJson(path.join(repoRoot, 'weworker', 'changelog.json'))
  if (!Array.isArray(changelog) || changelog.length === 0 || changelog[0]?.version !== publicVersion) {
    errors.push(`weworker/changelog.json must start with the ${publicVersion} release`)
  }

  const downloadConfig = fs.readFileSync(path.join(repoRoot, 'officialWeb', 'src', 'lib', 'downloadConfig.js'), 'utf8')
  if (!downloadConfig.includes(`APP_VERSION = '${publicVersion}'`)) {
    errors.push(`officialWeb APP_VERSION must be ${publicVersion}`)
  }

  const deployment = readJson(path.join(repoRoot, 'weworker', 'deployment.json'))
  if (deployment.officialUrl !== PUBLIC_SITE_URL) {
    errors.push(`public officialUrl must be ${PUBLIC_SITE_URL}`)
  }
  if (deployment.downloadUrl !== PUBLIC_DOWNLOAD_URL) {
    errors.push(`public downloadUrl must be ${PUBLIC_DOWNLOAD_URL}`)
  }
  if (!Array.isArray(deployment.updateSources) || deployment.updateSources.length === 0) {
    errors.push('public updateSources must be a non-empty array')
  } else if (deployment.updateSources[0]?.url !== PUBLIC_UPDATE_URL) {
    errors.push(`public updateSources[0].url must be ${PUBLIC_UPDATE_URL}`)
  }

  const desktopPackage = readJson(path.join(repoRoot, 'weworker', 'package.json'))
  if (desktopPackage.build?.publish?.[0]?.url !== PUBLIC_UPDATE_URL) {
    errors.push(`desktop publish URL must be ${PUBLIC_UPDATE_URL}`)
  }

  const publicUrlSources = [
    ['weworker/electron/update-manager.js', 'const UPDATE_SOURCES = DEPLOYMENT.updateSources'],
    ['weworker/renderer/src/components/settings/SettingsModal.jsx', 'deploymentConfig.updateSources.map'],
    ['weworker/scripts/build-electron-current-arch.cjs', 'url: deployment.updateSources[0].url'],
    ['officialWeb/src/lib/siteConfig.js', `OFFICIAL_SITE = '${PUBLIC_SITE_URL}'`],
    ['officialWeb/src/lib/siteConfig.js', `GITHUB_REPO = '${PUBLIC_REPO_URL}'`],
    ['officialWeb/index.html', `${PUBLIC_SITE_URL}/`],
    ['officialWeb/index.html', `${PUBLIC_SITE_URL}/logo.png`],
    ['docs/assets/social-preview.html', '../../officialWeb/public/logo.png'],
    ['docs/assets/social-preview.svg', 'data:image/png;base64,'],
  ]
  for (const [relativePath, expected] of publicUrlSources) {
    const content = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
    if (!content.includes(expected)) errors.push(`${relativePath} must reference ${expected}`)
  }

  const socialPreviewSvg = fs.readFileSync(path.join(repoRoot, 'docs', 'assets', 'social-preview.svg'), 'utf8')
  const embeddedLogo = socialPreviewSvg.match(/href="data:image\/png;base64,([^"]+)"/)?.[1]
  const publicLogo = fs.readFileSync(path.join(repoRoot, 'officialWeb', 'public', 'logo.png'))
  if (!embeddedLogo) {
    errors.push('docs/assets/social-preview.svg must embed the public logo')
  } else if (!Buffer.from(embeddedLogo, 'base64').equals(publicLogo)) {
    errors.push('docs/assets/social-preview.svg embedded logo must match officialWeb/public/logo.png')
  }

  const updaterSource = fs.readFileSync(path.join(repoRoot, 'weworker', 'electron', 'update-manager.js'), 'utf8')
  if (updaterSource.includes('url: DEPLOYMENT.downloadUrl')) {
    errors.push('desktop updater must not use the website download page as a metadata source')
  }

  const retiredReferences = [
    ['weworker/deployment.json', '/releases/download/latest/'],
    ['docs/github-repo-settings.md', 'github.com/aiceflower/WeWorker'],
    ['docs/assets/social-preview.html', 'github.com/aiceflower/WeWorker'],
    ['docs/assets/social-preview.svg', 'github.com/aiceflower/WeWorker'],
  ]
  for (const [relativePath, retired] of retiredReferences) {
    const content = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
    if (content.includes(retired)) errors.push(`${relativePath} still references retired address ${retired}`)
  }

  // webcli ships to npm on its own release cadence, so its version is decoupled
  // from the desktop app version; it only needs to stay consistent across the
  // release ledger the webcli release script writes.
  const webcliVersion = readJson(path.join(repoRoot, 'webcli', 'package.json')).version
  const webcliLedgerFiles = ['webcli/version.json', 'webcli/.claude-plugin/plugin.json']
  for (const relativePath of webcliLedgerFiles) {
    const value = readJson(path.join(repoRoot, relativePath)).version
    if (value !== webcliVersion) errors.push(`${relativePath} version is ${value}, expected ${webcliVersion}`)
  }
  const webcliSkill = fs.readFileSync(path.join(repoRoot, 'webcli', 'skills', 'webcli', 'SKILL.md'), 'utf8')
  if (!webcliSkill.includes(`version: ${webcliVersion}`)) {
    errors.push(`webcli/skills/webcli/SKILL.md version must be ${webcliVersion}`)
  }

  return errors
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const repoRoot = path.resolve(path.dirname(scriptPath), '..')
  const errors = validatePublicConfig(repoRoot)
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
  } else {
    console.log('Public configuration is consistent.')
  }
}
