import { randomUUID } from 'node:crypto';
import { invokeHostCli } from './host-cli-runtime.js';
import { executeHostCli } from './host-cli-provider.js';
import { resolveAdapterCall } from './adapter-host.js';
import { hostError } from './host-client.js';
import { adapterHelperPatterns, adapterPrimaryHost, hostMatchesPattern } from './host-scope.js';

/** Reuse the reviewed provider gate; the browser host supplies only scoped cookies. */
export function createHostHelpers(match, args, send, controller = new AbortController()) {
  const dispatch = send;
  send = payload => dispatch(payload, controller.signal);
  const parentId = randomUUID();
  const ws = {};
  const pendingRequests = new Map([[parentId, { ws, controller,
    hostCall: { toolName: `${match.adapter.name}.${match.command.id}`, snapshot: match.snapshot, originalArgs: structuredClone(args) } }]]);
  const abort = () => controller.abort();
  const message = value => { if (value?.type === 'webcli:cancel') abort(); };
  process.on('message', message);
  const request = async (action, payload = {}) => {
    controller.signal.throwIfAborted();
    if (action === 'host_cli_call') {
      try {
        return await invokeHostCli({ parentId, ws, payload, pendingRequests, resolveAdapterCall, execute: executeHostCli,
          authorizeWrite: async request => request.originalConfirmed === true,
          credentials: async request => {
            let url;
            try { url = new URL(request?.url); } catch { throw hostError('HOST_CLI_CONTEXT_INVALID', 'Invalid credential scope.'); }
            const named = Object.hasOwn(request, 'names');
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
              || !adapterHelperPatterns(match.adapter.manifest).some(pattern => hostMatchesPattern(url.hostname, pattern))
              || Object.keys(request).some(key => !['url', 'names'].includes(key))
              || (named && (!Array.isArray(request.names) || !request.names.length || request.names.length > 32))
              || (!named && url.hostname !== adapterPrimaryHost(match.adapter.manifest)
                && !(match.adapter.manifest.runtime_allowed_hosts || []).includes(url.hostname))) {
              throw hostError('HOST_CLI_CONTEXT_INVALID', 'Invalid credential scope.');
            }
            return (await send({ operation: 'adapter.helper', action: 'cookies_get', payload: request })).cookies;
          } });
      } catch (error) {
        const code = /^(HOST_CLI_[A-Z_]+|AUTH_REQUIRED)$/.test(error?.code) ? error.code : 'HOST_CLI_FAILED';
        throw hostError(code, code === 'AUTH_REQUIRED' ? 'Sign in to the service before retrying.' : 'Host CLI operation failed; it was not retried.');
      }
    }
    if (['backend_file_read', 'backend_xlsx_read'].includes(action)) {
      // File inputs must originate in the invocation, not in a site response.
      const paths = Object.values(args).flat().filter(value => typeof value === 'string');
      if (!paths.includes(payload.path)) throw hostError('HOST_FILE_DENIED', 'The file must be supplied in the original command arguments.');
      const helpers = await import('./bridge.js');
      return action === 'backend_file_read' ? helpers.handleBackendRuntimeFileRead(payload) : helpers.handleBackendRuntimeXlsxRead(payload);
    }
    if (action === 'backend_fetch') return send({ ...payload, operation: 'adapter.fetch' });
    if (['cookies_get', 'storage_get', 'main_world_eval', 'browser_fetch', 'download'].includes(action)) {
      return send({ operation: 'adapter.helper', action, payload });
    }
    throw hostError('HOST_UNSUPPORTED_HELPER', `Host helper is unsupported: ${action}`);
  };
  return { request, close() { pendingRequests.clear(); controller.abort(); process.off('message', message); } };
}
