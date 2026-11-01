import { buildApiSourceEvidence } from './generation-harness/source-evidence.js';
import { normalizeWriteResult, writeResultSpecs } from './exploration-write-result.js';
import { normalizeWorkflowFrames } from './page-workflow-frames.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_UI_WRITE' }); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).sort().join(',') === keys.sort().join(',');
const publicName = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v) && !/token|cookie|auth|password|secret|session|credential|api.?key|csrf|ticket|prototype|constructor/i.test(v);
const selector = v => typeof v === 'string' && v.trim() && v.length <= 300 && !/[\r\n\0]/.test(v);

/** The page owns events/submission; this is not an HTTP/idempotency contract. */
export function validateUiWrite(command) {
  if (command.uiWrite === undefined) return;
  const spec = command.uiWrite, route = command.pageRoute;
  const enhanced = spec?.version === 2;
  if (!exact(spec, ['version', 'url', 'method', 'form', 'inputs', 'submit', 'confirmation', 'inputMode', ...(spec?.result !== undefined ? ['result'] : []),
    ...(enhanced && spec?.hiddenFields !== undefined ? ['hiddenFields'] : []), ...(enhanced && spec?.shadowRoots !== undefined ? ['shadowRoots'] : []), ...(enhanced && spec?.frames !== undefined ? ['frames'] : []), ...(enhanced && spec?.navigation !== undefined ? ['navigation'] : [])]) || ![1, 2].includes(spec.version)
    || !(enhanced ? ['native-setter-no-events', 'native-input-change'] : ['native-setter-no-events']).includes(spec.inputMode) || spec.method !== 'POST'
    || command.runtime !== 'extension' || command.safety !== 'write' || command.requires_confirmation === false
    || command.pageWrite || command.execution || command.pageWorkflow || command.pageStrategy || !exact(route, ['origin', 'pathname'])) fail('UI writes require a fixed foreground route, explicit confirmation and a native form contract.');
  let url, page;
  if (spec.frames !== undefined) { try { normalizeWorkflowFrames(spec.frames); } catch { fail('Declare an exact retained frame owner chain.'); } }
  const operationOrigin = spec.frames?.at(-1).origin || route.origin;
  try { url = new URL(spec.url); page = new URL(route.origin + route.pathname); } catch { fail('Invalid UI write URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== operationOrigin || url.href !== spec.url || url.search || url.hash || url.username || url.password || url.pathname.includes(':id')
    || typeof route.pathname !== 'string' || !/^\/(?!\/)/.test(route.pathname) || page.origin !== route.origin || page.pathname !== route.pathname || page.search || page.hash || page.username || page.password || route.pathname.includes(':id')) fail('UI writes require fixed same-origin form and page URLs.');
  if (!selector(spec.form) || !Array.isArray(spec.inputs) || !spec.inputs.length || spec.inputs.length > 10
    || spec.inputs.some(v => !exact(v, ['selector', 'name', 'parameter', ...(enhanced && v.kind !== undefined ? ['kind'] : []), ...(enhanced && v.kind === 'choice' ? ['popup','option'] : [])]) || !selector(v.selector) || !publicName(v.name) || !publicName(v.parameter)
      || v.kind !== undefined && !['text', 'date', 'choice', 'select', 'checkbox', 'contenteditable'].includes(v.kind) || v.kind === 'choice' && (!selector(v.popup) || !selector(v.option) || spec.inputMode !== 'native-input-change'))
    || ['name', 'parameter', 'selector'].some(key => new Set(spec.inputs.map(v => v[key])).size !== spec.inputs.length)
    || !(enhanced && spec.submit?.mode === 'none' ? exact(spec.submit, ['mode']) && spec.inputMode === 'native-input-change'
      : exact(spec.submit, ['selector', 'text', ...(enhanced && spec.submit?.mode !== undefined ? ['mode'] : [])]) && selector(spec.submit.selector) && typeof spec.submit.text === 'string' && spec.submit.text.trim() && spec.submit.text.length <= 200
        && (!spec.submit.mode || ['requestSubmit', 'click', 'enter'].includes(spec.submit.mode)))
    || !exact(spec.confirmation, ['selector', 'attribute', 'parameter']) || !selector(spec.confirmation.selector)
    || !/^data-[a-z][a-z0-9-]{0,63}$/.test(spec.confirmation.attribute) || !publicName(spec.confirmation.attribute.slice(5).replaceAll('-', '_'))
    || !spec.inputs.some(v => v.parameter === spec.confirmation.parameter)) fail('Declare unique public native inputs, a named submit button and an input-correlated confirmation attribute.');
  if (spec.shadowRoots !== undefined && (!Array.isArray(spec.shadowRoots) || !spec.shadowRoots.length || spec.shadowRoots.length > 8 || spec.shadowRoots.some(v => !selector(v)))) fail('Declare up to eight unique open Shadow host selectors.');
  if (spec.navigation !== undefined) {
    let destination; try { destination = new URL(spec.navigation.url); } catch { fail('Declare a fixed same-origin submission destination.'); }
    if (!exact(spec.navigation,['url']) || destination.origin !== operationOrigin || destination.href !== spec.navigation.url || destination.username || destination.password || destination.hash || destination.search || spec.submit.mode === 'none') fail('Declare a fixed same-origin submission destination.');
  }
  if (spec.hiddenFields !== undefined && (!Array.isArray(spec.hiddenFields) || !spec.hiddenFields.length || spec.hiddenFields.length > 10
    || spec.hiddenFields.some(v => !exact(v, ['selector', 'name', 'source']) || !selector(v.selector) || typeof v.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v.name) || v.source !== 'page')
    || new Set([...spec.inputs, ...spec.hiddenFields].map(v => v.name)).size !== spec.inputs.length + spec.hiddenFields.length
    || new Set([...spec.inputs, ...spec.hiddenFields].map(v => v.selector)).size !== spec.inputs.length + spec.hiddenFields.length)) fail('Hidden fields must name unique page-owned controls without capturing their values.');
  if (enhanced && spec.result?.source === 'network') {
    if (!exact(spec.result,['source','url','method','ids']) || spec.result.url !== spec.url || spec.result.method !== spec.method || !Array.isArray(spec.result.ids) || !spec.result.ids.length || spec.result.ids.length>10) fail('Network IDs require one exact declared mutation and 1–10 public ID sources.');
    for(const id of spec.result.ids) {
      const mock = {id:id.idType==='integer'||id.idType==='signed-integer'?7:'7'};
      if (!exact(id,['publicId','idType',...(id.responseSource?['responseSource']:['responsePath'])])) fail('Declare only a public network ID source and exact type.');
      // Reuse source validation; an example value only checks the declaration.
      const response={};if(id.responsePath){let target=response;const keys=id.responsePath.split('.');for(const key of keys.slice(0,-1)){if(!publicName(key))fail('Use public network ID paths.');target=target[key]={};}target[keys.at(-1)]=mock.id;}
      try {normalizeWriteResult({...id,url:operationOrigin+'/items/:id',identityPath:'id',expect:{equals:{state:'ready'}}},response,operationOrigin,{headers:id.responseSource?.kind==='header'?{[id.responseSource.name]:id.responseSource.template?id.responseSource.template.replace(':id',String(mock.id)):String(mock.id)}:{},url:id.responseSource?.kind==='url'?id.responseSource.template.replace(':id',String(mock.id)):undefined});}catch{fail('Invalid public network result source.');}
    }
  } else if (spec.result !== undefined && (!exact(spec.result, ['attribute', 'publicId', 'idType']) || spec.result.publicId !== true
    || !(enhanced ? ['string','integer','signed-integer','decimal'] : ['string', 'integer']).includes(spec.result.idType) || !/^data-[a-z][a-z0-9-]{0,63}$/.test(spec.result.attribute)
    || !publicName(spec.result.attribute.slice(5).replaceAll('-', '_')) || spec.result.attribute === spec.confirmation.attribute)) fail('UI results require a distinct public ID attribute on the same receipt and an explicit ID type.');
  const names = spec.inputs.map(v => v.parameter).sort(), schema = command.schema;
  if (!schema || schema.type !== 'object' || schema.additionalProperties !== false || schema['x-webcli-requires-confirmation'] !== true
    || JSON.stringify(Object.keys(schema.properties || {}).sort()) !== JSON.stringify([...names, '__confirmed'].sort())
    || schema.properties.__confirmed?.type !== 'boolean' || JSON.stringify([...(schema.required || [])].sort()) !== JSON.stringify(names)
    || names.some(name => schema.properties[name]?.type !== 'string' || Object.hasOwn(schema.properties[name], 'default'))) fail('UI write parameters must be required strings without defaults.');
}
export function resolveUiWrite(command, args) {
  validateUiWrite(command);
  if (args?.__confirmed !== true) throw Object.assign(new Error('Explicit confirmation is required.'), { code: 'CONFIRMATION_REQUIRED' });
  const names = command.uiWrite.inputs.map(v => v.parameter);
  if (!object(args) || Object.keys(args).some(key => key !== '__confirmed' && !names.includes(key))
    || names.some(name => typeof args[name] !== 'string' || args[name].length > 10000 || /[\r\n\0]/.test(args[name]))
    || !args[command.uiWrite.confirmation.parameter]?.trim()) fail('Provide exact single-line strings and a nonempty public correlation value.');
  if (command.uiWrite.inputs.some(v => v.kind === 'checkbox' && !['true', 'false'].includes(args[v.parameter]))) fail('Checkbox parameters require the exact strings true or false.');
  return { url: command.uiWrite.url, method: 'POST', body: Object.fromEntries(command.uiWrite.inputs.map(v => [v.name, args[v.parameter]])) };
}
export function uiWriteModule(id) {
  return `(function () { window.__webcliRegisterCommand(${JSON.stringify(id)}, function (args = {}) {
  if (args.__confirmed !== true) return {blocked:true, requiresConfirmation:true};
  throw new Error('UI_WRITE_DISPATCH_REQUIRED');
}); })();\n`;
}
export function assertUiWriteModule(command, files) {
  if (command.uiWrite && files.get(command.module)?.toString('utf8') !== uiWriteModule(command.id)) fail('UI write modules are fixed registration stubs.');
}
export function buildUiWriteTool(site, tool, candidate, origin) {
  if (typeof tool.name !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(tool.name)) fail('UI write names must be portable identities.');
  const uiWrite = { ...tool.uiWrite, version: tool.uiWrite?.version ?? 1, url: candidate.url, method: candidate.method };
  const names = (uiWrite.inputs || []).map(v => v.parameter);
  if (JSON.stringify((uiWrite.inputs || []).map(v => v.name).sort()) !== JSON.stringify([...(candidate.requestEvidence?.bodyKeys || [])].sort())) fail('Input names must match the source declaration.');
  const schema = { type: 'object', additionalProperties: false, required: names,
    properties: { ...Object.fromEntries(names.map(name => [name, { type: 'string', maxLength: 10000 }])), __confirmed: { type: 'boolean' } },
    'x-webcli-requires-confirmation': true, 'x-webcli-agent-authored': true };
  const command = { runtime: 'extension', safety: 'write', uiWrite, pageRoute: { origin, pathname: tool.pagePathname }, schema };
  validateUiWrite(command);
  return { toolDefinition: { name: site + '.' + tool.name, access: 'write', description: tool.purpose || 'Submit one confirmed native form and correlate its page acknowledgement.',
    uiWrite, pageRoute: command.pageRoute, parameters: schema,
    generationSource: { ...buildApiSourceEvidence(candidate, { sourceKind: candidate.declared ? 'authored_ui_write_declaration' : 'observed_write' }), risk: { level: 'write', confidence: 1 } } },
    v2Content: uiWriteModule(tool.name.replaceAll('_', '-')) };
}

export const uiWriteSuccess = { ok: true, submitted: true, confirmationMatched: true, effectVerified: false };
export const uiWriteFailure = { ok: false, errorCode: 'UI_WRITE_CONFIRMATION_FAILED' };
// An offline submission model, never a source for the real execution's ID.
export const uiWriteMockSuccess = command => {
  const result=command.uiWrite.result, sample=value=>['integer','signed-integer'].includes(value.idType)?7:value.idType==='decimal'?'7':'example-ui-result';
  return {...uiWriteSuccess,...(result?.source==='network' ? (result.ids.length===1?{resultId:sample(result.ids[0])}:{resultIds:result.ids.map(sample)}) : result?{resultId:sample(result)}:{})};
};

// Bind all authored inputs to independent resource fields, including a changed
// correlation field. Canonical paths prevent $ aliases from weakening this proof.
export function validateUiEffect(command, fixture) {
  const spec = command.uiWrite, paths = fixture.effect.argumentPaths;
  const names = spec.inputs.map(v => v.parameter).sort();
  const result = fixture.effect.resultReadback;
  if (Boolean(spec.result) !== (result !== undefined) || !object(paths) || JSON.stringify(Object.keys(paths).sort()) !== JSON.stringify(names)
    || new Set(Object.values(paths)).size !== names.length) fail('UI effects require one distinct readback field per input and a matching declared receipt ID readback.');
  if (spec.result) {
    normalizeWriteResult(result, uiWriteMockSuccess(command), spec.frames?.at(-1).origin || command.pageRoute.origin);
    const declarations=spec.result.source==='network'?spec.result.ids:[spec.result],readbacks=writeResultSpecs(result);
    if(readbacks.length!==declarations.length || readbacks.some((value,index)=>value.responsePath!==(declarations.length===1?'resultId':'resultIds.'+index)||(value.idType||'string')!==declarations[index].idType)) fail('UI result readback must bind every declared result ID with its exact type.');
  }
  for (const name of names) {
    const field = paths[name];
    if (typeof field !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+){0,7}$/.test(field) || field.split('.').some(v => !publicName(v))) fail('UI readback bindings require exact public property paths.');
    if (fixture.effect.after.equals?.[field] !== fixture.representativeArgs[name]) fail('Every after field must equal its exact reviewed input.');
    if (result && writeResultSpecs(result).some(value=>value.expect.equals?.[field] !== fixture.representativeArgs[name])) fail('Every result resource field must also equal its exact reviewed input.');
  }
  const identity = fixture.effect.identityPath;
  if (typeof identity !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+){0,7}$/.test(identity) || identity.split('.').some(v => !publicName(v))
    || typeof fixture.effect.before.equals?.[identity] !== 'string' || !fixture.effect.before.equals[identity].trim()
    || fixture.effect.before.equals[identity] !== fixture.effect.after.equals?.[identity]) fail('Declare a stable public resource identity field in both before and after.');
  const correlation = paths[spec.confirmation.parameter];
  if (!Object.hasOwn(fixture.effect.before.equals || {}, correlation) || fixture.effect.before.equals[correlation] === fixture.effect.after.equals[correlation]) fail('Before/after must prove a changed correlation field.');
}
