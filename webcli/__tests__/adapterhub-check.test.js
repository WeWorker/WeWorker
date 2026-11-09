import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../adapterhub-client.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveEndpoint: () => 'https://example.com/hub',
  listAdapters: vi.fn(async () => ({
    total: 5,
    items: [
      { name: 'a.example.com', version: '1.0.0', origin: 'official', installable: true },
      { name: 'b.example.com', version: '2.0.0', origin: 'official', installable: true },
      { name: 'c.example.com', version: '1.0.0', origin: 'official', installable: true },
      { name: 'd.example.com', version: '0.0.0', origin: 'official', installable: false },
      // e.example.com 不在 Hub：已下架
    ],
  })),
}));

import { runAdapterHubCli } from '../adapterhub-cli.js';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'adapterhub-check-'));
  const builtinDir = join(root, 'builtin-adapters');
  const userDir = join(root, 'user-adapters');
  mkdirSync(userDir, { recursive: true });
  // 内置：a 最新、b 可更新、c 已下架场景之外再补一个本地更新
  for (const [name, version] of [['a.example.com', '1.0.0'], ['b.example.com', '1.0.0'], ['e.example.com', '1.0.0'], ['f.example.com', '3.0.0']]) {
    mkdirSync(join(builtinDir, name), { recursive: true });
    writeFileSync(join(builtinDir, name, 'manifest.json'), JSON.stringify({ name, version }));
  }
  return { root, builtinDir, userDir };
}

async function runCommand(env, args) {
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

it('check 覆盖全部分类：可更新/已最新/本地更新/已下架/暂无制品', async () => {
  const { root, builtinDir, userDir } = makeFixture();
  try {
    const output = await runCommand(
      { WEWORKER_BUILTIN_ADAPTERS_DIR: builtinDir, WEBCLI_ADAPTERS_DIR: userDir },
      ['check'],
    );
    const text = output.out.join('\n');
    expect(text).toContain('本地 4 个');
    expect(text).toContain('↑ b.example.com');                      // hub 2.0.0 > 内置 1.0.0
    expect(text).toContain('install b.example.com');                // 内置可更新提示 install
    expect(text).toContain('a.example.com');                        // 已最新
    expect(text).toContain('f.example.com');                        // 本地更新（hub 无此名 → 已下架？f 不在 hub → delisted）
    expect(text).toContain('× e.example.com');                      // hub 无条目 → 已下架
    expect(text).toContain('可更新 1');
    expect(output.err).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('check --json 输出 summary 与逐条 action', async () => {
  const { root, builtinDir, userDir } = makeFixture();
  try {
    const output = await runCommand(
      { WEWORKER_BUILTIN_ADAPTERS_DIR: builtinDir, WEBCLI_ADAPTERS_DIR: userDir },
      ['check', '--json'],
    );
    const payload = output.json();
    expect(payload.summary.local).toBe(4);
    expect(payload.summary['update-available']).toBe(1);
    expect(payload.summary.delisted).toBeGreaterThanOrEqual(1);
    const byName = Object.fromEntries(payload.items.map((item) => [item.name, item]));
    expect(byName['b.example.com'].action).toBe('update-available');
    expect(byName['b.example.com'].source).toBe('builtin');
    expect(byName['a.example.com'].action).toBe('up-to-date');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
