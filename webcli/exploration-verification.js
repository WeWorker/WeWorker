import { explorationError as fail } from './exploration-commands.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sensitive = /password|passwd|secret|cookie|authorization|token|credential|api.?key|csrf|session/i;
const invalid = message => { throw fail('INVALID_VERIFICATION', message); };

// Advisory coverage, never a claim that a business mapping has been proved.
export function auditVerification(cases = [], previous = []) {
  const warnings = [];
  for (const item of cases) {
    const expect = item.expect || {};
    const semanticPaths = [...Object.keys(expect.equals || {}), ...Object.keys(expect.patterns || {})]
      .filter(key => !Object.hasOwn(item.args || {}, key));
    if (!semanticPaths.length) warnings.push({ code: 'STRUCTURE_ONLY_VERIFICATION', caseId: item.id,
      message: 'Structure/count/input echoes do not prove source-field mapping or filtering. Add assertions on business result fields.' });
  }
  for (const old of previous) {
    const current = cases.find(item => item.id === old.id);
    // Changed assertions need review even when a change is a valid correction.
    if (!current || JSON.stringify(current.expect) !== JSON.stringify(old.expect)) warnings.push({
      code: 'VERIFICATION_CHANGED', caseId: old.id, message: 'An earlier case was removed or its assertions changed. Recheck the original requirement; a new pass does not validate the old contract.' });
  }
  return warnings;
}
function checkKeys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('Verification contains unsupported fields.');
}
function checkPath(value) {
  if (value === '$') return value;
  if (typeof value !== 'string' || value.length > 200 || !/^\$?(?:\.?[a-zA-Z0-9_*-]+)+$/.test(value)
    || value.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) invalid('Use dot paths and * for array rows.');
  return value;
}
function checkPattern(value) {
  // A small predictable RegExp subset: anchored literals/classes, no groups,
  // alternatives or backreferences, at most two variable repetitions.
  if (typeof value !== 'string' || value.length > 200 || !value.startsWith('^') || !value.endsWith('$')) invalid('Patterns must be anchored and at most 200 characters.');
  let variableRepeats = 0, inClass = false, lastQuantifier = false;
  for (let i = 1; i < value.length - 1; i++) {
    const char = value[i];
    if (char === '\\') { if (/\d|[kxpPu]/.test(value[++i] || '')) invalid('Pattern escapes are limited to character classes and literal punctuation.'); lastQuantifier = false; continue; }
    if (char === '[') { inClass = true; lastQuantifier = false; continue; }
    if (char === ']') { inClass = false; continue; }
    if (inClass) continue;
    if ('()|^$'.includes(char)) invalid('Patterns do not support groups, alternatives or internal anchors.');
    if ('*+?{'.includes(char)) {
      if (lastQuantifier) invalid('Nested pattern quantifiers are unsupported.');
      lastQuantifier = true;
      if (char === '{') {
        const quantifier = value.slice(i).match(/^\{(\d+)(?:,(\d*))?\}/);
        if (!quantifier || Number(quantifier[1]) > 2048 || (quantifier[2] && Number(quantifier[2]) > 2048)) invalid('Invalid pattern quantifier.');
        if (quantifier[0].includes(',') && quantifier[1] !== quantifier[2]) variableRepeats++;
        i += quantifier[0].length - 1;
      } else variableRepeats++;
    } else lastQuantifier = false;
  }
  if (variableRepeats > 2) invalid('Use at most two variable pattern repetitions.');
  try { new RegExp(value); } catch { invalid('Invalid regular expression.'); }
  return value;
}
export function dataOnly(value, depth = 0) {
  if (depth > 12) invalid('Verification values are nested too deeply.');
  if (Array.isArray(value)) { for (const item of value) dataOnly(item, depth + 1); return; }
  if (object(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (sensitive.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid('Verification must not contain credentials or unsafe object keys.');
      dataOnly(nested, depth + 1);
    }
  } else if ((typeof value === 'number' && !Number.isFinite(value)) || (value !== null && !['string', 'number', 'boolean'].includes(typeof value))) invalid('Verification values must be finite JSON data.');
}

export function normalizeVerificationCases(cases) {
  if (!Array.isArray(cases) || !cases.length || cases.length > 10 || JSON.stringify(cases).length > 50000) invalid('Provide 1–10 cases with at most 50000 total characters.');
  const ids = new Set();
  return cases.map(item => {
    checkKeys(item, ['id', 'args', 'expect']);
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.id) || ids.has(item.id)) invalid('Each case needs a unique portable id.');
    ids.add(item.id);
    if (!object(item.args)) invalid('Each case needs an args object.');
    dataOnly(item.args);
    const expected = item.expect;
    checkKeys(expected, ['version', 'requiredPaths', 'types', 'notEmpty', 'patterns', 'equals', 'rowCount']);
    if (expected.version !== undefined && expected.version !== 1) invalid('Unsupported output contract version.');
    if (!Object.keys(expected).some(key => key !== 'version')) invalid('Each case needs an output assertion.');
    for (const key of ['requiredPaths', 'notEmpty']) if (expected[key] !== undefined) {
      if (!Array.isArray(expected[key]) || expected[key].length > 50) invalid(`${key} must be an array of at most 50 paths.`);
      expected[key].forEach(checkPath);
    }
    for (const key of ['types', 'patterns', 'equals']) if (expected[key] !== undefined) {
      if (!object(expected[key]) || Object.keys(expected[key]).length > 50) invalid(`${key} must map at most 50 paths to assertions.`);
      for (const [field, value] of Object.entries(expected[key])) {
        checkPath(field);
        if (key === 'patterns') checkPattern(value);
        if (key === 'types' && (typeof value !== 'string' || value.split('|').some(type => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)))) invalid('Unsupported assertion type.');
        if (key === 'equals') { if (object(value) || Array.isArray(value) || sensitive.test(field)) invalid('equals supports non-sensitive scalar assertions.'); dataOnly(value); }
      }
    }
    if (expected.rowCount !== undefined) {
      checkKeys(expected.rowCount, ['path', 'min', 'max']); checkPath(expected.rowCount.path);
      const { min, max } = expected.rowCount;
      if (min === undefined && max === undefined) invalid('rowCount needs min or max.');
      for (const count of [min, max]) if (count !== undefined && (!Number.isSafeInteger(count) || count < 0 || count > 1000000)) invalid('rowCount bounds must be non-negative integers.');
      if (min !== undefined && max !== undefined && min > max) invalid('rowCount min exceeds max.');
    }
    if (!(expected.requiredPaths?.length || expected.notEmpty?.length || Object.keys(expected.types || {}).length || Object.keys(expected.patterns || {}).length || Object.keys(expected.equals || {}).length || expected.rowCount)) invalid('At least one non-empty assertion is required.');
    return JSON.parse(JSON.stringify({ id: item.id, args: item.args, expect: { version: 1, ...expected } }));
  });
}

export function applyVerificationCases(testCases, verification = {}) {
  return testCases.flatMap(test => {
    const authored = verification[test.toolName];
    if (!authored) return [test];
    return authored.map(item => ({ ...test, caseId: item.id, arguments: item.args, argumentSources: Object.fromEntries(Object.keys(item.args).map(key => [key, 'agent_verification'])),
      missingRequired: [], validationErrors: [], captureBound: false,
      // Authored arguments replace missing schema defaults; they never turn a
      // non-read or evidence-free case into a permissible execution.
      execute: test.risk.level === 'read' && test.risk.confidence >= 0.75 && ['captured_sample', 'page_observation'].includes(test.contract.kind) && !test.unverifiable,
      contract: { ...test.contract, authoredFixture: item.expect } }));
  });
}
