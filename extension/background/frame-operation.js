// A deadline must bound the awaited Chrome promise, not just its dispatch.
// Chrome calls cannot be cancelled: after a timeout their result is discarded
// and the latched error prevents every subsequent dispatch in this operation.
export function createFrameOperation({ deadline = Date.now() + 30000, assertRunning = () => {},
  timeoutCode = 'FRAME_OPERATION_TIMEOUT', timeoutMessage = 'Frame operation timed out. An in-flight action may have happened; do not replay it automatically.' } = {}) {
  let stopped;
  const check = (limit = deadline) => {
    if (stopped) throw stopped;
    try {
      assertRunning();
      if (Date.now() >= Math.min(deadline, limit)) throw Object.assign(new Error(timeoutMessage), { code: timeoutCode });
    } catch (error) { stopped = error; throw error; }
  };
  const run = async (operation, limit = deadline) => {
    check(limit);
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        const poll = () => {
          try { check(limit); }
          catch (error) { reject(error); return; }
          timer = setTimeout(poll, Math.min(50, Math.max(1, Math.min(deadline, limit) - Date.now())));
        };
        poll();
        Promise.resolve().then(() => { check(limit); return operation(); }).then(value => {
          try { check(limit); resolve(value); } catch (error) { reject(error); }
        }, reject);
      });
    } finally { clearTimeout(timer); }
  };
  return { check, run };
}

// Cleanup has its own small budget, including after cancellation. Never wait
// forever for a removed renderer, and never clean a successor document.
export async function settleFrameCleanup(operation) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      new Promise(resolve => { timer = setTimeout(resolve, 1000); }),
    ]);
  } catch { /* A removed document/session owns no reusable cleanup target. */ }
  finally { clearTimeout(timer); }
}
