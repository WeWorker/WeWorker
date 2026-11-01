import { explorationError as fail } from './exploration-commands.js';
import { writeResultIdentityMatches, writeResultSpecs } from './exploration-write-result.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw fail('INVALID_WRITE_CASE', 'Effect polling requires bounded integer intervalMs/maxAttempts and explicit pending equals assertions distinct from the final state.'); };
const canonical = path => path.replace(/^\$\.?/, '').split('.').filter(Boolean).join('.');
const scalar = value => value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
  || typeof value === 'string' && value.length <= 1000;

export function normalizeWritePoll(input, effect) {
  if (!object(input) || Object.keys(input).some(key => !['intervalMs', 'maxAttempts', 'pending', 'resultPending'].includes(key))
    || !Number.isInteger(input.intervalMs) || input.intervalMs < 250 || input.intervalMs > 5000
    || !Number.isInteger(input.maxAttempts) || input.maxAttempts < 2 || input.maxAttempts > 20
    || input.pending === undefined && input.resultPending === undefined) invalid();
  for (const [name, final] of [['pending', effect.after], ...(effect.resultReadback ? writeResultSpecs(effect.resultReadback).map(spec=>['resultPending',spec.expect]) : [['resultPending',undefined]])]) {
    const condition = input[name];
    if (condition === undefined) continue;
    if (!final || !object(condition) || Object.keys(condition).join(',') !== 'equals' || !object(condition.equals)
      || !Object.keys(condition.equals).length || Object.keys(condition.equals).length > 10) invalid();
    const entries = Object.entries(condition.equals);
    if (entries.some(([path, value]) => !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,7}$/.test(path) || path.length > 200 || !scalar(value)
      || path.split('.').some(key => /password|passwd|secret|cookie|authorization|token|credential|api.?key|csrf|session/i.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)))) invalid();
    // A declared pending state must be observably different from final success.
    if (!entries.some(([path, value]) => Object.entries(final.equals || {}).some(([key, expected]) => canonical(key) === path && expected !== value))) invalid();
  }
  return structuredClone(input);
}

function check(signal, deadline) {
  if (signal.aborted) throw fail('WRITE_READBACK_CANCELLED', 'Effect reading cancelled. The write must not be replayed.');
  if (Date.now() >= deadline) throw fail('WRITE_READBACK_TIMEOUT', 'Effect reading exhausted its total time budget. The write must not be replayed.');
}

async function wait(intervalMs, signal, deadline) {
  check(signal, deadline);
  await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(fail('WRITE_READBACK_CANCELLED', 'Effect reading cancelled.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  check(signal, deadline);
}

/** Only GET observations repeat. Errors, identity drift and unlisted states stop immediately. */
export async function readWriteEffect({ execution, phase, binding, read, verify, signal, deadline, document }) {
  const effect = execution.effect, poll = phase === 'after' && effect.poll !== undefined ? normalizeWritePoll(effect.poll, effect) : undefined;
  const maxAttempts = poll?.maxAttempts || 1;
  let currentDocument = document;
  const get = async request => {
    check(signal, deadline);
    const result = await read(request, currentDocument);
    check(signal, deadline);
    // Freeze the first document even if it only returned a pending observation.
    currentDocument ||= result.document;
    return result.value;
  };
  const matches = (value, expect) => expect && verify(value, { version: 1, ...expect }).length === 0;
  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    const value = await get(effect.readback);
    let passed = matches(value, effect[phase]), pending = false;
    if (phase === 'after' && execution.page?.ui
      && !writeResultIdentityMatches(value, { identityPath: effect.identityPath }, effect.before.equals[effect.identityPath])) {
      return { passed: false, attempts, document: currentDocument };
    }
    if (!passed) pending = matches(value, poll?.pending);
    else if (binding) {
      const specs = writeResultSpecs(effect.resultReadback), bindings = binding.bindings || [binding];
      if(bindings.length!==specs.length)return {passed:false,attempts,document:currentDocument};
      for(let index=0;index<specs.length;index++) {
        const spec=specs[index],selected=bindings[index],resource=await get({url:selected.url});
        if (!writeResultIdentityMatches(resource, spec, selected.id)) return { passed: false, attempts, document: currentDocument };
        passed = matches(resource, spec.expect);
        if (!passed) {pending = matches(resource, poll?.resultPending);break;}
      }
    }
    if (passed || !pending || attempts === maxAttempts) return { passed: Boolean(passed), attempts, document: currentDocument };
    await wait(poll.intervalMs, signal, deadline);
  }
}
