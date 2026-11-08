import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
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
