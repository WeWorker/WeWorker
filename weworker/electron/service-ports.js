import { createServer } from 'node:net'

export const DEFAULT_SERVICE_PORTS = Object.freeze({ backend: 8765, exploration: 8766, bridge: 3711 })

function bind(port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(server))
  })
}

export async function selectServicePorts(preferred = DEFAULT_SERVICE_PORTS) {
  const servers = []
  const ports = {}
  try {
    for (const name of Object.keys(DEFAULT_SERVICE_PORTS)) {
      const port = preferred[name]
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid ${name} port`)
      let server
      try { server = await bind(port) }
      catch (error) {
        if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error
        server = await bind(0)
      }
      servers.push(server)
      ports[name] = server.address().port
    }
    return ports
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  }
}
