import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installAdapter } from '../adapter-install-store.js';
import { managedAdapterViews } from '../adapter-views.js';
import { syncManagedAdapterSkills } from '../adapter-skill-sync.js';
import {
  portableSkillIntents, portableSkillIntentMarkdown, portableSkillIntentResource, isOwnedIntentResource,
} from '../adapter-skill-intents.js';

function tool(name, { safety = 'read', runtime = 'background', properties = {} } = {}) {
  return { name, safety, requires_confirmation: safety === 'write', execution: { type: 'api', runtime }, parameters: { type: 'object', properties } };
}

function adapter(overrides = {}) {
  return {
    id: 'demo',
    tools: [
      tool('demo.search', { properties: { query: { type: 'string' }, limit: { type: 'integer' } } }),
      tool('demo.save', { safety: 'write', properties: { title: { type: 'string' } } }),
      tool('demo.page', { runtime: 'page', properties: { q: { type: 'string' } } }),
    ],
    ...overrides,
  };
}

const exactRoute = {
  id: 'search-transformer', tier: 'exact', tool: 'demo.search',
  utterances: ['搜索 transformer 论文'], args: { query: 'transformer' },
  examples: ['搜索 transformer 论文'], negativeExamples: ['提交 transformer 论文'],
};

function intents(routes) {
  return { version: 1, routes };
}

function packageFiles(version, routeDefinition) {
  const manifest = {
    schema_version: 2, name: 'demo', version, description: 'Fixture Adapter', match: ['example.com'],
    ...(routeDefinition ? { skill_intents: routeDefinition } : {}),
    commands: [{
      id: 'search', runtime: 'extension', module: 'extension/commands/search.js', description: 'Fixture search', safety: 'read',
      execution: { type: 'api', runtime: 'background' },
      schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }],
  };
  return new Map([
    ['manifest.json', JSON.stringify(manifest)],
    ['extension/commands/search.js', 'fixture source'],
  ]);
}

function install(version, routeDefinition) {
  return installAdapter({ files: packageFiles(version, routeDefinition), origin: { kind: 'local' }, allowPermissionChange: true });
}

let root, target;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adapter-skill-intents-'));
  target = join(root, 'skills');
  vi.stubEnv('WEWORKER_BUILD_PROFILE', 'public');
  vi.stubEnv('WEWORKER_BUILTIN_ADAPTERS_DIR', join(root, 'builtin'));
  vi.stubEnv('WEWORKER_USER_ADAPTERS_DIR', join(root, 'user'));
  vi.stubEnv('WEBCLI_ADAPTERS_DIR', join(root, 'user'));
  vi.stubEnv('WEWORKER_ADAPTER_DATA_DIR', join(root, 'data'));
  vi.stubEnv('WEWORKER_ADAPTERS_DIR', join(root, 'legacy-toolkit'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function sync(adapterId = 'demo') {
  return syncManagedAdapterSkills({ target, snapshot: managedAdapterViews(), profile: 'public', adapterId });
}

describe('portable Adapter Skill intent hints', () => {
  it('keeps only routes whose tool is a read-only background API command', () => {
    const routes = [
      exactRoute,
      { ...exactRoute, id: 'write-route', tool: 'demo.save' },
      { ...exactRoute, id: 'page-route', tool: 'demo.page' },
    ];
    expect(portableSkillIntents(adapter({ skill_intents: intents(routes) })).routes.map((route) => route.id)).toEqual(['search-transformer']);
  });

  it('drops malformed entries instead of making the whole Skill unusable', () => {
    const routes = [
      exactRoute,
      { ...exactRoute },
      { ...exactRoute, id: 'unanchored', tier: 'template', pattern: '搜索 ([a-z]+) 论文', captures: { query: { group: 1, type: 'string' } } },
      { ...exactRoute, id: 'bad-regex', tier: 'regex', pattern: '([a-z' },
      { ...exactRoute, id: 'unknown-capture', tier: 'template', pattern: '^搜索 ([a-z]+) 论文$', captures: { missing: { group: 1, type: 'string' } } },
      { ...exactRoute, id: 'unknown-arg', args: { missing: 'value' } },
      { ...exactRoute, id: 'no-negatives', negativeExamples: [] },
    ];
    const result = portableSkillIntents(adapter({ skill_intents: intents(routes) }));
    expect(result.routes.map((route) => route.id)).toEqual(['search-transformer']);
  });

  it('returns null when nothing valid remains or the version is unsupported', () => {
    expect(portableSkillIntents(adapter({ skill_intents: intents([{ ...exactRoute, tool: 'demo.save' }]) }))).toBeNull();
    expect(portableSkillIntents(adapter({ skill_intents: { version: 2, routes: [exactRoute] } }))).toBeNull();
    expect(portableSkillIntents(adapter())).toBeNull();
  });

  it('renders match rules, rejection examples and the CLI target', () => {
    const markdown = portableSkillIntentMarkdown(portableSkillIntents(adapter({ skill_intents: intents([
      exactRoute,
      { id: 'search', tier: 'template', tool: 'demo.search', pattern: '^搜索 (.+) 论文$', captures: { query: { group: 1, type: 'string' } }, examples: ['搜索 graph 论文'], negativeExamples: ['提交 graph 论文'] },
      { id: 'by-id', tier: 'regex', tool: 'demo.search', pattern: '^论文 ([0-9]+)$', negatives: ['^删除论文'], examples: ['论文 42'], negativeExamples: ['删除论文 42'] },
    ]) })));
    expect(markdown).toContain('## Fast intent selection (portable Skill hints)');
    expect(markdown).toContain('### 1. Exact phrases');
    expect(markdown).toContain('`webcli call demo.search`');
    expect(markdown).toContain('--query=<group 1, string>');
    expect(markdown).toContain('Reject when matching');
    expect(markdown).toContain('No:');
  });

  it('emits a self-verifying reference resource and rejects edited copies', () => {
    const resource = portableSkillIntentResource(portableSkillIntents(adapter({ skill_intents: intents([exactRoute]) })));
    expect(JSON.parse(resource)).toMatchObject({ generator: 'webcli-adapter-skill-intents', version: 1, adapterId: 'demo' });
    expect(isOwnedIntentResource(resource)).toBe(true);
    expect(isOwnedIntentResource(resource.replace('transformer', 'edited'))).toBe(false);
    expect(isOwnedIntentResource('not json')).toBe(false);
    expect(portableSkillIntentResource(null)).toBeNull();
  });

  it('writes, preserves and removes the generated reference alongside the Skill', () => {
    install('1.0.0', intents([exactRoute]));
    sync();
    const reference = join(target, 'webcli-demo/references/intent-routes.json');
    expect(readFileSync(join(target, 'webcli-demo/SKILL.md'), 'utf8')).toContain('Fast intent selection');
    expect(isOwnedIntentResource(readFileSync(reference, 'utf8'))).toBe(true);

    writeFileSync(reference, '{"user":"edited"}');
    sync();
    expect(readFileSync(reference, 'utf8')).toBe('{"user":"edited"}');

    rmSync(reference);
    sync();
    expect(isOwnedIntentResource(readFileSync(reference, 'utf8'))).toBe(true);

    install('1.1.0', undefined);
    sync();
    expect(existsSync(reference)).toBe(false);
    expect(readFileSync(join(target, 'webcli-demo/SKILL.md'), 'utf8')).not.toContain('Fast intent selection');
  });
});
