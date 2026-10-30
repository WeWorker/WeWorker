import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserService } from '../browser-service.js';
import { WebSocketBridge } from '../bridge.js';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-service-')); roots.push(rootDir);
  const requestExtension = vi.fn(async message => message.type === 'exploration_list_tabs'
    ? { tabs: [{ id: 7, url: 'https://example.com/' }, { id: 8, url: 'https://example.org/' }] }
    : { ok: true, data: message.command === 'open' ? { tabId: 8, url: message.args.url, identity: 'example-tab-identity' } : { completed: true, identity: 'example-tab-identity' } });
  const options = { rootDir, requestExtension, capabilities: () => ({ connected: true, capabilities: ['browser_commands_v1'] }) };
  return { options, requestExtension, service: new BrowserService(options) };
}
it('persists bound sessions across instances and does not close or navigate user tabs', async () => {
  const { service, options, requestExtension } = setup();
  expect((await service.execute('bind', { session: 'work', tabId: 7 })).ok).toBe(true);
  const restored = new BrowserService(options);
  expect((await restored.execute('sessions')).data.sessions).toMatchObject([{ session: 'work', tabId: 7, owned: false }]);
  expect((await restored.execute('open', { session: 'work', url: 'https://example.org/' })).error.code).toBe('BOUND_TAB_NAVIGATION');
  expect((await restored.execute('back', { session: 'work' })).error.code).toBe('BOUND_TAB_NAVIGATION');
  expect((await restored.execute('close', { session: 'work' })).data.tabClosed).toBe(false);
  expect(requestExtension.mock.calls.some(([msg]) => msg.command === 'close')).toBe(false);
});
it('owns newly opened tabs and closes only owned tabs', async () => {
  const { service, requestExtension } = setup();
  const opened = await service.execute('open', { session: 'new', url: 'https://example.org/' });
  expect(opened.data).toMatchObject({ tabId: 8, owned: true });
  expect((await service.execute('state', { session: 'new' })).ok).toBe(true);
  expect((await service.execute('close', { session: 'new' })).data.tabClosed).toBe(true);
  expect(requestExtension.mock.calls.some(([msg]) => msg.command === 'close' && msg.tabId === 8)).toBe(true);
});
it('prevents ambiguous bindings, invalid inputs and non-web URLs', async () => {
  const { service } = setup();
  await service.execute('bind', { session: 'one', tabId: 7 });
  expect((await service.execute('bind', { session: 'two', tabId: 7 })).error.code).toBe('TAB_BUSY');
  expect((await service.execute('bind', { session: '../escape', tabId: 7 })).error.code).toBe('INVALID_ARGUMENT');
  expect((await service.execute('state', { session: 'one', unexpected: true })).error.code).toBe('INVALID_ARGUMENT');
  expect((await service.execute('open', { session: 'two', url: 'file:///example' })).error.code).toBe('INVALID_ARGUMENT');
  expect((await service.execute('fill', { session: 'one', selector: '#search' })).error.code).toBe('INVALID_ARGUMENT');
});
it('serializes work per session without one rejected operation unlocking another', async () => {
  const { service, requestExtension } = setup(); await service.execute('bind', { session: 'work', tabId: 7 });
  let finish;
  const original = requestExtension.getMockImplementation();
  requestExtension.mockImplementation(message => message.command === 'state' ? new Promise(resolve => { finish = resolve; }) : original(message));
  const running = service.execute('state', { session: 'work' });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  for (let i = 0; i < 2; i++) expect((await service.execute('state', { session: 'work' })).error.code).toBe('SESSION_BUSY');
  finish({ ok: true, data: { title: 'Example' } }); expect((await running).ok).toBe(true);
});
it('reports capability gaps and preserves typed page failures', async () => {
  const { options, service, requestExtension } = setup(); await service.execute('bind', { session: 'work', tabId: 7 });
  expect((await service.execute('doctor')).data.ready).toBe(true);
  const outdated = new BrowserService({ ...options, capabilities: () => ({ connected: true, capabilities: [] }) });
  expect((await outdated.execute('doctor')).data.ready).toBe(false);
  expect((await outdated.execute('state', { session: 'work' })).error.code).toBe('EXTENSION_UPGRADE_REQUIRED');
  const original = requestExtension.getMockImplementation();
  requestExtension.mockImplementation(message => message.type === 'browser_execute' ? { ok: false, error: { code: 'STALE_REF', message: 'Refresh state.' } } : original(message));
  expect((await service.execute('click', { session: 'work', ref: 'old' })).error.code).toBe('STALE_REF');
});
it('only local RPC callers receive browser results; extension peers cannot invoke it', async () => {
  const bridge = Object.create(WebSocketBridge.prototype);
  const execute = vi.fn(async () => ({ ok: true, data: { title: 'Example' } }));
  bridge._profileService = vi.fn(async () => ({ execute }));
  bridge._runInProfile = (msg, ws, fn) => fn(); bridge._route = { getStore: () => ({ contextId: 'example-context' }) }; bridge._broadcast = vi.fn();
  const ws = { _explorationLocal: true, readyState: 1, send: vi.fn() };
  await bridge._handleBrowserCommand({ id: 'one', command: 'state', args: {} }, ws);
  expect(execute).toHaveBeenCalledOnce(); expect(bridge._broadcast).not.toHaveBeenCalled();
  expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({ id: 'one', type: 'browser_command_result', result: { ok: true } });
  await bridge._handleBrowserCommand({ id: 'two', command: 'state' }, { ...ws, _explorationLocal: false });
  expect(execute).toHaveBeenCalledOnce();
});
it('actual CLI exposes browser discovery without a service or model', () => {
  const cli = fileURLToPath(new URL('../index.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'call', 'browser.help'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).commands.map(item => item.name)).toContain('browser.network');
});

it('permits dialog responses while a browser operation is blocked, without releasing its lock', async () => {
  const { service, requestExtension } = setup(); await service.execute('bind', { session: 'work', tabId: 7 });
  let finish; const original = requestExtension.getMockImplementation();
  requestExtension.mockImplementation(message => message.command === 'click' ? new Promise(resolve => { finish = resolve; }) : original(message));
  const pending = service.execute('click', { session: 'work', selector: '#prompt' });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect((await service.execute('dialog', { session: 'work', action: 'accept' })).ok).toBe(true);
  expect((await service.execute('state', { session: 'work' })).error.code).toBe('SESSION_BUSY');
  finish({ ok: true, data: {} }); await pending;
});
it('validates upload files locally and preserves expired browser session identity errors', async () => {
  const { service, requestExtension, options } = setup(); await service.execute('bind', { session: 'work', tabId: 7 });
  expect((await service.execute('upload', { session: 'work', selector: 'input', paths: ['relative.txt'] })).error.code).toBe('INVALID_ARGUMENT');
  expect((await service.execute('upload', { session: 'work', selector: 'input', paths: [options.rootDir] })).error.code).toBe('INVALID_ARGUMENT');
  const original = requestExtension.getMockImplementation();
  requestExtension.mockImplementation(message => message.type === 'browser_execute' ? { ok: false, error: { code: 'SESSION_EXPIRED', message: 'Rebind intended tab.' } } : original(message));
  expect((await service.execute('state', { session: 'work' })).error.code).toBe('SESSION_EXPIRED');
  expect(requestExtension.mock.calls.at(-1)[0].identity).toBe('example-tab-identity');
});

it('guards frame eval and document targeting from older extensions and forwards explicit identities', async () => {
  const { service, options, requestExtension } = setup(); await service.execute('bind', { session: 'work', tabId: 7 });
  const expression = 'document.title';
  expect((await service.execute('eval', { session: 'work', frameId: 12, expression })).error.code).toBe('EXTENSION_UPGRADE_REQUIRED');
  expect((await service.execute('click', { session: 'work', selector: '#example', documentId: 'example-document' })).error.code).toBe('EXTENSION_UPGRADE_REQUIRED');
  const capable = new BrowserService({ ...options, capabilities: () => ({ connected: true, capabilities: ['browser_commands_v1', 'browser_frames_v1'] }) });
  expect((await capable.execute('eval', { session: 'work', frameId: '12', documentId: 'example-document', expression })).ok).toBe(true);
  expect(requestExtension.mock.calls.at(-1)[0]).toMatchObject({ command: 'eval', args: { frameId: '12', documentId: 'example-document', expression }, identity: 'example-tab-identity' });
});

it('download observers release no action locks and propagate progress details, while old extensions are rejected', async () => {
  const { service, requestExtension, options } = setup(); await service.execute('bind', { session: 'work', tabId: 7 });
  expect((await service.execute('downloads', { session: 'work' })).error.code).toBe('EXTENSION_UPGRADE_REQUIRED');
  const capable = new BrowserService({ ...options, capabilities: () => ({ connected: true, capabilities: ['browser_commands_v1', 'browser_downloads_v1'] }) });
  let finish; const original = requestExtension.getMockImplementation();
  requestExtension.mockImplementation(message => message.command === 'wait' ? new Promise(resolve => { finish = resolve; }) : original(message));
  const pending = capable.execute('wait', { session: 'work', kind: 'download', after: 'example-cursor' });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect((await capable.execute('click', { session: 'work', selector: '#download' })).ok).toBe(true);
  expect((await capable.execute('downloads', { session: 'work' })).ok).toBe(true);
  finish({ ok: false, error: { code: 'DOWNLOAD_TIMEOUT', message: 'Still receiving.', details: { state: 'in_progress', download: { downloadId: 'example-guid' } } } });
  expect((await pending).error).toMatchObject({ code: 'DOWNLOAD_TIMEOUT', details: { download: { downloadId: 'example-guid' } } });
  expect((await capable.execute('wait', { session: 'work', kind: 'selector' })).error.code).toBe('INVALID_ARGUMENT');
});

it('requires the native frame pointer capability and forwards drag document identity', async () => {
  const { service, requestExtension, options } = setup();await service.execute('bind',{session:'work',tabId:7});
  const framesOnly=new BrowserService({...options,capabilities:()=>({connected:true,capabilities:['browser_commands_v1','browser_frames_v1']})});
  const args={session:'work',frameId:12,documentId:'example-child',selector:'#from',toSelector:'#to'};
  const before=requestExtension.mock.calls.length;
  expect((await framesOnly.execute('drag',args)).error.code).toBe('EXTENSION_UPGRADE_REQUIRED');
  expect(requestExtension.mock.calls.slice(before).some(([msg])=>msg.type==='browser_execute')).toBe(false);
  const native=new BrowserService({...options,capabilities:()=>({connected:true,capabilities:['browser_commands_v1','browser_frames_v1','browser_frame_pointer_v1']})});
  expect((await native.execute('drag',args)).ok).toBe(true);
  expect(requestExtension.mock.calls.at(-1)[0]).toMatchObject({command:'drag',args:{frameId:12,documentId:'example-child',toSelector:'#to'}});
});

it('event polling bypasses a busy page action without releasing its lock, and guards old plugins', async () => {
  const { service, requestExtension, options } = setup();await service.execute('bind',{session:'work',tabId:7});
  expect((await service.execute('events',{session:'work',channel:'console'})).error.code).toBe('EXTENSION_UPGRADE_REQUIRED');
  expect((await service.execute('network',{session:'work',since:'2m'})).error.code).toBe('EXTENSION_UPGRADE_REQUIRED');
  const native=new BrowserService({...options,capabilities:()=>({connected:true,capabilities:['browser_commands_v1','browser_events_v1']})});
  let finish;const original=requestExtension.getMockImplementation();
  requestExtension.mockImplementation(msg=>msg.command==='click'?new Promise(resolve=>{finish=resolve}):original(msg));
  const click=native.execute('click',{session:'work',selector:'#example'});await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  expect((await native.execute('events',{session:'work',channel:'network'})).ok).toBe(true);
  expect((await native.execute('fill',{session:'work',selector:'#example',value:'Example'})).error.code).toBe('SESSION_BUSY');
  expect((await native.execute('console',{session:'work',follow:true})).error.code).toBe('INVALID_ARGUMENT');
  finish({ok:true,data:{completed:true}});await click;
});

it('requires AX capability for source flags and opaque AX refs, then forwards them unchanged',async()=>{
  const {service,options,requestExtension}=setup();await service.execute('bind',{session:'work',tabId:7});
  const ref='ax:12:example-document:00000000-0000-4000-8000-000000000001:1';
  for(const [command,args]of[['state',{source:'ax'}],['state',{compareSources:true}],['click',{ref}]])expect((await service.execute(command,{session:'work',...args})).error.code).toBe('EXTENSION_UPGRADE_REQUIRED');
  const capable=new BrowserService({...options,capabilities:()=>({connected:true,capabilities:['browser_commands_v1','browser_accessibility_v1']})});
  expect((await capable.execute('click',{session:'work',ref})).ok).toBe(true);
  expect(requestExtension.mock.calls.at(-1)[0].args).toEqual({ref});
});

it('guards new screenshot options and saves PNG only to a new explicit local file, never passing its path to Chrome',async()=>{
  const {service,options,requestExtension}=setup();await service.execute('bind',{session:'work',tabId:7});
  expect((await service.execute('screenshot',{session:'work',annotate:true})).error.code).toBe('EXTENSION_UPGRADE_REQUIRED');
  const capable=new BrowserService({...options,capabilities:()=>({connected:true,capabilities:['browser_commands_v1','browser_screenshot_v1']})});
  const data=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(data);data.writeUInt32BE(1,16);data.writeUInt32BE(1,20);
  const original=requestExtension.getMockImplementation();
  requestExtension.mockImplementation(msg=>msg.command==='screenshot'?{ok:true,data:{mimeType:'image/png',data:data.toString('base64'),annotations:[{label:'1',ref:'example-ref'}]}}:original(msg));
  const destination=path.join(options.rootDir,'example.png');
  const result=await capable.execute('screenshot',{session:'work',annotate:true,path:destination});
  expect(result.ok).toBe(true);expect(result.data.path).toBe(destination);expect(result.data.data).toBeUndefined();expect(fs.readFileSync(destination)).toEqual(data);
  expect(requestExtension.mock.calls.at(-1)[0].args.path).toBeUndefined();
  const count=requestExtension.mock.calls.length;
  expect((await capable.execute('screenshot',{session:'work',path:destination})).error.code).toBe('SCREENSHOT_FILE_EXISTS');expect(requestExtension.mock.calls.length).toBe(count+1); // Read-only tab inventory only.
  expect((await capable.execute('screenshot',{session:'work',path:'relative.png'})).error.code).toBe('INVALID_ARGUMENT');
  expect((await capable.execute('screenshot',{session:'work',path:path.join(options.rootDir,'missing','example.png')})).error.code).toBe('SCREENSHOT_PATH_UNAVAILABLE');
});

it('requires explicit shadow capability even for refs, and rejects shadow on non-selector waits',async()=>{
  const {service,options,requestExtension}=setup();await service.execute('bind',{session:'work',tabId:7});
  for(const args of [{shadow:true,selector:'button'},{ref:'shadow:example:1'}])expect((await service.execute('click',{session:'work',...args})).error.code).toBe('EXTENSION_UPGRADE_REQUIRED');
  const capable=new BrowserService({...options,capabilities:()=>({connected:true,capabilities:['browser_commands_v1','browser_shadow_query_v1']})});
  expect((await capable.execute('find',{session:'work',shadow:true,role:'button',name:'Example'})).ok).toBe(true);
  expect(requestExtension.mock.calls.at(-1)[0].args).toEqual({shadow:true,role:'button',name:'Example'});
  expect((await capable.execute('wait',{session:'work',kind:'download',shadow:true})).error.code).toBe('INVALID_ARGUMENT');
});

it('requires compound capability for structured reads and explicit option matching',async()=>{
  const {service,options,requestExtension}=setup();await service.execute('bind',{session:'work',tabId:7});
  for(const [command,args] of [['get',{selector:'input',property:'compound'}],['get',{property:'html',as:'json'}],['state',{compound:true}],['select',{selector:'select',value:'example',by:'value'}]])expect((await service.execute(command,{session:'work',...args})).error.code).toBe('EXTENSION_UPGRADE_REQUIRED');
  const capable=new BrowserService({...options,capabilities:()=>({connected:true,capabilities:['browser_commands_v1','browser_compound_v1']})});
  expect((await capable.execute('get',{session:'work',property:'html',as:'json',depth:'3',childrenMax:10})).ok).toBe(true);
  expect(requestExtension.mock.calls.at(-1)[0].args).toEqual({property:'html',as:'json',depth:'3',childrenMax:10});
});

it('uploads locally validated files with private verification metadata and guards all new target forms',async()=>{
  const {service,options,requestExtension}=setup();await service.execute('bind',{session:'work',tabId:7});
  // Some filesystem filters transform .txt backing bytes differently for Node
  // and Chrome. This fixture must have the same known bytes in both processes.
  const file=path.join(options.rootDir,'example-file.json');fs.writeFileSync(file,'{"example":true}');
  expect(fs.statSync(file).size).toBe(16);
  expect((await service.execute('upload',{session:'work',selector:'#file',paths:[file]})).error.code).toBe('EXTENSION_UPGRADE_REQUIRED');
  const capable=new BrowserService({...options,capabilities:()=>({connected:true,capabilities:['browser_commands_v1','browser_upload_target_v1','browser_shadow_query_v1','browser_frames_v1']})});
  expect((await capable.execute('upload',{session:'work',shadow:true,role:'button',name:'Example upload',frameId:12,documentId:'example-document',paths:[file]})).ok).toBe(true);
  expect(requestExtension.mock.calls.at(-1)[0].args._uploadFiles).toEqual([{name:'example-file.json',size:16}]);
  expect((await capable.execute('upload',{session:'work',selector:'#file',paths:[file],_uploadFiles:[]})).error.code).toBe('INVALID_ARGUMENT');
});

it('rejects inconsistent path and handle metadata before dispatch without reading contents', async () => {
  const { options, requestExtension, service } = setup(); await service.execute('bind', { session: 'work', tabId: 7 });
  const contents = ['', 'Example file', 'Public Unicode 示例\n', 'x'.repeat(10000)];
  const files = contents.map((body, index) => {
    const file = path.join(options.rootDir, `example-${index}.json`); fs.writeFileSync(file, body); return file;
  });
  const stat = fs.lstatSync.bind(fs);
  const metadata = vi.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
    const value = stat(file, ...args);
    return files.includes(file) ? Object.assign(Object.create(value), { size: 65536 }) : value;
  });
  const read = vi.spyOn(fs, 'readFileSync');
  try {
    const capable = new BrowserService({ ...options, capabilities: () => ({ connected: true, capabilities: ['browser_commands_v1', 'browser_upload_target_v1'] }) });
    read.mockClear();
    expect((await capable.execute('upload', { session: 'work', selector: '#file', paths: files })).error.code).toBe('UPLOAD_FILE_VIEW_MISMATCH');
    expect(requestExtension.mock.calls.some(([message]) => message.command === 'upload')).toBe(false);
    expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); metadata.mockRestore(); }
});

it('rejects unavailable upload metadata without sending a browser upload', async () => {
  const { options, requestExtension, service } = setup(); await service.execute('bind', { session: 'work', tabId: 7 });
  const file = path.join(options.rootDir, 'example-unavailable.json'); fs.writeFileSync(file, '{"example":true}');
  const capable = new BrowserService({ ...options, capabilities: () => ({ connected: true, capabilities: ['browser_commands_v1', 'browser_upload_target_v1'] }) });
  const stat = fs.lstatSync.bind(fs);
  const inspect = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => { if (target === file) throw new Error('Example inspection failure'); return stat(target, ...args); });
  try {
    expect((await capable.execute('upload', { session: 'work', selector: '#file', paths: [file] })).error.code).toBe('FILE_UNAVAILABLE');
    expect(requestExtension.mock.calls.some(([message]) => message.command === 'upload')).toBe(false);
  } finally { inspect.mockRestore(); }
});
it('gates directory/chooser selection on the selected extension and keeps the filesystem snapshot private',async()=>{
  const {options,service,requestExtension}=setup();await service.execute('bind',{session:'work',tabId:7});
  const directory=path.join(options.rootDir,'example-folder');fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'example.json'),'{}');
  const args={session:'work',selector:'#choose',paths:[directory],directory:true,chooser:true};
  const old=new BrowserService({...options,capabilities:()=>({connected:true,capabilities:['browser_commands_v1','browser_upload_target_v1']})});
  expect((await old.execute('upload',args)).error.code).toBe('EXTENSION_UPGRADE_REQUIRED');
  expect(requestExtension.mock.calls.some(([v])=>v.command==='upload')).toBe(false);
  const current=new BrowserService({...options,capabilities:()=>({connected:true,capabilities:['browser_commands_v1','browser_upload_target_v1','browser_upload_extended_v1']})});
  const result=await current.execute('upload',args);expect(result.ok).toBe(true);expect(JSON.stringify(result)).not.toContain('relativePath');
  expect(requestExtension.mock.calls.at(-1)[0].args._uploadFiles).toEqual([{name:'example.json',size:2,relativePath:'example-folder/example.json'}]);
  expect((await current.execute('upload',{...args,directory:'sometimes'})).error.code).toBe('INVALID_ARGUMENT');
});
