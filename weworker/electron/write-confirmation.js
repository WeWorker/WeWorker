/** Native decisions only; no renderer IPC accepts an approval boolean. */
export function attachWriteConfirmation(child, { dialog, isCurrent, now = Date.now }) {
  const cancelled = new Set();
  const dialogs = new Map();
  child.on('exit', () => { for (const controller of dialogs.values()) controller.abort(); });
  let queue = Promise.resolve();
  const send = message => {
    if (!isCurrent()) return;
    if (typeof child.postMessage === 'function') child.postMessage(message);
    else if (child.connected) child.send(message);
  };
  child.on('message', message => {
    if (message?.type === 'write_confirmation_hello') send({ type: 'write_confirmation_host_ready' });
    if (message?.type === 'write_confirmation_cancel') { cancelled.add(message.requestId); dialogs.get(message.requestId)?.abort(); }
    if (message?.type !== 'write_confirmation_request') return;
    const request = message.request;
    if (!request || typeof request.requestId !== 'string' || typeof request.tool !== 'string' || !Number.isFinite(request.expiresAt)) return;
    queue = queue.then(async () => {
      let approved = false, code, timer;
      try {
        if (!isCurrent() || cancelled.has(request.requestId) || now() >= request.expiresAt) return;
        const detail = JSON.stringify({ tool: request.tool, adapter: request.adapter, context: request.scope, arguments: request.args }, null, 2);
        // Never approve a truncated review. Sensitive fields are displayed only
        // in this local native window, never in logs or model-facing events.
        if (detail.length > 16_000) { code = 'WRITE_REVIEW_TOO_LARGE'; return; }
        const controller = new AbortController(); dialogs.set(request.requestId, controller);
        timer = setTimeout(() => controller.abort(), Math.max(0, request.expiresAt - now())); timer.unref?.();
        const result = await dialog.showMessageBox({ type: 'question', title: 'WeWorker · 等待确认',
          signal: controller.signal,
          message: '确认提交此操作？', detail: `${detail}\n\n此确认仅执行以上请求一次，5 分钟内有效。取消或过期不会提交。`,
          buttons: ['取消', '确认提交一次'], defaultId: 0, cancelId: 0, noLink: true });
        approved = result.response === 1 && isCurrent() && !cancelled.has(request.requestId) && now() < request.expiresAt;
      } catch { code = 'WRITE_CONFIRMATION_UNAVAILABLE'; } finally {
        clearTimeout(timer); dialogs.delete(request.requestId);
        cancelled.delete(request.requestId);
        send({ type: 'write_confirmation_decision', requestId: request.requestId, approved, ...(code ? { code } : {}) });
      }
    }).catch(() => {});
  });
}
