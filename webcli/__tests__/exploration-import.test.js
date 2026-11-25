import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExplorationService } from '../exploration-service.js';

const roots = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-import-')); roots.push(root);
  for (const [key, dir] of Object.entries({ WEWORKER_USER_ADAPTERS_DIR: 'user', WEBCLI_ADAPTERS_DIR: 'user', WEWORKER_ADAPTER_DATA_DIR: 'data', WEWORKER_BUILTIN_ADAPTERS_DIR: 'builtin' })) vi.stubEnv(key, path.join(root, dir));
  vi.stubEnv('WEWORKER_BUILD_PROFILE', 'public');
  const request = vi.fn(async message => message.type === 'exploration_list_tabs'
    ? { tabs: [{ id: 7, url: 'https://example.com/' }] }
    : { ok: true, data: { identity: { tabId: 7, session: 'placeholder' } } });
  const service = new ExplorationService({ rootDir: root, requestExtension: request,
    capabilities: () => ({ connected: true, capabilities: ['passive_exploration_v1', 'browser_profiles_v1'] }) });
  const input = { schema_version: 1, instruction: 'Read items', site: { start_url: 'https://example.com/', allowed_domains: ['example.com'] },
    source_exploration: { exploration_id: 'exp_example', run_id: 'run_example', api_evidence: { schema_version: 1, structural_only: true, entries: [
      { url: 'https://example.com/api/list?q=placeholder-secret', method: 'GET', status: 200, responseContentType: 'application/json',
        responsePreview: '{"token":"placeholder-secret"}', headers: { Cookie: 'placeholder-secret' }, verified: true,
        responseEvidence: { bodyKind: 'json', bodyShape: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } } } } } },
      { url: 'https://example.org/list', method: 'GET', status: 200 },
    ] } } };
  return { service, request, input };
}

it('imports without capture/reload/replay, binds the explicit current tab and strips values', async () => {
  const { service, request, input } = setup();
  const result = await service.execute('import', { input, tabId: 7, requestId: 'import-one' });
  expect(result).toMatchObject({ ok: true, data: { status: 'evidence_ready', candidateCount: 1, validatedDigest: null } });
  const run = service.runs.get(result.data.taskId);
  expect(run.browserIdentity).toBeDefined();
  expect(JSON.stringify(run)).not.toContain('placeholder-secret');
  expect(request.mock.calls.map(([m]) => m.type)).toEqual(['exploration_list_tabs', 'browser_execute']);
  expect((await service.execute('package-read', { taskId: run.taskId, expectedDigest: '0'.repeat(64) })).error.code).toBe('VALIDATION_REQUIRED');
  expect((await service.execute('import', { input, tabId: 7, requestId: 'import-one' })).data.taskId).toBe(run.taskId);
  input.instruction = 'Different goal';
  expect((await service.execute('import', { input, tabId: 7, requestId: 'import-one' })).error.code).toBe('REQUEST_CONFLICT');
});

it('rejects wrong origins and missing capture contracts without creating a task', async () => {
  const { service, input } = setup();
  input.site = { start_url: 'https://example.org/', allowed_domains: ['example.org'] };
  expect((await service.execute('import', { input, tabId: 7, requestId: 'one' })).error.code).toBe('TAB_CHANGED');
  delete input.source_exploration.api_evidence;
  expect((await service.execute('import', { input, tabId: 7, requestId: 'two' })).error.code).toBe('INVALID_ARGUMENT');
  expect(service.runs.size).toBe(0);
});

it('preserves observed mutation risk even when the endpoint name looks read-only', async () => {
  const { service, input } = setup();
  input.source_exploration.api_evidence.entries[0].mutationObserved = true;
  const result = await service.execute('import', { input, tabId: 7, requestId: 'mutation' });
  const run = service.runs.get(result.data.taskId);
  expect(run.candidates[0].risk.level).toBe('write');
  expect((await service.execute('generate', { taskId: run.taskId })).error.code).toBe('NO_READ_EVIDENCE');
});

it('uses imported JSON structure even when the response MIME is text/html without recapturing', async () => {
  const { service, request, input } = setup();
  input.source_exploration.api_evidence.entries[0].responseContentType = 'text/html';
  const result = await service.execute('import', { input, tabId: 7, requestId: 'mislabelled-json' });
  const analysis = await service.execute('analyze', { taskId: result.data.taskId });
  expect(analysis.ok).toBe(true);
  expect(analysis.data.candidates[0]).toMatchObject({ eligible: true, verdict: 'likely_data', contract: 'unverified' });
  expect(analysis.data.candidates[0].samplePaths).toContainEqual({ path: '$.items.*.name', type: 'string' });
  expect(request.mock.calls.map(([m]) => m.type)).toEqual(['exploration_list_tabs', 'browser_execute']);
});

it.each([300_000, 2 * 1024 * 1024, 4 * 1024 * 1024])('imports compact structure from a %i-byte response without recapturing', async size => {
  const { service, request, input } = setup();
  const entry = input.source_exploration.api_evidence.entries[0];
  entry.responseContentType = 'text/html';
  entry.responseEvidence = { ...entry.responseEvidence, bodyFullSize: size, bodyReadLimit: 4 * 1024 * 1024,
    bodyTransferSize: 100, bodyTruncated: false, bodyOmitted: false };
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(4000);
  const result = await service.execute('import', { input, tabId: 7, requestId: 'large-response' });
  expect(result.ok).toBe(true);
  const evidence = await service.execute('evidence', { taskId: result.data.taskId });
  expect(evidence.data.candidates[0].responseEvidence).toMatchObject({ bodyKind: 'json', bodyFullSize: size,
    bodyReadLimit: 4 * 1024 * 1024, bodyTransferSize: 100, bodyTruncated: false, bodyOmitted: false });
  const analysis = await service.execute('analyze', { taskId: result.data.taskId });
  expect(analysis.data.candidates[0]).toMatchObject({ eligible: true, verdict: 'likely_data', contract: 'unverified' });
  expect(analysis.data.candidates[0].samplePaths).toContainEqual({ path: '$.items.*.name', type: 'string' });
  expect(request.mock.calls.map(([m]) => m.type)).toEqual(['exploration_list_tabs', 'browser_execute']);
});

it('keeps the capture limit and wire size distinct from unknown decoded size', async () => {
  const { service, input } = setup();
  input.source_exploration.api_evidence.entries[0].responseEvidence = {
    bodyKind: 'opaque', bodyOmitted: true, bodyTruncated: true, bodyFullSize: 0,
    bodyOmissionReason: 'too_large', bodyReadLimit: 4 * 1024 * 1024, bodyTransferSize: 5 * 1024 * 1024,
  };
  const result = await service.execute('import', { input, tabId: 7, requestId: 'oversized-response' });
  const evidence = await service.execute('evidence', { taskId: result.data.taskId });
  expect(evidence.data.candidates[0].responseEvidence).toMatchObject({
    bodyOmissionReason: 'too_large', bodyReadLimit: 4 * 1024 * 1024, bodyTransferSize: 5 * 1024 * 1024, bodyFullSize: 0,
  });
  const analysis = await service.execute('analyze', { taskId: result.data.taskId });
  expect(analysis.data.candidates[0].eligible).toBe(false);
  expect(analysis.data.candidates[0].reasons).toContain('response_body_too_large');
});

it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 'placeholder-private-value', { raw: 'placeholder-private-value' }])(
  'drops invalid capture size metadata (%j)', async value => {
    const { service, input } = setup();
    Object.assign(input.source_exploration.api_evidence.entries[0].responseEvidence, { bodyReadLimit: value, bodyTransferSize: value });
    const result = await service.execute('import', { input, tabId: 7, requestId: 'invalid-size-metadata' });
    const run = service.runs.get(result.data.taskId);
    expect(run.candidates[0].responseEvidence.bodyReadLimit).toBeUndefined();
    expect(run.candidates[0].responseEvidence.bodyTransferSize).toBeUndefined();
    expect(JSON.stringify(run)).not.toContain('placeholder-private-value');
  },
);

it.each(['not_captured', 'too_large', 'non_json', 'empty', 'read_timeout', 'invalid_encoding', 'read_failed'])(
  'preserves the safe omission reason %s through import and analysis', async reason => {
    const { service, input } = setup();
    input.source_exploration.api_evidence.entries[0].responseEvidence = {
      bodyKind: 'opaque', bodyOmitted: true, bodyFullSize: 0, bodyOmissionReason: reason,
    };
    const result = await service.execute('import', { input, tabId: 7, requestId: 'omitted-body' });
    const candidate = service.runs.get(result.data.taskId).candidates[0];
    expect(candidate.responseEvidence.bodyOmissionReason).toBe(reason);
    const analysis = await service.execute('analyze', { taskId: result.data.taskId });
    expect(analysis.data.candidates[0].eligible).toBe(false);
    expect(analysis.data.candidates[0].reasons).toContain(`response_body_${reason}`);
  },
);

it('drops arbitrary omission descriptions and does not trust them as structural evidence', async () => {
  const { service, input } = setup();
  input.source_exploration.api_evidence.entries[0].responseEvidence = {
    bodyKind: 'opaque', bodyOmitted: true, bodyOmissionReason: 'placeholder-private-error',
  };
  const result = await service.execute('import', { input, tabId: 7, requestId: 'unsafe-omission' });
  const run = service.runs.get(result.data.taskId);
  expect(run.candidates[0].responseEvidence.bodyOmissionReason).toBeUndefined();
  expect(JSON.stringify(run)).not.toContain('placeholder-private-error');
});
