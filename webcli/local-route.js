import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Local deterministic routing: regex rules aligned with WeWorker's router-config
 * pattern layer (weworker/backend-ts/src/api-query-router/patterns.ts).
 *
 * Design contract (mirrors WeWorker's "漏判免费、误判致命" red line):
 * - Only ADDS confident hits on top of the existing decision-service flow.
 *   Any miss, gate hit, disabled or broken rule file falls through to the
 *   remote decision service unchanged.
 * - Only tools present in the current catalog are routable (scope filter).
 * - Rule safety is enforced at compile time (compile-routing-rules.mjs drops
 *   anything that is not a read-only command); runtime re-checks existence.
 * - Extractors that fail produce no argument rather than a guess.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RULES_PATH = join(__dirname, 'routing-rules.json');
export const DEFAULT_MIN_CONFIDENCE = 0.8;

// Discussion-mode gate, aligned with WeWorker's gates.ts word list: questions
// about the product, errors or preferences must not be deterministically
// routed to a site command.
const DISCUSSION_GATE
  = /怎么|如何|为什么|是什么|什么叫|是什么意思|介绍一下|介绍下|推荐一下|有什么区别|区别是什么|支持吗|可以吗|能用吗|失败|报错|偏好|是否|[吗呢]\s*[？?。!！]{0,2}\s*$/;

/** 去除全部空白（含内部），与 WeWorker routes/scenario 层的归一化口径一致。 */
function normalizeMessage(message) {
  return String(message ?? '').replace(/\s+/g, '');
}

/** Escape a value for a single-quoted bash string ('…' becomes '\''). */
function shellQuote(value) {
  return String(value ?? '').replace(/'/g, `'\\''`);
}

function compileRegex(source, flags) {
  if (typeof source !== 'string' || !source) return null;
  try { return new RegExp(source, flags || 'i'); } catch { return null; }
}

function compilePattern(pattern) {
  if (pattern.type === 'keyword' || (!pattern.type && Array.isArray(pattern.keywords))) {
    const terms = (pattern.keywords || []).map(term => normalizeMessage(term));
    if (!terms.length) return null;
    const mode = pattern.match_mode || 'any';
    const weight = Number.isFinite(pattern.weight) ? pattern.weight : 1;
    return { kind: 'keyword', terms, mode, weight };
  }
  const re = compileRegex(pattern.expression, pattern.flags);
  if (!re) return null;
  return { kind: 'regex', re, weight: Number.isFinite(pattern.weight) ? pattern.weight : 1 };
}

function patternHits(pattern, raw, normalized) {
  if (pattern.kind === 'regex') return pattern.re.test(raw) || pattern.re.test(normalized);
  const contains = term => normalized.includes(term);
  if (pattern.mode === 'all') return pattern.terms.every(contains);
  if (pattern.mode === 'phrase') {
    // Phrase mode: all terms must appear, in the configured order.
    let index = -1;
    for (const term of pattern.terms) {
      index = normalized.indexOf(term, index + 1);
      if (index < 0) return false;
    }
    return true;
  }
  return pattern.terms.some(contains);
}

/** Coerce an extracted value; failures yield undefined (never a guess). */
function coerceExtracted(value, extractor) {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  if (extractor.type === 'integer') {
    if (!/^[+-]?\d+$/.test(raw)) return undefined;
    const num = parseInt(raw, 10);
    return clampNumber(num, extractor);
  }
  if (extractor.type === 'number') {
    const num = Number(raw);
    if (!Number.isFinite(num)) return undefined;
    return clampNumber(num, extractor);
  }
  if (typeof extractor.max_length === 'number' && raw.length > extractor.max_length) {
    return raw.slice(0, extractor.max_length);
  }
  return raw;
}

function clampNumber(value, extractor) {
  let next = value;
  if (Number.isFinite(extractor.min) && next < extractor.min) next = extractor.min;
  if (Number.isFinite(extractor.max) && next > extractor.max) next = extractor.max;
  return next;
}

function extractArgs(extractors, raw, normalized) {
  const args = {};
  if (!Array.isArray(extractors)) return args;
  for (const extractor of extractors) {
    const re = compileRegex(extractor.regex, extractor.flags);
    if (!re || typeof extractor.arg !== 'string' || !extractor.arg) continue;
    const match = re.exec(raw) || re.exec(normalized);
    if (!match) continue; // A failing extractor produces no argument.
    const value = coerceExtracted(match[1] ?? match[0], extractor);
    if (value !== undefined) args[extractor.arg] = value;
  }
  return args;
}

/**
 * Match a natural-language request against the bundled regex rules.
 *
 * @param {string} request raw user request
 * @param {{rules?: object|null, availableTools?: Set<string>|null, knownSite?: string|null, adapterOf?: (tool: string) => {adapterId: string, commandId: string, command?: object} | null}} options
 * @returns {{kind: 'routed', site: object, command: object, callCommand: string, helpCommand: string, args: object, source: 'local-regex'} | null
 */
export function matchLocalRoute(request, { rules, availableTools, knownSite, adapterOf } = {}) {
  if (!rules || !Array.isArray(rules.entries) || !rules.entries.length) return null;
  if (knownSite && !rules.entries.some(entry => entry.tool.startsWith(knownSite + '.'))) return null;
  const raw = String(request ?? '');
  if (!raw.trim()) return null;
  if (DISCUSSION_GATE.test(raw)) return null;
  const normalized = normalizeMessage(raw);
  const minConfidence = Number.isFinite(rules.min_confidence) ? rules.min_confidence : DEFAULT_MIN_CONFIDENCE;
  const negative = entry => (entry.negative_patterns || [])
    .map(source => compileRegex(source, 'i'))
    .filter(Boolean);
  const entries = [...rules.entries]
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const entry of entries) {
    if (typeof entry.tool !== 'string' || !entry.tool.includes('.')) continue;
    if (availableTools && !availableTools.has(entry.tool)) continue;
    if (knownSite && !entry.tool.startsWith(knownSite + '.')) continue;
    if (negative(entry).some(re => re.test(raw) || re.test(normalized))) continue;
    const patterns = (entry.patterns || []).map(compilePattern).filter(Boolean);
    const hits = patterns.filter(pattern => patternHits(pattern, raw, normalized));
    if (!hits.length) continue;
    const confidence = Math.max(...hits.map(pattern => pattern.weight));
    if (confidence < minConfidence) continue;
    const args = { ...(entry.default_args || {}), ...extractArgs(entry.arg_extractors, raw, normalized) };
    const context = adapterOf ? adapterOf(entry.tool) : null;
    const adapterId = entry.tool.slice(0, entry.tool.lastIndexOf('.'));
    const commandId = entry.tool.slice(entry.tool.lastIndexOf('.') + 1);
    const argPayload = Object.keys(args).length
      ? ` --args '${shellQuote(JSON.stringify(args))}'`
      : '';
    return {
      kind: 'routed',
      site: { name: adapterId, adapterId, description: context?.adapter?.description || '', confidence: 1 },
      command: { name: commandId, description: context?.command?.description || '', confidence },
      callCommand: `webcli call ${entry.tool}${argPayload}`,
      helpCommand: `webcli ${adapterId} ${commandId} help`,
      args,
      source: 'local-regex',
    };
  }
  return null;
}

/** Load the bundled rules; a missing or unparsable file disables local routing. */
export function loadLocalRouteRules({ path = DEFAULT_RULES_PATH, env = process.env } = {}) {
  if (env.WEBCLI_LOCAL_ROUTE === '0') return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}
