const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const WEWORKER_ROOT = path.resolve(__dirname, '..')
const { normalizeDeploymentConfig } = require('../deployment-config.cjs')

function buildElectronArgs(target, platform = process.platform, arch = process.arch) {
  if (target === '--mac') {
    if (platform !== 'darwin') throw new Error('macOS packages must be built on macOS')
    if (arch !== 'arm64' && arch !== 'x64') throw new Error(`Unsupported macOS architecture: ${arch}`)
    return ['--mac', `--${arch}`]
  }
  if (target === '--win') {
    if (platform !== 'win32') throw new Error('Windows packages must be built on Windows')
    if (arch !== 'x64') throw new Error(`Windows packages require x64; got ${arch}`)
    return ['--win', '--x64']
  }
  throw new Error(`Expected --mac or --win; got ${target || 'nothing'}`)
}

function buildElectronCommand(
  target,
  platform = process.platform,
  arch = process.arch,
  nodeExecutable = process.execPath,
  cliPath = require.resolve('electron-builder/cli.js'),
  configPath,
) {
  const args = [cliPath, ...buildElectronArgs(target, platform, arch)]
  if (configPath) args.push('--config', configPath)
  return {
    executable: nodeExecutable,
    args,
  }
}

function createElectronBuilderConfig({ root = WEWORKER_ROOT, outputPath } = {}) {
  const packagePath = path.join(root, 'package.json')
  const deploymentPath = path.join(root, 'deployment.json')
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  const deployment = normalizeDeploymentConfig(JSON.parse(fs.readFileSync(deploymentPath, 'utf8')))
  const config = {
    ...packageJson.build,
    publish: [{ provider: 'generic', url: deployment.downloadUrl }],
  }
  const targetPath = outputPath || path.join(root, 'build', '.electron-builder-config.json')
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return targetPath
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) throw new Error('Usage: node scripts/build-electron-current-arch.cjs --mac|--win')
  const configPath = createElectronBuilderConfig()
  const { executable, args } = buildElectronCommand(argv[0], process.platform, process.arch, process.execPath, require.resolve('electron-builder/cli.js'), configPath)
  const result = spawnSync(executable, args, { cwd: path.resolve(__dirname, '..'), stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`electron-builder exited with code ${result.status}`)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`[build] ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = { buildElectronArgs, buildElectronCommand, createElectronBuilderConfig }
