import { buildApiSourceEvidence } from './generation-harness/source-evidence.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_PAGE_WRITE' }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const publicName = name => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) && !/token|cookie|auth|password|secret|session|credential|api.?key|csrf|ticket|prototype|constructor/i.test(name);

/** A deliberately narrow, reviewable page-fetch contract. No arbitrary live author code. */
export function validatePageWrite(command) {
  if (command.pageWrite === undefined) return;
  const spec = command.pageWrite, route = command.pageRoute;
  if (!object(spec) || spec.version !== 1 || Object.keys(spec).some(key => !['version', 'url', 'method', 'bodyParameters', 'idempotency'].includes(key))
    || command.runtime !== 'extension' || command.safety !== 'write' || command.execution
    || command.uiWrite || command.pageWorkflow || command.pageStrategy || !route || Object.keys(route).some(key => !['origin', 'pathname'].includes(key))) fail('Page writes require an exact foreground route and write safety.');
  let page;
  try { page = new URL(route.origin + route.pathname); } catch { fail('Invalid page write route.'); }
  if (typeof route.pathname !== 'string' || !/^\/(?!\/)/.test(route.pathname) || page.origin !== route.origin || page.pathname !== route.pathname
    || page.search || page.hash || page.username || page.password || route.pathname.includes(':id')) fail('Page writes require a fixed page pathname.');
  let url;
  try { url = new URL(spec.url); } catch { fail('Invalid page write URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== route.origin || url.href !== spec.url || url.username || url.password || url.search || url.hash || url.pathname.includes(':id')
    || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(spec.method)) fail('Page writes require a fixed same-origin mutation URL without query or fragment.');
  if (!object(spec.bodyParameters) || Object.keys(spec.bodyParameters).length > 30 || Object.entries(spec.bodyParameters).some(([field, name]) => !publicName(field) || typeof name !== 'string' || !publicName(name))
    || new Set(Object.values(spec.bodyParameters)).size !== Object.keys(spec.bodyParameters).length) fail('Provide at most 30 distinct public JSON field/argument bindings.');
  if (!object(spec.idempotency) || Object.keys(spec.idempotency).sort().join(',') !== 'header,serverDeduplicates' || !['idempotency-key', 'x-idempotency-key'].includes(spec.idempotency.header) || spec.idempotency.serverDeduplicates !== true) fail('Page writes require an explicit server idempotency header contract with serverDeduplicates:true. Browser transport can resend requests.');
  const schema = command.schema;
  const names = Object.values(spec.bodyParameters).sort();
  if (!schema || schema.type !== 'object' || schema.additionalProperties !== false
    || JSON.stringify(Object.keys(schema.properties || {}).filter(key => key !== '__confirmed').sort()) !== JSON.stringify([...names].sort())
    || JSON.stringify([...(schema.required || [])].filter(key => key !== '__confirmed').sort()) !== JSON.stringify(names)
    || names.some(name => schema.properties[name]?.type !== 'string' || Object.hasOwn(schema.properties[name], 'default'))) fail('Page write arguments must be required strings without defaults, without control parameters.');
}

export function resolvePageWrite(command, args) {
  validatePageWrite(command);
  const names = Object.values(command.pageWrite.bodyParameters);
  if (!object(args) || Object.keys(args).some(key => key !== '__confirmed' && !names.includes(key))
    || names.some(name => typeof args[name] !== 'string' || args[name].length > 10000)) fail('Provide the declared string arguments (10000 characters maximum each).');
  return { url: command.pageWrite.url, method: command.pageWrite.method,
    body: Object.fromEntries(Object.entries(command.pageWrite.bodyParameters).map(([key, name]) => [key, args[name]])) };
}

// The module is a registration stub. The Extension owns dispatch from the
// manifest; neither preview nor normal calls execute author JavaScript live.
export function pageWriteModule(id) {
  return `(function () { window.__webcliRegisterCommand(${JSON.stringify(id)}, function (args = {}) {
  throw new Error('PAGE_WRITE_DISPATCH_REQUIRED');
}); })();\n`;
}

export function buildExtensionWriteTool(site, tool, candidate, origin) {
  if (typeof tool.name !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(tool.name)) fail('Page write names must be portable command identities.');
  const id = tool.name.replace(/_/g, '-');
  const pageWrite = { version: 1, url: candidate.url, method: candidate.method, bodyParameters: tool.bodyParameters || {}, idempotency: tool.idempotency };
  const names = Object.values(pageWrite.bodyParameters);
  if (JSON.stringify(Object.keys(pageWrite.bodyParameters).sort()) !== JSON.stringify([...(candidate.requestEvidence?.bodyKeys || [])].sort())) fail('Page write JSON fields must match the declared or observed source fields.');
  const schema = { type: 'object', additionalProperties: false, required: names,
    properties: { ...Object.fromEntries(names.map(name => [name, { type: 'string', maxLength: 10000 }])) },
    'x-webcli-agent-authored': true };
  const command = { runtime: 'extension', safety: 'write', pageWrite, pageRoute: { origin, pathname: tool.pagePathname }, schema };
  validatePageWrite(command);
  return { toolDefinition: { name: site + '.' + tool.name, access: 'write', description: tool.purpose || 'Perform one same-origin page JSON request.',
    pageWrite, pageRoute: command.pageRoute, parameters: schema,
    generationSource: { ...buildApiSourceEvidence(candidate, { sourceKind: candidate.declared ? 'authored_write_declaration' : 'observed_write' }), risk: { level: 'write', confidence: 1 } } },
    v2Content: pageWriteModule(id) };
}

export function assertPageWriteModule(command, files) {
  if (command.pageWrite && files.get(command.module)?.toString('utf8').replace('  if (args.__confirmed !== true) return {blocked:true, requiresConfirmation:true};\n', '') !== pageWriteModule(command.id)) fail('Page write modules are fixed registration stubs. Author request bindings in the manifest; arbitrary page code is not supported.');
}
