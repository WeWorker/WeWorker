// Normalize at the trusted host boundary, using the selected package's schema.
// Never infer types from values alone, or normalize the confirmation control.
const diagnostics = new WeakMap();
const controls = new Set(['__confirmed', 'dry-run']);

export function hostArgumentError(reason, argument, expected) {
  const details = { stage: 'argument_validation', writeDispatched: false, reason };
  if (typeof argument === 'string' && argument.length <= 160
    && /^[A-Za-z][A-Za-z0-9_.\[\]-]*$/.test(argument)
    && !/key|cookie|authorization|password|secret|token/i.test(argument)) details.argument = argument;
  if (expected) details.expected = expected;
  const message = reason === 'changed'
    ? 'Write arguments differ from the confirmed invocation. No write was dispatched.'
    : 'Invalid argument' + (details.argument ? `: ${details.argument}` : '')
      + (expected ? ` (expected ${expected})` : '') + '. No write was dispatched.';
  const error = Object.assign(new Error(message), { code: 'HOST_CLI_INVALID_ARGUMENT' });
  diagnostics.set(error, Object.freeze({ message, details: Object.freeze(details) }));
  return error;
}

// Provider/extension exception text and details must not become diagnostics.
export const hostArgumentDiagnostic = error => diagnostics.get(error);

export function safeHostArgumentDetails(details) {
  if (details?.stage !== 'argument_validation' || details.writeDispatched !== false
    || !['type', 'changed', 'depth'].includes(details.reason)) return undefined;
  // Reuse the fixed diagnostic constructor to discard unrecognized wire fields.
  const expected = typeof details.expected === 'string' && details.expected.length <= 80
    && details.expected.split('|').every(type => ['integer', 'number', 'string', 'boolean', 'object', 'array', 'null'].includes(type))
    ? details.expected : undefined;
  return hostArgumentDiagnostic(hostArgumentError(details.reason, details.argument, expected)).details;
}

export function normalizeHostArguments(args, schema = {}) {
  function normalize(value, definition, field, depth) {
    if (depth > 32) throw hostArgumentError('depth', field);
    if (!definition || typeof definition !== 'object') return structuredClone(value);
    const types = Array.isArray(definition.type) ? definition.type : [definition.type];
    if (types.includes('string') && typeof value === 'string') return value;
    if (value === null && types.includes('null')) return null;
    if (typeof value === 'string' && value.trim() && !types.includes('string')) {
      const number = Number(value);
      if (types.includes('integer') && /^[+-]?\d+$/.test(value.trim()) && Number.isSafeInteger(number)) value = number;
      else if (types.includes('number') && Number.isFinite(number)) value = number;
      else if (types.includes('boolean') && ['true', 'false'].includes(value)) value = value === 'true';
      else if (types.includes('array') && definition.items?.type === 'integer') {
        const parts = value.split(',').map(part => part.trim()).filter(Boolean);
        if (parts.length) value = parts;
      }
    }
    if (types.includes('integer') && Number.isSafeInteger(value)) return value;
    if (types.includes('number') && typeof value === 'number' && Number.isFinite(value)) return value;
    if (types.includes('boolean') && typeof value === 'boolean') return value;
    if (types.includes('array') && Array.isArray(value)) {
      return value.map((entry, index) => normalize(entry, definition.items, `${field}[${index}]`, depth + 1));
    }
    if (types.includes('object') && value && typeof value === 'object' && !Array.isArray(value)) {
      const properties = definition.properties || {};
      const entries = Object.entries(value).map(([key, entry]) => [key,
        depth === 0 && controls.has(key) ? structuredClone(entry)
          : normalize(entry, Object.hasOwn(properties, key) ? properties[key] : undefined,
            field ? `${field}.${key}` : key, depth + 1)]);
      for (const [key, prop] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key) && !(depth === 0 && controls.has(key)) && prop && Object.hasOwn(prop, 'default')) {
          entries.push([key, normalize(prop.default, prop, field ? `${field}.${key}` : key, depth + 1)]);
        }
      }
      return Object.fromEntries(entries);
    }
    if (types.every(type => type === undefined)) return structuredClone(value);
    throw hostArgumentError('type', field, types.filter(type => ['integer', 'number', 'string', 'boolean', 'object', 'array', 'null'].includes(type)).join('|'));
  }
  return normalize(args, schema, '', 0);
}
