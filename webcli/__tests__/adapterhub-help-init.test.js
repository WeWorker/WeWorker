import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../adapterhub-credentials.js', () => ({
  adapterHubCredentialStatus: vi.fn(async () => ({ configured: true, source: 'windows-dpapi' })),
  loadAdapterHubToken: vi.fn(async () => ({ token: '', source: 'none' })),
  readHiddenToken: vi.fn(async () => 'ahp_interactivepromptoken00'),
  removeAdapterHubToken: vi.fn(async () => true),
  saveAdapterHubToken: vi.fn(async () => '/tmp/credentials/adapterhub-token.dpapi'),
}));

import { runAdapterHubCli } from '../adapterhub-cli.js';
import { readHiddenToken, saveAdapterHubToken } from '../adapterhub-credentials.js';

const entry = fileURLToPath(new URL('../index.js', import.meta.url));
const run = (args, env = {}) => spawnSync(process.execPath, [entry, 'adapterhub', ...args], {
  encoding: 'utf8',
  env: { ...process.env, WEBCLI_ADAPTERHUB_ENDPOINT: '', ...env },
});

async function withCapturedConsole(runner) {
  const logs = { out: [], err: [] };
  const original = { log: console.log, error: console.error };
  console.log = value => logs.out.push(value);
  console.error = value => logs.err.push(value);
  try {
    return { result: await runner(), logs };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  process.exitCode = undefined;
});

describe('help 不依赖 AdapterHub 端点', () => {
  it('端点为空时 --help 仍以退出码 0 输出用法', () => {
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain('webcli adapterhub');
    expect(help.stdout).toContain('用法');
    expect(help.stdout).not.toContain('端点为空');
  });

  it('端点为空时 --json 用法输出仍可用（endpoint 允许为 null）', () => {
    const usage = run(['--help', '--json']);
    expect(usage.status).toBe(0);
    expect(usage.stderr).toBe('');
    const payload = JSON.parse(usage.stdout);
    expect(payload.commands).toContain('install');
    expect('endpoint' in payload).toBe(true);
    expect(payload.endpoint === null || typeof payload.endpoint === 'string').toBe(true);
  });
});

describe('init 支持非交互式 PAT', () => {
  it('位置参数直接保存，不触发交互输入', async () => {
    const { logs } = await withCapturedConsole(() => runAdapterHubCli(['init', 'ahp_positionaltoken000000']));
    expect(saveAdapterHubToken).toHaveBeenCalledExactlyOnceWith('ahp_positionaltoken000000');
    expect(readHiddenToken).not.toHaveBeenCalled();
    expect(logs.out.join('\n')).toContain('DPAPI');
  });

  it('省略位置参数时保持交互输入', async () => {
    await withCapturedConsole(() => runAdapterHubCli(['init']));
    expect(readHiddenToken).toHaveBeenCalledOnce();
    expect(saveAdapterHubToken).toHaveBeenCalledExactlyOnceWith('ahp_interactivepromptoken00');
  });

  it('格式非法的 PAT 报参数错误且不落盘', async () => {
    const { logs } = await withCapturedConsole(() => runAdapterHubCli(['init', 'not-a-token']));
    expect(saveAdapterHubToken).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(logs.err.join('\n')).toContain('PAT 格式无效');
  });
});

(process.platform === 'win32' ? it : it.skip)('init 位置参数真实写入 DPAPI 凭据文件（Windows）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapterhub-init-'));
  try {
    const credentialFile = join(dir, 'adapterhub-token.dpapi');
    const output = run(['init', 'ahp_localdpapitoken000000'], { WEBCLI_ADAPTERHUB_CREDENTIAL_FILE: credentialFile });
    expect(output.status).toBe(0);
    expect(existsSync(credentialFile)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
