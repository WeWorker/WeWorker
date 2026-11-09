import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../adapterhub-client.js', () => ({
  resolveEndpoint: () => 'https://example.com/hub',
  listAdapters: vi.fn(async () => ({
    total: 3,
    items: [
      { name: 'a.example.com', display: 'A 站点', version: '1.0.0', origin: 'official' },
      { name: 'b.example.com', display: 'B 站点', version: '1.0.0', origin: 'official' },
      { name: 'c.example.com', display: 'C 站点', version: '1.0.0', origin: 'user' },
    ],
  })),
}));

import { runAdapterHubCli } from '../adapterhub-cli.js';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'adapterhub-list-'));
  const builtinDir = join(root, 'builtin-adapters');
  const userDir = join(root, 'user-adapters');
  mkdirSync(userDir, { recursive: true });
  for (const name of ['a.example.com']) {
    mkdirSync(join(builtinDir, name), { recursive: true });
    writeFileSync(join(builtinDir, name, 'manifest.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
  return { root, builtinDir, userDir };
}

async function runList(env, args) {
  const logs = { out: [], err: [] };
  const original = { log: console.log, error: console.error };
  console.log = value => logs.out.push(value);
  console.error = value => logs.err.push(value);
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    await runAdapterHubCli(args);
    return { ...logs, json: () => JSON.parse(logs.out.join('\n')) };
  } finally {
    console.log = original.log;
    console.error = original.error;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

afterEach(() => {
  process.exitCode = undefined;
});

it('list 默认全部并标记未安装', async () => {
  const { root, builtinDir, userDir } = makeFixture();
  try {
    const output = await runList(
      { WEWORKER_BUILTIN_ADAPTERS_DIR: builtinDir, WEBCLI_ADAPTERS_DIR: userDir },
      ['list'],
    );
    const text = output.out.join('\n');
    expect(text).toContain('共 3 个，未安装 2 个');
    expect(text).toContain('a.example.com');
    expect(text).not.toContain('a.example.com        A 站点 v1.0.0 [未安装]'); // 已装不带标记
    expect(text).toContain('b.example.com');
    expect(output.err).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('list --installed 仅看已装，--installed=false 仅看未装', async () => {
  const { root, builtinDir, userDir } = makeFixture();
  try {
    const env = { WEWORKER_BUILTIN_ADAPTERS_DIR: builtinDir, WEBCLI_ADAPTERS_DIR: userDir };
    const installed = await runList(env, ['list', '--installed']);
    const text = installed.out.join('\n');
    expect(text).toContain('已安装 1 个');
    expect(text).toContain('a.example.com');
    expect(text).not.toContain('b.example.com');

    const missing = await runList(env, ['list', '--installed=false']);
    const missingText = missing.out.join('\n');
    expect(missingText).toContain('未安装 2 个');
    expect(missingText).toContain('c.example.com');
    expect(missingText).not.toContain('a.example.com');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('list --installed --json 输出过滤后的 items', async () => {
  const { root, builtinDir, userDir } = makeFixture();
  try {
    const output = await runList(
      { WEWORKER_BUILTIN_ADAPTERS_DIR: builtinDir, WEBCLI_ADAPTERS_DIR: userDir },
      ['list', '--installed', '--json'],
    );
    const payload = output.json();
    expect(payload.total).toBe(3);
    expect(payload.installedFilter).toBe('true');
    expect(payload.items.map((item) => item.name)).toEqual(['a.example.com']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
