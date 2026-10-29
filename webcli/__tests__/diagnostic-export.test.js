import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ExplorationService } from '../exploration-service.js';
import { resolveAdapterPaths } from '../paths.js';
import { checkDiagnosticDirectory, DIAGNOSTIC_LIMITS } from '../diagnostic-export.js';

const roots = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup({ mode = 'browser', connected = true, capability = true, request } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-export-')); roots.push(root);
  for (const [key, value] of Object.entries({ WEWORKER_USER_ADAPTERS_DIR: path.join(root,'user'), WEBCLI_ADAPTERS_DIR: path.join(root,'user'), WEWORKER_ADAPTER_DATA_DIR: path.join(root,'data'), WEWORKER_BUILTIN_ADAPTERS_DIR: path.join(root,'builtin') })) vi.stubEnv(key,value);
  const at = Date.now() - 30000;
  const requestExtension = vi.fn(request || (async msg => ({ ok: true, data: msg.command === 'events' ? { entries: msg.args.channel === 'network' ? [{ timestamp: at + 1000, sequence: 1, phase: 'complete', url: 'https://example.com/account/example-private-placeholder?token=example-secret-placeholder', method: 'GET', status: 200, size: 25 }] : [{ timestamp: at + 1000, sequence: 1, level: 'error', text: 'example-secret-placeholder' }], capturedAt: Date.now(), truncated: false, hasMore: false }
    : msg.command === 'diagnostic-trace' ? { logs: [`[${new Date(at+1000).toISOString()}] [abcdef123456] example-secret-placeholder`], contentAvailable: true }
    : { title: 'example-private-placeholder', url: 'https://example.com/account', metrics: { interactiveNodes: 3, textChars: 12 } } })));
  const service = new ExplorationService({ rootDir: path.join(root,'tasks'), paths: resolveAdapterPaths(), mode, requestExtension,
    capabilities: () => ({ connected, contextId: 'example-private-profile', capabilities: capability ? ['browser_diagnostics_v1'] : [] }) });
  const run = { taskId: mode === 'http' ? 'http-00000000-0000-0000-0000-000000000000' : '00000000-0000-0000-0000-000000000000', mode, createdAt: new Date(at).toISOString(), updatedAt: new Date(at+1000).toISOString(), status: 'failed', siteKey: 'example.com', origin: 'https://example.com', tabId: 7, browserIdentity: 'example-identity',
    candidates: [], events: [{ at: new Date(at+1000).toISOString(), cursor: 1, status: 'failed', message: 'example-secret-placeholder' }], goal: 'example-private-placeholder', sequence: 1 };
  service.runs.set(run.taskId, run);
  const directory = path.join(root,'export');
  return { root, service, run, at, requestExtension, directory, export: extra => service.execute('export', { taskId: run.taskId, directory, ...extra }) };
}
function receipt(f) { return JSON.parse(fs.readFileSync(path.join(f.directory,'receipt.json'))); }
function rows(f,name) { return fs.readFileSync(path.join(f.directory,`${name}.jsonl`),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }

it('exports only the selected task/profile, redacts unconstrained strings and never dispatches an action', async () => {
  const f = setup(); const before = JSON.stringify(f.run);
  const result = await f.export({ traceIds: ['abcdef123456'] });
  expect(result.ok).toBe(true); expect(result.data.complete).toBe(false); // no installed Adapter and trace retention unknown
  expect(f.requestExtension.mock.calls.map(([m])=>m.command)).toEqual(['events','events','state','diagnostic-trace']);
  for (const [message] of f.requestExtension.mock.calls) expect(message).toMatchObject({ type:'browser_execute',tabId:7,identity:'example-identity',args:{diagnosticOrigin:'https://example.com'} });
  const text = fs.readdirSync(f.directory).map(file=>fs.readFileSync(path.join(f.directory,file),'utf8')).join('');
  for (const secret of ['example-secret-placeholder','example-private-placeholder','example-private-profile','example.com','https://',f.root,'abcdef123456']) expect(text).not.toContain(secret);
  expect(receipt(f)).toMatchObject({ currentEffectVerified:false,replayAllowed:false,toolExecuted:false,status:'partial' });
  expect(rows(f,'call-trace')).toHaveLength(1); expect(JSON.stringify(f.run)).toBe(before);
});
it('uses inclusive absolute windows, never consumes a source to recreate missing history', async () => {
  const f = setup(); f.run.events = [0,1000,2000,3000].map((n,i)=>({at:new Date(f.at+n).toISOString(),cursor:i+1,status:'draft'}));
  expect((await f.export({since:new Date(f.at+1000).toISOString(),until:new Date(f.at+2000).toISOString()})).ok).toBe(true);
  expect(rows(f,'task-trace').map(row=>row.cursor)).toEqual([2,3]);
  expect(rows(f,'network')).toHaveLength(1); expect(f.requestExtension).toHaveBeenCalledTimes(3);
});
it('reports row limits, source eviction, pending gaps and partial failure independently', async () => {
  const f = setup({request:async msg=>msg.command==='state' ? {ok:false,error:{code:'SESSION_EXPIRED',message:'example-secret-placeholder'}} : {ok:true,data:{capturedAt:Date.now(),hasMore:false,truncated:true,entries:[{timestamp:Date.now()-1000,sequence:8,phase:'gap',dropped:1}]}}});
  f.run.events = Array.from({length:200},(_,i)=>({at:new Date(f.at+1000+i).toISOString(),cursor:i+5,status:'failed'}));
  expect((await f.export({limit:2})).ok).toBe(true);
  expect(receipt(f).sections['task-trace']).toMatchObject({count:2,truncated:true,status:'partial'});
  expect(receipt(f).sections.network.truncated).toBe(true);
  expect(receipt(f).sections.state).toMatchObject({status:'failed',reason:'SESSION_EXPIRED'});
  for (const section of Object.values(receipt(f).sections)) expect(section.bytes).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.sectionBytes);
});
it.each([{mode:'http',reason:'NOT_APPLICABLE_HOST_HTTP'},{connected:false,reason:'PROFILE_DISCONNECTED'},{capability:false,reason:'EXTENSION_UPGRADE_REQUIRED'}])('does not bootstrap unavailable runtime: $reason', async options => {
  const f=setup(options); await f.export({screenshot:true,traceIds:['abcdef123456']});
  expect(f.requestExtension).not.toHaveBeenCalled();
  for(const name of ['network','console','state','call-trace','screenshot']) expect(receipt(f).sections[name].reason).toBe(options.reason);
});
it('accepts an actual host HTTP UUID but reports unavailable trace evidence without executing a request', async () => {
  const f=setup({mode:'http'}), traceId=randomUUID();
  const result=await f.export({traceIds:[traceId]});
  expect(result.ok).toBe(true); expect(result.data.complete).toBe(false);
  expect(receipt(f).sections['call-trace']).toMatchObject({status:'missing',reason:'NOT_APPLICABLE_HOST_HTTP',count:0});
  expect(f.requestExtension).not.toHaveBeenCalled();
  const contents=fs.readdirSync(f.directory).map(file=>fs.readFileSync(path.join(f.directory,file),'utf8')).join('');
  expect(contents).not.toContain(traceId);
});
it('does not send a host HTTP UUID to a browser trace source', async () => {
  const f=setup(), result=await f.export({traceIds:[randomUUID()]});
  expect(result.error.code).toBe('INVALID_ARGUMENT'); expect(f.requestExtension).not.toHaveBeenCalled();
  expect(fs.existsSync(f.directory)).toBe(false);
});
it.each([{since:'yesterday'},{until:'2999-01-01T00:00:00Z'},{limit:0},{limit:201},{limit:true},{screenshot:'yes'},{traceIds:['wrong']},{traceIds:Array(11).fill('abcdef123456')},{unexpected:true}])('rejects invalid selection before any read or directory creation: %j', async args => {
  const f=setup(); expect((await f.export(args)).ok).toBe(false); expect(f.requestExtension).not.toHaveBeenCalled(); expect(fs.existsSync(f.directory)).toBe(false);
});
it('refuses an existing directory/file, traversal, managed destinations and linked ancestors', async () => {
  const f=setup(); fs.mkdirSync(f.directory); fs.writeFileSync(path.join(f.directory,'keep'),'example');
  expect((await f.export()).error.code).toBe('EXPORT_DESTINATION_EXISTS'); expect(fs.readFileSync(path.join(f.directory,'keep'),'utf8')).toBe('example');
  expect(()=>checkDiagnosticDirectory(path.join(f.root,'tasks','new'),[f.service.root])).toThrow(/outside/);
  expect(()=>checkDiagnosticDirectory(f.root+path.sep+'..'+path.sep+'escaped')).toThrow(/traversal/);
  const link=path.join(f.root,'linked'); fs.symlinkSync(f.service.root,link,process.platform==='win32'?'junction':'dir');
  expect(()=>checkDiagnosticDirectory(path.join(link,'child'))).toThrow(/links/);
  expect(f.requestExtension).not.toHaveBeenCalled();
});
it('revalidates the destination after asynchronous collection and does not overwrite a raced directory', async () => {
  const f=setup(); let done=false;
  f.service.request=async()=>{if(!done){done=true;fs.mkdirSync(f.directory);fs.writeFileSync(path.join(f.directory,'keep'),'example');}return{ok:true,data:{entries:[],metrics:{}}};};
  expect((await f.export()).error.code).toBe('EXPORT_DESTINATION_EXISTS'); expect(fs.readdirSync(f.directory)).toEqual(['keep']);
});
it('requires explicit screenshot opt-in, bounds bytes and preserves failure reasons', async () => {
  const f=setup(); f.service.request=async msg=>msg.command==='screenshot'?{ok:true,data:{mimeType:'image/png',data:'a'.repeat(3*1024*1024)}}:{ok:true,data:{entries:[],metrics:{}}};
  await f.export({screenshot:true}); expect(receipt(f).sections.screenshot.status).toBe('failed'); expect(fs.existsSync(path.join(f.directory,'screenshot.png'))).toBe(false);
});
it('never guesses dates in legacy call traces and marks missing trace IDs separately', async () => {
  const f=setup();f.service.request=async msg=>({ok:true,data:msg.command==='diagnostic-trace'?{logs:msg.args.traceID==='abcdef123456'?['[12:34:56.123] [abcdef123456] example']:[]}:{entries:[],metrics:{}}});
  await f.export({traceIds:['abcdef123456','abcdef123457']});expect(receipt(f).sections['call-trace']).toMatchObject({status:'partial',recordsWithoutUsableTime:1,missingTraces:1,count:0});
});
it('keeps partial files on filesystem failure and never writes a successful receipt or deletes output', async () => {
  const f=setup(); const write=fs.writeFileSync;
  vi.spyOn(fs,'writeFileSync').mockImplementation((file,...args)=>{if(String(file).endsWith('task-state.jsonl'))throw Error('Example disk failure');return write(file,...args);});
  expect((await f.export()).error.code).toBe('EXPORT_SAVE_FAILED');
  expect(fs.readdirSync(f.directory)).toEqual(['task-trace.jsonl']);
  expect((await f.export()).error.code).toBe('EXPORT_DESTINATION_EXISTS');
});
it('refuses a destination ancestor changed to a link during evidence collection', async () => {
  const f=setup();const parent=path.join(f.root,'parent');fs.mkdirSync(parent);const elsewhere=path.join(f.root,'elsewhere');fs.mkdirSync(elsewhere);let changed=false;
  f.service.request=async()=>{if(!changed){changed=true;fs.renameSync(parent,path.join(f.root,'retained-parent'));fs.symlinkSync(elsewhere,parent,process.platform==='win32'?'junction':'dir');}return{ok:true,data:{entries:[],metrics:{}}};};
  const result=await f.export({directory:path.join(parent,'output')});expect(result.error.code).toBe('EXPORT_LINK_REJECTED');expect(fs.readdirSync(elsewhere)).toEqual([]);
});
