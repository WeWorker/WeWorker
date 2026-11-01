import { explorationError as fail } from './exploration-commands.js';
import { normalizeVerificationCases } from './exploration-verification.js';
import { assertReadRequest } from './exploration-host.js';

const invalid = () => { throw fail('INVALID_WRITE_CASE', 'Result readback requires one fixed same-origin :id path, publicId:true, exact public response/identity paths and content assertions.'); };
const sensitive = /password|passwd|secret|cookie|authorization|token|credential|api.?key|csrf|session/i;
const parts = path => path.split('.');
export const writeResultSpecs = spec => Array.isArray(spec) ? spec : [spec];
export const requiresWriteResultV2 = spec => Boolean(spec && (Array.isArray(spec) || spec.responseSource || ['signed-integer','decimal'].includes(spec.idType)));
function checkPath(path) {
  if (typeof path !== 'string' || path.length > 200 || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path)
    || parts(path).length > 8 || parts(path).some(key => sensitive.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key))) invalid();
}
function valueAt(value, path) {
  for (const key of parts(path)) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

/** Only the explicitly reviewed public identifier can survive the response. */
export function resolveWriteResult(spec, response, origin, metadata = {}) {
  if(Array.isArray(spec)) {
    const bindings=spec.map(value=>resolveWriteResult(value,response,origin,metadata));
    return {bindings,ids:bindings.map(value=>value.id)};
  }
  let id = spec.responsePath ? valueAt(spec.idType === 'decimal' && metadata.exactBody ? metadata.exactBody : response, spec.responsePath) : undefined;
  if(spec.responseSource?.kind==='header') id=metadata.headers?.[spec.responseSource.name];
  if(spec.responseSource?.kind==='url' || spec.responseSource?.kind==='header' && spec.responseSource.template) {
    const sourceUrl=spec.responseSource.kind==='url'?metadata.url:id;
    if(typeof sourceUrl!=='string'||!sourceUrl||sourceUrl.length>4096||/[\r\n\0]/.test(sourceUrl))invalid();
    let actual,template;try{actual=new URL(sourceUrl,origin);template=new URL(spec.responseSource.template);}catch{invalid();}
    const expected=template.pathname.split('/'),received=actual.pathname.split('/');
    if(actual.origin!==origin||actual.search||actual.hash||actual.username||actual.password||received.length!==expected.length||expected.some((part,i)=>part!==':id'&&part!==received[i]))invalid();
    try{id=decodeURIComponent(received[expected.indexOf(':id')]);}catch{invalid();}
  }
  const valid = spec.idType === 'integer'
    ? Number.isSafeInteger(id) && id >= 0 && !Object.is(id, -0)
    : spec.idType === 'signed-integer' ? Number.isSafeInteger(id) && !Object.is(id,-0)
    : spec.idType === 'decimal' ? typeof id === 'string' && id.length<=512 && /^(?:0|-?[1-9][0-9]*)$/.test(id)
    : (spec.idType === undefined || spec.idType === 'string') && typeof id === 'string' && id.length > 0 && id.length <= 512
      && id !== '.' && id !== '..' && /^[\p{L}\p{N}_.-]+$/u.test(id);
  if (!valid) throw fail('WRITE_RESULT_ID_INVALID', 'The actual write response lacks a public identifier matching the declared type and source. No lossy coercion or resource URL guessing is allowed.');
  const url = new URL(spec.url);
  url.pathname = '/' + url.pathname.slice(1).split('/').map(part => part === ':id' ? encodeURIComponent(id) : part).join('/');
  assertReadRequest({ url: url.href }, origin, []);
  return { id, url: url.href };
}

export function normalizeWriteResult(input, mockResponse, origin, metadata = {}) {
  if(Array.isArray(input)) {
    if(input.length<2||input.length>10)invalid();
    const specs=input.map(value=>{if(Array.isArray(value))invalid();return normalizeWriteResult(value,mockResponse,origin,metadata);});
    if(new Set(specs.map(value=>JSON.stringify([value.url,value.responsePath,value.responseSource]))).size!==specs.length)invalid();
    return specs;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['url', 'publicId', 'idType', 'responsePath', 'responseSource', 'identityPath', 'expect'].includes(key)) || input.publicId !== true
    || input.idType !== undefined && !['string', 'integer', 'signed-integer', 'decimal'].includes(input.idType)) invalid();
  if(input.responseSource) {
    const source=input.responseSource;
    if(input.responsePath!==undefined||!source||typeof source!=='object'||Array.isArray(source))invalid();
    if(source.kind==='header') {
      if(Object.keys(source).sort().join(',')!==(source.template===undefined?'kind,name':'kind,name,template')||typeof source.name!=='string'||!(/^(?:x-[a-z0-9-]{1,60}|location)$/.test(source.name))||sensitive.test(source.name)||source.name==='location'&&!source.template)invalid();
    } else if(source.kind==='url') {
      if(Object.keys(source).sort().join(',')!=='kind,template')invalid();
      let template;try{template=new URL(source.template);}catch{invalid();}
      if(template.origin!==origin||template.href!==source.template||template.username||template.password||template.search||template.hash||template.pathname.split('/').filter(v=>v===':id').length!==1)invalid();
    } else invalid();
    if(source.kind==='header'&&source.template){let template;try{template=new URL(source.template);}catch{invalid();}if(template.origin!==origin||template.href!==source.template||template.username||template.password||template.search||template.hash||template.pathname.split('/').filter(v=>v===':id').length!==1)invalid();}
    if(['integer','signed-integer'].includes(input.idType))invalid(); // Headers/URLs are text; never silently coerce.
  } else checkPath(input.responsePath);
  checkPath(input.identityPath);
  let url;
  try { url = new URL(input.url); } catch { invalid(); }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash || input.url !== url.href
    || url.pathname.split('/').filter(part => part === ':id').length !== 1) invalid();
  // An example ID validates the fixed read route without making a network call.
  const expect = normalizeVerificationCases([{ id: 'result', args: {}, expect: input.expect }])[0].expect;
  if (!Object.keys(expect.equals || {}).some(key => {
    const canonical = key.replace(/^\$\.?/, '').split('.').filter(Boolean).join('.');
    return canonical && canonical !== input.identityPath && !canonical.includes('*');
  })) invalid();
  const spec = { url: url.href, publicId: true, ...(input.idType !== undefined ? { idType: input.idType } : {}), ...(input.responseSource?{responseSource:structuredClone(input.responseSource)}:{responsePath:input.responsePath}), identityPath: input.identityPath, expect };
  // Metadata sources use explicit public mock metadata supplied by the fixture.
  try { resolveWriteResult(spec, mockResponse, origin, metadata); } catch { invalid(); }
  return spec;
}

export function writeResultIdentityMatches(value, spec, id) {
  return Object.is(valueAt(value, spec.identityPath), id);
}

export function savedWriteResult(execution) {
  const spec = execution.effect.resultReadback;
  if (!execution.resultBinding) throw fail('WRITE_RESULT_ID_UNAVAILABLE', 'No durable response identifier is available. Inspect the service independently; never repeat the write to recover its ID.');
  // Reconstruct rather than accepting a persisted arbitrary URL; validate again
  // before either transport or credential resolution can observe the target.
  if(Array.isArray(spec)) {
    if(!Array.isArray(execution.resultBinding.ids)||execution.resultBinding.ids.length!==spec.length)throw fail('WRITE_RESULT_ID_UNAVAILABLE','The durable identifier set is incomplete.');
    const bindings=spec.map((value,index)=>savedWriteResult({...execution,effect:{...execution.effect,resultReadback:value},resultBinding:{id:execution.resultBinding.ids[index]}}));
    return {bindings,ids:bindings.map(value=>value.id)};
  }
  const origin = new URL(spec.url).origin;
  if (!(execution.page ? [execution.page.ui?.frames?.at(-1).origin || execution.page.route.origin] : execution.http.origins).includes(origin)) throw fail('HTTP_ORIGIN_DENIED', 'Result readback origin is not declared.');
  return resolveWriteResult({ ...spec, responseSource:undefined, responsePath: 'id' }, execution.resultBinding, origin);
}

export { parseWriteJson } from './write-result-json.js';
