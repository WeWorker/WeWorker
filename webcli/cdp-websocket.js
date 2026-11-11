/**
 * CDP client over a browser-endpoint WebSocket.
 *
 * Same interface contract as createCdpPipe (send/onEvent/closed/close) so
 * BrowserHost consumers are transport-agnostic. Used by the attach mode of the
 * Browser Keeper design: the Bridge connects to an already-running Chrome via
 * the dynamic debugging port recorded in DevToolsActivePort, instead of owning
 * the Chrome pipe (which dies with the Bridge).
 */
import { WebSocket } from "ws";

/**
 * @param {string} url ws://127.0.0.1:<port>/devtools/browser/<id>
 * @param {{timeoutMs?: number}} opts
 */
export function createCdpWebSocket(url, { timeoutMs = 10_000 } = {}) {
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const listeners = new Set();
  const ws = new WebSocket(url, { perMessageDeflate: false });

  const failAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  const onClose = () => {
    if (closed) return;
    closed = true;
    failAll(new Error("Browser connection closed"));
  };

  /** Resolves once the socket is open; rejects on close/error/timeout. */
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP websocket connect timed out")), timeoutMs);
    timer.unref?.();
    ws.once("open", () => { clearTimeout(timer); resolve(); });
    ws.once("error", (e) => { clearTimeout(timer); reject(e); });
    ws.once("close", () => { clearTimeout(timer); onClose(); });
  });

  ws.on("message", (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(Object.assign(new Error(message.error.message || "CDP error"), { code: message.error.code }));
      else entry.resolve(message.result ?? {});
    } else if (message.method) {
      for (const listener of listeners) listener(message);
    }
  });
  ws.on("close", onClose);
  ws.on("error", onClose);

  // Resolves to the client interface once the socket is open; rejects on
  // connect failure/timeout (attach callers await this).
  return ready.then(() => ({
    send(method, params = {}, sessionId) {
      if (closed || ws.readyState !== 1) return Promise.reject(new Error("Browser connection closed"));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get closed() { return closed; },
    close: () => { closed = true; try { ws.close(); } catch {} onClose(); },
  }));
}
