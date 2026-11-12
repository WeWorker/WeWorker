import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const entry = fileURLToPath(new URL('../index.js', import.meta.url));
const run = args => spawnSync(process.execPath, [entry, 'adapterhub', ...args], {
  encoding: 'utf8', env: { ...process.env, WEBCLI_ADAPTERHUB_ENDPOINT: 'https://example.com/hub' },
});
it('routes explicit formats and preserves default JSON output without requests', () => {
  const legacy = run(['status', '--json']);
  expect(legacy.status).toBe(0);
  expect(JSON.parse(legacy.stdout)).toHaveProperty('configured');
  for (const format of ['json', 'yaml', 'csv', 'table', 'plain', 'markdown']) {
    const output = run(['status', '--output-format=' + format]);
    expect(output.status).toBe(0); expect(output.stderr).toBe('');
  }
  expect(JSON.parse(run(['--help', '--output-format=json']).stdout).commands).toContain('install');
});
it('invalid formats cannot reach writes and explicit failures preserve exit categories', () => {
  const invalid = run(['install', 'example', '--output-format=invalid']);
  expect(invalid.status).toBe(2); expect(invalid.stdout).toBe('');
  expect(invalid.stderr).toContain('不支持的输出格式');
  for (const command of ['toString', '__proto__', 'unknown']) {
    const output = run([command, '--output-format=json']);
    expect(output.status).toBe(2); expect(JSON.parse(output.stdout).code).toBe('USAGE_ERROR');
  }
  const missing = run(['validate', '/example-missing-package.adapt', '--output-format=json']);
  expect(missing.status).toBe(1); expect(JSON.parse(missing.stdout).code).toBe('ADAPTERHUB_ERROR');
  const usage = run(['install', '--unknown', '--output-format=yaml']);
  expect(usage.status).toBe(2); expect(usage.stdout).toContain('USAGE_ERROR');
});
