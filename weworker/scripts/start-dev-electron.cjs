const path = require('node:path')
const { spawn } = require('node:child_process')
const { prepareDevElectron } = require('./prepare-dev-electron.cjs')

function startDevElectron({ executable, args = process.argv.slice(2), spawnProcess = spawn, host = process } = {}) {
  const child = spawnProcess(executable, ['.', ...args], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    windowsHide: false,
  })
  const forward = (signal) => { if (!child.killed) child.kill(signal) }
  const onSigint = () => forward('SIGINT')
  const onSigterm = () => forward('SIGTERM')
  const cleanup = () => {
    host.removeListener('SIGINT', onSigint)
    host.removeListener('SIGTERM', onSigterm)
  }
  host.on('SIGINT', onSigint)
  host.on('SIGTERM', onSigterm)
  child.on('error', (error) => {
    cleanup()
    console.error(`[dev] Cannot start WeWorker: ${error.message}`)
    host.exitCode = 1
  })
  child.on('close', (code) => {
    cleanup()
    host.exitCode = code === null ? 1 : code
  })
  return child
}

if (require.main === module) {
  try {
    const { build } = require('../package.json')
    const executable = prepareDevElectron({ displayName: build.productName, bundleId: `${build.appId}.dev` })
    startDevElectron({ executable })
  } catch (error) {
    console.error(`[dev] Cannot prepare WeWorker: ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = { startDevElectron }
