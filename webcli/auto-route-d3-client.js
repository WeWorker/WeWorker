/** Configurable System One classification client. */
import { decisionServiceUrl } from './decision-service-config.js';
import { runtimeConfig as config } from './runtime-config.js';
import { loadDecisionApiKey } from './decision-api-key.js';
export function d3Url() {
  return decisionServiceUrl(process.env.WEBCLI_D3_URL || config.d3Url, 'WEBCLI_D3_URL');
}
export async function d3Predict(state, questions, opts = {}) {

  const answers = {};
  let apiKey;
  let serverModel;
  const model = process.env.WEBCLI_D3_MODEL ?? config.model;
  if (model != null && typeof model !== 'string') throw new Error('WEBCLI_D3_MODEL must be a string.');
  // Serialize questions to avoid unnecessary concurrent service load.
  for (const [id, question] of Object.entries(questions)) {
    const entries = Object.entries(question.criteria || {});
    if (!entries.length) throw new Error('Decision service choice 缺少候选');
    if (entries.length === 1) {
      answers[id] = { type: 'choice', choice: entries[0][0], probabilities: { [entries[0][0]]: 1 }, confidence: 1 };
      continue;
    }
    apiKey ||= await loadDecisionApiKey({ defaultKey: config.apiKey, optional: config.apiKey === undefined && !process.env.DECISION_API_KEY?.trim() });
    const remaining = Math.min(10_000, (opts.deadline ?? Date.now() + 10_000) - Date.now());
    if (remaining <= 0) throw new Error('choice_timeout');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetch(`${decisionServiceUrl(opts.url ?? d3Url(), 'WEBCLI_D3_URL')}/v1/systemone`, {
        method: 'POST', redirect: 'error',
        headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ state, questions: { [id]: question }, ...(model?.trim() ? { model: model.trim() } : {}) }), signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Decision service /v1/systemone HTTP ${response.status}`);
      let json;
      try {
        if (opts.maxResponseBytes && response.body?.getReader) {
          const reader = response.body.getReader(), chunks = [];
          let size = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > opts.maxResponseBytes) { await reader.cancel(); throw new Error('choice_response_limit'); }
              chunks.push(value);
            }
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } finally { reader.releaseLock(); }
        } else json = await response.json();
      }
      catch { throw new Error('Decision service response is not valid JSON.'); }
      if (typeof json?.model === 'string') serverModel = json.model;
      const answer = json?.answers?.[id];
      const probabilities = answer?.probabilities;
      const values = entries.map(([option]) => probabilities?.[option]);
      if ((answer?.type !== undefined && answer.type !== 'choice') || !probabilities ||
          !Object.hasOwn(question.criteria, answer.choice) ||
          values.some(value => !Number.isFinite(value) || value < 0 || value > 1) ||
          Object.keys(probabilities).some(option => !Object.hasOwn(question.criteria, option)) ||
          Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.01 ||
          probabilities[answer.choice] < Math.max(...values) - 1e-6) {
        throw new Error('Decision service choice 响应无效');
      }
      answers[id] = answer;
    } finally { clearTimeout(timer); }
  }
  return { answers, routing: { model: serverModel || model || null }, usage: { input_tokens: 0, output_tokens: 0 } };
}
