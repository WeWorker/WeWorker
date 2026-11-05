import net from 'node:net';
import { createHash } from 'node:crypto';

// OS-owned loopback mutex: released on process exit, with no stale file to
// delete. Collisions only cause a bounded busy error; never take over a port.
export async function withHostAccountLock(identity, fn, { signal, timeoutMs = 5000 } = {}) {
  const port = 42000 + createHash('sha256').update(identity).digest().readUInt16BE(0) % 18000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled.'), { code: 'SECRET_STORE_CANCELLED' });
    const server = net.createServer(socket => socket.destroy());
    const acquired = await new Promise((resolve, reject) => {
      server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(Object.assign(new Error('Account lock unavailable.'), {code:'SECRET_STORE_IO'})));
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(true));
    });
    if (acquired) {
      try { return await fn(); }
      finally { await new Promise(resolve => server.close(resolve)); }
    }
    if (Date.now() >= deadline) throw Object.assign(new Error('Account is busy; retry later.'), { code: 'SECRET_STORE_BUSY' });
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
