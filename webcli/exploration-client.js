import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { bridgeUrl, resolveBridgeInstance } from './bridge-instance.js';

const DEFAULT_BRIDGE_URL = bridgeUrl(resolveBridgeInstance());

export function callExploration(command, args, options = {}) {
  return callLocalCommand('exploration', command, args, options);
}

export function callLocalCommand(namespace, command, args, { url = DEFAULT_BRIDGE_URL, timeoutMs = 20000, signal, profile = process.env.WEBCLI_PROFILE, connectionId } = {}) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve({ schemaVersion: 1, ok: false, command: `${namespace}.${command}`, error: { code: 'ABORTED', message: 'Local request canceled.' } }); return; }
    const socket = new WebSocket(url);
    const id = `${namespace}-${randomUUID()}`;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.close(); resolve(result);
    };
    const error = (code, message) => finish({ schemaVersion: 1, ok: false, command: `${namespace}.${command}`, error: { code, message } });
    const abort = () => { error('ABORTED', 'Local request canceled.'); socket.terminate(); };
    const timer = setTimeout(() => {
      error('TIMEOUT', namespace === 'exploration' && command === 'export' ? 'Diagnostic export wait expired. Inspect the selected directory and receipt; never overwrite a partial export.' : namespace === 'browser' ? 'Bridge did not respond. Inspect the browser state before retrying an action.' : 'Bridge did not respond. Check its version; use the same requestId to retry start without duplicating a task.');
      socket.terminate();
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('open', () => socket.send(JSON.stringify({ type: `${namespace}_command`, id, command, args, ...(profile !== undefined ? { browserProfile: profile } : {}), ...(connectionId ? { browserConnectionId: connectionId } : {}) })));
    socket.on('message', data => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.id === id && message.type === `${namespace}_command_result`) finish(message.result);
    });
    socket.on('error', () => error('BRIDGE_UNAVAILABLE', 'Start WebCLI Bridge with webcli service start -d. No desktop client is needed.'));
    socket.on('close', () => error('BRIDGE_DISCONNECTED', namespace === 'exploration' && command === 'export' ? 'Bridge disconnected. Inspect the selected export directory and receipt; partial files are retained.' : namespace === 'browser' ? 'Bridge disconnected. Inspect browser.sessions and the current observation before resuming.' : 'Bridge disconnected; reconnect and inspect exploration.list before retrying.'));
  });
}
