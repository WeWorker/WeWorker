import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { writeAdapterPackageFromSiteMemory } from '../adapter-scaffold.js';
import { validateAdapterDraft } from '../generation-harness/static-validator.js';
import { packageDraftBundle } from '../generation-harness/package-inspection.js';
import { readPackageDirectory } from '../adapter-package-files.js';
import { verifyGeneratedWriteTools } from '../generation-harness/write-tool-verifier.js';
import { createDraftEvidenceTools } from '../generation-harness/draft-evidence-tools.js';
import { createAdapterPublisher } from '../generation-harness/adapter-publisher.js';
import { writeGenerationHarnessProvenance } from '../generation-harness/provenance.js';
import { GenerationRunStore } from '../generation-harness/run-store.js';
import { resolveAdapterPaths } from '../paths.js';
import { installAdapter } from '../adapter-install-store.js';
import { buildAdapterCatalog } from '../adapter-catalog.js';
import { dropDraftTool } from '../generation-harness/draft-revision.js';
import { reviseAdapterDraft } from '../generation-harness/draft-revision.js';
import { createPreviewRuntimeValidator } from '../generation-harness/runtime-validator.js';
import { GenerationRun } from '../generation-harness/generation-run.js';
import { GENERATION_STATUSES } from '../generation-harness/constants.js';

const roots = [];
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-generation-')); roots.push(root); return root; };
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = temporary();
  vi.stubEnv('WEWORKER_USER_ADAPTERS_DIR', path.join(root, 'user'));
  vi.stubEnv('WEBCLI_ADAPTERS_DIR', path.join(root, 'user'));
  vi.stubEnv('WEWORKER_ADAPTER_DATA_DIR', path.join(root, 'data'));
  vi.stubEnv('WEWORKER_BUILTIN_ADAPTERS_DIR', path.join(root, 'builtin'));
  vi.stubEnv('WEWORKER_BUILD_PROFILE', 'public');
  return root;
}
const memory = {
  siteKey: 'example.com', siteHost: 'example.com', siteOrigin: 'https://example.com', canonicalEntryUrl: 'https://example.com/',
  listApiCandidates: ['/api/menu/list', '/api/user/info', '/api/pending/count'].map(url => ({ url: `https://example.com${url}`, method: 'GET' })),
};
const plan = { tools: [ { name: 'get_user', risk: 'read', sourceApiIndexes: [1] }, { name: 'get_pending_count', risk: 'read', sourceApiIndexes: [2] } ] };
function create(input = memory, options = {}) { return writeAdapterPackageFromSiteMemory(input, { outputRoot: setup(), plan, ...options }); }

it('generates a closed package, canonical commands, aliases and separate source bindings', async () => {
  const draft = create();
  const { manifest, scripts } = packageDraftBundle(draft.adapterDir);
  expect(draft.toolNames).toEqual(['example.com.check-login-status', 'example.com.get-user', 'example.com.get-pending-count']);
  expect(manifest.commands[1].aliases).toEqual(['get_user']);
  expect(manifest.commands[1].execution).toBeUndefined(); // Generated fetch still needs the authenticated page.
  const evidence = JSON.parse(fs.readFileSync(draft.files.sourceEvidence, 'utf8'));
  expect(evidence.commands['get-pending-count'].generationSource.endpoint).toContain('/api/pending/count');
  const validation = validateAdapterDraft({ adapterDir: draft.adapterDir, expectedSiteKey: memory.siteKey, expectedToolNames: plan.tools.map(t => `${memory.siteKey}.${t.name}`) });
  expect(validation.errors).toEqual([]);
  expect([...readPackageDirectory(draft.adapterDir).files.keys()].some(file => /generation|SKILL|knowledge/.test(file))).toBe(false);
  const tools = [], requests = [];
  const context = vm.createContext({ window: { location: { origin: memory.siteOrigin }, __webmcpRegister: adapter => tools.push(...adapter.tools) }, URL, URLSearchParams,
    fetch: async url => { requests.push(String(url)); return { ok: true, status: 200, text: async () => '{"data":7}' }; } });
  for (const script of scripts) vm.runInContext(script.source, context);
  expect(await tools.find(t => t.name.endsWith('.get-pending-count')).handler({})).toMatchObject({ ok: true, data: { data: 7 } });
  expect(requests).toEqual(['https://example.com/api/pending/count']);
});

it('does not include captured query, request or response values in package or evidence', () => {
  const draft = create({ ...memory, listApiCandidates: [{ url: 'https://example.com/api/list?q=CAPTURED_PRIVATE_VALUE', method: 'GET', requestBodyPreview: '{"title":"CAPTURED_BODY_VALUE"}', responsePreview: '{"data":[{"title":"CAPTURED_RESPONSE_VALUE"}]}' }] }, { plan: { tools: [{ name: 'get_items', risk: 'read', sourceApiIndexes: [0] }] } });
  const content = [...readPackageDirectory(draft.adapterDir).files.values()].join('\n') + fs.readFileSync(draft.files.sourceEvidence, 'utf8');
  expect(content).not.toMatch(/CAPTURED_(PRIVATE|BODY|RESPONSE)_VALUE/);
});

it('keeps keyword parameter names while excluding credential fields and all captured values', () => {
  const draft = create({ ...memory, listApiCandidates: [{ url: 'https://example.com/api/search?keyword=CAPTURED_SEARCH&keywords=CAPTURED_WORDS&api_key=fixture-secret&key=fixture-secret&privateKey=fixture-secret&token=fixture-secret', method: 'GET' }] }, { plan: { tools: [{ name: 'search_items', risk: 'read', sourceApiIndexes: [0] }] } });
  const pkg = readPackageDirectory(draft.adapterDir);
  const command = pkg.manifest.commands.find(item => item.id === 'search-items');
  expect(Object.keys(command.schema.properties)).toEqual(['keyword', 'keywords']);
  expect([...pkg.files.values()].join('\n')).not.toMatch(/CAPTURED_SEARCH|CAPTURED_WORDS|fixture-secret/);
});

it('refuses to overwrite an existing draft and rejects missing planned registrations', () => {
  const root = setup();
  const draft = writeAdapterPackageFromSiteMemory(memory, { outputRoot: root, plan });
  expect(() => writeAdapterPackageFromSiteMemory(memory, { outputRoot: root, plan })).toThrow(/empty/);
  fs.writeFileSync(path.join(draft.adapterDir, 'extension/commands/get-user.js'), '/* missing handler */');
  expect(validateAdapterDraft({ adapterDir: draft.adapterDir, expectedToolNames: ['example.com.get_user'] }).errors.map(e => e.code)).toContain('MISSING_PLANNED_TOOL');
});

it('keeps the distributable bootstrap identical to the browser implementation', () => {
  expect(fs.readFileSync(new URL('../adapter-extension-loader.js', import.meta.url), 'utf8')).toBe(fs.readFileSync(new URL('../../extension/background/v2-loader.js', import.meta.url), 'utf8'));
});

function runFor(draft) {
  const snapshot = { siteKey: memory.siteKey, artifacts: { draft, staticValidation: validateAdapterDraft({ adapterDir: draft.adapterDir, expectedToolNames: draft.toolNames }) } };
  return { id: 'fixture-run', snapshot, setArtifact: (key, value) => { snapshot.artifacts[key] = value; } };
}

it('installs verified immutable package bytes into the managed user catalog without task evidence', async () => {
  const draft = create();
  const run = runFor(draft);
  const digest = readPackageDirectory(draft.adapterDir).digest;
  writeGenerationHarnessProvenance({ run, draft, validation: run.snapshot.artifacts.staticValidation, plan });
  expect(readPackageDirectory(draft.adapterDir).digest).toBe(digest);
  const result = await createAdapterPublisher()({ run });
  expect(result.digest).toBe(digest);
  expect(buildAdapterCatalog().effective[0]).toMatchObject({ name: memory.siteKey, source: 'user', digest });
  expect(fs.existsSync(path.join(resolveAdapterPaths().builtinDir, memory.siteKey))).toBe(false);
});

it('rejects changes after validation and concurrent changes to the installation baseline', async () => {
  const draft = create();
  const run = runFor(draft);
  const file = path.join(draft.adapterDir, 'extension/commands/get-user.js');
  const source = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, source + '\n// changed');
  await expect(createAdapterPublisher()({ run })).rejects.toThrow(/changed after validation/);
  run.snapshot.artifacts.staticValidation = validateAdapterDraft({ adapterDir: draft.adapterDir, expectedToolNames: draft.toolNames });
  installAdapter({ directory: draft.adapterDir });
  await expect(createAdapterPublisher()({ run })).rejects.toMatchObject({ code: 'ADAPTER_BASE_CHANGED' });
});

it('refuses a revision that changes a managed draft into the historical publication format', async () => {
  const draft = create();
  const run = runFor(draft);
  fs.writeFileSync(draft.files.manifest, JSON.stringify({ id: memory.siteKey, match: [memory.siteKey] }));
  fs.writeFileSync(path.join(draft.adapterDir, 'index.js'), 'window.__webmcpRegister({ tools: [] });');
  expect(validateAdapterDraft({ adapterDir: draft.adapterDir }).errors[0].code).toBe('PACKAGE_FORMAT_CHANGED');
  await expect(createAdapterPublisher()({ run })).rejects.toThrow(/package format changed/);
  expect(buildAdapterCatalog().effective).toEqual([]);
});

it('keeps missing mock fixtures and write skeletons from passing; verifies authored handlers separately from the bootstrap gate', async () => {
  const draft = create({ ...memory, listApiCandidates: [], actionApiCandidates: [{ url: 'https://example.com/api/submit', method: 'POST', actionName: 'submit', toolName: 'example.com.submit_draft' }] },
    { plan: { tools: [{ name: 'submit_request', risk: 'write', sourceApiIndexes: [0] }] } });
  const commandPath = path.join(draft.adapterDir, 'extension/commands/submit-request.js');
  const initial = validateAdapterDraft({ adapterDir: draft.adapterDir, expectedToolNames: draft.toolNames });
  expect(initial.errors.map(error => error.code)).toEqual(expect.arrayContaining(['WRITE_AGENT_AUTHORING_REQUIRED', 'MISSING_WRITE_VERIFICATION']));
  const manifest = JSON.parse(fs.readFileSync(draft.files.manifest, 'utf8'));
  manifest.commands.find(command => command.id === 'submit-request').schema['x-webcli-agent-authored'] = true;
  fs.writeFileSync(draft.files.manifest, JSON.stringify(manifest));
  const handler = `window.__webcliRegisterCommand('submit-request', async args => {
    if (args.__confirmed !== true) return { blocked: true, requiresConfirmation: true };
    const response = await fetch('https://example.com/api/submit', { method: 'POST', body: JSON.stringify({ title: args.title }) });
    const body = JSON.parse(await response.text()); return { ok: response.ok && body.code === 0 };
  });`;
  fs.writeFileSync(commandPath, handler);
  const tools = createDraftEvidenceTools(() => draft.adapterDir);
  const fixture = { representativeArgs: { title: 'Fixture request' }, expectedRequest: { method: 'POST', url: 'https://example.com/api/submit', body: { title: 'Fixture request' } },
    successResponse: { status: 200, body: { code: 0 } }, successExpectation: { ok: true }, failureResponse: { status: 200, body: { code: 409 } }, failureExpectation: { ok: false } };
  await tools.find(tool => tool.name === 'write_generation_fixture').execute({ commandId: 'submit-request', fixture });
  expect(validateAdapterDraft({ adapterDir: draft.adapterDir, expectedToolNames: draft.toolNames }).errors).toEqual([]);
  expect(await verifyGeneratedWriteTools({ adapterDir: draft.adapterDir, expectedSiteKey: memory.siteKey })).toMatchObject({ passed: true, writeToolCount: 1 });
  fs.writeFileSync(commandPath, handler.replace('args.__confirmed !== true', 'false'));
  expect((await verifyGeneratedWriteTools({ adapterDir: draft.adapterDir, expectedSiteKey: memory.siteKey })).errors[0].code).toBe('WRITE_IO_BEFORE_CONFIRMATION');
});

it('preserves dropped source in task evidence, keeps a closed package and protects evidence paths', () => {
  const draft = create();
  dropDraftTool(draft.adapterDir, 'example.com.get_user');
  expect(readPackageDirectory(draft.adapterDir).commands.map(command => command.id)).not.toContain('get-user');
  expect(fs.existsSync(path.join(path.dirname(draft.files.sourceEvidence), 'discarded/get-user.js'))).toBe(true);
  const root = setup();
  const outside = temporary();
  fs.symlinkSync(outside, path.join(root, '.generation'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => writeAdapterPackageFromSiteMemory(memory, { outputRoot: root, plan })).toThrow(/symbolic link|junction/);
  expect(fs.readdirSync(outside)).toEqual([]);
});

it('stores new runs under the profile workspace while resolving historical paths through their original store', () => {
  const root = setup();
  const store = new GenerationRunStore({ legacyRootDir: path.join(root, 'legacy') });
  expect(store.rootDir).toBe(path.join(resolveAdapterPaths().workspaceDir, 'runs'));
  const historical = new GenerationRunStore({ rootDir: path.join(root, 'legacy') });
  const oldDraft = path.join(historical.getDraftRoot('old-run'), 'example.com');
  historical.save({ id: 'old-run', artifacts: { draft: { adapterDir: oldDraft, files: { sourceEvidence: path.join(oldDraft, 'fixture.json') } } } });
  const resumed = store.load('old-run');
  expect(resumed.artifacts.draft.adapterDir).toBe(oldDraft);
  resumed.status = 'awaiting_approval';
  store.save(resumed);
  expect(historical.load('old-run').status).toBe('awaiting_approval');
  store.save({ id: 'new-run', artifacts: {} });
  expect(fs.existsSync(path.join(store.rootDir, 'new-run/run.json'))).toBe(true);
});

it('previews canonical registrations with the bound API evidence and never adds the draft to the catalog', async () => {
  const draft = create();
  const requestExtension = vi.fn(async message => {
    expect(message.previewBundle.manifest.schema_version).toBe(2);
    expect(message.previewBundle.packageDigest).toBe(readPackageDirectory(draft.adapterDir).digest);
    expect(message.previewBundle.scripts[0].path).toBe('bootstrap.js');
    if (message.testCases) {
      const command = message.testCases.find(test => test.toolName === 'example.com.get-pending-count');
      expect(command.sourceEvidence.endpoint).toContain('/api/pending/count');
      expect(message.testCases.find(test => test.toolName.endsWith('check-login-status')).execute).toBe(false);
      return { passed: true };
    }
    return { passed: true, tools: packageDraftBundle(draft.adapterDir).manifest.commands.map(command => ({ name: `${memory.siteKey}.${command.id}`, parameters: command.schema })) };
  });
  const result = await createPreviewRuntimeValidator({ requestExtension })({ run: runFor(draft), draft, plan, memory });
  expect(result.passed).toBe(true);
  expect(requestExtension).toHaveBeenCalledTimes(2);
  expect(buildAdapterCatalog().effective).toEqual([]);
});

it('refuses browser preview when package bytes changed since static validation', async () => {
  const draft = create();
  const validation = validateAdapterDraft({ adapterDir: draft.adapterDir });
  fs.appendFileSync(path.join(draft.adapterDir, 'extension/commands/get-user.js'), '\n/* changed fixture */');
  const requestExtension = vi.fn();
  await expect(createPreviewRuntimeValidator({ requestExtension })({ run: runFor(draft), draft, plan, memory, validation })).rejects.toThrow(/changed after static/);
  expect(requestExtension).not.toHaveBeenCalled();
});

it.each([false, true])('isolates revision evidence and persists the baseline while repairing invalid JSON: %s', async (invalidManifest) => {
  const draft = create();
  const manifestText = fs.readFileSync(draft.files.manifest, 'utf8');
  if (invalidManifest) fs.writeFileSync(draft.files.manifest, '{');
  const store = new GenerationRunStore({ rootDir: temporary() });
  const run = GenerationRun.create({ store, siteKey: memory.siteKey, goal: 'Fixture revision' });
  for (const state of ['CONTEXT_READY', 'PLANNING', 'DRAFTING', 'STATIC_VALIDATING']) run.transition(GENERATION_STATUSES[state]);
  const model = vi.fn().mockResolvedValueOnce({ type: 'tool_call', name: 'inspect_generation_evidence', arguments: {} });
  if (invalidManifest) model.mockResolvedValueOnce({ type: 'tool_call', name: 'write_draft_file', arguments: { path: 'manifest.json', content: manifestText, reason: 'Repair invalid JSON.' } });
  model.mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
    .mockResolvedValueOnce({ type: 'final', content: 'Verified.' });
  const revised = await reviseAdapterDraft({ run, store, model, draft, plan, staticValidator: validateAdapterDraft, validation: { errors: [] } });
  expect(revised.validation.passed).toBe(true);
  expect(revised.draft.files.sourceEvidence).not.toBe(draft.files.sourceEvidence);
  expect(fs.readFileSync(revised.draft.files.sourceEvidence, 'utf8')).toBe(fs.readFileSync(draft.files.sourceEvidence, 'utf8'));
  expect(revised.draft.managedBaseline).toEqual(draft.managedBaseline);
  run.setArtifact('draft', revised.draft);
  const persisted = store.load(run.id).artifacts.draft;
  expect(persisted.packageFormat).toBe(2);
  expect(persisted.files.sourceEvidence).toBe(revised.draft.files.sourceEvidence);
  expect(persisted.managedBaseline).toEqual(draft.managedBaseline);
});
