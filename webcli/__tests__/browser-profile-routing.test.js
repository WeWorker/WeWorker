import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocketBridge } from '../bridge.js';
import { callLocalCommand } from '../exploration-client.js';

vi.mock('../adapter-host.js', async original => ({ ...await original(), resolveAdapterCall: name => name === 'example.toolkit'
  ? { command: { runtime: 'wewright', id: 'read', module: 'example.js' }, adapter: { root: '/example' } }
  : name === 'example.http' ? { command: { runtime: 'http', id: 'read', http: { version: 2, strategy: 'AUTH_API' } }, adapter: { root: '/example' } }
  : name === 'example.navigation' ? { command: { runtime: 'extension', id: 'read', pageWorkflow: true, pageRoute: { navigation: { pathname: '/items/:id' } } }, adapter: { root: '/example' } }
  : name === 'example.query-navigation' ? { command: { runtime: 'extension', id: 'read', pageWorkflow: true, pageRoute: { navigation: { pathname: '/items', queryParameters: [{ name: 'keyword', queryKey: 'q' }] } } }, adapter: { root: '/example' } }
  : name === 'example.query-workflow' ? { command: { runtime: 'extension', id: 'read', pageWorkflow: true, pageRoute: { workflow: { steps: [{ query: { mode: 'navigate', queryParameters: [{ name: 'keyword', queryKey: 'q' }] } }] } } }, adapter: { root: '/example' } }
  : name === 'example.control-workflow' ? { command: { runtime: 'extension', id: 'read', pageWorkflow: true, pageRoute: { workflow: { steps: [{ when: { path: 'hasNext', equals: true }, query: {} }] } } }, adapter: { root: '/example' } }
  : name === 'example.origin-navigation' ? { command: { runtime: 'extension', id: 'read', pageWorkflow: true, pageRoute: { navigation: { resultOrigin: 'https://example.org' } } }, adapter: { root: '/example' } }
  : name === 'example.origin-workflow' ? { command: { runtime: 'extension', id: 'read', pageWorkflow: true, pageRoute: { workflow: { steps: [{ origin: 'https://example.org', query: {} }] } } }, adapter: { root: '/example' } }
  : name === 'example.frame-workflow' ? { command: { runtime: 'extension', id: 'read', pageWorkflow: true, pageRoute: { workflow: { steps: [{ frames: [{ selector: '#owner', origin: 'https://example.org', pathname: '/child' }], query: {} }] } } }, adapter: { root: '/example' } }
  : name === 'example.hash-navigation' ? { command: { runtime: 'extension', id: 'read', pageWorkflow: true, pageRoute: { navigation: { hashNavigation: {} } } }, adapter: { root: '/example' } }
  : name === 'example.hash-workflow' ? { command: { runtime: 'extension', id: 'read', pageWorkflow: true, pageRoute: { workflow: { steps: [{ query: { hashNavigation: {} } }] } } }, adapter: { root: '/example' } }
  : name === 'example.ui-result' ? { command: { runtime: 'extension', safety: 'write', uiWrite: { result: { attribute: 'data-result-id', publicId: true, idType: 'integer' } }, pageRoute: { origin: 'https://example.com', pathname: '/editor' } }, adapter: { root: '/example' } }
  : name === 'example.ui-choice' ? {command:{runtime:'extension',safety:'write',uiWrite:{version:2,inputs:[{kind:'choice'}]},pageRoute:{origin:'https://example.com',pathname:'/editor'}},adapter:{root:'/example'}}
  : name === 'example.ui-controls' ? {command:{runtime:'extension',safety:'write',uiWrite:{version:2},pageRoute:{origin:'https://example.com',pathname:'/editor'}},adapter:{root:'/example'}}
  : name === 'example.workflow' ? { command: { runtime: 'extension', id: 'read', pageWorkflow: true, pageRoute: { workflow: { steps: [] } } }, adapter: { root: '/example' } } : null }));
vi.mock('../toolkit-runner.js', () => ({ runToolkitTool: vi.fn(async () => ({ exitCode: 0, result: { example: 'toolkit' } })) }));
vi.mock('../http-runner.js', () => ({ runHttpTool: vi.fn(async () => ({ exitCode: 0, result: { example: 'http' } })) }));

const resources = [];
afterEach(async () => {
  for (const { bridge, root } of resources.splice(0)) {
    bridge.stopAdapterStateWatcher();
    for (const ws of bridge._wss.clients) ws.terminate();
    await new Promise(resolve => bridge._wss.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-routing-'));
  const bridge = new WebSocketBridge({ workspaceDir: root, port: 0 }); resources.push({ root, bridge });
  await new Promise(resolve => bridge._wss.on('listening', resolve));
  const url = `ws://127.0.0.1:${bridge._wss.address().port}`;
  const call = (ns, cmd, args = {}, profile) => callLocalCommand(ns, cmd, args, { url, profile });
  async function peer(contextId = randomUUID(), extraCapabilities = []) {
    const ws = new WebSocket(url), messages = [], received = [];
    ws.on('message', data => { const msg = JSON.parse(String(data)); messages.push(msg); if (msg.type !== 'extension_connected') received.push(msg); });
    await new Promise(resolve => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'extension_hello', contextId, capabilities: ['browser_commands_v1', 'browser_profiles_v1', 'passive_exploration_v1', ...extraCapabilities], version: '1.0.0' }));
    await vi.waitFor(() => expect(messages.some(msg => msg.type === 'extension_hello_ack' || msg.type === 'extension_hello_error')).toBe(true));
    const reply = (msg, result) => ws.send(JSON.stringify({ type: 'call_tool_result', id: msg.id, result }));
    let hold = null;
    ws.on('message', data => {
      const msg = JSON.parse(String(data));
      if (hold?.(msg)) return;
      if (msg.type === 'exploration_list_tabs') reply(msg, { tabs: [{ id: 7, url: 'https://example.com/', active: true }] });
      if (msg.type === 'browser_execute') reply(msg, { ok: true, data: { identity: `example-${contextId}`, value: contextId } });
      if (msg.type === 'exploration_capture_passive') reply(msg, { requests: [] });
      if (msg.type === 'validate_generation_preview') reply(msg, { passed: true, tools: [] });
      if (msg.type === 'call_tool') reply(msg, { contextId, args: msg.args });
      if (msg.type === 'http_credentials') reply(msg, { cookies: [], contextId });
      if (msg.type === 'get_trace_logs') ws.send(JSON.stringify({ type: 'get_trace_logs_result', id: msg.id, logs: [contextId] }));
    });
    return { ws, contextId, messages, received, reply, setHold(fn) { hold = fn; } };
  }
  async function rpc(msg) {
    const ws = new WebSocket(url); await new Promise(resolve => ws.on('open', resolve));
    const id = randomUUID();
    const result = new Promise(resolve => ws.on('message', data => { const message = JSON.parse(String(data)); if (message.id === id) { resolve(message); ws.close(); } }));
    ws.send(JSON.stringify({ ...msg, id })); return result;
  }
  return { root, bridge, url, call, peer, rpc };
}

it('rejects scoped cookie requests on v1 peers before dispatch and pins v2 requests to the capable peer', async () => {
  const { bridge, peer } = await setup();
  const old = await peer(randomUUID(), ['http_credentials_v1']), current = await peer(randomUUID(), ['http_credentials_v1', 'http_credentials_v2']);
  const payload = { version: 2, url: 'https://example.com/api/items', names: ['example_session'], storeId: '0', partitionKey: { topLevelSite: 'https://example.org', hasCrossSiteAncestor: true } };
  const request = profile => bridge._route.run(bridge._profiles.select(profile), () => bridge._request({ type: 'http_credentials', payload }));
  await expect(request(old.contextId)).rejects.toMatchObject({ code: 'HTTP_CREDENTIALS_UNAVAILABLE' });
  await expect(bridge._route.run(bridge._profiles.select(old.contextId), () => bridge._request({ type: 'http_credentials', payload: { ...payload, version: undefined } }))).rejects.toMatchObject({ code: 'HTTP_CREDENTIALS_UNAVAILABLE' });
  expect(old.messages.some(message => message.type === 'http_credentials')).toBe(false);
  expect(await request(current.contextId)).toEqual({ cookies: [], contextId: current.contextId });
  expect(current.messages.find(message => message.type === 'http_credentials').payload).toEqual(payload);
});

it('routes host AUTH_API desktop calls without a profile, whether zero or multiple browsers are online', async () => {
  const { rpc, peer } = await setup();
  expect((await rpc({ type: 'call_tool', toolName: 'example.http', args: {}, browserProfile: 'example-offline' })).result).toEqual({ example: 'http' });
  await peer(); await peer();
  expect((await rpc({ type: 'call_tool', toolName: 'example.http', args: {} })).result).toEqual({ example: 'http' });
});

it.each([['navigation', 'page_navigation_v1', /parameterized page navigation/], ['workflow', 'page_workflow_v1', /ordered page workflows/]])('rejects page %s on an older selected profile before dispatch without falling back', async (kind, capability, message) => {
  const { rpc, peer } = await setup();
  const capabilities = ['adapter_catalog_v1', 'page_sources_v1', 'page_query_v1'];
  const old = await peer(randomUUID(), capabilities), current = await peer(randomUUID(), [...capabilities, capability]);
  const result = await rpc({ type: 'call_tool', toolName: 'example.' + kind, args: { itemId: '007' }, browserProfile: old.contextId });
  expect(result.error).toMatch(message);
  expect([...old.received, ...current.received].some(msg => msg.type === 'call_tool')).toBe(false);
  expect((await rpc({ type: 'call_tool', toolName: 'example.' + kind, args: { itemId: '007' }, browserProfile: current.contextId })).result.contextId).toBe(current.contextId);
});

it('routes HTTP exploration independently of browser flags/defaults with stable host task history', async () => {
  const { call, peer } = await setup();
  const args = { mode: 'http', origin: 'https://example.com', goal: 'Read example API', requestId: 'example-host-route' };
  const first = await call('exploration', 'start', args, 'example-offline');
  expect(first).toMatchObject({ ok: true, contextId: null, connectionId: null, data: { mode: 'http', status: 'evidence_ready', tabId: null } });
  await peer(); await peer();
  expect((await call('exploration', 'start', args)).data.taskId).toBe(first.data.taskId);
  expect((await call('exploration', 'get', { taskId: first.data.taskId })).data.mode).toBe('http');
  expect((await call('exploration', 'list', { mode: 'http' })).data.tasks).toHaveLength(1);
  expect((await call('exploration', 'list')).error.code).toBe('PROFILE_AMBIGUOUS');
  expect((await call('exploration', 'get', { taskId: first.data.taskId, mode: 'browser' })).error.code).toBe('MODE_MISMATCH');
  expect((await call('exploration', 'list', { mode: 'invalid' })).error.code).toBe('INVALID_ARGUMENT');
});

it('isolates same session names and tab IDs, replies only to the caller, and routes desktop requests and trace', async () => {
  const { call, peer, rpc } = await setup(); const a = await peer(), b = await peer();
  expect((await call('browser', 'tabs')).error.code).toBe('PROFILE_AMBIGUOUS');
  for (const p of [a, b]) expect((await call('browser', 'bind', { session: 'work', tabId: 7 }, p.contextId)).ok).toBe(true);
  for (const p of [a, b]) expect((await call('browser', 'eval', { session: 'work', expression: '1' }, p.contextId)).data.value).toBe(p.contextId);
  const result = await rpc({ type: 'call_tool', toolName: 'example.read', args: { profile: 'business-value' }, browserProfile: a.contextId });
  expect(result.result).toEqual({ contextId: a.contextId, args: { profile: 'business-value' } });
  expect(a.messages.concat(b.messages).some(msg => msg.type === 'call_tool_result')).toBe(false);
  expect((await rpc({ type: 'exploration_list_tabs', browserProfile: b.contextId })).result.tabs[0].id).toBe(7);
  expect((await rpc({ type: 'get_trace_logs', browserProfile: b.contextId })).logs).toEqual([b.contextId]);
  await call('profile', 'use', { name: b.contextId });
  a.ws.send(JSON.stringify({ type: 'adapter_bundle', id: 'example-resource-request', payload: {} }));
  await vi.waitFor(() => expect(a.messages.some(msg => msg.id === 'example-resource-request')).toBe(true));
  expect(b.messages.some(msg => msg.id === 'example-resource-request')).toBe(false);
});

it('pins in-flight multi-stage work despite default changes; ignores forged responses and fails immediately on disconnect', async () => {
  const { bridge, call, peer } = await setup(); const a = await peer(), b = await peer();
  await call('profile', 'use', { name: a.contextId });
  let first;
  a.setHold(msg => { if (msg.type === 'exploration_list_tabs') { first = msg; return true; } });
  const binding = call('browser', 'bind', { session: 'work', tabId: 7 });
  await vi.waitFor(() => expect(first).toBeTruthy());
  await call('profile', 'use', { name: b.contextId });
  b.reply(first, { tabs: [{ id: 7, url: 'https://example.org/' }] });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(bridge._pendingRequests.size).toBe(1);
  a.reply(first, { tabs: [{ id: 7, url: 'https://example.com/' }] });
  expect((await binding).contextId).toBe(a.contextId);
  expect(b.messages.some(msg => msg.type === 'browser_execute' && msg.command === 'bind')).toBe(false);
  first = null;
  const pending = call('browser', 'tabs', {}, a.contextId);
  await vi.waitFor(() => expect(first).toBeTruthy());
  a.ws.close();
  expect((await pending).error.code).toBe('PROFILE_DISCONNECTED'); expect(bridge._pendingRequests.size).toBe(0);
  const replacement = await peer(a.contextId);
  const staleConnection = await callLocalCommand('browser', 'tabs', {}, { url: `ws://127.0.0.1:${bridge._wss.address().port}`, profile: a.contextId, connectionId: 'example-old-socket' });
  expect(staleConnection.error.code).toBe('PROFILE_DISCONNECTED');
  replacement.reply(first, { tabs: [{ id: 999, url: 'https://example.com/' }] });
  expect((await call('browser', 'tabs', {}, a.contextId)).data.tabs[0].id).toBe(7);
});

it('keeps exploration background tasks and tab locks in the starting profile, and reads offline history', async () => {
  const { call, peer } = await setup(); const a = await peer(), b = await peer();
  for (const p of [a, b]) await call('browser', 'bind', { session: 'work', tabId: 7 }, p.contextId);
  let capture;
  a.setHold(msg => { if (msg.type === 'exploration_capture_passive') { capture = msg; return true; } });
  const task = await call('exploration', 'start', { tabId: 7, requestId: 'example-start', goal: 'Read example items' }, a.contextId);
  expect(task.ok).toBe(true); await vi.waitFor(() => expect(capture).toBeTruthy());
  expect((await call('browser', 'eval', { session: 'work', expression: '1' }, a.contextId)).error.code).toBe('TAB_BUSY');
  expect((await call('browser', 'eval', { session: 'work', expression: '1' }, b.contextId)).ok).toBe(true);
  await call('profile', 'use', { name: b.contextId });
  a.reply(capture, { requests: [] });
  await vi.waitFor(async () => expect((await call('exploration', 'get', { taskId: task.data.taskId }, a.contextId)).data.status).toBe('evidence_ready'));
  expect((await call('exploration', 'get', { taskId: task.data.taskId }, b.contextId)).error.code).toBe('TASK_NOT_FOUND');
  a.ws.close(); await new Promise(resolve => a.ws.on('close', resolve));
  expect((await call('exploration', 'list', {}, a.contextId)).data.tasks[0].taskId).toBe(task.data.taskId);
  expect((await call('exploration', 'collect', { taskId: task.data.taskId }, a.contextId)).error.code).toBe('PROFILE_OFFLINE');
  expect((await call('browser', 'doctor', {}, a.contextId)).data.ready).toBe(false);
  expect((await call('exploration', 'cancel', { taskId: task.data.taskId }, a.contextId)).data.status).toBe('cancelled');
});

it('retains pre-profile stores read-only and never assigns their sessions to a new browser', async () => {
  const { root, call, peer } = await setup();
  fs.mkdirSync(path.join(root, 'browser')); const file = path.join(root, 'browser', 'sessions.json');
  const source = JSON.stringify({ work: { session: 'work', tabId: 7, owned: false } }); fs.writeFileSync(file, source);
  const id = randomUUID(), task = { schemaVersion: 1, taskId: id, status: 'collecting', candidates: [], events: [], updatedAt: '2026-10-17', tabId: 7 };
  fs.mkdirSync(path.join(root, 'exploration')); fs.writeFileSync(path.join(root, 'exploration', id + '.json'), JSON.stringify(task));
  expect((await call('browser', 'sessions', {}, 'legacy')).data.sessions[0].session).toBe('work');
  expect((await call('exploration', 'get', { taskId: id }, 'legacy')).data.status).toBe('collecting');
  expect((await call('browser', 'close', { session: 'work' }, 'legacy')).error.code).toBe('LEGACY_READ_ONLY');
  expect((await call('exploration', 'cancel', { taskId: id }, 'legacy')).error.code).toBe('LEGACY_READ_ONLY');
  const p = await peer(); expect((await call('browser', 'sessions', {}, p.contextId)).data.sessions).toEqual([]);
  const draftDir = path.join(root, 'example-draft'); fs.mkdirSync(draftDir); fs.writeFileSync(path.join(draftDir, 'example.js'), 'Example public draft');
  const archived = (await resources.at(-1).bridge._services.get('legacy:exploration')).runs.get(id);
  archived.draft = { adapterDir: draftDir, toolNames: ['example.read'] }; archived.draftFiles = ['example.js'];
  expect((await call('exploration', 'draft-read', { taskId: id, file: 'example.js' }, 'legacy')).data.content).toBe('Example public draft');
  expect(fs.readFileSync(file, 'utf8')).toBe(source);
  expect(JSON.parse(fs.readFileSync(path.join(root, 'exploration', id + '.json')))).toEqual(task);
});

it('rejects duplicate hello without replacement and runs Toolkit with zero or multiple browsers', async () => {
  const { call, peer, rpc } = await setup();
  expect((await rpc({ type: 'call_tool', toolName: 'example.toolkit', args: {}, browserProfile: 'missing' })).result.example).toBe('toolkit');
  const a = await peer(), b = await peer(), duplicate = await peer(a.contextId);
  expect(duplicate.messages.find(msg => msg.type === 'extension_hello_error').error.code).toBe('PROFILE_ID_CONFLICT');
  expect((await call('browser', 'tabs', {}, a.contextId)).ok).toBe(true);
  expect((await rpc({ type: 'call_tool', toolName: 'example.toolkit', args: {} })).result.example).toBe('toolkit');
  expect(b.messages.some(msg => msg.type === 'call_tool')).toBe(false);
});

it('pins child-worker extension calls and events to their starting context and caller', async () => {
  const { bridge, call, peer } = await setup(); const a = await peer(), b = await peer();
  const owners = [a, b].map(() => ({ readyState: 1, send: vi.fn() }));
  const controllers = [];
  const started = await Promise.all([a, b].map((p, index) => bridge._runInProfile({ browserProfile: p.contextId }, owners[index], async () => {
    const controller = bridge._generationWorkers; controllers.push(controller);
    controller.workerScript = path.join(import.meta.dirname, 'fixtures/generation-worker-fixture.js');
    controller.reportDir = path.join(controller.store.rootDir, 'reports');
    return controller.start({ siteKey: 'example.com', goal: 'Read public example', input: { fixtureMode: 'extension' } });
  })));
  await call('profile', 'use', { name: b.contextId });
  await vi.waitFor(() => {
    for (let i = 0; i < 2; i++) expect(controllers[i].get(started[i].id)?.status).toBe('awaiting_approval');
  }, { timeout: 5000 });
  for (let i = 0; i < 2; i++) {
    expect(controllers[1 - i].get(started[i].id)).toBeNull();
    expect(owners[i].send.mock.calls.length).toBeGreaterThan(0);
    expect(owners[i].send.mock.calls.every(([raw]) => JSON.parse(raw).runId === started[i].id)).toBe(true);
  }
  for (const p of [a, b]) expect(p.messages.filter(msg => msg.type === 'validate_generation_preview')).toHaveLength(1);
});


it('rejects UI result IDs on an older profile before ordinary call dispatch without fallback', async () => {
  const { rpc, peer } = await setup();
  const capabilities = ['adapter_catalog_v1', 'page_sources_v1', 'page_write_v1', 'ui_write_v1'];
  const old = await peer(randomUUID(), capabilities), current = await peer(randomUUID(), [...capabilities, 'ui_write_result_v1']);
  const args = { title: 'Example', __confirmed: true };
  const result = await rpc({ type: 'call_tool', toolName: 'example.ui-result', args, browserProfile: old.contextId });
  expect(result.error).toMatch(/UI receipt IDs/);
  expect([...old.received, ...current.received].some(msg => msg.type === 'call_tool')).toBe(false);
  expect((await rpc({ type: 'call_tool', toolName: 'example.ui-result', args, browserProfile: current.contextId })).result.contextId).toBe(current.contextId);
});

it('gates event-driven UI writes on the selected profile before any ordinary dispatch',async()=>{
  const {rpc,peer}=await setup(),caps=['adapter_catalog_v1','page_sources_v1','page_write_v1','ui_write_v1'];
  const old=await peer(randomUUID(),caps),current=await peer(randomUUID(),[...caps,'ui_write_controls_v2']);
  const request=browserProfile=>rpc({type:'call_tool',toolName:'example.ui-controls',args:{title:'Example',__confirmed:true},browserProfile});
  expect((await request(old.contextId)).error).toMatch(/event-driven UI/);
  expect([...old.received,...current.received].some(value=>value.type==='call_tool')).toBe(false);
  expect((await request(current.contextId)).result.contextId).toBe(current.contextId);
});

it.each(['query-navigation', 'query-workflow', 'hash-navigation', 'hash-workflow', 'control-workflow', 'origin-navigation', 'origin-workflow', 'frame-workflow'])('refuses %s on a selected legacy peer without any dispatch or profile fallback', async kind => {
  const { rpc, peer } = await setup();
  const capabilities = ['adapter_catalog_v1', 'page_sources_v1', 'page_query_v1', 'page_navigation_v1', 'page_workflow_v1'];
  const old = await peer(randomUUID(), capabilities), current = await peer(randomUUID(), [...capabilities, 'page_navigation_query_v1', 'page_navigation_hash_v1', 'page_workflow_control_v1', 'page_navigation_origin_v1', 'page_workflow_frames_v1']);
  const request = browserProfile => rpc({ type: 'call_tool', toolName: 'example.' + kind, args: { keyword: '007' }, browserProfile });
  expect((await request(old.contextId)).error).toMatch(/public URL query navigation|hash navigation|conditional or repeated page workflows|explicit cross-origin page reading|frame workflows/);
  expect([...old.received, ...current.received].some(msg => msg.type === 'call_tool')).toBe(false);
  expect((await request(current.contextId)).result.contextId).toBe(current.contextId);
});

it('requires the frame capability even when the selected profile supports cross-origin workflows', async () => {
  const { rpc, peer } = await setup();
  const capabilities = ['adapter_catalog_v1', 'page_sources_v1', 'page_query_v1', 'page_navigation_v1', 'page_workflow_v1', 'page_navigation_origin_v1'];
  const old = await peer(randomUUID(), capabilities), current = await peer(randomUUID(), [...capabilities, 'page_workflow_frames_v1']);
  expect((await rpc({ type: 'call_tool', toolName: 'example.frame-workflow', args: {}, browserProfile: old.contextId })).error).toMatch(/frame workflows/);
  expect([...old.received, ...current.received].some(msg => msg.type === 'call_tool')).toBe(false);
});

it('gates popup choice ordinary calls on the chosen profile without switching peers',async()=>{
  const {rpc,peer}=await setup(),caps=['adapter_catalog_v1','page_sources_v1','page_write_v1','ui_write_v1','ui_write_controls_v2'];
  const old=await peer(randomUUID(),caps),current=await peer(randomUUID(),[...caps,'ui_write_choices_v1']);
  const request=browserProfile=>rpc({type:'call_tool',toolName:'example.ui-choice',args:{title:'Example',__confirmed:true},browserProfile});
  expect((await request(old.contextId)).error).toMatch(/date and popup choices/);
  expect([...old.received,...current.received].some(value=>value.type==='call_tool')).toBe(false);
  expect((await request(current.contextId)).result.contextId).toBe(current.contextId);
});
