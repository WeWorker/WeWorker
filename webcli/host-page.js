import { readAdapterBundle } from './adapter-host.js';
import { buildV2Bootstrap, v2InjectionFiles, v2CommandDefs } from './adapter-extension-loader.js';
import { adapterHelperPatterns, adapterPagePatterns, adapterPrimaryHost } from './host-scope.js';
import { createHostRuntime } from './host-runtime.js';
import { hostError } from './host-client.js';
import { usesBackgroundExecution } from './conditional-execution.js';

export function isPageCommand(command, args = {}) {
  return command.runtime === 'extension' && (!command.execution || command.execution.runtime === 'page'
    || (command.execution.pageWhenAbsent && !usesBackgroundExecution(command, args)));
}

// Serialized with the Adapter so follow-up handlers retain their original page state.
export async function completePageUpload(result, handlers, adapterName, helper) {
  if (!result || typeof result !== 'object' || !Object.hasOwn(result, '__cdp_action')) return result;
  const reject = message => { throw Object.assign(new Error(message), { code: 'HOST_INVALID_CONTINUATION' }); };
  if (result.__cdp_action !== 'set_file_input' || typeof result.selector !== 'string' || !result.selector
    || result.selector.length > 4096 || !Array.isArray(result.files) || !result.files.length || result.files.length > 32
    || result.files.some(file => typeof file !== 'string' || !file)) reject('Invalid file upload continuation.');
  const after = result.__after;
  if (after !== undefined && (!after || typeof after.toolName !== 'string' || !after.toolName.startsWith(adapterName + '.')
    || typeof handlers.get(after.toolName) !== 'function'
    || (after.delay !== undefined && (!Number.isInteger(after.delay) || after.delay < 0 || after.delay > 10000)))) {
    reject('Invalid upload completion handler.');
  }
  const uploaded = await helper('set_file_input', { selector: result.selector, files: result.files });
  if (!after) return uploaded;
  if (after.delay) await new Promise(resolve => setTimeout(resolve, after.delay));
  const completed = await handlers.get(after.toolName)({});
  if (completed && typeof completed === 'object' && ['__cdp_action', '__after', '__webcli_navigation', '__webcli_page_query'].some(key => Object.hasOwn(completed, key))) {
    reject('Nested upload continuations are not supported; the upload was not retried.');
  }
  return completed ?? uploaded;
}

export async function runHostPageAdapter({ adapter, command, snapshot }, args, send) {
  if (!isPageCommand(command, args)) throw hostError('HOST_UNSUPPORTED_RUNTIME', 'Expected a page Adapter command.');
  if ((command.requires_confirmation ?? command.safety === 'write') && args.__confirmed !== true) {
    throw hostError('CONFIRMATION_REQUIRED', 'Explicit confirmation is required for this command.');
  }
  const bundle = readAdapterBundle(snapshot);
  const route = command.routeDomain || command.tabDomain || adapterPrimaryHost(bundle.manifest);
  const validated = createHostRuntime(adapter.name, route).validateArgs(args, command.schema);
  const files = v2InjectionFiles(bundle.manifest, Object.keys(bundle.files));
  const script = `(async () => {
    try {
      const handlers = new Map();
      window.__webmcpWecliRuntime = (${createHostRuntime.toString()})(${JSON.stringify(adapter.name)}, ${JSON.stringify(route)},
        async (action, payload = {}) => {
          if (typeof window.__webcliHostHelper !== 'function') throw Object.assign(new Error('Page host helper is unsupported: ' + action), {code:'HOST_UNSUPPORTED_HELPER'});
          return window.__webcliHostHelper(action, payload);
        });
      window.__webmcpRegister = definition => {
        for (const tool of definition.tools || []) handlers.set(tool.handlerName || tool.name, tool.handler);
      };
      ${buildV2Bootstrap(bundle.manifest)}
      ${[...files.internal, ...files.commands].map(path => bundle.files[path]).join('\n;\n')}
      for (const definition of Object.values(${JSON.stringify(v2CommandDefs(bundle.manifest))})) {
        const registered = handlers.get(definition.name);
        if (registered) for (const alias of definition.aliases) {
          if (!handlers.has(alias)) handlers.set(alias, registered);
        }
      }
      const handler = handlers.get(${JSON.stringify(`${adapter.name}.${command.id}`)});
      if (!handler) throw Object.assign(new Error('Adapter handler was not registered.'), {code:'ADAPTER_COMMAND_UNAVAILABLE'});
      const initialResult = await handler(${JSON.stringify(validated)});
      const result = await (${completePageUpload.toString()})(initialResult, handlers, ${JSON.stringify(adapter.name)}, window.__webcliHostHelper);
      const serialized = JSON.stringify({ok:true, result:result === undefined ? null : result});
      if (serialized.length > 2500000) throw Object.assign(new Error('Adapter result exceeds the size limit.'), {code:'HOST_PAYLOAD_TOO_LARGE'});
      return serialized;
    } catch(error) {
      return JSON.stringify({ok:false,error:{code:String(error.code || 'ADAPTER_EXECUTION_FAILED'),message:String(error.message || error).slice(0,2000)}});
    }
  })()`;
  let initialUrl = `https://${route}/`;
  if (bundle.manifest.homepage_url) {
    const homepage = new URL(bundle.manifest.homepage_url);
    if (homepage.hostname === route && ['http:', 'https:'].includes(homepage.protocol)) initialUrl = homepage.href;
  }
  await send({ operation: 'adapter.prepare', name: adapter.name, commandId: command.id,
    hosts: adapterHelperPatterns(bundle.manifest), pageHosts: adapterPagePatterns(bundle.manifest), initialUrl,
    write: command.safety === 'write', confirmed: args.__confirmed === true });
  return send({ operation: 'adapter.page', initialUrl, script });
}
