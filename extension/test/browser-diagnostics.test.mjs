import test from 'node:test';
import assert from 'node:assert/strict';
import { executeBrowserCommand } from '../background/browser-commands.js';

test('diagnostic trace reads only the retained task tab, with identity/origin checks before any read', async () => {
  const reads = [], traceID = 'abcdef123456';
  const chrome = { storage: { session: { get: async () => ({ 'webcli-browser-tab-7': 'example-identity' }) } },
    tabs: { get: async () => ({ id:7, url:'https://example.com/' }), sendMessage: async (id,msg) => { reads.push(id); return { logs:[`[2026-01-01T00:00:00.000Z] [${msg.traceID}] example`] }; }, query: async () => { throw Error('must not enumerate tabs'); } } };
  const execute = overrides => executeBrowserCommand({ command:'diagnostic-trace',tabId:7,identity:'example-identity',args:{traceID,diagnosticOrigin:'https://example.com'},...overrides }, {chrome,getTraceLogs:()=>[`[2026-01-01T00:00:00.000Z] [${traceID}] example SW`]});
  assert.equal((await execute()).data.logs.length,2); assert.deepEqual(reads,[7]);
  reads.length=0;
  assert.equal((await execute({identity:'stale'})).error.code,'SESSION_EXPIRED');
  assert.equal((await execute({args:{traceID,diagnosticOrigin:'https://example.org'}})).error.code,'DIAGNOSTIC_ORIGIN_CHANGED');
  assert.equal((await execute({args:{traceID:'wrong'}})).error.code,'INVALID_ARGUMENT'); assert.deepEqual(reads,[]);
});

test('diagnostic trace bounds both sources and marks unavailable content without falling back to other tabs', async () => {
  const traceID='abcdef123456';
  const chrome={storage:{session:{get:async()=>({'webcli-browser-tab-7':'example'})}},tabs:{get:async()=>({url:'https://example.com/'}),sendMessage:async()=>{throw Error('no injector');}}};
  const result=await executeBrowserCommand({command:'diagnostic-trace',tabId:7,identity:'example',args:{traceID,diagnosticOrigin:'https://example.com'}},{chrome,getTraceLogs:()=>Array(101).fill(`[2026-01-01T00:00:00.000Z] [${traceID}] `+'x'.repeat(9000))});
  assert.equal(result.ok,true);assert.equal(result.data.contentAvailable,false);assert.equal(result.data.truncated,true);assert.equal(result.data.logs.length,100);assert.ok(result.data.logs.every(line=>line.length<=8000));
});
