import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runLanguageModelWorker, shouldRunLanguageModelDirect } from '../ai-analyzer.js';
import { LanguageModelWorkerSession } from '../ai-worker-session.js';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runInternalWorker(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoDir, 'index.js'), 'internal-ai-call'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WEBCLI_AI_WORKER: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe('AI worker process isolation', () => {
  it('kills only the owned model worker on abort and uses a fresh worker for the next request', async () => {
    const session = new LanguageModelWorkerSession({ workerScript: path.join(repoDir, '__tests__/fixtures/ai-session-worker.mjs') });
    const controller = new AbortController();
    try {
      const first = await session.call({ prompt: 'first' });
      const pending = session.call({ prompt: 'late', config: { delayMs: 5000 }, signal: controller.signal, retryOnCrash: false });
      controller.abort(new DOMException('cancel fixture', 'AbortError'));
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      const next = await session.call({ prompt: 'next' });
      expect(next.text).toBe('reply:next');
      expect(next.pid).not.toBe(first.pid);
    } finally { await session.close(); }
  });

  it('does not spawn on an already aborted call', async () => {
    const session = new LanguageModelWorkerSession({ workerScript: path.join(repoDir, '__tests__/fixtures/ai-session-worker.mjs') });
    const controller = new AbortController(); controller.abort();
    await expect(session.call({ prompt: 'unused', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.session).toBe(null);
  });
  it('does not create additional one-shot AI processes for Harness fallback calls', () => {
    expect(shouldRunLanguageModelDirect({ WEBCLI_GENERATION_WORKER: '1' })).toBe(true);
    expect(shouldRunLanguageModelDirect({ WEBCLI_AI_DIRECT: '1' })).toBe(true);
    expect(shouldRunLanguageModelDirect({})).toBe(false);
  });

  it('returns configured model errors without crashing the process', async () => {
    const result = await runInternalWorker({
      prompt: 'test',
      maxTokens: 10,
      taskLabel: 'worker validation test',
      config: {
        provider: 'custom',
        protocol: 'anthropic',
        base_url: 'https://example.invalid',
        model: 'test-model',
        api_key: '',
      },
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  });

  it('turns a non-zero worker exit into a normal AI_WORKER_CRASHED error', async () => {
    const workerScript = path.join(repoDir, '__tests__/fixtures/ai-worker-exit.mjs');
    await expect(runLanguageModelWorker({
      prompt: 'test',
      config: {},
      maxTokens: 10,
      taskLabel: 'worker crash test',
      workerScript,
    })).rejects.toMatchObject({ code: 'AI_WORKER_CRASHED' });
  });

  it('reuses one persistent AI subprocess across Harness loop steps', async () => {
    const session = new LanguageModelWorkerSession({
      workerScript: path.join(repoDir, '__tests__/fixtures/ai-session-worker.mjs'),
    });
    const first = await session.call({ prompt: 'one', taskLabel: 'step 1' });
    const second = await session.call({ prompt: 'two', taskLabel: 'step 2' });
    await session.close();

    expect(first.text).toBe('reply:one');
    expect(second.text).toBe('reply:two');
    expect(second.pid).toBe(first.pid);
  });

  it('restarts the persistent AI subprocess once after a native-style exit', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-ai-session-'));
    const marker = path.join(tempDir, 'crashed-once');
    const session = new LanguageModelWorkerSession({
      workerScript: path.join(repoDir, '__tests__/fixtures/ai-session-worker.mjs'),
    });
    try {
      const result = await session.call({
        prompt: 'retry',
        taskLabel: 'retry step',
        config: { crashOnceMarker: marker },
      });
      expect(result.text).toBe('reply:retry');
    } finally {
      await session.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
