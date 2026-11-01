import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installAdapter, selectAdapter, removeInstalledAdapter } from '../adapter-install-store.js';
import { writePackageDirectory, readPackageDirectory } from '../adapter-package-files.js';
import { managedAdapterView, managedAdapterViews, managedAdapterSkill } from '../adapter-views.js';
import { syncManagedAdapterSkills } from '../adapter-skill-sync.js';
import { describeAdapterCatalog } from '../adapter-host.js';
import { WebSocketBridge } from '../bridge.js';

const cli = fileURLToPath(new URL('../index.js', import.meta.url));
let root, target;
function files(version = '1.0.0', command = 'list', runtime = 'extension') {
  const module = runtime === 'extension' ? `extension/commands/${command}.js` : `wewright/commands/${command}.py`;
  return new Map([
    ['manifest.json', JSON.stringify({ schema_version: 2, name: 'demo', version, description: 'Fixture Adapter', match: ['example.com'],
      commands: [{ id: command, runtime, module, description: 'Fixture command', safety: 'write',
        schema: { type: 'object', properties: { count: { type: 'integer', description: 'Fixture count' } }, required: ['count'] } }] })],
    [module, runtime === 'extension' ? 'fixture source' : '# fixture source'],
  ]);
}
function install(version, command, runtime) { return installAdapter({ files: files(version, command, runtime), origin: { kind: 'local' }, allowPermissionChange: true }); }
function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: process.env, encoding: 'utf8', timeout: 15000 });
  if (result.error) throw result.error;
  return result;
}
function success(args) {
  const result = run(args);
  expect(result.stderr, result.stdout).toBe('');
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
function sync(adapterId = 'demo') { return syncManagedAdapterSkills({ target, snapshot: managedAdapterViews(), profile: 'public', adapterId }); }
function skill() { return readFileSync(join(target, 'webcli-demo/SKILL.md'), 'utf8'); }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adapter-views-'));
  target = join(root, 'skills');
  vi.stubEnv('WEWORKER_BUILD_PROFILE', 'public');
  vi.stubEnv('WEWORKER_BUILTIN_ADAPTERS_DIR', join(root, 'builtin'));
  vi.stubEnv('WEWORKER_USER_ADAPTERS_DIR', join(root, 'user'));
  vi.stubEnv('WEBCLI_ADAPTERS_DIR', join(root, 'user'));
  vi.stubEnv('WEWORKER_ADAPTER_DATA_DIR', join(root, 'data'));
  vi.stubEnv('WEWORKER_ADAPTERS_DIR', join(root, 'legacy-toolkit'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('effective Adapter CLI views and generated Skills', () => {
  it('keeps site help compact and command help parameter-specific without executing', () => {
    install('1.0.0');
    for (const args of [['demo', '-h'], ['demo', 'help'], ['adapter', 'demo', '--help']]) {
      const output = success(args);
      expect(output).toContain('Usage: webcli demo <command> [options]');
      expect(output).toContain('Commands:');
      expect(output).not.toContain('--count');
    }
    for (const args of [['demo', 'list', '-h'], ['demo', 'list', '--help'], ['demo', 'list', '-help'], ['demo', 'list', 'help'], ['adapter', 'demo', 'list', '--help'], ['call', 'demo.list', '--help']]) {
      const output = success(args);
      expect(output).toContain('Usage: webcli demo list [options]');
      expect(output).toContain('--count=<integer>');
      expect(output).toContain('(required)');
    }
    expect(success(['adapter', 'demo', 'list', '--help', '--output-format=yaml'])).toContain('count');
    expect(success(['call', 'demo.list', '-h', '--output-format=markdown'])).toContain('count');
    const site = JSON.parse(success(['demo', '-h', '-f', 'json']));
    expect(site.tools[0]).not.toHaveProperty('parameters');
    expect(JSON.parse(success(['demo', '-h', '--json'])).tools[0]).not.toHaveProperty('parameters');
    expect(JSON.parse(success(['adapter', 'demo', '-h', '--json'])).tools[0]).not.toHaveProperty('parameters');
    const command = JSON.parse(success(['demo', 'list', '-h', '-f', 'json']));
    expect(command.params).toContainEqual(expect.objectContaining({ name: 'count', required: true }));
    expect(run(['demo', 'missing', '-h']).status).not.toBe(0);
  });


  it('uses the same version, digest and tools in list, info, help and Skill without changing the package', () => {
    const installed = install();
    const listing = JSON.parse(success(['adapter', 'list', '--json'])).filter((entry) => entry.id === 'demo');
    expect(listing).toHaveLength(1);
    const info = JSON.parse(success(['adapter', 'info', 'demo', '--json']));
    expect(info).toEqual(listing[0]);
    expect(info.digest).toBe(installed.digest);
    expect(info.tools[0].params[0]).toMatchObject({ name: 'count', type: 'integer', required: true });
    const output = success(['adapter', 'skill', 'demo', '--regenerate', '--overwrite']);
    expect(output).toContain(installed.digest);
    expect(output).toContain('webcli call demo.list');
    expect(output).toContain('__confirmed: true');
    expect(output).toContain('Input JSON Schema:');
    expect(output).toContain('webcli call demo.list --key=value');
    expect(output).not.toContain("--args '<JSON object>'");
    expect(output).toContain('Check each command’s execution and guidance');
    expect(output).toContain('background API commands may run directly');
    expect(output).toContain('"required": [');
    expect(output).not.toContain(root);
    expect(success(['demo', 'list', 'help'])).toContain('--count=<integer>');
    expect(readPackageDirectory(installed.executionRoot).digest).toBe(installed.digest);
    expect(existsSync(join(installed.executionRoot, 'SKILL.md'))).toBe(false);
  });

  it('copies the validated Adapter package icon into the matching Skill root', () => {
    const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#2563eb"/></svg>'
    const packageFiles = files()
    packageFiles.set('icon.svg', icon)
    installAdapter({ files: packageFiles, origin: { kind: 'local' }, allowPermissionChange: true })
    sync()
    expect(readFileSync(join(target, 'webcli-demo/icon.svg'), 'utf8')).toBe(icon)
  })

  it('discovers both runtimes of a mixed package and labels Toolkit correctly', () => {
    const pkg = files();
    const manifest = JSON.parse(pkg.get('manifest.json'));
    manifest.commands.push({ id: 'run', runtime: 'wewright', module: 'wewright/commands/run.py', description: 'Toolkit fixture', schema: { type: 'object', properties: {} } });
    pkg.set('manifest.json', JSON.stringify(manifest)); pkg.set('wewright/commands/run.py', '# fixture');
    installAdapter({ files: pkg, origin: { kind: 'local' } });
    const view = managedAdapterView('demo');
    expect(view.adapter_type).toBe('mixed');
    expect(view.tools.map((entry) => entry.name)).toEqual(['demo.list', 'demo.run']);
    expect(managedAdapterSkill(view)).toContain('Runtime: Toolkit');
    expect(success(['demo', 'run', 'help'])).toContain('Runtime: Toolkit');
  });

  it('keeps nested and boolean JSON Schema definitions intact in derived guidance', () => {
    const pkg = files();
    const manifest = JSON.parse(pkg.get('manifest.json'));
    manifest.commands[0].schema.properties.payload = { type: ['object', 'null'], properties: { value: { enum: ['fixture'] } } };
    manifest.commands[0].schema.properties.extra = true;
    pkg.set('manifest.json', JSON.stringify(manifest));
    installAdapter({ files: pkg, origin: { kind: 'local' } });
    const view = managedAdapterView('demo');
    expect(view.tools[0].parameters).toEqual(manifest.commands[0].schema);
    expect(view.tools[0].params.find((entry) => entry.name === 'payload').type).toBe('object|null');
    expect(managedAdapterSkill(view)).toContain('"extra": true');
  });

  it('includes versioned human guidance and discovery phrases in the generated Skill', () => {
    const pkg = files();
    const manifest = JSON.parse(pkg.get('manifest.json'));
    manifest.discovery_terms = ['find pending items', 'check project queue'];
    pkg.set('manifest.json', JSON.stringify(manifest));
    pkg.set('guidance.md', '## Selection\n\nChoose `demo.list` when the user asks for pending items.\n');
    const installed = installAdapter({ files: pkg, origin: { kind: 'local' } });
    const view = managedAdapterView('demo');
    expect(view.guidance).toContain('pending items');
    const generated = managedAdapterSkill(view);
    expect(generated).toContain('find pending items');
    expect(generated).toContain('Choose `demo.list`');
    expect(generated.indexOf('## Adapter usage guidance')).toBeLessThan(generated.indexOf('## demo.list'));
    sync();
    expect(skill()).toContain('Choose `demo.list`');
    expect(readPackageDirectory(installed.executionRoot).digest).toBe(installed.digest);
    expect(existsSync(join(installed.executionRoot, 'SKILL.md'))).toBe(false);
    expect(JSON.stringify(describeAdapterCatalog())).not.toContain('Choose `demo.list`');
  });

  it('allows open_browser for an effective v2 Adapter website only while it is active', async () => {
    install();
    const bridge = {
      isExtensionConnected: () => true,
      _browser: () => ({ mode: 'system' }),
      _request: async () => ({ tabId: 7 }),
    };
    const result = await WebSocketBridge.prototype.openBrowser.call(bridge, 'https://example.com/');
    expect(result).toMatchObject({ success: true, method: 'extension', tabId: 7 });
    selectAdapter('demo', 'disabled');
    await expect(WebSocketBridge.prototype.openBrowser.call(bridge, 'https://example.com/')).rejects.toThrow(/not allowed/i);
  });

  it('suppresses stale legacy copies when active, disabled, corrupted and removed', () => {
    const installed = install();
    // A stale mirror is not the trusted immutable execution package.
    writeFileSync(join(root, 'user/demo/manifest.json'), JSON.stringify({ id: 'demo', name: 'Old', version: '0.1.0' }));
    writeFileSync(join(root, 'user/demo/index.js'), "window.__webmcpRegister({tools:[{name:'demo.obsolete'}]})");
    const toolkit = join(root, 'legacy-toolkit/demo'); mkdirSync(toolkit, { recursive: true });
    writeFileSync(join(toolkit, 'manifest.json'), '{invalid stale toolkit');
    expect(JSON.parse(success(['adapter', 'list', '--json'])).filter((entry) => entry.id === 'demo')).toHaveLength(1);
    selectAdapter('demo', 'disabled');
    expect(JSON.parse(success(['adapter', 'list', '--json'])).some((entry) => entry.id === 'demo')).toBe(false);
    expect(run(['adapter', 'info', 'demo']).status).toBe(1);
    selectAdapter('demo', 'user');
    writeFileSync(join(installed.executionRoot, 'extension/commands/list.js'), 'tampered');
    expect(run(['adapter', 'skill', 'demo']).status).toBe(1);
    expect(JSON.parse(success(['adapter', 'remove', 'demo'])).action).toBe('removed');
    expect(JSON.parse(success(['adapter', 'list', '--json'])).some((entry) => entry.id === 'demo')).toBe(false);
    expect(() => managedAdapterView('demo')).toThrow(/unavailable/);
  });

  it('installs locally, selects development and removes only the managed user version', () => {
    const directory = join(root, 'draft/demo'); writePackageDirectory(directory, files());
    expect(JSON.parse(success(['adapter', 'install', '--directory', directory])).active).toBe(true);
    expect(managedAdapterView('demo').source).toBe('user');
    success(['adapter', 'develop', directory]);
    expect(managedAdapterView('demo').source).toBe('development');
    success(['adapter', 'use', 'demo', 'disabled']);
    success(['adapter', 'remove', 'demo']);
    expect(existsSync(join(directory, 'manifest.json'))).toBe(true);
    expect(run(['adapter', 'remove', 'demo']).status).toBe(1);
    expect(run(['adapter', 'install', '--directory', directory, '--force']).status).toBe(1);
  });

  it('removal restores the built-in package without editing either source', () => {
    const builtin = join(root, 'builtin/demo'); writePackageDirectory(builtin, files());
    install('1.1.0', 'new');
    success(['adapter', 'remove', 'demo']);
    expect(managedAdapterView('demo')).toMatchObject({ version: '1.0.0', source: 'builtin' });
    expect(run(['adapter', 'remove', 'demo']).status).toBe(1);
    expect(readPackageDirectory(builtin).manifest.version).toBe('1.0.0');
  });

  it('requires explicit permission changes and refuses legacy overwrite of managed packages', () => {
    install();
    const directory = join(root, 'draft/demo'); writePackageDirectory(directory, files('1.1.0', 'changed'));
    expect(run(['adapter', 'install', '--directory', directory]).status).toBe(1);
    expect(managedAdapterView('demo').version).toBe('1.0.0');
    success(['adapter', 'install', '--directory', directory, '--allow-permission-change']);
    expect(managedAdapterView('demo').version).toBe('1.1.0');
    const legacy = join(root, 'legacy.js'); writeFileSync(legacy, 'fixture');
    expect(run(['adapter', 'install', '--file', legacy, '--name', 'demo']).status).toBe(1);
    expect(managedAdapterView('demo').version).toBe('1.1.0');
    expect(run(['adapter', 'knowledge', 'demo']).status).toBe(1);
  });

  it('updates manually disabled generated Skills without enabling them', () => {
    install(); sync();
    const file = join(target, 'webcli-demo/SKILL.md');
    renameSync(file, file + '.disabled');
    install('1.1.0', 'changed'); sync();
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(file + '.disabled', 'utf8')).toContain('webcli call demo.changed');
    selectAdapter('demo', 'disabled'); expect(sync().retired).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(file + '.disabled', 'utf8')).not.toContain('webcli call');
  });

  it('refreshes only owned Skills, retires disabled/removed commands and restores on enable', () => {
    install(); expect(sync().installed).toBe(1);
    expect(skill()).toContain('webcli call demo.list');
    install('1.1.0', 'changed'); expect(sync().installed).toBe(1);
    expect(skill()).toContain('webcli call demo.changed');
    expect(skill()).not.toContain('webcli call demo.list');
    selectAdapter('demo', 'disabled'); expect(sync().retired).toBe(1);
    expect(skill()).not.toContain('webcli call');
    selectAdapter('demo', 'user'); expect(sync().installed).toBe(1);
    removeInstalledAdapter('demo'); expect(sync().retired).toBe(1);
    expect(skill()).not.toContain('webcli call');
  });

  it('preserves user-authored, user-edited and other-profile Skills', () => {
    install();
    mkdirSync(join(target, 'webcli-demo'), { recursive: true });
    writeFileSync(join(target, 'webcli-demo/SKILL.md'), 'User-owned fixture');
    expect(sync().preserved).toEqual(['demo']); expect(skill()).toBe('User-owned fixture');
    const otherTarget = join(root, 'generated');
    syncManagedAdapterSkills({ target: otherTarget, snapshot: managedAdapterViews(), profile: 'public' });
    const file = join(otherTarget, 'webcli-demo/SKILL.md');
    const original = readFileSync(file, 'utf8');
    expect(syncManagedAdapterSkills({ target: otherTarget, snapshot: managedAdapterViews(), profile: 'custom' }).preserved).toEqual(['demo']);
    expect(readFileSync(file, 'utf8')).toBe(original);
    writeFileSync(file, original + 'User edit');
    expect(syncManagedAdapterSkills({ target: otherTarget, snapshot: managedAdapterViews(), profile: 'public' }).preserved).toEqual(['demo']);
    expect(readFileSync(file, 'utf8')).toBe(original + 'User edit');
  });

  it('rejects linked Skill directories before writing outside the selected target', () => {
    install(); mkdirSync(target); const outside = join(root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(target, 'webcli-demo'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => sync()).toThrow(/directory/);
    expect(existsSync(join(outside, 'SKILL.md'))).toBe(false);
  });

  it('installs derived Skills through the actual installer and replaces legacy managed names without touching unknown custom names', () => {
    install();
    mkdirSync(join(target, 'webcli-demo'), { recursive: true });
    writeFileSync(join(target, 'webcli-demo/SKILL.md'), 'legacy generated Skill');
    mkdirSync(join(target, 'webcli-user-custom'), { recursive: true });
    writeFileSync(join(target, 'webcli-user-custom/SKILL.md'), 'custom Skill must remain');
    writeFileSync(join(target, 'webcli-user-custom/.weworker-custom-skill.json'), '{"kind":"custom"}');
    success(['install', '--skills', 'demo', '--target', target]);
    expect(skill()).toContain('webcli call demo.list');
    expect(skill()).not.toContain('legacy generated Skill');
    expect(readFileSync(join(target, 'webcli-user-custom/SKILL.md'), 'utf8')).toBe('custom Skill must remain');
    install('1.1.0', 'changed');
    success(['install', '--skills', 'demo', '--target', target]);
    expect(skill()).toContain('webcli call demo.changed');
    selectAdapter('demo', 'disabled');
    success(['install', '--skills', 'demo', '--target', target]);
    expect(skill()).not.toContain('webcli call');
  });

  it('replaces reserved bundled webcli Skills during installation', () => {
    mkdirSync(join(target, 'webcli'), { recursive: true });
    writeFileSync(join(target, 'webcli/SKILL.md'), 'legacy bundled Skill');
    writeFileSync(join(target, 'webcli/SKILL.md.disabled'), 'disabled legacy bundled Skill');
    success(['install', '--skills', '--target', target]);
    expect(readFileSync(join(target, 'webcli/SKILL.md'), 'utf8')).not.toContain('legacy bundled Skill');
    expect(existsSync(join(target, 'webcli/SKILL.md.disabled'))).toBe(false);
  });

  it('rejects a broken registry instead of exposing a stale Skill or legacy catalog', () => {
    install(); sync();
    writeFileSync(join(root, 'data/adapter-state/public/registry.json'), '{invalid');
    expect(() => sync()).toThrow(/inspection/);
    expect(run(['adapter', 'list', '--json']).status).toBe(1);
    expect(run(['adapter', 'skill', 'demo']).status).toBe(1);
  });
});

it('derives Ctrip entity mapping and workflows from the actual versioned package', () => {
  const packageRoot = fileURLToPath(new URL('../../adapters/ctrip.com/', import.meta.url));
  installAdapter({ files: readPackageDirectory(packageRoot).files, origin: { kind: 'local' } });
  const view = managedAdapterView('ctrip.com');
  const output = managedAdapterSkill(view);
  expect(output).toContain('destination-search');
  expect(output).toContain('destinationId=33、hotelCityId=38');
  expect(output).toContain('webcli call ctrip.com.attraction');
  expect(output).toContain('一次调用中完成');
  expect(view.tools.find(tool => tool.id === 'attraction').params.find(param => param.name === 'city').description).toContain('destination-search.destinationId');
});
