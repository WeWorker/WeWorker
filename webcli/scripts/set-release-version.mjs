import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptFile = fileURLToPath(import.meta.url)
const defaultRoot = path.resolve(path.dirname(scriptFile), '..')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function applyReleaseVersion(version, root = defaultRoot) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[+-][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid WebCLI version: ${version}`)
  }

  const packageFile = path.join(root, 'package.json')
  const lockFile = path.join(root, 'package-lock.json')
  const versionFile = path.join(root, 'version.json')
  const pluginFile = path.join(root, '.claude-plugin', 'plugin.json')
  const skillFile = path.join(root, 'skills', 'webcli', 'SKILL.md')

  const packageJson = readJson(packageFile)
  const packageLock = readJson(lockFile)
  if (!packageLock.packages?.['']) {
    throw new Error('package-lock.json is missing the root package entry')
  }
  const versionJson = readJson(versionFile)
  const pluginJson = readJson(pluginFile)
  const skill = fs.readFileSync(skillFile, 'utf8')
  if (!/^version:\s*\S+$/m.test(skill)) {
    throw new Error('SKILL.md frontmatter is missing the version field')
  }

  packageJson.version = version
  packageLock.version = version
  packageLock.packages[''].version = version
  versionJson.version = version
  pluginJson.version = version

  writeJson(packageFile, packageJson)
  writeJson(lockFile, packageLock)
  writeJson(versionFile, versionJson)
  writeJson(pluginFile, pluginJson)
  fs.writeFileSync(skillFile, skill.replace(/^version:\s*\S+$/m, `version: ${version}`))
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  try {
    applyReleaseVersion(process.argv[2])
    process.stdout.write(`WebCLI release version set to ${process.argv[2]}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
