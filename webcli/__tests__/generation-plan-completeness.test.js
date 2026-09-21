import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, expect, it } from 'vitest';
import { writeScaffoldFromSiteMemory } from '../adapter-scaffold.js';
import { validateAdapterDraft } from '../generation-harness/static-validator.js';
import { resolveAdapterDraftFile } from '../generation-harness/draft-revision.js';
import { plannedToolNames } from '../generation-harness/plan-binding.js';

const roots = [];
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-binding-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const memory = {
  siteKey: 'example.test', siteHost: 'example.test', siteOrigin: 'https://example.test',
  canonicalEntryUrl: 'https://example.test/',
  listApiCandidates: ['/api/menu/list', '/api/user/info', '/api/pending/count'].map(url => ({ url: `https://example.test${url}`, method: 'GET' })),
  actionApiCandidates: [{ url: 'https://example.test/api/submit', method: 'POST', toolName: 'example.test.submit_draft', actionName: 'submit' }],
  actionCaptureHistory: [{ url: 'https://example.test/api/delete', method: 'POST', toolName: 'example.test.delete_draft', actionName: 'delete' }],
};
const plan = { tools: [
  { name: 'get_user', risk: 'read', sourceApiIndexes: [1] },
  { name: 'get_pending_count', risk: 'read', sourceApiIndexes: [2] },
] };

it('generates the exact planned second and third sources, excluding historical actions', async () => {
  const draft = writeScaffoldFromSiteMemory(memory, { outputRoot: temporary(), plan });
  expect(draft.toolNames).toEqual(['example.test.check_login_status', ...plannedToolNames(memory.siteKey, plan)]);
  const count = fs.readFileSync(path.join(draft.adapterDir, 'webcli-generated/tools/get_pending_count.generated.js'), 'utf8');
  expect(count).toContain('/api/pending/count');
  expect(count).not.toContain('/api/menu/list');
  const validation = validateAdapterDraft({ adapterDir: draft.adapterDir, expectedSiteKey: memory.siteKey, expectedToolNames: plannedToolNames(memory.siteKey, plan) });
  expect(validation.errors).toEqual([]);
  const requested = [];
  const context = vm.createContext({
    window: { __webmcpRegister() {}, location: { origin: memory.siteOrigin } }, URL, URLSearchParams,
    fetch: async (url) => {
      requested.push(String(url));
      return { ok: true, status: 200, text: async () => '{"data":7}' };
    },
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(draft.adapterDir, 'manifest.json'), 'utf8'));
  for (const file of manifest.support_files) vm.runInContext(fs.readFileSync(path.join(draft.adapterDir, file), 'utf8'), context);
  const output = await vm.runInContext('window.__webmcpGeneratedSupport["example.test"].tools.find(t => t.name === "example.test.get_pending_count").handler({})', context);
  expect(requested).toEqual(['https://example.test/api/pending/count']);
  expect(output).toMatchObject({ ok: true, status: 200, data: { data: 7 } });
});

it('rejects missing and unplanned registered tools even when the generator reports success', () => {
  const draft = writeScaffoldFromSiteMemory(memory, { outputRoot: temporary(), plan });
  fs.writeFileSync(path.join(draft.adapterDir, 'index.js'), 'window.__webmcpRegister({tools:[{name:"example.test.unplanned"}]});');
  const validation = validateAdapterDraft({ adapterDir: draft.adapterDir, expectedSiteKey: memory.siteKey, expectedToolNames: plannedToolNames(memory.siteKey, plan) });
  expect(validation.errors.map(error => error.code)).toEqual(['MISSING_PLANNED_TOOL', 'MISSING_PLANNED_TOOL', 'UNPLANNED_TOOL']);
});

it('fails explicitly on unresolved planned evidence', () => {
  expect(() => writeScaffoldFromSiteMemory(memory, { outputRoot: temporary(), plan: { tools: [{ name: 'missing', risk: 'read', sourceApiIndexes: [9] }] } })).toThrow('source API not found');
});

it('allows a new nested draft file but rejects traversal, alternate streams and junctions', () => {
  const root = temporary();
  expect(resolveAdapterDraftFile(root, 'tools/new.js', { mustExist: false }).filePath).toBe(path.join(root, 'tools/new.js'));
  expect(() => resolveAdapterDraftFile(root, 'tools/new.js')).toThrow('not found');
  for (const name of ['../escape.js', 'C:/escape.js', 'file:stream.js', 'aux.js']) {
    expect(() => resolveAdapterDraftFile(root, name, { mustExist: false })).toThrow();
  }
  const outside = temporary();
  fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => resolveAdapterDraftFile(root, 'linked/new.js', { mustExist: false })).toThrow('symbolic link');
});
