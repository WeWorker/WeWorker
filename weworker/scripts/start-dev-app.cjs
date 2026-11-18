const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { prepareDevElectron } = require('./prepare-dev-electron.cjs')
const { startDevElectron } = require('./start-dev-electron.cjs')

const ROOT = path.resolve(__dirname, '..')
const RENDERER_ROOT = path.join(ROOT, 'renderer')

async function createRenderer(config) {
  const entry = require.resolve('vite', { paths: [RENDERER_ROOT] })
  const { createServer } = await import(pathToFileURL(entry).href)
  return createServer(config)
}

function launchElectron(options) {
  const { build } = require('../package.json')
  const executable = prepareDevElectron({ displayName: build.productName, bundleId: build.appId + '.dev' })
  return startDevElectron({ ...options, executable, args: [] })
}

async function startDevApp({
  createRenderer: createServer = createRenderer,
  launchElectron: launch = launchElectron,
  host = process,
  env = process.env,
} = {}) {
  const { selectRendererPort } = await import('../electron/service-ports.js')
  const requestedPort = env.WEWORKER_RENDERER_PORT === undefined
    ? 5173
    : Number(env.WEWORKER_RENDERER_PORT)
  if (env.WEWORKER_RENDERER_PORT === '') throw new Error('Invalid renderer port')
  const port = await selectRendererPort(requestedPort)
  let renderer
  let electron
  let stopping = false
  const onSignal = signal => {
    stopping = true
    if (electron && !electron.killed) electron.kill(signal)
  }
  const onSigint = () => onSignal('SIGINT')
  const onSigterm = () => onSignal('SIGTERM')
  host.on('SIGINT', onSigint)
  host.on('SIGTERM', onSigterm)

  try {
    renderer = await createServer({
      root: RENDERER_ROOT,
      configFile: path.join(RENDERER_ROOT, 'vite.config.js'),
      server: { host: '127.0.0.1', port, strictPort: false, open: false },
    })
    if (stopping) return
    await renderer.listen()
    if (stopping) return
    const address = renderer.httpServer.address()
    if (!address || typeof address === 'string') throw new Error('Renderer did not bind a TCP port')
    const rendererUrl = 'http://127.0.0.1:' + address.port
    renderer.printUrls?.()
    electron = launch({
      host,
      env: { ...env, NODE_ENV: 'development', WEWORKER_RENDERER_DEV_URL: rendererUrl },
    })
    host.exitCode = await new Promise((resolve, reject) => {
      electron.once('error', reject)
      electron.once('close', code => resolve(code ?? 1))
    })
  } finally {
    host.removeListener('SIGINT', onSigint)
    host.removeListener('SIGTERM', onSigterm)
    await renderer?.close()
  }
}

if (require.main === module) {
  startDevApp().catch(error => {
    console.error('[dev] Cannot start WeWorker: ' + error.message)
    process.exitCode = 1
  })
}

module.exports = { startDevApp }
