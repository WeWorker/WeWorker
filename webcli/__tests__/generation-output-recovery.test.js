import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { GenerationWorkerController } from '../generation-worker-controller.js';
import { GenerationRunStore } from '../generation-harness/run-store.js';

async function waitFor(predicate) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('fixture did not reach expected state');
}

it('real generation worker preserves run identity and acknowledges resume before the model finishes', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-output-recovery-'));
  const store = new GenerationRunStore({ rootDir });
  const limits = [];
  let heldResponse;
  const reply = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { completion_tokens: 1024 } }));
  };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    limits.push(JSON.parse(raw).max_tokens);
    if (limits.length === 2) heldResponse = res;
    else reply(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const controller = new GenerationWorkerController({
    store, workerScript: path.resolve(import.meta.dirname, '../index.js'), reportDir: path.join(rootDir, 'reports'),
    requestExtension: async () => { throw new Error('fixture must not touch a browser'); },
  });
  let runId;
  const sessions = [];
  try {
    const modelConfig = { provider: 'custom', protocol: 'openai', base_url: `http://127.0.0.1:${server.address().port}`, model: 'fixture-model', api_key: 'fake-test-key', max_output_tokens: 1024 };
    const started = await controller.start({
      siteKey: 'example.test', goal: 'fixture query tools',
      input: { mode: 'agent', memory: {
        siteKey: 'example.test', siteHost: 'example.test', siteOrigin: 'https://example.test',
        listApiCandidates: [{ method: 'GET', url: 'https://example.test/api/list' }], actionApiCandidates: [],
      } },
    }, { modelConfig });
    runId = started.id;
    const initialSession = controller.activeWorkers.get(runId);
    if (initialSession) sessions.push(initialSession);
    const paused = await waitFor(() => {
      const run = controller.get(runId);
      return !controller.activeWorkers.has(runId) && run?.status === 'needs_user_input' && run;
    });
    expect(paused.artifacts.pendingQuestion).toMatchObject({ code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', outputLimit: 1024 });
    expect(paused.modelCallCount).toBe(1);
    // The response is deliberately held until AFTER resume returns. A controller
    // waiting for completion instead of acknowledgement would deadlock this test.
    const resumed = await controller.resume(runId, '已调整额度', { modelConfig: { ...modelConfig, max_output_tokens: 4096 } });
    expect(resumed.id).toBe(runId);
    expect(resumed.status).toBe('planning');
    const resumedSession = controller.activeWorkers.get(runId);
    expect(resumedSession).toBeTruthy();
    sessions.push(resumedSession);
    // A delayed close notification from the previous worker must not remove
    // the newly resumed worker for the same run ID.
    if (initialSession) initialSession.child.emit('close', 0, null);
    expect(controller.activeWorkers.get(runId)).toBe(resumedSession);
    await waitFor(() => heldResponse);
    reply(heldResponse);
    const pausedAgain = await waitFor(() => {
      const run = controller.get(runId);
      return !controller.activeWorkers.has(runId) && run?.status === 'needs_user_input' && run;
    });
    expect(limits).toEqual([1024, 4096]);
    expect(pausedAgain.modelCallCount).toBe(2);
    expect(pausedAgain.artifacts.pendingQuestion.outputLimit).toBe(4096);
    expect(JSON.stringify(store.load(runId))).not.toContain('fake-test-key');
  } finally {
    if (heldResponse && !heldResponse.writableEnded) reply(heldResponse);
    if (runId && controller.activeWorkers.has(runId)) {
      await controller.cancel(runId, 'fixture cleanup');
      await waitFor(() => !controller.activeWorkers.has(runId));
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.all(sessions.map((session) => session.closedSignal.promise));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}, 20000);
