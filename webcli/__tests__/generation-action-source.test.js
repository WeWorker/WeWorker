import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GenerationHarness, GenerationRunStore, createAdapterGenerationWorkflow } from '../generation-harness/index.js';
import { buildContextSections } from '../generation-harness/adapter-generation-workflow.js';

const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const memory = {
  siteKey: 'example.com', siteHost: 'example.com', siteOrigin: 'https://example.com',
  canonicalEntryUrl: 'https://example.com/',
  listApiCandidates: [{ url: 'https://example.com/api/navigation/list', method: 'GET' }],
  actionApiCandidates: [{
    url: 'https://example.com/api/search', method: 'GET',
    toolName: 'example.com.search_items', actionName: 'search',
  }],
};

it('identifies the index namespace of passive and recorded read candidates', () => {
  const sections = buildContextSections(memory);
  expect(sections.list_apis[0]).toMatchObject({ index: 0, sourceApiKind: 'list' });
  expect(sections.action_apis[0]).toMatchObject({ index: 0, sourceApiKind: 'action' });
});

it.each(['classic', 'agent'])('allows %s planning to bind recorded reads without selecting a passive API at the same index', async (mode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-action-source-'));
  roots.push(root);
  for (const [key, value] of Object.entries({
    WEWORKER_USER_ADAPTERS_DIR: path.join(root, 'user'), WEBCLI_ADAPTERS_DIR: path.join(root, 'user'),
    WEWORKER_ADAPTER_DATA_DIR: path.join(root, 'data'), WEWORKER_BUILTIN_ADAPTERS_DIR: path.join(root, 'builtin'),
    WEWORKER_BUILD_PROFILE: 'public',
  })) vi.stubEnv(key, value);
  const actions = mode === 'agent'
    ? ['save_generation_plan', 'scaffold_adapter_draft', 'validate_adapter_draft', 'validate_adapter_runtime', 'finish_run', 'final']
    : ['save_generation_plan', 'final'];
  let offeredSourceKind;
  const model = vi.fn(async ({ tools }) => {
    offeredSourceKind = tools.find(tool => tool.name === 'save_generation_plan')
      .parameters.properties.tools.items.properties.sourceApiKind;
    const name = actions.shift();
    if (name === 'final') return { type: 'final', content: 'done' };
    return { type: 'tool_call', name, arguments: name === 'save_generation_plan' ? {
      summary: 'Search items', strategy: 'api_first', tools: [{
        name: 'search_items', purpose: 'Search items', risk: 'read',
        sourceApiKind: 'action', sourceApiIndexes: [0],
      }],
    } : name === 'finish_run' ? { summary: 'verified' } : {} };
  });
  const store = new GenerationRunStore({ rootDir: path.join(root, 'runs') });
  const harness = new GenerationHarness({ store, workflow: createAdapterGenerationWorkflow({
    model, runtimeValidator: vi.fn(async () => ({ passed: true, errors: [] })),
    adaptersDir: path.join(root, 'user'),
  }) });
  const started = harness.start({ siteKey: memory.siteKey, goal: 'Search items', input: { mode, memory, tabId: 7 } });
  const result = await harness.wait(started.id);
  expect(offeredSourceKind).toMatchObject({ type: 'string', enum: ['list', 'action'] });
  expect(result.status).toBe('awaiting_approval');
  const draft = store.load(started.id).artifacts.draft;
  const script = fs.readFileSync(path.join(draft.adapterDir, 'extension/commands/search-items.js'), 'utf8');
  expect(script).toContain('/api/search');
  expect(script).not.toContain('/api/navigation/list');
});
