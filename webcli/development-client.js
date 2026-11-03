import { developmentCommands } from './development-commands.js';
import { callDevelopmentInstall } from './development-install-client.js';

const BASE = 'http://127.0.0.1:8766';
const MAX_BYTES = 2 * 1024 * 1024;

/** Fixed loopback endpoint, host identity check, no process startup and no retry. */
export async function callDevelopment(command, args, { fetch: fetcher = globalThis.fetch, env = process.env } = {}) {
  const failure = (code, message) => ({ schemaVersion: 1, ok: false, command: `development.${command}`, error: { code, message } });
  const spec = developmentCommands[command];
  if (!spec) return failure('UNKNOWN_COMMAND', 'Use webcli call development.help.');
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || spec.required.some(key => !Object.hasOwn(args, key))
      || Object.keys(args).some(key => ![...spec.required, ...(spec.optional || [])].includes(key))) {
    return failure('INVALID_ARGUMENT', 'Use exactly the documented required and optional arguments.');
  }
  const identity = env.WEWORKER_EXPLORATION_INSTANCE_ID;
  if (typeof identity !== 'string' || !identity.trim()) return failure('HOST_IDENTITY_REQUIRED', 'Run in the desktop host environment with WEWORKER_EXPLORATION_INSTANCE_ID. No service was started or adopted.');
  if (['review', 'apply'].includes(command)) return callDevelopmentInstall(command, args, { fetch: fetcher, env });
  const body = JSON.stringify(args);
  if (Buffer.byteLength(body) > MAX_BYTES) return failure('INPUT_TOO_LARGE', 'Development arguments exceed 2 MiB.');
  let submitted = false;
  try {
    const health = await fetcher(`${BASE}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!health.ok) return failure('SERVICE_UNAVAILABLE', 'Website exploration service is unavailable.');
    const info = await health.json();
    if (info.instance_id !== identity || info.runtime !== 'local_browser.local_cdp' || info.capabilities?.development_commands !== true) {
      return failure('HOST_IDENTITY_MISMATCH', 'Listener is not the expected development-capable host service. No command was submitted.');
    }
    submitted = true;
    const response = await fetcher(`${BASE}/api/development/commands/${command}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', 'X-WeWorker-Exploration-Instance': identity }, body,
    });
    const result = await response.json();
    if (result?.schemaVersion !== 1 || typeof result.ok !== 'boolean' || result.command !== `development.${command}` || (!response.ok && result.ok)) {
      return failure('INVALID_RESPONSE', 'Unexpected command response. Inspect state before retrying; do not replay writes.');
    }
    return result;
  } catch {
    return failure(submitted ? 'OUTCOME_UNKNOWN' : 'SERVICE_UNAVAILABLE', submitted
      ? 'Connection interrupted after submission. Inspect state before retrying; do not replay debug or writes.'
      : 'Cannot reach the expected website exploration service. No command was submitted.');
  }
}
