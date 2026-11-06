// Only the inherited parent channel is used. There is deliberately no socket
// approval endpoint or environment/session-ID based grant.
export function createParentConfirmationChannel(proc = process) {
  const port = proc.parentPort;
  const send = port ? message => port.postMessage(message) : proc.send ? message => proc.send(message) : null;
  if (!send) return undefined;
  let ready = false;
  const pending = new Map();
  const receive = message => {
    if (message?.type === 'write_confirmation_host_ready') ready = true;
    if (message?.type === 'write_confirmation_decision') pending.get(message.requestId)?.(message.approved === true, message.code);
  };
  if (port) port.on('message', event => receive(event.data));
  else proc.on('message', receive);
  proc.on('disconnect', () => { ready = false; for (const finish of [...pending.values()]) finish(false); });
  send({ type: 'write_confirmation_hello' });
  return async (request, signal) => {
    if (!ready) throw Object.assign(new Error('The host confirmation interface is unavailable. Nothing was submitted.'), { code: 'WRITE_CONFIRMATION_UNAVAILABLE' });
    return new Promise((resolve, reject) => {
      const finish = (approved, code) => {
        pending.delete(request.requestId); signal.removeEventListener('abort', abort);
        if (code === 'WRITE_REVIEW_TOO_LARGE') reject(Object.assign(new Error('The request is too large to review safely. Nothing was submitted.'), { code }));
        else if (code === 'WRITE_CONFIRMATION_UNAVAILABLE') reject(Object.assign(new Error('The host confirmation interface is unavailable. Nothing was submitted.'), { code }));
        else resolve(approved);
      };
      const abort = () => { finish(false); try { send({ type: 'write_confirmation_cancel', requestId: request.requestId }); } catch {} };
      pending.set(request.requestId, finish);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      try { send({ type: 'write_confirmation_request', request }); }
      catch { finish(false, 'WRITE_CONFIRMATION_UNAVAILABLE'); }
    });
  };
}
