import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdapterHubCli } from '../adapterhub-cli.js';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'adapterhub-installed-'));
  const builtinDir = join(root, 'builtin-adapters');
  const userDir = join(root, 'user-adapters');
  mkdirSync(userDir, { recursive: true });
  for (const name of ['a.example.com', 'b.example.com']) {
    mkdirSync(join(builtinDir, name), { recursive: true });
    writeFileSync(join(builtinDir, name, 'manifest.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
  // 一个缺 manifest 的目录不应计入
  mkdirSync(join(builtinDir, 'broken.example.com'), { recursive: true });
  return { root, builtinDir, userDir };
}

async function withCapturedOutput(env, run) {
  const logs = { out: [], err: [] };
  const original = { log: console.log, error: console.error, env: { ...env } };
  console.log = value => logs.out.push(value);
  console.error = value => logs.err.push(value);
  const saved = {};
  for (const key of Object.keys(original.env)) {
    saved[key] = process.env[key];
    process.env[key] = original.env[key];
  }
  try {
    await runAdapterHubCli(run);
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

it('installed 把打包内置 Adapter 计入并标记来源', async () => {
  const { root, builtinDir, userDir } = makeFixture();
  try {
    const output = await withCapturedOutput(
      { WEWORKER_BUILTIN_ADAPTERS_DIR: builtinDir, WEBCLI_ADAPTERS_DIR: userDir },
      ['installed'],
    );
    const text = output.out.join('\n');
    expect(text).toContain('本地 Adapter 2 个（内置 2 · 自装 0）');
    expect(text).toContain('a.example.com');
    expect(text).toContain('[内置]');
    expect(text).not.toContain('broken.example.com');
    expect(output.err).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('installed --json 输出 source 与分组计数', async () => {
  const { root, builtinDir, userDir } = makeFixture();
  try {
    const output = await withCapturedOutput(
      { WEWORKER_BUILTIN_ADAPTERS_DIR: builtinDir, WEBCLI_ADAPTERS_DIR: userDir },
      ['installed', '--json'],
    );
    const payload = output.json();
    expect(payload.total).toBe(2);
    expect(payload.builtin).toBe(2);
    expect(payload.installed).toBe(0);
    expect(payload.items.map((item) => item.source)).toEqual(['builtin', 'builtin']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('无内置目录且无自装时 installed 为空且不报错', async () => {
  const { root, userDir } = makeFixture();
  try {
    const output = await withCapturedOutput(
      { WEWORKER_BUILTIN_ADAPTERS_DIR: join(root, 'missing'), WEBCLI_ADAPTERS_DIR: userDir },
      ['installed'],
    );
    expect(output.out.join('\n')).toContain('本地 Adapter 0 个（内置 0 · 自装 0）');
    expect(output.err).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
