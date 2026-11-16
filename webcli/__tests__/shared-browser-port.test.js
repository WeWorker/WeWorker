import { afterEach, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { connectSharedBrowser } from '../shared-browser-client.js';

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
