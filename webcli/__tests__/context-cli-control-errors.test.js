import { expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

it.each([
  [['route', '--context', '../unsafe', 'Search'], 'context_invalid_id'],
  [['route', '--context', 'example', '--new-context', 'Search'], 'context_invalid_flag'],
  [['call', 'example.com.list', '--context', 'example', '--step', 's1'], 'context_invalid_association'],
])('the actual CLI preserves usage exit codes before storage or dispatch: %j', async (args, code) => {
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve('index.js'), ...args], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
    child.once('error', reject); child.once('close', exitCode => done({ exitCode, stdout, stderr }));
  });
  expect(result.exitCode, result.stderr).toBe(2); expect(result.stdout).toBe(''); expect(result.stderr).toContain(code);
});


it('actual CLI help exposes automatic context creation, maintenance and context-aware routing', () => {
  const run = args => {
    const result = spawnSync(process.execPath, [resolve('index.js'), ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.status, result.stderr).toBe(0); return result.stdout;
  };
  const text = run(['--help']);
  for (const flag of ['--new-context', '--context <id>', 'context status', 'context recover', 'context prune --dry-run']) expect(text).toContain(flag);
  const json = JSON.parse(run(['--help', '--output-format=json']));
  expect(json.commands.find(c => c.name === 'call <tool>').usage).toContain('--new-context');
  expect(json.commands.find(c => c.name === 'context').usage).toContain('prune --dry-run');
  expect(run(['route', '--help'])).toContain('With context, bind declared actions');
});
