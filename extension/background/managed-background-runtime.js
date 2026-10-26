import { buildV2Bootstrap, v2InjectionFiles } from './v2-loader.js';

export const MANAGED_RUNNER_PATH = 'offscreen/managed-runner.html';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isMissingOffscreenDocument = (error) => /No current offscreen document/i.test(error?.message || '');

// Executed by CDP in a fresh, extension-owned offscreen document. Package code is
// installed executable code; this is lifecycle isolation, not a JavaScript sandbox.
function initializeRuntime(token, context) {
  const handlers = new Map();
  function error(code, message, details) { return Object.assign(new Error(message), { code, details }); }
  async function requestPrivileged(action, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type: 'managed_adapter_runtime_request', token, action, payload });
    if (!response?.ok) throw error(response?.error?.code || 'RUNTIME_HELPER_ERROR', response?.error?.message || 'Adapter runtime request failed', response?.error?.details);
    return response.result;
  }
  window.__webmcpWecliRuntime = {
    createRuntimeError: error,
    requestPrivileged,
    getContext: () => ({ ...context }),
    requireConfirmation(args = {}) {
      if (args.__confirmed !== true) throw error('CONFIRMATION_REQUIRED', 'Explicit confirmation is required for this write command.');
      return true;
    },
    validateArgs(args = {}, schema = {}) {
      const result = { ...args };
      for (const [name, definition] of Object.entries(schema.properties || {})) {
        if (!(name in result) && definition && Object.hasOwn(definition, 'default')) result[name] = definition.default;
      }
      for (const name of schema.required || []) {
        if (result[name] === undefined || result[name] === null || result[name] === '') throw error('INVALID_ARGS', 'Missing argument: ' + name);
      }
      if (schema.additionalProperties === false) {
        for (const name of Object.keys(result)) if (!Object.hasOwn(schema.properties || {}, name) && !['__confirmed', 'dry-run'].includes(name)) {
          throw error('INVALID_ARGS', 'Unknown argument: ' + name);
        }
      }
      for (const [name, definition] of Object.entries(schema.properties || {})) {
        let value = result[name];
        if (value === undefined || !definition || typeof definition !== 'object') continue;
        const types = Array.isArray(definition.type) ? definition.type : [definition.type];
        // CLI numeric flags stay strings. Match page-runtime normalization only
        // for explicitly numeric schemas; string IDs (including leading zeros)
        // and handlers that do not call validateArgs must retain their values.
        if (typeof value === 'string' && value.trim() !== '' && !types.includes('string')) {
          const numeric = Number(value.trim());
          if ((types.includes('integer') && Number.isInteger(numeric))
            || (types.includes('number') && Number.isFinite(numeric))) {
            value = numeric;
          } else if (types.includes('array') && definition.items?.type === 'integer') {
            const parts = value.split(',').map(part => part.trim()).filter(Boolean);
            const numbers = parts.map(Number);
            if (parts.length > 0 && numbers.every(Number.isInteger)) value = numbers;
            } else if (types.includes('array') && definition.items?.type === 'string') {
            const trimmed = value.trim();
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) value = parsed;
              } catch { /* keep the original string */ }
            }
            if (!Array.isArray(value)) value = [trimmed];
          }
          result[name] = value;
        }
        if (!types.some(type => !type || (type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
          : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
          : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === type))) {
          throw error('INVALID_ARGS', 'Invalid argument type: ' + name);
        }
        if (Array.isArray(definition.enum) && !definition.enum.includes(value)) throw error('INVALID_ARGS', 'Invalid argument value: ' + name);
      }
      return result;
    },
    async fetchJson(input, init = {}) {
      const response = await requestPrivileged('backend_fetch', { url: String(input), options: {
        method: init.method || 'GET', headers: { Accept: 'application/json', ...(init.headers || {}) }, body: init.body,
      } });
      let body = response.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* Keep non-JSON responses. */ } }
      if (!response.ok) throw error('HTTP_ERROR', 'HTTP ' + response.status, { status: response.status, body });
      return body;
    },
    setFileInput: (selector, files) => requestPrivileged('set_file_input', { selector, files }),
    /** Report "not logged in"; WeWorker then runs the login flow and retries reads. */
    authRequired(message = 'Login required') { throw error('AUTH_REQUIRED', message, { phase: 'handler' }); },
  };
  window.__webmcpRegister = (adapter) => {
    for (const tool of adapter?.tools || []) if (typeof tool.handler === 'function') handlers.set(tool.handlerName || tool.name, tool.handler);
  };
  window.__weworkerManagedInvoke = async (name, args) => {
    try {
      if (!handlers.has(name)) throw error('ADAPTER_COMMAND_UNAVAILABLE', 'Adapter command handler is unavailable.');
      return { ok: true, result: await handlers.get(name)(args) ?? null };
    } catch (err) {
      return { ok: false, error: { code: err.code || 'ADAPTER_EXECUTION_FAILED', message: err.message || 'Adapter command failed', ...(err.details ? { details: err.details } : {}) } };
    }
  };
}

/** Calls and privileged helpers share one queue with the legacy offscreen runner. */
export function createManagedBackgroundRuntime({ bundle, request, exclusive, api = globalThis.chrome, timeoutMs = 120000 }) {
  let active = null;
  async function handleMessage(message, sender) {
    const call = active;
    if (!call?.accepting || sender?.id !== api.runtime.id || sender?.url !== call.url || message.token !== call.token) {
      throw new Error('Adapter runtime context is unavailable.');
    }
    // Never accept caller-provided route, host grants, digest or trace context.
    const task = Promise.resolve().then(() => request(message.action, message.payload || {}, call.context));
    call.pending.add(task);
    try { return await task; } finally { call.pending.delete(task); }
  }

  async function execute(manifest, command, args = {}, context = {}, previewBundle = null) {
    return exclusive(async () => {
      const selected = previewBundle || await bundle(manifest);
      const current = selected.manifest.commands.find((entry) => entry.id === command.id);
      if (current?.runtime !== 'extension' || current.execution?.type !== 'api' || current.execution?.runtime !== 'background') {
        throw new Error('Adapter command does not support background execution.');
      }
      if ((current.requires_confirmation ?? current.safety === 'write') && args.__confirmed !== true) throw new Error('Explicit confirmation is required for this command.');
      const token = crypto.randomUUID();
      const url = api.runtime.getURL(MANAGED_RUNNER_PATH) + '?call=' + token;
      const call = { token, url, accepting: true, pending: new Set(), context };
      const known = [api.runtime.getURL('offscreen/direct-runner.html'), api.runtime.getURL(MANAGED_RUNNER_PATH)];
      const contexts = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (contexts.some((entry) => !known.includes(entry.documentUrl?.split('?')[0]))) throw new Error('An unrelated offscreen document is active.');
      if (contexts.length) {
        try { await api.offscreen.closeDocument(); }
        catch (error) { if (!isMissingOffscreenDocument(error)) throw error; }
      }
      let ownedDocument = false, attached = false, target;
      const evaluate = async (expression) => {
        if (!call.accepting) throw new Error('Adapter execution has ended.');
        const remaining = context.previewNoPage ? context.previewDeadline - Date.now() : timeoutMs;
        if (!(remaining > 0)) throw new Error('Adapter execution timed out.');
        let timer;
        try {
          const result = await Promise.race([
            api.debugger.sendCommand(target, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: false }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Adapter execution timed out.')), remaining); }),
          ]);
          if (result?.exceptionDetails) throw new Error('Adapter background script failed.');
          return result?.result?.value;
        } finally { clearTimeout(timer); }
      };
      try {
        await api.offscreen.createDocument({ url, reasons: ['IFRAME_SCRIPTING'], justification: 'Execute an installed Adapter in an isolated document lifecycle.' });
        ownedDocument = true;
        const deadline = Date.now() + 5000;
        while (!target && Date.now() < deadline) {
          const found = (await api.debugger.getTargets()).find((entry) => entry.url === url);
          if (found) target = { targetId: found.id }; else await sleep(25);
        }
        if (!target) throw new Error('Adapter background target is unavailable.');
        await api.debugger.attach(target, '1.3'); attached = true;
        active = call;
        await evaluate('(' + initializeRuntime.toString() + ')(' + JSON.stringify(token) + ',' + JSON.stringify(context) + ')');
        await evaluate(buildV2Bootstrap(selected.manifest));
        const { internal, commands } = v2InjectionFiles(selected.manifest, Object.keys(selected.files));
        for (const path of [...internal, ...commands]) {
          if (typeof selected.files[path] !== 'string') throw new Error('Adapter background source is unavailable.');
          await evaluate(selected.files[path]);
        }
        const result = await evaluate('window.__weworkerManagedInvoke(' + JSON.stringify(manifest.name + '.' + current.id) + ',' + JSON.stringify(args) + ')');
        if (!result?.ok) throw Object.assign(new Error(result?.error?.message || 'Adapter command failed.'), result?.error || {});
        return result.result;
      } finally {
        call.accepting = false;
        if (active === call) active = null;
        if (attached) await api.debugger.detach(target).catch(() => {});
        try {
          if (ownedDocument) {
            try { await api.offscreen.closeDocument(); }
            catch (error) {
              // A refresh or Chrome lifecycle cleanup may have closed it first.
              if (!isMissingOffscreenDocument(error)) throw error;
            }
          }
        }
        finally {
          // A late helper must finish under its original context before releasing
          // the shared queue. Closing the document prevents new helper requests.
          await Promise.allSettled([...call.pending]);
        }
      }
    }, context);
  }
  return { execute, handleMessage };
}
