import { CommandExecutionError } from './errors.js';

// Do not discard a real signed response and replace it with an unsigned query.
// A success acknowledgement without a list is not proof of an empty account.
export function validateCreatorCaptures(captures) {
  for (const [url, capture] of Object.entries(captures || {})) {
    if (!url.includes('/note/analyze/list')) continue;
    if (!capture?.ok) throw new CommandExecutionError('Creator analytics list HTTP ' + capture?.status);
    let body;
    try { body = JSON.parse(capture.body); } catch { throw new CommandExecutionError('Creator analytics list returned non-JSON'); }
    if (body?.success === false || body?.data?.result?.success === false) throw new CommandExecutionError('Creator analytics list request was rejected');
    if (!Array.isArray(body?.data?.note_infos)) throw new CommandExecutionError('Creator analytics response missing note_infos; cannot determine whether the account has notes');
  }
}
