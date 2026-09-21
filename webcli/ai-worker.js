import { callConfiguredLanguageModel } from './ai-analyzer.js';
import readline from 'node:readline';
import { modelOutputErrorDetails } from './generation-harness/model-output-policy.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function runAiCallWorker() {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw || '{}');
    const result = await callConfiguredLanguageModel({
      prompt: input.prompt,
      maxTokens: input.maxTokens,
      purpose: input.purpose,
      taskLabel: input.taskLabel,
      config: input.config,
    });
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: error?.message || String(error),
      code: error?.code || 'AI_WORKER_REQUEST_FAILED',
      ...(error?.code === 'MODEL_OUTPUT_LIMIT_EXCEEDED' ? { details: modelOutputErrorDetails(error.details) } : {}),
    }));
  }
}

export async function runAiSessionWorker() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!String(line || '').trim()) continue;
    let id = '';
    try {
      const input = JSON.parse(line);
      id = String(input.id || '');
      const result = await callConfiguredLanguageModel({
        prompt: input.prompt,
        maxTokens: input.maxTokens,
        purpose: input.purpose,
        taskLabel: input.taskLabel,
        config: input.config,
      });
      process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        id,
        ok: false,
        error: error?.message || String(error),
        code: error?.code || 'AI_WORKER_REQUEST_FAILED',
        ...(error?.code === 'MODEL_OUTPUT_LIMIT_EXCEEDED' ? { details: modelOutputErrorDetails(error.details) } : {}),
      })}\n`);
    }
  }
}
