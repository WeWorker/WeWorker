import { fingerprint, fail, LIMITS } from './context-model.js';
import { validateToolArguments } from './generation-harness/tool-registry.js';
import { businessSchema } from './business-args.js';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const controlArgument = key => /^__/i.test(key);
export function applyResultMetadata(entries, metadata, adapterId) {
  if (metadata === undefined) return entries;
  if (!object(metadata)) fail('binding_invalid_metadata', 2);
  const names = new Set(entries.map(e => e.name));
  for (const [name, declaration] of Object.entries(metadata)) {
    if (!names.has(name) || !object(declaration) || Object.keys(declaration).some(k => !['safety', 'results'].includes(k)) ||
        (declaration.safety !== undefined && !['read', 'write'].includes(declaration.safety))) fail('binding_invalid_metadata', 2);
  }
  const merged = entries.map(e => ({ ...e, ...metadata[e.name], adapterId }));
  compileResultBindings(merged);
  return merged;
}
const parts = path => {
  if (typeof path !== 'string' || !/^(?:\$\.)?[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*$/.test(path) ||
      path.split('.').some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) fail('binding_invalid_path', 2);
  return path.replace(/^\$\./, '').split('.');
};
export function readBindingPath(value, path) {
  if (path === '$') return value;
  for (const key of parts(path)) {
    if (!object(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

// All package formats are converted here; the decision provider never sees package metadata.
export function compileResultBindings(entries) {
  const byName = new Map();
  for (const entry of entries) {
    if (byName.has(entry.name)) byName.set(entry.name, null);
    else byName.set(entry.name, entry);
  }
  for (const entry of entries) for (const alias of [
    ...(entry.aliases || []).map(alias => `${entry.adapterId}.${alias}`), ...(entry.legacyNames || []),
  ]) {
    if (byName.has(alias) && byName.get(alias) !== entry) byName.set(alias, null);
    else if (!byName.has(alias)) byName.set(alias, entry);
  }
  const compiled = new Map();
  for (const entry of entries) {
    if (entry.results === undefined) continue;
    if (!byName.get(entry.name)) fail('binding_duplicate_tool', 2);
    if (!Array.isArray(entry.results) || entry.safety !== 'read' || entry.enabled === false) fail('binding_invalid_query', 2);
    const results = entry.results.map(rule => {
      if (!object(rule) || (rule.when !== undefined && !object(rule.when)) || !Array.isArray(rule.actions)) fail('binding_invalid_rule', 2);
      if (!rule.actions.length) return { ...rule, actions: [] };
      if (Object.hasOwn(rule, 'itemsPath') === Object.hasOwn(rule, 'itemPath')) fail('binding_invalid_rule', 2);
      const path = rule.itemPath ?? rule.itemsPath;
      if (path !== '$') parts(path);
      parts(rule.idField); parts(rule.titleField);
      const ids = new Set();
      const actions = rule.actions.flatMap(declaration => {
        if (!object(declaration) || !/^[a-z][a-z0-9-]*$/.test(declaration.id) || ids.has(declaration.id) ||
            typeof declaration.label !== 'string' || !declaration.label.trim()) fail('binding_invalid_action', 2);
        ids.add(declaration.id);
        const variants = declaration.variants;
        if (variants !== undefined && (!Array.isArray(variants) || !variants.length || variants.length > 8 ||
            ['command', 'args', 'inputs', 'when'].some(key => Object.hasOwn(declaration, key)))) fail('binding_invalid_variant', 2);
        const compiledVariants = (variants || [declaration]).map(variant => {
          if (!object(variant)) fail('binding_invalid_variant', 2);
          if (variants) {
            if (!object(variant.when) || !Object.keys(variant.when).length || ['id', 'label', 'variants'].some(key => Object.hasOwn(variant, key))) fail('binding_invalid_variant', 2);
            for (const [key, value] of Object.entries(variant.when)) {
              parts(key);
              if (value !== null && !['string', 'boolean', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) fail('binding_invalid_variant', 2);
            }
          } else if (variant.when !== undefined) fail('binding_invalid_variant', 2);
          const action = { ...variant, id: declaration.id, label: declaration.label };
          if (!object(action.args) || typeof action.command !== 'string') fail('binding_invalid_action', 2);
          const name = byName.has(action.command) ? action.command : `${entry.adapterId}.${action.command}`;
          const target = byName.get(name);
          if (!target || target.adapterId !== entry.adapterId || !['read', 'write'].includes(target.safety) || target.enabled === false) fail('binding_invalid_target', 2);
          for (const [key, mapping] of Object.entries(action.args)) {
            if (controlArgument(key) || ['constructor', 'prototype'].includes(key) || !object(mapping) ||
                Object.keys(mapping).length !== 1 || (!Object.hasOwn(mapping, 'value') && !Object.hasOwn(mapping, 'from'))) fail('binding_invalid_argument', 2);
            if (Object.hasOwn(mapping, 'from')) {
              if (!/^(item|query)\./.test(mapping.from)) fail('binding_invalid_argument', 2);
              parts(mapping.from.slice(mapping.from.indexOf('.') + 1));
            }
          }
          const targetSchema = businessSchema(target.parameters || target.schema || {});
          const inputs = action.inputs === undefined ? [] : action.inputs;
          if (!Array.isArray(inputs) || new Set(inputs).size !== inputs.length || inputs.some(key =>
            typeof key !== 'string' || !Object.hasOwn(targetSchema.properties || {}, key) || Object.hasOwn(action.args, key) ||
            controlArgument(key) || /(?:password|token|secret|api[-_]?key|authorization|cookie|^constructor$|^prototype$)/i.test(key))) fail('binding_invalid_input', 2);
          const schema = inputs.length ? { ...targetSchema, required: [...new Set([...(targetSchema.required || []), ...inputs])] } : targetSchema;
          return { ...action, tool: target.name, safety: target.safety, targetFingerprint: target.sourceFingerprint, schema };
        });
        if (new Set(compiledVariants.map(action => action.safety)).size !== 1) fail('binding_invalid_variant', 2);
        for (let i = 0; i < compiledVariants.length; i++) for (let j = i + 1; j < compiledVariants.length; j++) {
          const a = compiledVariants[i].when, b = compiledVariants[j].when;
          if (!Object.keys(a).some(key => Object.hasOwn(b, key) && JSON.stringify(a[key]) !== JSON.stringify(b[key]))) fail('binding_ambiguous_variant', 2);
        }
        return compiledVariants;
      });
      return { ...rule, actions };
    });
    compiled.set(entry.name, { entry, results, fingerprint: fingerprint(JSON.stringify({ entry, results })) });
  }
  return compiled;
}

export function matchResultBinding(binding, args) {
  if (!binding) return null;
  const effective = { ...args };
  for (const [key, schema] of Object.entries(binding.entry.parameters?.properties || binding.entry.schema?.properties || {})) {
    if (!Object.hasOwn(effective, key) && Object.hasOwn(schema, 'default')) effective[key] = schema.default;
  }
  const matches = binding.results.filter(rule => Object.entries(rule.when || {}).every(([key, value]) => JSON.stringify(effective[key]) === JSON.stringify(value)));
  if (matches.length > 1) fail('binding_ambiguous_result', 2);
  return matches.length ? { ...matches[0], query: effective } : null;
}

export function extractBoundEntities(binding, args, raw) {
  const rule = matchResultBinding(binding, args);
  if (!rule || !rule.actions.length) return null;
  const value = readBindingPath(raw, rule.itemPath ?? rule.itemsPath);
  const rows = Object.hasOwn(rule, 'itemPath') ? (object(value) ? [value] : null) : value;
  if (!Array.isArray(rows)) fail('binding_invalid_result');
  const ids = new Set();
  return { resultRuleIndex: binding.results.findIndex(candidate => candidate.actions === rule.actions),
    completeness: rows.length > LIMITS.objects ? 'truncated' : 'unknown', resultCount: rows.length,
    actions: [...new Map(rule.actions.map(({ id, label, safety, tool }) => [id, { id, label, safety, tool }])).values()], entities: rows.slice(0, LIMITS.objects).map((item, i) => {
    const id = readBindingPath(item, rule.idField), title = readBindingPath(item, rule.titleField);
    if (!['string', 'number'].includes(typeof id) || (typeof id === 'number' && (!Number.isFinite(id) || (Number.isInteger(id) && !Number.isSafeInteger(id)))) || !String(id) ||
        ids.has(String(id)) || typeof title !== 'string' || Buffer.byteLength(title) > 256) fail('binding_invalid_entity');
    ids.add(String(id));
    const bindings = Object.fromEntries(rule.actions.map((action, bindingIndex) => ({ action, bindingIndex })).filter(({ action }) =>
      Object.entries(action.when || {}).every(([key, expected]) => JSON.stringify(readBindingPath(item, key)) === JSON.stringify(expected))).map(({ action, bindingIndex }) => {
      const parameters = Object.fromEntries(Object.entries(action.args).map(([key, mapping]) => [key,
        Object.hasOwn(mapping, 'value') ? structuredClone(mapping.value) : readBindingPath(mapping.from.startsWith('item.') ? item : rule.query, mapping.from.slice(mapping.from.indexOf('.') + 1))]));
      const ready = Object.values(parameters).every(x => x !== undefined) && validateToolArguments(parameters, action.schema).length === 0;
      return [action.id, { tool: action.tool, args: parameters, safety: action.safety, ready, ...(action.when ? { bindingIndex } : {}) }];
    }));
    return { entityRef: `e${i + 1}`, businessId: String(id), title, status: '', bindings };
  }) };
}
