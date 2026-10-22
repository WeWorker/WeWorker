/** d3-flash classification client (System One, no authentication required). */
import { decisionServiceUrl } from './decision-service-config.js';
export function d3Url() {
  return decisionServiceUrl(process.env.WEBCLI_D3_URL, 'WEBCLI_D3_URL');
}
export async function d3Predict(state, questions, opts = {}) {

  const answers = {};
  // Serialize questions to avoid unnecessary concurrent service load.
  for (const [id, question] of Object.entries(questions)) {
    const entries = Object.entries(question.criteria || {});
    if (!entries.length) throw new Error('d3-flash choice 缺少候选');
    if (entries.length === 1) {
      answers[id] = { type: 'choice', choice: entries[0][0], probabilities: { [entries[0][0]]: 1 }, confidence: 1 };
      continue;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${decisionServiceUrl(opts.url ?? process.env.WEBCLI_D3_URL, 'WEBCLI_D3_URL')}/v1/systemone`, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ model: 'vllm-sr/d3-flash', state, questions: { [id]: question } }), signal: controller.signal,
      });
      if (!response.ok) throw new Error(`d3-flash /v1/systemone HTTP ${response.status}`);
      let json;
      try { json = await response.json(); }
      catch { throw new Error('d3-flash response is not valid JSON.'); }
      const answer = json?.answers?.[id];
      const probabilities = answer?.probabilities;
      const values = entries.map(([option]) => probabilities?.[option]);
      if (answer?.type !== 'choice' || !probabilities ||
          !Object.hasOwn(question.criteria, answer.choice) ||
          values.some(value => !Number.isFinite(value) || value < 0 || value > 1) ||
          Object.keys(probabilities).some(option => !Object.hasOwn(question.criteria, option)) ||
          Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.01 ||
          probabilities[answer.choice] < Math.max(...values) - 1e-6) {
        throw new Error('d3-flash choice 响应无效');
      }
      answers[id] = answer;
    } finally { clearTimeout(timer); }
  }
  return { answers, routing: { model: 'd3-flash' }, usage: { input_tokens: 0, output_tokens: 0 } };
}
