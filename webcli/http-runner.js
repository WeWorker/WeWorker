import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { readPackageDirectory, adapterError } from './adapter-package-files.js';
import { validateHttpContract } from './http-contract.js';
import { createHttpClient } from './http-client.js';
import { httpWorkerMain } from './http-worker.js';

const fail = (code, message) => adapterError('HTTP_' + code, message);

// Normalize only explicitly numeric schema fields at the runtime boundary.
// CLI strings and authored JSON cases must reach the same handler types without
// changing string identifiers, union types that allow strings, or blank input.
export function normalizeHttpArguments(args = {}, schema = {}) {
  if (schema.type !== 'object') return args;
  const result = { ...args };
  for (const [key, definition] of Object.entries(schema.properties || {})) {
    const types = Array.isArray(definition.type) ? definition.type : [definition.type];
    const value = result[key];
    if (typeof value !== 'string' || !value.trim() || types.includes('string')) continue;
    const number = Number(value);
    if (types.includes('integer') && Number.isSafeInteger(number)) result[key] = number;
    else if (types.includes('number') && Number.isFinite(number)) result[key] = number;
  }
  return result;
}

/** Execute a verified package snapshot. Credentials exist only in the host request closure. */
export async function runHttpTool(match, args = {}, options = {}) {
  const pkg = readPackageDirectory(match.adapter.root);
  if (match.adapter.digest && pkg.digest !== match.adapter.digest) throw fail('STALE_PACKAGE', 'Adapter changed before HTTP execution.');
  const command = pkg.commands.find(entry => entry.id === match.command.id);
  if (!command || command.runtime !== 'http') throw fail('COMMAND_UNAVAILABLE', 'HTTP command is unavailable.');
  validateHttpContract(command);
  args = normalizeHttpArguments(args, command.schema);
  if (!options.mockRequest && (command.requires_confirmation || command.safety === 'write') && args.__confirmed !== true) throw fail('CONFIRMATION_REQUIRED', 'Explicit confirmation is required for this command.');
  if (options.signal?.aborted) throw fail('ABORTED', 'HTTP operation cancelled.');
  const controller = new AbortController();
  // The mock transport exists only in the host verifier. It receives no auth
  // resolver or environment and cannot fall back to the real transport.
  const client = options.mockRequest
    ? { request: options.mockRequest, redact: value => value, dispose() {} }
    : createHttpClient(command, { ...options, signal: controller.signal });
  const { request, redact } = client;
  const worker = new Worker('(' + httpWorkerMain.toString() + ')()', { eval: true, env: {},
    resourceLimits: { maxOldGenerationSizeMb: 64 },
    workerData: { module: command.module, args, files: Object.fromEntries([...pkg.files]
      .filter(([name]) => name.startsWith('http/')).map(([name, bytes]) => [name, bytes.toString('utf8')])) } });
  const traceID = options.traceID || randomUUID();
  let finished = false, pendingRequests = 0;
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(fail('TIMEOUT', 'HTTP command timed out. No request was retried.')), options.timeoutMs || 30_000);
      const abort = () => reject(fail('ABORTED', 'HTTP operation cancelled.'));
      options.signal?.addEventListener('abort', abort, { once: true });
      worker.once('error', () => reject(fail('COMMAND_FAILED', 'HTTP worker failed.')));
      worker.once('exit', () => reject(fail('COMMAND_FAILED', 'HTTP worker exited without a result.')));
      worker.on('message', async message => {
        if (finished) return;
        if (message.type === 'result') {
          if (pendingRequests) reject(fail('UNSETTLED_REQUESTS', 'HTTP command returned before its requests finished. Inspect effects before retrying.'));
          else resolve(redact(message.result));
        }
        else if (message.type === 'failure') reject(adapterError(message.error.code, message.error.message));
        else if (message.type === 'request') {
          pendingRequests++;
          try { const result = await request(message.options); if (!finished) worker.postMessage({ id: message.id, result }); }
          catch (error) {
            options.onRequestFailure?.(error);
            if (!finished) worker.postMessage({ id: message.id, error: { code: error.code || 'HTTP_REQUEST_FAILED', message: 'HTTP request failed under its declared contract.' } });
          }
          finally { pendingRequests--; }
        }
      });
      worker.once('exit', () => { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); });
    });
    return { result, traceID, exitCode: 0 };
  } finally {
    finished = true; controller.abort(); await worker.terminate(); client.dispose();
  }
}
