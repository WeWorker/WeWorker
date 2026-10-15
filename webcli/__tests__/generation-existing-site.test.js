import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { writeAdapterPackageFromSiteMemory } from '../adapter-scaffold.js';
import { resolveAdapterPaths } from '../paths.js';
import { buildAdapterCatalog } from '../adapter-catalog.js';
import { readPackageDirectory } from '../adapter-package-files.js';
import { readAdapterState } from '../adapter-state.js';
import { createAdapterPublisher } from '../generation-harness/adapter-publisher.js';
import { validateAdapterDraft } from '../generation-harness/static-validator.js';
import { createPreviewRuntimeValidator } from '../generation-harness/runtime-validator.js';
import { verifyGeneratedWriteTools } from '../generation-harness/write-tool-verifier.js';
import { prepareGenerationRun, allocateGenerationPlan } from '../generation-harness/existing-site.js';
import { GenerationHarness } from '../generation-harness/generation-harness.js';
import { GenerationRunStore } from '../generation-harness/run-store.js';
import { createAdapterGenerationWorkflow } from '../generation-harness/adapter-generation-workflow.js';
import { createDraftEvidenceTools } from '../generation-harness/draft-evidence-tools.js';

const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-site-generation-'));
  roots.push(root);
  for (const [key, value] of Object.entries({ WEWORKER_USER_ADAPTERS_DIR: 'user', WEBCLI_ADAPTERS_DIR: 'user', WEWORKER_ADAPTER_DATA_DIR: 'data', WEWORKER_BUILTIN_ADAPTERS_DIR: 'builtin' })) vi.stubEnv(key, path.join(root, value));
  vi.stubEnv('WEWORKER_BUILD_PROFILE', 'public');
  const base = writeAdapterPackageFromSiteMemory({ siteKey: 'example.com', siteHost: 'example.com', listApiCandidates: [{ url: 'https://example.com/api/list', method: 'GET' }] }, { outputRoot: path.join(root, 'builtin'), plan: { tools: [{ name: 'search_items', risk: 'read', sourceApiIndexes: [0] }] } });
  // A pre-existing mutation must be retained, and must never be exercised by this read-only exploration.
  const manifest = JSON.parse(fs.readFileSync(base.files.manifest, 'utf8'));
  manifest.commands.push({ id: 'submit-item', runtime: 'extension', module: 'extension/commands/submit-item.js', safety: 'write', schema: { type: 'object', properties: {} }, description: 'Existing mutation' });
  fs.writeFileSync(base.files.manifest, JSON.stringify(manifest));
  fs.writeFileSync(path.join(base.adapterDir, 'extension/commands/submit-item.js'), "__webcliRegisterCommand('submit-item', () => { throw new Error('MUST_NOT_EXECUTE_EXISTING_MUTATION'); });");
  const memory = { siteKey: 'search.example.com', siteHost: 'search.example.com', siteOrigin: 'https://search.example.com', listApiCandidates: [{ url: 'https://search.example.com/api/search?keyword=fixture', method: 'GET', responsePreview: '{"data":[{"id":"fixture"}]}' }] };
  const run = { id: 'existing-site-fixture', snapshot: { siteKey: memory.siteKey, input: { memory }, artifacts: {} }, persist: vi.fn(), setArtifact(key, value) { this.snapshot.artifacts[key] = value; } };
  const prepared = prepareGenerationRun(run);
  const plan = allocateGenerationPlan(prepared, { tools: [{ name: 'search_items', purpose: 'Search items', risk: 'read', sourceApiIndexes: [0] }] });
  const draft = writeAdapterPackageFromSiteMemory(prepared, { outputRoot: path.join(root, 'draft'), plan });
  const validation = validateAdapterDraft({ adapterDir: draft.adapterDir, expectedSiteKey: 'example.com', expectedToolNames: ['example.com.explored-search-items'] });
  run.snapshot.artifacts = { draft, staticValidation: validation };
  return { root, base, memory, run, prepared, plan, draft, validation };
}

it('targets the unique existing owner and adds commands without changing any previous command or file', async () => {
  const { base, run, prepared, draft, plan, validation } = setup();
  expect(run.snapshot.siteKey).toBe('example.com');
  expect(prepared.siteHost).toBe('search.example.com');
  expect(plan.tools[0].name).toBe('explored_search_items');
  const before = readPackageDirectory(base.adapterDir), after = readPackageDirectory(draft.adapterDir);
  for (const [name, contents] of before.files) if (name !== 'manifest.json') expect(after.files.get(name)).toEqual(contents);
  for (const command of before.manifest.commands) expect(after.manifest.commands.find(item => item.id === command.id)).toEqual(command);
  expect(after.manifest.match).toContain('search.example.com');
  expect(after.manifest.version).toBe('1.0.1');
  expect(validation.errors).toEqual([]);
  expect(await verifyGeneratedWriteTools({ adapterDir: draft.adapterDir, expectedSiteKey: prepared.siteKey })).toMatchObject({ passed: true, writeToolCount: 0 });
  const result = await createAdapterPublisher()({ run, approval: { acceptChanges: true } }).catch(error => error);
  // The added host grant still needs the current concrete review, even for an additive package.
  expect(result.code).toBe('ADAPTER_INSTALL_REVIEW_REQUIRED');
  const review = run.snapshot.artifacts.installationReview;
  const installed = await createAdapterPublisher()({ run, approval: { reviewId: review.reviewId, acceptChanges: true } });
  expect(installed.siteKey).toBe('example.com');
  expect(buildAdapterCatalog().diagnostics).toEqual([]);
  expect(buildAdapterCatalog().effective).toHaveLength(1);
  expect(buildAdapterCatalog().effective[0].commands.map(command => command.id)).toEqual(expect.arrayContaining(['submit-item', 'search-items', 'explored-search-items']));
});

it('registers the complete package but executes only the newly explored commands', async () => {
  const { run, draft, plan, prepared, validation } = setup();
  const requestExtension = vi.fn(async message => {
    expect(message.siteKey).toBe('search.example.com');
    const pkg = readPackageDirectory(draft.adapterDir);
    if (!message.testCases) return { passed: true, tools: pkg.commands.map(command => ({ name: command.name, parameters: command.schema })) };
    expect(message.testCases.map(test => test.toolName)).toEqual(['example.com.explored-search-items']);
    return { passed: true };
  });
  expect(await createPreviewRuntimeValidator({ requestExtension })({ run, draft, plan, memory: prepared, validation })).toMatchObject({ passed: true });
});

it('updates only the generated command without requiring the model to rewrite inherited metadata', async () => {
  const { draft, base } = setup();
  const onWrite = vi.fn();
  const update = createDraftEvidenceTools(() => draft.adapterDir, onWrite).find(tool => tool.name === 'update_generated_command');
  const schema = { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] };
  await expect(update.execute({ commandId: 'submit-item', schema })).rejects.toThrow(/Only commands generated/);
  expect(onWrite).not.toHaveBeenCalled();
  const result = await update.execute({ commandId: 'explored-search-items', schema, source: "window.__webcliRegisterCommand('explored-search-items', args => ({ keyword: args.keyword }));" });
  expect(result.command.schema).toEqual(schema);
  expect(onWrite).toHaveBeenCalledOnce();
  expect(validateAdapterDraft({ adapterDir: draft.adapterDir }).passed).toBe(true);
  for (const command of readPackageDirectory(base.adapterDir).manifest.commands) expect(readPackageDirectory(draft.adapterDir).manifest.commands.find(item => item.id === command.id)).toEqual(command);
});

it.each(['file', 'command', 'drop', 'baseline'])('rejects a modified inherited %s instead of treating it as verified', async kind => {
  const { base, draft } = setup();
  const manifest = JSON.parse(fs.readFileSync(draft.files.manifest, 'utf8'));
  if (kind === 'file') fs.appendFileSync(path.join(draft.adapterDir, 'extension/commands/submit-item.js'), '\n// modified');
  if (kind === 'command') { manifest.commands.find(command => command.id === 'submit-item').safety = 'read'; fs.writeFileSync(draft.files.manifest, JSON.stringify(manifest)); }
  if (kind === 'drop') { manifest.commands = manifest.commands.filter(command => command.id !== 'submit-item'); fs.writeFileSync(draft.files.manifest, JSON.stringify(manifest)); }
  if (kind === 'baseline') fs.appendFileSync(path.join(base.adapterDir, 'extension/commands/submit-item.js'), '\n// changed upstream');
  expect(validateAdapterDraft({ adapterDir: draft.adapterDir }).passed).toBe(false);
  expect((await verifyGeneratedWriteTools({ adapterDir: draft.adapterDir })).passed).toBe(false);
});

it('retains the domain conflict guard and installed state when a conflicting package is published', async () => {
  const { memory, root } = setup();
  // An unprepared standalone draft is still rejected by the normal installer.
  const draft = writeAdapterPackageFromSiteMemory(memory, { outputRoot: path.join(root, 'unprepared'), plan: { tools: [{ name: 'query_items', risk: 'read', sourceApiIndexes: [0] }] } });
  const run = { snapshot: { siteKey: memory.siteKey, artifacts: { draft, staticValidation: validateAdapterDraft({ adapterDir: draft.adapterDir }) } }, setArtifact() {} };
  const before = readAdapterState(resolveAdapterPaths());
  await expect(createAdapterPublisher()({ run })).rejects.toMatchObject({ code: 'ADAPTER_DOMAIN_CONFLICT' });
  expect(readAdapterState(resolveAdapterPaths())).toEqual(before);
  expect(buildAdapterCatalog().effective[0].source).toBe('builtin');
});

it('persists the canonical target through the real workflow and protects capabilities across successive additions', async () => {
  const { root, memory, base } = setup();
  const store = new GenerationRunStore({ rootDir: path.join(root, 'runs') });
  const model = vi.fn().mockRejectedValue(new Error('Quick mode must not call a model'));
  const harness = new GenerationHarness({ store, workflow: createAdapterGenerationWorkflow({ model, runtimeValidator: async () => ({ passed: true }) }), publisher: createAdapterPublisher() });
  for (let iteration = 0; iteration < 2; iteration++) {
    const initial = harness.start({ siteKey: memory.siteKey, goal: 'Fixture search', input: { memory, mode: 'quick' } });
    const ready = await harness.wait(initial.id);
    expect(ready.status).toBe('awaiting_approval');
    expect(ready.siteKey).toBe('example.com');
    const persisted = store.load(initial.id);
    expect(persisted.input.memory.generationBaseline.name).toBe('example.com');
    const { describeGeneratedInstall } = await import('../generation-harness/install-review.js');
    const review = describeGeneratedInstall(persisted.artifacts.draft);
    harness.publish(initial.id, { reviewId: review.reviewId, acceptChanges: true });
    expect((await harness.wait(initial.id)).status).toBe('completed');
    const active = buildAdapterCatalog().effective[0];
    expect(active.commands).toHaveLength(readPackageDirectory(base.adapterDir).commands.length + iteration + 1);
    for (const [name, contents] of readPackageDirectory(base.adapterDir).files) if (name !== 'manifest.json') expect(readPackageDirectory(active.root).files.get(name)).toEqual(contents);
  }
  expect(model).not.toHaveBeenCalled();
});
