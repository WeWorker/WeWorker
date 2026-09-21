import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GENERATION_STATUSES,
  GenerationHarness,
  GenerationRunStore,
  createAdapterGenerationWorkflow,
  createAdapterPublisher,
  fingerprintDirectory,
  seedAdapterDraft,
} from '../generation-harness/index.js';

const tmpDirs = [];

function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

const MEMORY = {
  siteKey: 'newsite.example.test',
  siteHost: 'newsite.example.test',
  siteOrigin: 'https://newsite.example.test',
  canonicalEntryUrl: 'https://newsite.example.test/list',
  recommendedStrategy: 'COOKIE_API',
  verdictPattern: 'api_driven',
  // V2 evidence forces seedAdapterDraft to use the run draft root as source,
  // which is exactly the path that produced the empty-hash vs missing mismatch.
  apiAnalysisV2: { schemaVersion: 2, candidates: [{ evidenceId: 'list', risk: 'read', strategyNote: { replayStatus: 'verified' } }] },
  listApiCandidates: [{ url: 'https://newsite.example.test/api/list', method: 'GET', apiEvidence: { evidenceId: 'list' } }],
  actionApiCandidates: [],
};

function createFakeScaffoldWriter() {
  return (memory, { outputRoot }) => {
    const adapterDir = path.join(outputRoot, memory.siteKey);
    const toolsDir = path.join(adapterDir, 'webcli-generated', 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(adapterDir, 'index.js'), `window.__webmcpRegister({ name: "test", tools: [{ name: "${memory.siteKey}.search_records" }] });\n`);
    fs.writeFileSync(path.join(toolsDir, 'search_records.generated.js'), '// search tool');
    fs.writeFileSync(path.join(adapterDir, 'manifest.json'), `${JSON.stringify({
      id: memory.siteKey,
      match: [memory.siteHost],
      support_files: ['webcli-generated/tools/search_records.generated.js'],
    }, null, 2)}\n`);
    return { adapterDir, toolNames: [`${memory.siteKey}.search_records`], files: {} };
  };
}

describe('publish fingerprint baseline (ADAPTER_CHANGED_DURING_GENERATION regression)', () => {
  it('seeds fingerprints before creating the draft root directory', () => {
    const draftRoot = path.join(makeTmpDir('webcli-seed-order-'), 'revision-0');
    const workspace = seedAdapterDraft({
      sourceAdapterDir: draftRoot,
      draftRoot,
      siteKey: 'newsite.example.test',
      adaptersDir: makeTmpDir('webcli-seed-order-adapters-'),
    });
    expect(workspace.sourceFingerprint).toBe('missing');
    expect(workspace.publishBaselineFingerprint).toBe('missing');
    expect(workspace.seededFromExisting).toBe(false);
  });

  it('publishes a brand-new V2 site whose formal adapter directory does not exist', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-publish-store-') });
    const adaptersDir = makeTmpDir('webcli-publish-adapters-');
    const runtimeValidator = vi.fn().mockResolvedValue({ passed: true, validator: 'adapter_runtime_validator_v1', errors: [] });
    const model = vi.fn()
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'save_generation_plan',
        arguments: {
          summary: '生成只读查询工具',
          strategy: 'api_first',
          tools: [{ name: 'search_records', purpose: '查询记录', risk: 'read', sourceApiIndexes: [0] }],
        },
      })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'scaffold_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_runtime', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'finish_run', arguments: { summary: '全部验证通过' } })
      .mockResolvedValueOnce({ type: 'final', content: 'done' });

    const harness = new GenerationHarness({
      store,
      workflow: createAdapterGenerationWorkflow({
        model,
        scaffoldWriter: createFakeScaffoldWriter(),
        runtimeValidator,
        adaptersDir,
      }),
      publisher: createAdapterPublisher({ adaptersDir }),
    });
    const started = harness.start({
      siteKey: MEMORY.siteKey,
      goal: 'agent mode publish',
      input: { memory: MEMORY, mode: 'agent' },
    });
    await harness.wait(started.id);
    expect(harness.get(started.id).status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);

    const published = await harness.publish(started.id);
    await harness.wait(started.id);
    expect(published.siteKey).toBe(MEMORY.siteKey);
    expect(harness.get(started.id).status).toBe(GENERATION_STATUSES.COMPLETED);
    expect(fs.existsSync(path.join(adaptersDir, MEMORY.siteKey, 'manifest.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(adaptersDir, 'index.json'), 'utf8'))).toContain(MEMORY.siteKey);
  });

  it('still rejects publishing when the formal adapter changed after seeding', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-publish-guard-store-') });
    const adaptersDir = makeTmpDir('webcli-publish-guard-adapters-');
    const runtimeValidator = vi.fn().mockResolvedValue({ passed: true, validator: 'adapter_runtime_validator_v1', errors: [] });
    const model = vi.fn()
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'save_generation_plan',
        arguments: {
          summary: '生成只读查询工具',
          strategy: 'api_first',
          tools: [{ name: 'search_records', purpose: '查询记录', risk: 'read', sourceApiIndexes: [0] }],
        },
      })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'scaffold_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_runtime', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'finish_run', arguments: { summary: '全部验证通过' } })
      .mockResolvedValueOnce({ type: 'final', content: 'done' });

    const harness = new GenerationHarness({
      store,
      workflow: createAdapterGenerationWorkflow({
        model,
        scaffoldWriter: createFakeScaffoldWriter(),
        runtimeValidator,
        adaptersDir,
      }),
      publisher: createAdapterPublisher({ adaptersDir }),
    });
    const started = harness.start({
      siteKey: MEMORY.siteKey,
      goal: 'guard test',
      input: { memory: MEMORY, mode: 'agent' },
    });
    await harness.wait(started.id);
    expect(harness.get(started.id).status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);

    // Simulate an external actor (e.g. another agent session) creating the
    // formal adapter directory after the run started.
    fs.mkdirSync(path.join(adaptersDir, MEMORY.siteKey), { recursive: true });
    fs.writeFileSync(path.join(adaptersDir, MEMORY.siteKey, 'index.js'), '// external change\n');
    expect(fingerprintDirectory(path.join(adaptersDir, MEMORY.siteKey))).not.toBe('missing');

    await harness.publish(started.id);
    await harness.wait(started.id);
    const failed = harness.get(started.id);
    expect(failed.status).toBe(GENERATION_STATUSES.FAILED);
    expect(failed.lastError?.code).toBe('ADAPTER_CHANGED_DURING_GENERATION');
  });
});
