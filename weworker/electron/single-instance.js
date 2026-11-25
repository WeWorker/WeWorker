import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Electron keys its lock by userData. Use the same lock directory across profiles
// while leaving each instance's actual data directory in place.
export async function acquireDesktopInstance(app, onTakeover, {
  timeoutMs = 45_000,
  retryMs = 350,
  launch = { launchedAt: Math.trunc(performance.timeOrigin), pid: process.pid },
  appData = process.platform === 'win32' && path.isAbsolute(process.env.APPDATA || '')
    ? process.env.APPDATA
    : app.getPath('appData'),
} = {}) {
  const lockPath = path.join(appData, 'WeWorker Desktop Instance')
  fs.mkdirSync(lockPath, { recursive: true })
  const requestLock = () => {
    const userData = app.getPath('userData')
    app.setPath('userData', lockPath)
    try {
      return app.requestSingleInstanceLock(launch)
    } finally {
      app.setPath('userData', userData)
    }
  }

  function handleSecondInstance(_event, _argv, _cwd, contender) {
    if (!Number.isSafeInteger(contender?.launchedAt) || !Number.isSafeInteger(contender?.pid)) return
    if (contender.launchedAt > launch.launchedAt || (contender.launchedAt === launch.launchedAt && contender.pid > launch.pid)) {
      onTakeover()
    }
  }

  app.on('second-instance', handleSecondInstance)
  const deadline = Date.now() + timeoutMs
  do {
    if (requestLock()) return true
    if (Date.now() >= deadline) break
    await delay(retryMs)
  } while (true)
  app.off('second-instance', handleSecondInstance)
  return false
}
