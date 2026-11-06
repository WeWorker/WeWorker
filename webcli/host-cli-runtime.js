import { usesBackgroundExecution } from './conditional-execution.js';
import { normalizeHostArguments, hostArgumentError } from './host-cli-arguments.js';

// Correlate a helper request with the original, host-owned Adapter invocation.
// Adapter-provided identities, paths and process arguments are never accepted.
function canonicalArgs(value, root = false) {
  if (Array.isArray(value)) return value.map(entry => canonicalArgs(entry));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !root || key !== '__confirmed')
    .map(key => [key, canonicalArgs(value[key])]));
  return value;
}

export async function invokeHostCli({ parentId, ws, payload, pendingRequests, resolveAdapterCall, execute, credentials,
  authorizeWrite = async () => false, timeoutMs = 55000 }) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const pending = typeof parentId === 'string' ? pendingRequests.get(parentId) : null;
  if (!pending || pending.ws !== ws || !pending.hostCall || pending.controller?.signal.aborted) {
    fail('HOST_CLI_CONTEXT_INVALID', 'The host invocation is no longer active.');
  }
  if (pending.hostCliStarted) fail('HOST_CLI_ALREADY_CALLED', 'Only one host CLI call is allowed per invocation.');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'args')
    || !payload.args || typeof payload.args !== 'object' || Array.isArray(payload.args)) {
    fail('HOST_CLI_INVALID_ARGUMENT', 'Invalid host CLI request.');
  }
  let encoded;
  try { encoded = JSON.stringify(payload.args); } catch { fail('HOST_CLI_INVALID_ARGUMENT', 'Invalid host CLI request.'); }
  if (Buffer.byteLength(encoded) > 64 * 1024) fail('HOST_CLI_INVALID_ARGUMENT', 'Host CLI arguments exceed the limit.');
  const selected = resolveAdapterCall(pending.hostCall.toolName);
  const snapshot = pending.hostCall.snapshot;
  if (!selected || selected.adapter.source !== 'builtin'
    || selected.snapshot.name !== snapshot.name || selected.snapshot.digest !== snapshot.digest
    || selected.snapshot.profile !== snapshot.profile || selected.command.runtime !== 'extension'
    || !usesBackgroundExecution(selected.command, pending.hostCall.originalArgs)
    || !['read', 'write'].includes(selected.command.safety)
    || (selected.command.safety === 'read' && selected.command.requires_confirmation === true)) {
    fail('HOST_CLI_CONTEXT_INVALID', 'The selected Adapter command cannot use this host capability.');
  }
  // Reserve before awaiting: duplicate helper requests must not trigger a second
  // authentication creation or child process even after a failed attempt.
  pending.hostCliStarted = true;
  const signal = pending.controller.signal;
  const active = () => !signal.aborted && pendingRequests.get(parentId) === pending && pending.ws === ws;
  if (!active()) fail('HOST_CLI_CONTEXT_INVALID', 'The host invocation is no longer active.');
  const timer = setTimeout(() => pending.controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let executionArgs = payload.args;
    if (selected.command.safety === 'write') {
      let original, requested;
      // Normalize both representations against the same host-resolved schema.
      // Use the captured call for authorization AND execution, never helper data.
      const normalized = canonicalArgs(normalizeHostArguments(pending.hostCall.originalArgs, selected.command.schema), true);
      original = JSON.stringify(normalized);
      const helper = canonicalArgs(normalizeHostArguments(payload.args, selected.command.schema), true);
      requested = JSON.stringify(helper);
      if (!original || original !== requested) {
        const field = Object.keys(selected.command.schema?.properties || {}).find(key =>
          JSON.stringify(normalized?.[key]) !== JSON.stringify(helper?.[key]));
        throw hostArgumentError('changed', field);
      }
      executionArgs = normalized;
      // Enforce the selected command's existing confirmation policy against
      // the original Bridge invocation, never the Adapter helper's payload.
      const approved = await authorizeWrite({ invocationId: parentId, connection: ws,
        adapter: { ...selected.snapshot }, command: { id: selected.command.id, safety: 'write' },
        args: structuredClone(executionArgs), signal,
        requiresConfirmation: selected.command.requires_confirmation ?? true,
        permit: pending.hostCall.permit, selected });
      if (!active()) fail('HOST_CLI_CONTEXT_INVALID', 'The host invocation is no longer active.');
      if (approved !== true) fail('HOST_CLI_CONFIRMATION_REQUIRED', 'Verified user confirmation is required.');
    }
    const result = await execute({
    adapter: Object.freeze({ name: selected.snapshot.name, digest: selected.snapshot.digest, profile: selected.snapshot.profile }),
    command: Object.freeze({ id: selected.command.id, safety: selected.command.safety }),
    args: executionArgs,
    signal,
    markWriteDispatched: selected.command.safety === 'write' ? () => {
      if (!active() || pending.hostWriteDispatched) fail('HOST_CLI_CONTEXT_INVALID', 'The write invocation is no longer active.');
      pending.hostWriteDispatched = true;
    } : undefined,
    credentials: Object.freeze({ cookies: async request => {
      if (!active()) fail('HOST_CLI_CONTEXT_INVALID', 'The host invocation is no longer active.');
      const value = await credentials(request, selected);
      if (!active()) fail('HOST_CLI_CONTEXT_INVALID', 'The host invocation is no longer active.');
      return value;
    } }),
    });
    if (!active()) fail(pending.hostWriteDispatched ? 'HOST_CLI_OUTCOME_UNKNOWN' : 'HOST_CLI_CONTEXT_INVALID', 'The host invocation is no longer active.');
    if (selected.command.safety === 'write' && !pending.hostWriteDispatched) fail('HOST_CLI_OUTCOME_UNKNOWN', 'Write dispatch was not reported.');
    return result;
  } catch (error) {
    if (pending.hostWriteDispatched) fail('HOST_CLI_OUTCOME_UNKNOWN', 'The write result is unknown; inspect the target before retrying.');
    throw error;
  } finally { clearTimeout(timer); }
}
