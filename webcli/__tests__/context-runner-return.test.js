import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../adapter-host.js', () => ({ resolveAdapterCall: vi.fn() }));
vi.mock('../http-runner.js', () => ({ runHttpTool: vi.fn() }));
vi.mock('../toolkit-runner.js', () => ({ runToolkitTool: vi.fn() }));
import { resolveAdapterCall } from '../adapter-host.js';
import { runHttpTool } from '../http-runner.js';
import { runToolkitTool } from '../toolkit-runner.js';
import { cmdCall } from '../index.js';

let output;
const snapshot = { name: 'example.com', digest: 'a'.repeat(64), profile: 'public' };
function match(runtime) {
  return { snapshot, adapter: { name: 'example.com', root: '/fixture/example' },
    command: { id: 'list', module: runtime + '/commands/list.js', runtime, safety: 'read', http: {} } };
}
beforeEach(() => {
  vi.stubEnv('WEBCLI_HOST_ENDPOINT', undefined); vi.stubEnv('WEBCLI_HOST_TOKEN', undefined);
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('Unexpected process exit'); });
});
it('rejects context capture through an embedding host before resolving or dispatching a local package', async () => {
  vi.stubEnv('WEBCLI_HOST_ENDPOINT', 'http://127.0.0.1:1/webcli/v1');
  await expect(cmdCall('example.com.list', '{}', { returnResult: true })).rejects.toThrow('context_host_unsupported');
  expect(resolveAdapterCall).not.toHaveBeenCalled();
  expect(runHttpTool).not.toHaveBeenCalled(); expect(runToolkitTool).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; });

it.each(['http', 'wewright'])('returns actual %s Runner results before formatting or process exit', async runtime => {
  resolveAdapterCall.mockReturnValue(match(runtime));
  const raw = { rows: [{ id: 7, title: 'Example' }], ok: true };
  const runner = runtime === 'http' ? runHttpTool : runToolkitTool;
  runner.mockResolvedValue({ result: raw, traceID: 'fixture-trace', exitCode: 0 });
  const result = await cmdCall('example.com.list', '{"limit":2}', { returnResult: true, outputFormat: 'json', executionSnapshot: snapshot });
  expect(result).toEqual({ raw, traceID: 'fixture-trace', exitCode: 0 });
  expect(runner.mock.calls[0][1]).toEqual({ limit: 2 });
  expect(output).not.toHaveBeenCalled(); expect(process.exit).not.toHaveBeenCalled();
});
it.each(['http', 'wewright'])('returns %s failures for context persistence', async runtime => {
  resolveAdapterCall.mockReturnValue(match(runtime));
  const runner = runtime === 'http' ? runHttpTool : runToolkitTool;
  runner.mockRejectedValue(Object.assign(new Error('Fixture failure'), { code: 'FIXTURE_FAILURE' }));
  expect(await cmdCall('example.com.list', '{}', { returnResult: true, outputFormat: 'json' })).toEqual({
    raw: { error: 'Fixture failure', code: 'FIXTURE_FAILURE' }, exitCode: 1,
  });
  expect(output).not.toHaveBeenCalled(); expect(process.exit).not.toHaveBeenCalled();
});
it.each(['digest', 'name', 'profile'])('rejects changed execution snapshot %s before dispatch', async key => {
  resolveAdapterCall.mockReturnValue(match('http'));
  await expect(cmdCall('example.com.list', '{}', { returnResult: true, outputFormat: 'json', executionSnapshot: { ...snapshot, [key]: 'changed' } })).rejects.toThrow('context_tool_profile_unavailable');
  expect(runHttpTool).not.toHaveBeenCalled(); expect(runToolkitTool).not.toHaveBeenCalled();
});
it('retains normal non-context command rendering', async () => {
  resolveAdapterCall.mockReturnValue(match('http'));
  runHttpTool.mockResolvedValue({ result: { rows: [] }, traceID: 'fixture-trace' });
  expect(await cmdCall('example.com.list', '{}', { outputFormat: 'json' })).toBeUndefined();
  expect(JSON.parse(output.mock.calls[0][0])).toEqual({ rows: [], trace_id: 'fixture-trace' });
});
it('does not route management namespaces through the context result contract', async () => {
  await expect(cmdCall('browser.help', '{}', { returnResult: true, outputFormat: 'json' })).rejects.toThrow('context_unsupported_command');
  expect(resolveAdapterCall).not.toHaveBeenCalled();
});
