import { expect, it } from 'vitest';
import { normalizeWriteResult, resolveWriteResult, savedWriteResult, writeResultIdentityMatches, parseWriteJson } from '../exploration-write-result.js';

const origin = 'https://example.com';
const spec = { url: origin + '/items/:id', publicId: true, responsePath: 'item.id', identityPath: 'id', expect: { equals: { title: 'After' } } };

it('binds only an own public response field and preserves string identity, zeros and Unicode', () => {
  const normalized = normalizeWriteResult(spec, { item: { id: 'example' } }, origin);
  const binding = resolveWriteResult(normalized, { item: { id: '007示例' }, unrelated: 'not retained' }, origin);
  expect(binding).toEqual({ id: '007示例', url: origin + '/items/007%E7%A4%BA%E4%BE%8B' });
  expect(writeResultIdentityMatches({ id: '007示例' }, normalized, binding.id)).toBe(true);
  expect(writeResultIdentityMatches({ id: 7 }, normalized, '007')).toBe(false);
  expect(() => resolveWriteResult(normalized, { item: Object.create({ id: 'example' }) }, origin)).toThrow();
});

it.each([undefined, null, 7, false, {}, [], '', '.', '..', '../other', 'a/b', 'a\\b', '%2e', 'https://example.org', 'a?b', 'a#b', 'a\n', '[REDACTED]', 'x'.repeat(513), '\ud800'])('rejects unsafe or absent response identity %#', id => {
  expect(() => resolveWriteResult(spec, { item: { id } }, origin)).toThrow();
});

it.each([
  { publicId: false }, { responsePath: 'access_token' }, { responsePath: 'item.*.id' }, { responsePath: '__proto__.id' },
  { responsePath: 'item.constructor' }, { identityPath: 'session.id' }, { responsePath: 'item..id' },
  { url: origin + '/items/:id/:id' }, { url: 'https://example.org/items/:id' }, { url: origin + '/items/:id?q=x' },
  { url: origin + '/items/:id#x' }, { url: 'https://example:placeholder@example.com/items/:id' },
  { url: origin + '/delete/:id' }, { expect: { equals: { id: 'example' } } },
  { expect: { equals: { '$.id': 'example' } } }, { expect: { equals: { '.id': 'example' } } }, { unexpected: true },
])('rejects unreviewable result readback declarations %#', patch => {
  expect(() => normalizeWriteResult({ ...spec, ...patch }, { item: { id: 'example' } }, origin)).toThrow();
});

it('requires a captured binding for recovery and rejects another origin before requests', () => {
  const execution = { effect: { resultReadback: spec }, http: { origins: [origin] } };
  expect(() => savedWriteResult(execution)).toThrow(expect.objectContaining({ code: 'WRITE_RESULT_ID_UNAVAILABLE' }));
  execution.resultBinding = { id: '007' };
  expect(savedWriteResult(execution).url).toBe(origin + '/items/007');
  execution.http.origins = ['https://example.org'];
  expect(() => savedWriteResult(execution)).toThrow();
});

it.each([0, 7, Number.MAX_SAFE_INTEGER])('preserves explicitly declared integer identity %s through resolution and recovery', id => {
  const normalized = normalizeWriteResult({ ...spec, idType: 'integer' }, { item: { id: 1 } }, origin);
  expect(resolveWriteResult(normalized, { item: { id } }, origin)).toEqual({ id, url: origin + '/items/' + id });
  expect(writeResultIdentityMatches({ id }, normalized, id)).toBe(true);
  expect(writeResultIdentityMatches({ id: String(id) }, normalized, id)).toBe(false);
  expect(savedWriteResult({ effect: { resultReadback: normalized }, http: { origins: [origin] }, resultBinding: { id } }).id).toBe(id);
});

it.each([-0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '7', '007', null, true])('rejects non-exact integer identities %#', id => {
  expect(() => resolveWriteResult({ ...spec, idType: 'integer' }, { item: { id } }, origin)).toThrow();
});

it('does not infer an ID type from the mock or silently widen an old declaration', () => {
  for (const idType of [null, 'number', 'auto', true]) expect(() => normalizeWriteResult({ ...spec, idType }, { item: { id: 1 } }, origin)).toThrow();
  expect(() => normalizeWriteResult(spec, { item: { id: 1 } }, origin)).toThrow();
  expect(() => normalizeWriteResult({ ...spec, idType: 'integer' }, { item: { id: '1' } }, origin)).toThrow();
  expect(normalizeWriteResult(spec, { item: { id: '007' } }, origin)).not.toHaveProperty('idType');
});

it('preserves signed safe integers and exact arbitrary-precision decimal JSON only when declared',()=>{
  const signed={...spec,idType:'signed-integer'};expect(resolveWriteResult(signed,{item:{id:-17}},origin).id).toBe(-17);
  const decimal={...spec,idType:'decimal'},text='{"item":{"id":-9007199254740993123456789},"count":3}';
  const exactBody=parseWriteJson(text,['item.id']);expect(exactBody).toEqual({item:{id:'-9007199254740993123456789'},count:3});
  expect(resolveWriteResult(decimal,JSON.parse(text),origin,{exactBody}).id).toBe('-9007199254740993123456789');
  expect(()=>resolveWriteResult(decimal,JSON.parse(text),origin)).toThrow();
  for(const raw of ['-0','1.0','1e3'])expect(()=>parseWriteJson('{"id":'+raw+'}',['id'])).toThrow();
  expect(parseWriteJson('{"id":"007","count":3}',['id'])).toEqual({id:'007',count:3});
});

it('reads only explicitly reviewed public headers and exact response URL templates',()=>{
  const header={...spec,responsePath:undefined,responseSource:{kind:'header',name:'x-resource-id'}};delete header.responsePath;
  const normalized=normalizeWriteResult(header,{},origin,{headers:{'x-resource-id':'007'}});
  expect(resolveWriteResult(normalized,{},origin,{headers:{'x-resource-id':'actual'}}).id).toBe('actual');
  expect(()=>resolveWriteResult(normalized,{item:{id:'mock'}},origin)).toThrow();
  const url={...header,responseSource:{kind:'url',template:origin+'/created/:id'}};
  expect(normalizeWriteResult(url,{},origin,{url:origin+'/created/007'})).toMatchObject({responseSource:url.responseSource});
  expect(resolveWriteResult(url,{},origin,{url:origin+'/created/%E7%A4%BA%E4%BE%8B'}).id).toBe('示例');
  for(const actual of ['https://example.org/created/7',origin+'/other/7',origin+'/created/7?secret=x',origin+'/created/a%2fb'])expect(()=>resolveWriteResult(url,{},origin,{url:actual})).toThrow();
  for(const name of ['authorization','x-token','set-cookie'])expect(()=>normalizeWriteResult({...header,responseSource:{kind:'header',name}},{},origin,{headers:{[name]:'example'}})).toThrow();
});

it('validates all IDs before any resource read and reconstructs a minimal multi-ID durable binding',()=>{
  const specs=[spec,{...spec,responsePath:'other.id',url:origin+'/others/:id',idType:'signed-integer'}];
  const normalized=normalizeWriteResult(specs,{item:{id:'007'},other:{id:-3}},origin);
  const resolved=resolveWriteResult(normalized,{item:{id:'actual'},other:{id:-4}},origin);
  expect(resolved.ids).toEqual(['actual',-4]);
  expect(savedWriteResult({effect:{resultReadback:normalized},http:{origins:[origin]},resultBinding:{ids:resolved.ids}})).toEqual(resolved);
  expect(()=>resolveWriteResult(normalized,{item:{id:'actual'}},origin)).toThrow();
  expect(()=>savedWriteResult({effect:{resultReadback:normalized},http:{origins:[origin]},resultBinding:{ids:['actual']}})).toThrow();
});
