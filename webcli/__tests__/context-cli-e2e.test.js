import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

let root, server, env;
const calls = [];
beforeEach(() => { calls.length = 0; });
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'webcli-context-cli-'));
  const builtin = join(root, 'builtin'), adapter = join(builtin, 'example.com');
  mkdirSync(join(adapter, 'extension', 'commands'), { recursive: true });
  const manifest = { schema_version: 2, name: 'example.com', version: '1.0.0', description: 'Example records', match: ['example.com'], commands: [
    { id: 'list', description: 'List records', safety: 'read', schema: { type: 'object', properties: { count: { type: 'integer' } } }, results: [
      { itemsPath: '$.rows', idField: 'id', titleField: 'title', actions: [
        { id: 'detail', label: '查看详情', command: 'detail', args: { key: { from: 'item.id' } } },
        { id: 'edit', label: '修改', command: 'edit', args: { key: { from: 'item.id' } }, inputs: ['body'] },
      ] },
    ] },
    { id: 'detail', description: 'Read record', safety: 'read', schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } },
    { id: 'edit', description: 'Edit record', safety: 'write', schema: { type: 'object', properties: { key: { type: 'string' }, body: { type: 'string' } }, required: ['key', 'body'], additionalProperties: false } },
    { id: 'unmapped', description: 'An explicit query without follow-up metadata', safety: 'read', schema: { type: 'object', properties: {} } },
  ].map(command => ({ ...command, runtime: 'extension', module: `extension/commands/${command.id}.js` })) };
  writeFileSync(join(adapter, 'manifest.json'), JSON.stringify(manifest));
  for (const command of manifest.commands) writeFileSync(join(adapter, command.module), 'throw new Error("Mock Bridge must supply the business result");');
  server = new WebSocketServer({ port: 0 });
  await new Promise(resolveReady => server.once('listening', resolveReady));
  server.on('connection', socket => socket.on('message', bytes => {
    const request = JSON.parse(bytes);
    if (request.type !== 'call_tool') return;
    calls.push(request);
    if (request.args.key === 'disconnect') { socket.terminate(); return; }
    if (request.args.key === 'invalid-json') { socket.send('invalid fixture response'); return; }
    if (request.args.key === 'error') {
      socket.send(JSON.stringify({ id: request.id, type: 'call_tool_error', error: 'Fixture failure', code: 'FIXTURE_FAILURE' })); return;
    }
    if (request.toolName.endsWith('.edit') && request.args.key === 'prepare-once' && calls.filter(c => c.toolName === request.toolName && c.args.key === 'prepare-once').length === 1) {
      socket.send(JSON.stringify({ id: request.id, type: 'call_tool_result', result: { status: 'prepared' }, execution: { phase: 'prepared' } })); return;
    }
    const result = request.toolName.endsWith('.list') ? { rows: request.args.count === 100
      ? Array.from({ length: 100 }, (_, index) => ({ id: `record-${index}`, title: `Record ${index}` }))
      : [{ id: 'a', title: 'First' }, { id: 'b', title: 'Second' }] }
      : { key: request.args.key, title: 'Selected detail' };
    socket.send(JSON.stringify({ id: request.id, type: 'call_tool_result', result }));
  }));
  env = { ...process.env, USERPROFILE: root, HOME: root, WEWORKER_WEBCLI_DISTRIBUTION: 'desktop',
    WEBCLI_BRIDGE_PORT: String(server.address().port), WEWORKER_BUILD_PROFILE: 'public',
    WEWORKER_BUILTIN_ADAPTERS_DIR: builtin, WEWORKER_USER_ADAPTERS_DIR: join(root, 'user'),
    WEBCLI_ADAPTERS_DIR: join(root, 'user'), WEWORKER_ADAPTER_DATA_DIR: join(root, 'data'), WEBCLI_D3_URL: '' };
});
afterAll(async () => {
  if (server) {
    for (const socket of server.clients) socket.terminate();
    await new Promise(done => server.close(done));
  }
  if (root) rmSync(root, { recursive: true, force: true });
});
function cli(...args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve('index.js'), ...args], { env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
    child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
  });
}
function receipt(result) {
  const line = result.stderr.split(/\r?\n/).find(line => line.startsWith('WEBCLI_CONTEXT '));
  expect(line, result.stderr).toBeDefined(); return JSON.parse(line.slice('WEBCLI_CONTEXT '.length));
}
it('allows a second real CLI call after an envelope preparation receipt and blocks a third dispatched write', async () => {
  const args = JSON.stringify({ key: 'prepare-once', body: 'Example text' });
  const first = await cli('call', 'example.com.edit', '--new-context', '--args', args);
  expect(first.code, first.stderr).toBe(0);
  const context = receipt(first);
  expect(context.toolOutcome).toBe('prepared'); expect(context.retryDisposition).toBe('safe_to_retry_before_dispatch');
  const second = await cli('call', 'example.com.edit', '--context', context.contextId, '--args', args);
  expect(second.code, second.stderr).toBe(0); expect(receipt(second).toolOutcome).toBe('acknowledged');
  const third = await cli('call', 'example.com.edit', '--context', context.contextId, '--args', args);
  expect(third.code).toBe(4); expect(third.stderr).toContain('context_operation_unresolved');
  expect(calls.filter(c => c.args.key === 'prepare-once')).toHaveLength(2);
}, 240000);
it('persists an automatic UUID across real CLI processes, opens the displayed second record, executes explicit writes and blocks replay', async () => {
  const first = await cli('call', 'example.com.list', '--new-context', '--output-format=json');
  expect(first.code, first.stderr).toBe(0);
  const source = receipt(first);
  expect(source.contextId).toMatch(/^[a-f0-9-]{36}$/);
  expect(source.contextPersistence).toBe('committed'); expect(source.displayState).toBe('staged');
  expect(JSON.parse(first.stdout).rows.map(row => row.id)).toEqual(['a', 'b']);
  const display = await cli('context', 'display', source.contextId, '--epoch', source.epoch, '--revision', String(source.revision),
    '--round', source.roundId, '--snapshot', source.snapshotId, '--args', JSON.stringify({ orderedEntityRefs: ['e2', 'e1'], completeness: 'unknown', delivered: true }));
  expect(display.code, display.stderr).toBe(0);
  const routed = await cli('route', '--context', source.contextId, '查看第二条');
  expect(routed.code, routed.stderr).toBe(0);
  const decision = JSON.parse(routed.stdout);
  expect(decision.kind).toBe('resolved'); expect(decision.steps[0].args).toEqual({ key: 'a' });
  const step = decision.steps[0];
  const selected = await cli('call', step.tool, '--context', source.contextId, '--decision', decision.decisionId, '--step', step.stepId,
    '--args', JSON.stringify(step.args), '--output-format=json');
  expect(selected.code, selected.stderr).toBe(0);
  expect(JSON.parse(selected.stdout).key).toBe('a'); expect(receipt(selected).toolOutcome).toBe('read_success');
  const repeated = await cli('call', step.tool, '--context', source.contextId, '--decision', decision.decisionId, '--step', step.stepId, '--args', JSON.stringify(step.args));
  expect(repeated.code).toBe(4);
  expect(calls.map(call => [call.toolName, call.args])).toEqual([['example.com.list', {}], ['example.com.detail', { key: 'a' }]]);
  const question = await cli('route', '--context', source.contextId, '修改第二条');
  expect(question.code, question.stderr).toBe(0);
  const pending = JSON.parse(question.stdout); expect(pending.missingFields).toEqual(['arguments.body']);
  const answer = await cli('route', '--context', source.contextId, '--reply-to', pending.clarificationId, 'Replacement');
  expect(answer.code, answer.stderr).toBe(0);
  const plan = JSON.parse(answer.stdout); expect(plan.executionEligibility).toBe('write_allowed');
  expect(plan.steps[0].args).toEqual({ key: 'a', body: 'Replacement' });
  const written = await cli('call', 'example.com.edit', '--context', source.contextId, '--args', JSON.stringify(plan.steps[0].args));
  expect(written.code, written.stderr).toBe(0); expect(receipt(written).toolOutcome).toBe('acknowledged'); expect(calls).toHaveLength(3);
  const replay = await cli('call', 'example.com.edit', '--context', source.contextId, '--args', JSON.stringify(plan.steps[0].args));
  expect(replay.code).toBe(4); expect(calls).toHaveLength(3);
}, 240000);
it.each(['error', 'disconnect', 'invalid-json'])('returns the real Bridge %s failure through the context contract', async key => {
  const result = await cli('call', 'example.com.detail', '--new-context', '--key=' + key, '--output-format=json');
  expect(result.code, result.stderr).toBe(1);
  expect(JSON.parse(result.stdout).error).toBeTruthy();
  expect(receipt(result).toolOutcome).toBe('failed');
}, 90000);
it('an unmapped query cannot leave a previous list as the current ordinal selection', async () => {
  const start = calls.length;
  const first = await cli('call', 'example.com.list', '--new-context', '--output-format=json');
  expect(first.code, first.stderr).toBe(0); const source = receipt(first);
  const display = await cli('context', 'display', source.contextId, '--epoch', source.epoch, '--revision', String(source.revision),
    '--round', source.roundId, '--snapshot', source.snapshotId, '--args', JSON.stringify({ orderedEntityRefs: ['e1', 'e2'], completeness: 'unknown', delivered: true }));
  expect(display.code, display.stderr).toBe(0);
  const unmapped = await cli('call', 'example.com.unmapped', '--context', source.contextId, '--output-format=json');
  expect(unmapped.code, unmapped.stderr).toBe(0); expect(receipt(unmapped).reasonCode).toBe('context_binding_unavailable');
  const followup = await cli('route', '--context', source.contextId, '查看第二条');
  expect(followup.code, followup.stderr).toBe(0);
  expect(JSON.parse(followup.stdout).kind).toBe('needs_input'); expect(JSON.parse(followup.stdout).steps).toBeUndefined();
  expect(calls.slice(start).map(call => call.toolName)).toEqual(['example.com.list', 'example.com.unmapped']);
}, 150000);
it('keeps large query output intact while executing only within its explicitly truncated action window', async () => {
  const first = await cli('call', 'example.com.list', '--new-context', '--args', JSON.stringify({ count: 100 }), '--output-format=json');
  expect(first.code, first.stderr).toBe(0); expect(JSON.parse(first.stdout).rows).toHaveLength(100);
  const source = receipt(first);
  expect(source.displayManifest).toMatchObject({ completeness: 'truncated', capturedCount: 20, resultCount: 100 });
  const displayArgs = ['context', 'display', source.contextId, '--epoch', source.epoch, '--revision', String(source.revision),
    '--round', source.roundId, '--snapshot', source.snapshotId, '--args'];
  const forged = await cli(...displayArgs, JSON.stringify({ orderedEntityRefs: source.displayManifest.orderedEntityRefs, completeness: 'complete', delivered: true }));
  expect(forged.code).toBe(2); expect(forged.stderr).toContain('context_invalid_display');
  const display = await cli(...displayArgs, JSON.stringify({ orderedEntityRefs: source.displayManifest.orderedEntityRefs, completeness: 'truncated', delivered: true }));
  expect(display.code, display.stderr).toBe(0);
  const routed = await cli('route', '--context', source.contextId, '查看第二条');
  expect(routed.code, routed.stderr).toBe(0);
  const decision = JSON.parse(routed.stdout), step = decision.steps[0];
  expect(step.args).toEqual({ key: 'record-1' });
  const selected = await cli('call', step.tool, '--context', source.contextId, '--decision', decision.decisionId, '--step', step.stepId,
    '--args', JSON.stringify(step.args), '--output-format=json');
  expect(selected.code, selected.stderr).toBe(0); expect(JSON.parse(selected.stdout).key).toBe('record-1');
}, 240000);
