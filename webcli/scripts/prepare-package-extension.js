import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { validateBuiltinOutput } from '../builtin-adapter-build.js'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const defaultWebcliDir = path.resolve(scriptDir, '..')
const defaultSourceExtensionDir = path.resolve(defaultWebcliDir, '..', 'extension')

const EXCLUDED_DIRS = new Set(['.git', 'node_modules'])
const EXCLUDED_FILE_SUFFIXES = [
  '.index-snippet.generated.txt',
  '.integration.generated.md',
]

/** The npm executable uses its own Bridge; the copied worker is the only file rewritten. */
export const NPM_BRIDGE_URL = 'ws://127.0.0.1:3712'
const DESKTOP_BRIDGE_URL = 'ws://localhost:3711'
const WORKER_RELATIVE_PATH = path.join('background', 'service-worker.js')

export function expectedPackagedWorker(contents) {
  const text = Buffer.isBuffer(contents) ? contents.toString('utf8') : String(contents)
  const constant = `const WS_URL = "${DESKTOP_BRIDGE_URL}";`
  const occurrences = text.split(constant).length - 1
  if (occurrences !== 1) {
    throw new Error(`npm extension worker must declare ${constant} exactly once; found ${occurrences}`)
  }
  return Buffer.from(text.replaceAll(DESKTOP_BRIDGE_URL, NPM_BRIDGE_URL), 'utf8')
}

function assertRegularDirectory(root) {
  const stat = fs.lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Package resource root must be a regular directory: ${root}`)
}

function readWorker(extensionDir) {
  const workerPath = path.join(extensionDir, WORKER_RELATIVE_PATH)
  if (!fs.existsSync(workerPath)) throw new Error(`Extension worker not found: ${workerPath}`)
  return fs.readFileSync(workerPath)
}

function assertCopyEntry(entry, sourcePath) {
  if (entry.isSymbolicLink()) throw new Error(`Package resource must not be a symbolic link: ${sourcePath}`)
  if (!entry.isDirectory() && !entry.isFile()) throw new Error(`Package resource must be a regular file or directory: ${sourcePath}`)
}

export function syncPackageExtension({
  webcliDir = defaultWebcliDir,
  sourceExtensionDir = defaultSourceExtensionDir,
  sourceBuiltinDir,
} = {}) {
  if (!fs.existsSync(sourceExtensionDir)) {
    throw new Error(`extension source directory not found: ${sourceExtensionDir}`)
  }
  assertRegularDirectory(sourceExtensionDir)
  if (sourceBuiltinDir) validateBuiltinOutput(sourceBuiltinDir)
  const targetExtensionDir = path.join(webcliDir, 'extension')
  const sourceWorker = readWorker(sourceExtensionDir)
  const packagedWorker = expectedPackagedWorker(sourceWorker)
  fs.rmSync(targetExtensionDir, { recursive: true, force: true })
  const fileCount = copyDirectory(sourceExtensionDir, targetExtensionDir, sourceExtensionDir)
  fs.writeFileSync(path.join(targetExtensionDir, WORKER_RELATIVE_PATH), packagedWorker)
  if (sourceBuiltinDir) {
    const targetBuiltinDir = path.join(webcliDir, 'adapters')
    fs.rmSync(targetBuiltinDir, { recursive: true, force: true })
    copyDirectory(sourceBuiltinDir, targetBuiltinDir, sourceBuiltinDir)
  }
  return { sourceExtensionDir, targetExtensionDir, fileCount }
}

export function checkPackageResources({ webcliDir = defaultWebcliDir, sourceExtensionDir, sourceBuiltinDir }) {
  assertRegularDirectory(sourceExtensionDir)
  validateBuiltinOutput(sourceBuiltinDir)
  validateBuiltinOutput(path.join(webcliDir, 'adapters'))
  for (const [source, target] of [
    [sourceExtensionDir, path.join(webcliDir, 'extension')],
    [sourceBuiltinDir, path.join(webcliDir, 'adapters')],
  ]) {
    assertRegularDirectory(target)
    const list = (dir, root = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(dir, entry.name)
      assertCopyEntry(entry, file)
      if (shouldSkipEntry(entry, file, root)) return []
      return entry.isDirectory() ? list(file, root) : [path.relative(root, file)]
    }).sort()
    const sourceFiles = list(source)
    if (JSON.stringify(sourceFiles) !== JSON.stringify(list(target))) throw new Error('Package resource set is stale; synchronize the prepared profile.')
    for (const file of sourceFiles) {
      const sourceBytes = fs.readFileSync(path.join(source, file))
      const expected = source === sourceExtensionDir && file === WORKER_RELATIVE_PATH
        ? expectedPackagedWorker(sourceBytes)
        : sourceBytes
      if (!expected.equals(fs.readFileSync(path.join(target, file)))) {
        throw new Error('Package resource content is stale; synchronize the prepared profile.')
      }
    }
  }
}

function copyDirectory(sourceDir, targetDir, sourceRoot) {
  let fileCount = 0
  fs.mkdirSync(targetDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    assertCopyEntry(entry, sourcePath)
    if (shouldSkipEntry(entry, sourcePath, sourceRoot)) continue
    if (entry.isDirectory()) {
      fileCount += copyDirectory(sourcePath, targetPath, sourceRoot)
    } else {
      fs.copyFileSync(sourcePath, targetPath)
      fileCount += 1
    }
  }
  return fileCount
}

function shouldSkipEntry(entry, sourcePath, sourceRoot) {
  if (entry.isDirectory()) {
    return EXCLUDED_DIRS.has(entry.name) || path.relative(sourceRoot, sourcePath) === 'test'
  }
  return EXCLUDED_FILE_SUFFIXES.some(suffix => entry.name.endsWith(suffix))
}

/**
 * Generate the packaged metrics defaults next to the npm entrypoint. The
 * checkout's model.json decides: a public model without metrics configuration
 * always writes `{enabled:false}`; an enabled model requires a build-time
 * `WEBCLI_METRICS_CLIENT_TOKEN` (or the explicit test-build opt-out).
 */
export function syncPackageMetrics({ webcliDir = defaultWebcliDir, modelPath, env = process.env } = {}) {
  const requireCjs = createRequire(import.meta.url)
  const { prepareMetricsClientConfig } = requireCjs(path.resolve(defaultWebcliDir, '..', 'weworker/scripts/metrics-client-config.cjs'))
  return prepareMetricsClientConfig({
    modelPath,
    outputPath: path.join(webcliDir, 'metrics-client.json'),
    env,
  })
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectExecution) {
  const repoRoot = path.resolve(defaultWebcliDir, '..')
  const internalEntry = path.join(repoRoot, 'internal/scripts/run-profile-build.cjs')
  const prepareArgs = fs.existsSync(internalEntry) ? [internalEntry, 'prepare'] : [path.join(repoRoot, 'weworker/scripts/prepare-build.cjs')]
  execFileSync(process.execPath, prepareArgs, { cwd: repoRoot, stdio: 'inherit' })
  const result = syncPackageExtension({
    sourceExtensionDir: path.join(repoRoot, 'weworker/build/extension-dist'),
    sourceBuiltinDir: path.join(repoRoot, 'weworker/build/builtin-adapters'),
  })
  const metrics = syncPackageMetrics({
    webcliDir: defaultWebcliDir,
    modelPath: path.join(repoRoot, 'weworker/model.json'),
  })
  console.log(`[prepare-package-extension] copied ${result.fileCount} file(s) from ${result.sourceExtensionDir} to ${result.targetExtensionDir}`)
  console.log(`[prepare-package-extension] metrics-client.json: ${metrics.enabled ? 'enabled' : 'disabled'}`)
}
