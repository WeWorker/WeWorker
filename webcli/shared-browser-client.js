import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

/** A persistent local control connection. No CDP traffic is proxied here. */
export async function connectSharedBrowser({ url = 'ws://127.0.0.1:3711', timeoutMs = 45000 } = {}) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let onLost = () => {};
  const fail = () => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('共享浏览器连接已断开；请检查执行结果，不自动重试')); }
    pending.clear(); onLost();
  };
  socket.on('close', fail);
  socket.on('error', () => {});
  socket.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'browser_lease_lost') { fail(); socket.close(); return; }
    if (message.type !== 'shared_browser_result') return;
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.ok) item.resolve(message.data);
    else item.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Bridge connection timed out')); }, 3000);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
  return {
    onLost(callback) { onLost = callback; },
    request(action, params = {}) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Bridge connection closed'));
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); socket.terminate(); reject(new Error('Browser control timed out')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ type: 'shared_browser', id, action, params }));
      });
    },
    close() { socket.close(); },
  };
}

export async function runBrowserControlStdio({ ensureBridgeRunning, checkRunning }) {
  const input = createInterface({ input: process.stdin });
  let client;
  let chain = Promise.resolve();
  const write = value => process.stdout.write(JSON.stringify(value) + '\n');
  const parentPid = Number(process.env.WEWORKER_TOOLKIT_PARENT_PID);
  const parentTimer = Number.isInteger(parentPid) && parentPid > 0 ? setInterval(() => {
    try { process.kill(parentPid, 0); } catch (error) {
      if (error.code === 'ESRCH') { write({ event: 'disconnected' }); input.close(); process.stdin.destroy(); }
    }
  }, 1000) : null;
  input.on('line', line => {
    chain = chain.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
        if (!['status', 'acquire', 'claim', 'release'].includes(message.action)) throw new Error('Invalid browser control action');
        if (!client) {
          if (message.action === 'status') {
            if (!await checkRunning()) {
              write({ id: message.id, ok: true, data: { status: 'stopped', cdpReady: false } }); return;
            }
          } else {
            await ensureBridgeRunning();
          }
          client = await connectSharedBrowser();
          client.onLost(() => { write({ event: 'disconnected' }); input.close(); process.stdin.destroy(); });
        }
        write({ id: message.id, ok: true, data: await client.request(message.action, message.params) });
      } catch (error) { write({ id: message?.id, ok: false, error: { code: error.code || 'BROWSER_CONTROL_FAILED', message: error.message } }); }
    });
  });
  await new Promise(resolve => input.once('close', resolve));
  clearInterval(parentTimer);
  await chain;
  client?.close();
}
