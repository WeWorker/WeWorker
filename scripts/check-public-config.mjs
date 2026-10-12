import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function duplicates(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

export function validatePublicConfig(repoRoot) {
  const errors = []
  const adaptersRoot = path.join(repoRoot, 'extension', 'adapters')
  const managedAdaptersRoot = path.join(repoRoot, 'adapters')
  const registryPath = path.join(adaptersRoot, 'index.json')
  const profilePath = path.join(repoRoot, 'weworker', 'build-profile.json')
  const registered = readJson(registryPath)
  const profile = readJson(profilePath)

  if (!Array.isArray(registered)) errors.push('extension/adapters/index.json must be an array')
  if (!Array.isArray(profile.adapters)) errors.push('weworker/build-profile.json adapters must be an array')
  if (errors.length) return errors

  for (const id of duplicates(registered)) errors.push(`duplicate registered Adapter: ${id}`)
  for (const id of duplicates(profile.adapters)) errors.push(`duplicate packaged Adapter: ${id}`)

  const manifestDirectories = fs.readdirSync(adaptersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => fs.existsSync(path.join(adaptersRoot, id, 'manifest.json')))
    .sort()

  const sortedRegistered = [...registered].sort()
  if (JSON.stringify(registered) !== JSON.stringify(sortedRegistered)) {
    errors.push('extension/adapters/index.json must be sorted')
  }
  if (JSON.stringify(sortedRegistered) !== JSON.stringify(manifestDirectories)) {
    errors.push('registered Adapters must exactly match directories containing manifest.json')
  }

  for (const id of registered) {
    const adapterDir = path.join(adaptersRoot, id)
    const manifestPath = path.join(adapterDir, 'manifest.json')
    const entryPath = path.join(adapterDir, 'index.js')
    if (!fs.existsSync(manifestPath)) {
      errors.push(`missing manifest: extension/adapters/${id}/manifest.json`)
      continue
    }
    const manifest = readJson(manifestPath)
    if (manifest.id !== id) errors.push(`Adapter id mismatch in extension/adapters/${id}/manifest.json`)
    if (!fs.existsSync(entryPath)) errors.push(`missing entrypoint: extension/adapters/${id}/index.js`)
  }

  for (const id of profile.adapters) {
    if (registered.includes(id)) continue
    const managedManifestPath = path.join(managedAdaptersRoot, id, 'manifest.json')
    if (!fs.existsSync(managedManifestPath)) {
      errors.push(`build profile references unregistered Adapter: ${id}`)
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
    'webcli/package.json',
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
