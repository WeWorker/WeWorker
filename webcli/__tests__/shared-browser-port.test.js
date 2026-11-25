import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { WebSocketServer } from 'ws';
import { connectSharedBrowser, runBrowserControlStdio } from '../shared-browser-client.js';

afterEach(() => vi.unstubAllEnvs());

it('shared browser control connects to the host-selected Bridge port', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  vi.stubEnv('WEBCLI_BRIDGE_PORT', String(server.address().port));
  vi.stubEnv('WEWORKER_WEBCLI_DISTRIBUTION', 'desktop');
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw);
    socket.send(JSON.stringify({ type: 'shared_browser_result', id: message.id, ok: true, data: { status: 'running' } }));
  }));
  let client;
  try {
    client = await connectSharedBrowser();
    expect(await client.request('status')).toEqual({ status: 'running' });
  } finally {
    client?.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});

it('terminates the WebSocket immediately when parentPid disappears during an in-flight request', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  let closedOnServer = false;
  let serverReceivedRequest;
  const requestReceived = new Promise(resolve => { serverReceivedRequest = resolve; });
  server.on('connection', socket => {
    socket.on('message', () => {
      // Intentionally never reply to simulate a hung Bridge/acquire call.
      serverReceivedRequest();
    });
    socket.on('close', () => { closedOnServer = true; });
  });

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let killCalls = 0;
  const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
    if (pid === 999999 && sig === 0) {
      killCalls += 1;
      if (killCalls >= 2) {
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }
    return true;
  });

  try {
    const runPromise = runBrowserControlStdio({
      ensureBridgeRunning: async () => {},
      checkRunning: async () => true,
      stdin,
      stdout,
      connect: () => connectSharedBrowser({ url: `ws://127.0.0.1:${port}`, timeoutMs: 30000 }),
      parentPid: 999999,
      parentPollMs: 50,
    });
    stdin.write(JSON.stringify({ id: 1, action: 'acquire', params: {} }) + '\n');
    await requestReceived;
    const started = Date.now();
    await runPromise;
    expect(Date.now() - started).toBeLessThan(2000);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(closedOnServer).toBe(true);
  } finally {
    killSpy.mockRestore();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});
