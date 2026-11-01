import { createHash } from 'node:crypto';

/* Portable, optional intent hints for catalog-managed Adapter Skills.
 * These are instructions for external Skill hosts, NOT a second WeWorker fast path.
 * Never execute regexes or dispatch tools here: the host remains responsible for
 * ambiguity checks, permissions and confirmation.
 */
const ROUTE_TIERS = ['exact', 'template', 'regex'];
const MAX_PATTERN_LENGTH = 240;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function eligibleTool(adapter, name) {
  return adapter.tools.find(tool => tool.name === name
    && tool.safety === 'read' && tool.requires_confirmation !== true
    && tool.execution?.type === 'api' && tool.execution?.runtime === 'background');
}

/** Return only well-formed, safe hints; an invalid entry cannot make a Skill unusable. */
export function portableSkillIntents(adapter) {
  const input = adapter.skill_intents;
  if (!isPlainObject(input) || input.version !== 1 || !Array.isArray(input.routes)) return null;
  const routes = [];
  const seen = new Set();
  for (const raw of input.routes) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(raw.id)
      || seen.has(raw.id) || !ROUTE_TIERS.includes(raw.tier) || typeof raw.tool !== 'string'
      || !eligibleTool(adapter, raw.tool)
      || !Array.isArray(raw.examples) || !raw.examples.length || raw.examples.some(s => typeof s !== 'string' || !s.trim())
      || !Array.isArray(raw.negativeExamples) || !raw.negativeExamples.length || raw.negativeExamples.some(s => typeof s !== 'string' || !s.trim())
      || (raw.args !== undefined && !isPlainObject(raw.args))) continue;
    const route = { id: raw.id, tier: raw.tier, tool: raw.tool };
    if (raw.tier === 'exact') {
      if (!Array.isArray(raw.utterances) || !raw.utterances.length
        || raw.utterances.some(s => typeof s !== 'string' || !s.trim())) continue;
      route.utterances = raw.utterances;
    } else {
      if (typeof raw.pattern !== 'string' || !raw.pattern || raw.pattern.length > MAX_PATTERN_LENGTH
        || (raw.tier === 'template' && (!raw.pattern.startsWith('^') || !raw.pattern.endsWith('$')))
        || (raw.flags !== undefined && raw.flags !== 'i')
        || (raw.negatives !== undefined && (!Array.isArray(raw.negatives) || raw.negatives.some(s => typeof s !== 'string' || !s || s.length > MAX_PATTERN_LENGTH)))) continue;
      try {
        new RegExp(raw.pattern, raw.flags || '');
        for (const negative of raw.negatives || []) new RegExp(negative, raw.flags || '');
      } catch { continue; }
      route.pattern = raw.pattern;
      if (raw.flags) route.flags = raw.flags;
      if (raw.negatives?.length) route.negatives = raw.negatives;
      if (raw.captures !== undefined) {
        if (!isPlainObject(raw.captures) || !Object.keys(raw.captures).length
          || Object.entries(raw.captures).some(([key, spec]) => !Object.hasOwn(eligibleTool(adapter, raw.tool).parameters?.properties || {}, key)
            || !isPlainObject(spec) || !Number.isInteger(spec.group) || spec.group < 1 || spec.group > 8
            || !['string', 'integer'].includes(spec.type)
            || (spec.min !== undefined && !Number.isInteger(spec.min))
            || (spec.max !== undefined && !Number.isInteger(spec.max)))) continue;
        route.captures = raw.captures;
      }
    }
    if (raw.args) {
      if (Object.keys(raw.args).some(key => !Object.hasOwn(eligibleTool(adapter, raw.tool).parameters?.properties || {}, key))) continue;
      route.args = raw.args;
    }
    route.examples = raw.examples;
    route.negativeExamples = raw.negativeExamples;
    seen.add(raw.id);
    routes.push(route);
  }
  return routes.length ? { version: 1, adapterId: adapter.id, routes } : null;
}

export function portableSkillIntentMarkdown(intents) {
  if (!intents) return '';
  const lines = [
    '## Fast intent selection (portable Skill hints)', '',
    'These rules are Skill instructions for the current host, not a WeWorker routing override. Use them only for the listed read-only background API tools.',
    'Check exact phrases first, then anchored templates, then conservative regexes. Match the entire current request as an action; do not shortcut discussion, follow-up questions, combined tasks, negation, missing/ambiguous arguments, or another site’s request.',
    'If multiple routes match, an example conflicts with a negative example, validation fails, or the installed Adapter differs, use the normal Agent tool-selection flow. Never infer missing required values or perform writes through these hints.',
    'For capable hosts, `references/intent-routes.json` contains the same versioned rules and positive/negative examples. Reading that file is optional: the essential rules are below.', '',
  ];
  for (const tier of ROUTE_TIERS) {
    const routes = intents.routes.filter(route => route.tier === tier);
    if (!routes.length) continue;
    lines.push('### ' + ({ exact: '1. Exact phrases', template: '2. Anchored templates', regex: '3. Conservative regular expressions' }[tier]), '');
    for (const route of routes) {
      lines.push('- `' + route.id + '` → `webcli call ' + route.tool + '`');
      if (route.utterances) lines.push('  - Match exact utterances (trim whitespace only): ' + route.utterances.map(s => JSON.stringify(s)).join(', '));
      if (route.pattern) lines.push('  - Pattern (JavaScript RegExp' + (route.flags ? ', flags=' + route.flags : '') + '): `' + route.pattern + '`');
      if (route.negatives) lines.push('  - Reject when matching: ' + route.negatives.map(s => '`' + s + '`').join(', '));
      if (route.captures) lines.push('  - Capture into CLI flags: ' + Object.entries(route.captures).map(([key, spec]) => `--${key}=<group ${spec.group}, ${spec.type}${spec.min === undefined ? '' : `, min ${spec.min}`}${spec.max === undefined ? '' : `, max ${spec.max}`}>`).join('; ') + '. Validate before calling.');
      if (route.args) lines.push('  - Fixed flags: ' + Object.entries(route.args).map(([key, value]) => `--${key}=${JSON.stringify(value)}`).join(' '));
      lines.push('  - Yes: ' + route.examples.map(s => JSON.stringify(s)).join(', '));
      lines.push('  - No: ' + route.negativeExamples.map(s => JSON.stringify(s)).join(', '));
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

export function portableSkillIntentDigest(intents) {
  return intents ? createHash('sha256').update(JSON.stringify(intents)).digest('hex') : null;
}

export function portableSkillIntentResource(intents) {
  return intents ? JSON.stringify({ generator: 'webcli-adapter-skill-intents', ...intents,
    contentDigest: portableSkillIntentDigest(intents) }, null, 2) + '\n' : null;
}

export function isOwnedIntentResource(content) {
  try {
    const { generator, contentDigest, ...intents } = JSON.parse(content);
    return generator === 'webcli-adapter-skill-intents' && contentDigest === portableSkillIntentDigest(intents);
  } catch { return false; }
}
