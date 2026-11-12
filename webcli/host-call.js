import vm from 'node:vm';
import { createHostRuntime } from './host-runtime.js';
import { runHostPageAdapter, isPageCommand } from './host-page.js';
import { resolveAdapterCall, readAdapterBundle, describeAdapterCatalog } from './adapter-host.js';
import { buildV2Bootstrap, v2InjectionFiles } from './adapter-extension-loader.js';
import { adapterHelperPatterns, adapterPagePatterns, adapterPrimaryHost } from './host-scope.js';
import { hostError, requestHost, readHostConfiguration } from './host-client.js';
import { createHostHelpers } from './host-helpers.js';
import { usesBackgroundExecution } from './conditional-execution.js';

/** Installed Adapter code runs in the CLI child, never in the Electron main process. */
export async function runHostBackgroundAdapter(match, args, send) {
  const { adapter, command, snapshot } = match;
  if (command.runtime !== 'extension' || !usesBackgroundExecution(command, args)) {
    throw hostError('HOST_UNSUPPORTED_RUNTIME', 'This Adapter runtime is unsupported. The host supports extension page commands and background API commands.');
  }
  if ((command.requires_confirmation ?? command.safety === 'write') && args.__confirmed !== true) {
    throw hostError('CONFIRMATION_REQUIRED', 'Explicit confirmation is required for this command.');
  }
  const bundle = readAdapterBundle(snapshot);
  const route = command.routeDomain || adapterPrimaryHost(bundle.manifest);
  const validated = createHostRuntime(adapter.name, route).validateArgs(args, command.schema);
  const initialUrl = bundle.manifest.homepage_url || `https://${route}/`;
  await send({ operation: 'adapter.prepare', name: adapter.name, commandId: command.id,
    hosts: adapterHelperPatterns(bundle.manifest), pageHosts: adapterPagePatterns(bundle.manifest), initialUrl,
    write: command.safety === 'write', confirmed: args.__confirmed === true });
  const handlers = new Map();
  const helpers = createHostHelpers(match, validated, send);
  const timers = new Set();
  const schedule = (callback, delay, ...values) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(...values); }, delay);
    timers.add(timer);
    return timer;
  };
  try {
    const runtime = createHostRuntime(adapter.name, route, helpers.request);
    const context = vm.createContext({ URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, Blob, FormData,
      setTimeout: schedule, clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
      __webmcpWecliRuntime: runtime,
      __webmcpRegister: definition => {
        for (const tool of definition.tools || []) handlers.set(tool.handlerName || tool.name, tool.handler);
      },
    });
    // VM supplies browser globals for compatibility, not a security boundary for installed code.
    vm.runInContext('globalThis.window = globalThis;', context);
    vm.runInContext(buildV2Bootstrap(bundle.manifest), context, { timeout: 1000 });
    const files = v2InjectionFiles(bundle.manifest, Object.keys(bundle.files));
    for (const path of [...files.internal, ...files.commands]) {
      vm.runInContext(bundle.files[path], context, { timeout: 1000, filename: path });
    }
    const handler = handlers.get(`${adapter.name}.${command.id}`);
    if (typeof handler !== 'function') throw hostError('ADAPTER_COMMAND_UNAVAILABLE', 'Adapter handler was not registered.');
    context.hostHandler = handler;
    context.hostArguments = validated;
    return await vm.runInContext('hostHandler(hostArguments)', context, { timeout: 1000 });
  } finally { for (const timer of timers) clearTimeout(timer); helpers.close(); }
}

export async function callHost(toolName, args = {}, options = {}) {
  const config = readHostConfiguration();
  // Existing Adapters may request cookies concurrently; the channel grants one operation at a time.
  let queued = Promise.resolve();
  const send = (payload, signal = options.signal) => {
    const result = queued.then(() => {
      signal?.throwIfAborted();
      const request = payload.operation === 'adapter.prepare' ? { ...payload, invokedCommand: toolName } : payload;
      return requestHost(request, { ...options, config, signal });
    });
    queued = result.catch(() => {});
    return result;
  };
  if (toolName.startsWith('browser.')) return send({ operation: 'browser', command: toolName.slice(8), args });
  if (toolName === 'host.catalog') {
    // Establish protocol compatibility even for discovery; a broken host must not look healthy.
    const host = await send({ operation: 'browser', command: 'doctor', args: {} });
    const catalog = describeAdapterCatalog();
    const query = String(args.query || '').toLowerCase();
    return { profile: catalog.profile, available: catalog.available, diagnostics: catalog.diagnostics,
      hostCapabilities: host.adapterCapabilities || {}, siteValidation: 'unverified',
      adapters: catalog.adapters.filter(adapter => !query || `${adapter.name} ${adapter.description}`.toLowerCase().includes(query))
        .map(adapter => ({ name: adapter.name, description: adapter.description, commands: adapter.commands.map(command => ({
          name: `${adapter.name}.${command.id}`, description: command.description, schema: command.schema,
          safety: command.safety, requires_confirmation: command.requires_confirmation ?? command.safety === 'write',
          hostSupported: isPageCommand(command) || (command.runtime === 'extension' && command.execution?.type === 'api' && command.execution?.runtime === 'background'),
          runtime: command.runtime, execution: command.execution, siteValidation: 'unverified',
          hostCompatibility: 'Runtime eligibility only. Consult hostCapabilities for helpers. Installed site commands require separate validation.',
        })) })) };
  }
  if (/^(profile|exploration|host)\./.test(toolName)) throw hostError('HOST_UNSUPPORTED_COMMAND', 'This command is not available through a browser host.');
  const match = resolveAdapterCall(toolName);
  if (!match) throw hostError('ADAPTER_COMMAND_UNAVAILABLE', 'Installed Adapter command was not found.');
  return isPageCommand(match.command, args) ? runHostPageAdapter(match, args, send) : runHostBackgroundAdapter(match, args, send);
}
