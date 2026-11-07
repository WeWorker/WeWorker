import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { callDevelopment } from '../development-client.js';
import { developmentHelp, developmentCommands } from '../development-commands.js';
import { extractFlagArgs } from '../index.js';
import { listBundledSkills, readBundledSkill } from '../skills-cli.js';
import { completionCandidates } from '../completion.js';

const env = { WEWORKER_EXPLORATION_INSTANCE_ID: 'test-instance-placeholder' };
const args = { toolkit_id: 'demo', tool_id: 'read_title' };
const health = () => new Response(JSON.stringify({ instance_id: env.WEWORKER_EXPLORATION_INSTANCE_ID,
  runtime: 'local_browser.local_cdp', capabilities: { development_commands: true } }));
const result = command => ({ schemaVersion: 1, command: `development.${command}`, ok: true, data: { revision: 1 } });

describe('development CLI', () => {
  it('preserves nested schemas, source quoting, unicode and newlines through --args', () => {
    const value = { code: 'async def read_title(ctx):\n    return {"标题": "a\\b"}',
      parameters_schema: { type: 'object', properties: {}, additionalProperties: false },
      result_schema: { type: 'object', properties: { count: { type: 'integer' } } }, expected_revision: 0 };
    expect(extractFlagArgs(['--args', JSON.stringify(value)]).args).toEqual(value);
  });
  it('help is offline, machine-readable and packaged with the inline skill', () => {
    const output = spawnSync(process.execPath, ['index.js', 'call', 'development.help'], { encoding: 'utf8' });
    expect(output.status, output.stderr).toBe(0);
    expect(JSON.parse(output.stdout).model).toBe('calling-agent');
    expect(developmentHelp().commands.map(item => item.name)).toContain('development.save');
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    for (const path of ['development-commands.js', 'development-client.js', 'development-install-client.js', 'skills/']) expect(pkg.files).toContain(path);
    const skill = fs.readFileSync(new URL('../skills/adapter-development/SKILL.md', import.meta.url), 'utf8');
    expect(skill).not.toMatch(/webcli call development\.[\w-]+ --args(?:\s|=)/);
    expect(skill).toContain('expected_digest');
    expect(skill).not.toContain('webwright');
    expect(listBundledSkills().some(item => item.name === 'adapter-development')).toBe(true);
    expect(readBundledSkill('adapter-development').content).toBe(skill);
  });
  it.skipIf(process.platform !== 'win32')('passes the documented prepare and save arguments through PowerShell 5.1 and a cmd launcher', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'development skill '));
    try {
      // Stop at the CLI parser: inspect exactly what the handler would receive, without contacting a host.
      const parser = new URL('../index.js', import.meta.url).href;
      fs.writeFileSync(path.join(root, 'probe.mjs'),
        'import { extractFlagArgs } from ' + JSON.stringify(parser) + ';\n' +
        'console.log(JSON.stringify(extractFlagArgs(process.argv.slice(4)).args));');
      fs.writeFileSync(path.join(root, 'webcli.cmd'), '@echo off\r\n"' + process.execPath + '" "%~dp0probe.mjs" %*\r\n');
      const skill = readBundledSkill('adapter-development').content;
      const prepare = skill.match(/^\$prepared = webcli call development\.prepare .+$/m)[0];
      const save = skill.match(/^\$submission = @\{[\s\S]+?^\$saved = webcli call development\.save .+$/m)[0];
      const script = [
        "$ErrorActionPreference = 'Stop'", '[Console]::OutputEncoding = [Text.UTF8Encoding]::new()',
        "$env:Path = (Get-Location).Path + ';' + $env:Path",
        "$selected = @(@{id='example.com'; digest=('a' * 64)})", '$current = @{data=@{revision=3}}',
        prepare, save, '@{prepared=$prepared; saved=$saved} | ConvertTo-Json -Depth 20 -Compress',
      ].join('\n');
      const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const run = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')], { cwd: root, encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      const { prepared, saved } = JSON.parse(run.stdout);
      expect(prepared).toEqual({ adapter_id: 'example.com', expected_digest: 'a'.repeat(64) });
      expect(saved).toMatchObject({ expected_revision: 3, description: '读取当前页面标题',
        code: 'async def get_page_title(ctx):\n    return {"title": await ctx.page.title()}',
        parameters_schema: { required: [], additionalProperties: false } });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('requires trusted host identity before any network activity', async () => {
    const fetch = vi.fn();
    expect((await callDevelopment('inspect', args, { fetch, env: {} })).error.code).toBe('HOST_IDENTITY_REQUIRED');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not submit to unknown listeners or older services', async () => {
    for (const info of [{ instance_id: 'other' }, { instance_id: env.WEWORKER_EXPLORATION_INSTANCE_ID }]) {
      const fetch = vi.fn(async () => new Response(JSON.stringify(info)));
      expect((await callDevelopment('inspect', args, { fetch, env })).error.code).toBe('HOST_IDENTITY_MISMATCH');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('sends exact objects to a fixed endpoint with host identity and redirects disabled', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(health()).mockResolvedValueOnce(new Response(JSON.stringify(result('inspect'))));
    expect(await callDevelopment('inspect', args, { fetch, env })).toEqual(result('inspect'));
    const [url, options] = fetch.mock.calls[1];
    expect(url).toBe('http://127.0.0.1:8766/api/development/commands/inspect');
    expect(options.redirect).toBe('error');
    expect(options.headers['X-WeWorker-Exploration-Instance']).toBe(env.WEWORKER_EXPLORATION_INSTANCE_ID);
    expect(JSON.parse(options.body)).toEqual(args);
  });
  it('reports structured conflicts and never retries a submitted command', async () => {
    const conflict = { schemaVersion: 1, ok: false, command: 'development.inspect', error: { code: 'STALE_REVISION' } };
    const fetch = vi.fn().mockResolvedValueOnce(health()).mockResolvedValueOnce(new Response(JSON.stringify(conflict), { status: 409 }));
    expect(await callDevelopment('inspect', args, { fetch, env })).toEqual(conflict);
    expect(fetch).toHaveBeenCalledTimes(2);
    const broken = vi.fn().mockResolvedValueOnce(health()).mockRejectedValueOnce(new Error('secret transport detail'));
    const response = await callDevelopment('inspect', args, { fetch: broken, env });
    expect(response.error.code).toBe('OUTCOME_UNKNOWN');
    expect(response.error.message).not.toContain('secret');
    expect(broken).toHaveBeenCalledTimes(2);
  });
  it('rejects unknown or misspelled arguments without I/O', async () => {
    const fetch = vi.fn();
    expect((await callDevelopment('install', {}, { fetch, env })).error.code).toBe('UNKNOWN_COMMAND');
    expect((await callDevelopment('inspect', { ...args, endpoint: 'https://example.com' }, { fetch, env })).error.code).toBe('INVALID_ARGUMENT');
    expect(fetch).not.toHaveBeenCalled();
    expect(Object.hasOwn(developmentCommands, 'install')).toBe(false);
  });
  it('rejects mismatched response envelopes', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(health()).mockResolvedValueOnce(new Response(JSON.stringify(result('save'))));
    expect((await callDevelopment('inspect', args, { fetch, env })).error.code).toBe('INVALID_RESPONSE');
  });
});

it('discovers management commands without starting a browser', async () => {
  const values = await completionCandidates(['call', 'development.'], 2, { loadViews: async () => [] });
  expect(values).toContain('development.save');
  const output = spawnSync(process.execPath, ['index.js', 'call', 'development.save', '--help'], { encoding: 'utf8' });
  expect(output.status, output.stderr).toBe(0);
  expect(JSON.parse(output.stdout).namespace).toBe('development');
});

it('reaches Toolkit runtime validation without a confirmation gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'development-write-guard-'));
  const builtin = path.join(root, 'builtin');
  const adapter = path.join(builtin, 'example.com');
  const empty = path.join(root, 'empty');
  fs.mkdirSync(path.join(adapter, 'wewright', 'commands'), { recursive: true });
  fs.mkdirSync(empty);
  fs.writeFileSync(path.join(adapter, 'wewright', 'commands', 'submit.py'), '# public fixture\n');
  fs.writeFileSync(path.join(adapter, 'manifest.json'), JSON.stringify({ schema_version: 2, name: 'example.com',
    version: '1.0.0', description: 'Public fixture', runtime_allowed_hosts: ['example.com'], commands: [{
      id: 'submit', runtime: 'wewright', module: 'wewright/commands/submit.py', safety: 'write',
      description: 'Submit example', schema: { type: 'object', properties: {} },
    }] }));
  const output = spawnSync(process.execPath, ['index.js', 'call', 'example.com.submit', '--args', '{}', '--output-format=json'], {
    encoding: 'utf8', env: { ...process.env, WEWORKER_RESOURCES_PATH: '',
      WEWORKER_ADAPTERS_DIR: empty, WEBCLI_ADAPTERS_DIR: empty, WEWORKER_USER_ADAPTERS_DIR: empty,
      WEWORKER_BUILTIN_ADAPTERS_DIR: builtin, WEWORKER_ADAPTER_DATA_DIR: path.join(root, 'data'),
      WEWORKER_BUILD_PROFILE: 'public', WEWORKER_TOOLKIT_RUNTIME: path.join(root, 'must-not-start'), WEBCLI_METRICS_UPLOAD: 'off' },
  });
  expect(output.status, output.stderr).toBe(1);
  expect(JSON.parse(output.stdout).error).toMatch(/runtime|Runtime/);
  expect(output.stdout).not.toContain('CONFIRMATION_REQUIRED');
});
it('discovers target-resolution commands and lists workspaces without a preselected target', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(health()).mockResolvedValueOnce(Response.json({ schemaVersion: 1, command: 'development.list', ok: true, data: { workspaces: [] } }));
  expect(await callDevelopment('list', {}, { fetch, env })).toMatchObject({ ok: true, data: { workspaces: [] } });
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({});
  expect(developmentHelp().commands.map(command => command.name)).toEqual(expect.arrayContaining(['development.list', 'development.prepare']));
  const values = await completionCandidates(['call', 'development.'], 2, { loadViews: async () => [] });
  expect(values).toEqual(expect.arrayContaining(['development.list', 'development.prepare']));
});
