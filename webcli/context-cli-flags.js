import { contextKey, fail } from './context-model.js';
import { randomUUID } from 'node:crypto';

const controls = new Set(['context', 'decision', 'step', 'reply-to']);
export function extractContextFlags(argv) {
  const args = [], values = {};
  const end = argv.indexOf('--');
  const options = end < 0 ? argv : argv.slice(0, end);
  // Legacy association flags belong to routing only after explicit opt-in.
  // Namespaced controls allow an Adapter's decision/step alongside routing.
  const namespaced = options.some(arg => /^--context-(decision|step|reply-to)(?:=|$)/.test(arg));
  const legacy = !namespaced && options.some(arg => /^--context(?:=|$)/.test(arg));
  let newContext = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { args.push(...argv.slice(i)); break; }
    if (arg === '--new-context') {
      if (newContext) fail('context_duplicate_flag', 2);
      newContext = true;
      continue;
    }
    if (arg.startsWith('--new-context=')) fail('context_invalid_flag', 2);
    const match = /^--(context|context-decision|context-step|context-reply-to|decision|step|reply-to)(?:=(.*))?$/.exec(arg);
    if (!match) { args.push(arg); continue; }
    if (['decision', 'step', 'reply-to'].includes(match[1]) && !legacy) { args.push(arg); continue; }
    const name = match[1].replace(/^context-/, '');
    if (Object.hasOwn(values, name)) fail('context_duplicate_flag', 2);
    const value = match[2] ?? argv[++i];
    if (!value || (match[2] === undefined && value.startsWith('--'))) fail('context_missing_flag_value', 2);
    values[name] = value;
  }
  if (newContext) {
    if (!['route', 'call'].includes(args[0]) || Object.keys(values).length) fail('context_invalid_flag', 2);
    values.context = randomUUID();
  }
  if (values.context !== undefined) contextKey(values.context);
  if (Object.keys(values).some(k => controls.has(k) && k !== 'context') && !values.context) fail('context_required', 2);
  if (values['reply-to'] && args[0] !== 'route') fail('context_invalid_flag', 2);
  if ((values.decision || values.step) && (args[0] !== 'call' || !values.decision || !values.step)) fail('context_invalid_association', 2);
  return { args, ...values };
}
