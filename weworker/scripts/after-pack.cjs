const { execFileSync } = require('child_process')
const path = require('path')
const { validatePackagedClaude } = require('./validate-claude-native.cjs')
const { validatePackagedNode } = require('./prepare-node-runtime.cjs')

function buildAdHocSignCommands(appPath) {
  return [
    ['--force', '--deep', '--sign', '-', appPath],
    ['--verify', '--deep', '--strict', '--verbose=4', appPath],
  ]
}

function afterPack(context, run = execFileSync, validate = validatePackagedClaude, validateNode = validatePackagedNode) {
  const arch = typeof context.arch === 'string'
    ? context.arch : { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[context.arch]
  const resourcesPath = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  validate(resourcesPath, context.electronPlatformName, arch)
  validateNode(resourcesPath, context.electronPlatformName, arch)
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )
  for (const args of buildAdHocSignCommands(appPath)) {
    run('/usr/bin/codesign', args, { stdio: 'inherit' })
  }
}

module.exports = afterPack
module.exports.buildAdHocSignCommands = buildAdHocSignCommands
