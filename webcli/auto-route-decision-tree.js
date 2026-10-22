import { buildSiteGroups } from './auto-route-catalog.js';
import { d3Predict } from './auto-route-d3-client.js';

const GATE = 0.85;
const ranked = probabilities => Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
const alternatives = probabilities => ranked(probabilities).slice(0, 3).map(([option, p]) => ({ option, p }));

/** Three-stage classification only. This module never executes an Adapter. */
export async function routeRequest(request, { adapters, knownSite, url, predict = d3Predict, onTrace = () => {} }) {
  if (!adapters.length) throw new Error('No available Adapter commands.');
  const state = `用户需求: ${request}`;
  async function choose(id, criteria, instructions) {
    const start = performance.now();
    const response = await predict(state, { [id]: { type: 'choice', instructions, criteria } }, { url });
    const probabilities = response.answers?.[id]?.probabilities;
    if (!probabilities || Object.keys(probabilities).length !== Object.keys(criteria).length ||
        Object.keys(criteria).some(key => !Object.hasOwn(probabilities, key) ||
          !Number.isFinite(probabilities[key]) || probabilities[key] < 0 || probabilities[key] > 1)) {
      throw new Error('Decision service returned invalid candidates.');
    }
    onTrace({ stage: id, durationMs: Math.round(performance.now() - start) });
    return probabilities;
  }
  let adapter = knownSite ? adapters.find(a => a.id === knownSite) : undefined;
  let siteConfidence = 1;
  if (knownSite && !adapter) throw new Error('Adapter unavailable: ' + knownSite);
  if (!adapter) {
    let shortlist = adapters.map(a => a.id);
    let round = 0;
    do {
      const groups = buildSiteGroups(shortlist);
      const candidates = [];
      for (const [i, group] of groups.entries()) {
        const scores = await choose(`q_g${i + 1}r${round}`, Object.fromEntries(group.map(id =>
          [id, adapters.find(a => a.id === id).description || id])), '需求应由哪个站点处理');
        candidates.push(...ranked(scores).slice(0, 3).map(([id]) => id));
      }
      shortlist = candidates;
      round++;
    } while (shortlist.length > 9);
    const final = await choose('q_f0', Object.fromEntries(shortlist.map(id =>
      [id, adapters.find(a => a.id === id).description || id])), '从候选站点中选择负责该需求的');
    const [id, confidence] = ranked(final)[0];
    if (confidence < GATE) return { kind: 'low-confidence', stoppedAt: { tier: 'site', alternatives: alternatives(final) } };
    adapter = adapters.find(a => a.id === id);
    siteConfidence = confidence;
  }
  const site = { name: adapter.id, adapterId: adapter.id, description: adapter.description, confidence: siteConfidence };
  if (!adapter.commands.length) throw new Error('No available Adapter commands.');
  const probabilities = await choose('q_c0', Object.fromEntries(adapter.commands.map(c =>
    [c.name, c.description || c.id])), '选择最匹配需求的命令');
  const [name, confidence] = ranked(probabilities)[0];
  if (confidence < GATE) return {
    kind: 'low-confidence', site,
    stoppedAt: { tier: 'command', alternatives: alternatives(probabilities).map(a => ({ ...a, option: `webcli call ${a.option}` })) },
  };
  const command = adapter.commands.find(c => c.name === name);
  return {
    kind: 'routed', site,
    command: { name: command.id, description: command.description, confidence },
    callCommand: `webcli call ${command.name}`,
    helpCommand: `webcli ${adapter.id} ${command.id} help`,
    singleCommand: adapter.commands.length === 1,
  };
}
