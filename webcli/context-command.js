import { ContextStore } from './context-store.js';
import { ContextError, fail, beginRound, commitRound, matchStep, registerDisplay, expired, sources, recordDispatch, LIMITS } from './context-model.js';
import { loadContextCatalog, canonicalTool, callRole, captureResult, snapshotDisplay } from './context-profile.js';
import { routeContext } from './context-router.js';
import { choose } from './context-choice.js';
import { routeRequest } from './auto-route-decision-tree.js';
import { businessArgs } from './business-args.js';

function requestText(tokens, catalog) {
  const literal = tokens.indexOf('--');
  const prefix = literal === -1 ? tokens : tokens.slice(0, literal);
  if (prefix.some(t => t.startsWith('--') && t !== '--json')) fail('context_invalid_flag', 2);
  const input = [...prefix.filter(t => t !== '--json'), ...(literal === -1 ? [] : tokens.slice(literal + 1))];
  if (catalog.entries?.some(t => t.adapterId === input[0])) input.shift();
  return input.join(' ');
}
const readSucceeded = completed => completed.exitCode === 0 && !completed.raw?.error && completed.raw?.success !== false && completed.raw?.ok !== false;
function validateReadBinding(s, catalog, now) {
  const binding = s.preparedDecision.source;
  if (!binding) return;
  const evidence = s.snapshots[binding.snapshotId];
  if (!evidence || evidence.capturedAt > now || now - evidence.capturedAt >= LIMITS.evidence) fail('context_evidence_expired');
  if (evidence.profile !== (catalog.resultBindings?.get(evidence.tool)?.fingerprint || catalog.profile)) fail('context_tool_profile_unavailable');
  if (!evidence.display?.delivered || evidence.display.version !== binding.displayVersion) fail('context_stale_display', 4);
}

export async function runContextRoute(tokens, controls, { store = new ContextStore(), catalog, provider, singleTurn = routeRequest } = {}) {
  catalog ??= await loadContextCatalog();
  provider ??= choose;
  const text = requestText(tokens, catalog);
  return store.transaction(controls.context, async (s, { created }) => {
    const result = await routeContext(s, text, { now: store.now(), catalog, replyTo: controls['reply-to'], provider });
    if (result.kind === 'unrelated') {
      const knownSite = catalog.routeAdapters?.find(adapter => adapter.id === tokens[0])?.id;
      result.singleTurnRoute = await singleTurn(text, { adapters: catalog.routeAdapters, knownSite });
    }
    result.context.id = controls.context;
    for (const item of s.preparedDecision?.steps || []) if (item.invocation) item.invocation.context = controls.context;
    if (result.singleTurnRoute?.invocation) result.singleTurnRoute.invocation.context = controls.context;
    if (created) result.context.state = 'created';
    return result;
  });
}

// capture runs on the actual raw Runner result, before business formatting or host offload.
export async function runContextCall({ id, tool, args, decision, step, invoke, deliver }, { store = new ContextStore(), catalog } = {}) {
  catalog ??= await loadContextCatalog();
  args = businessArgs(args);
  tool = canonicalTool(tool, catalog);
  const executionSnapshot = catalog.entries?.find(entry => entry.name === tool)?.executionSnapshot;
  const execute = () => executionSnapshot ? invoke(tool, args, { executionSnapshot }) : invoke(tool, args);
  const role = callRole(tool, args, catalog);
  const untracked = role === 'unsupported' && !decision && !step;

  const declared = catalog.resultBindings?.has(tool) || [...(catalog.resultBindings?.values() || [])].some(b => b.results.some(r => r.actions.some(a => a.tool === tool)));
  const write = role === 'approve';
  if (!untracked && (role === 'unsupported' || (!declared && !catalog.entries?.some(entry => entry.name === tool) && (!catalog.tools[role] || catalog.tools[role].name !== tool)))) fail('context_tool_profile_unavailable');
  let completed, receipt, toolOutcome, durableRevision;
  try {
    await store.transaction(id, async (s, { persist, created }) => {
      const matched = matchStep(s, tool, args, decision, step);
      if (write && matched && s.preparedDecision.executionEligibility === 'blocked') fail('context_write_blocked');
      if (expired(s, store.now()) && matched) fail('context_expired');
      if (matched) validateReadBinding(s, catalog, store.now());
      const lifecycle = matched ? 'continued' : beginRound(s, null, store.now(), { freshRead: true });
      const historyAvailable = sources(s, store.now()).length > 0;
      const roundId = matched ? s.preparedDecision.roundId : s.activeRound.roundId;
      const guard = write ? recordDispatch(s, { tool, args, roundId, decisionId: matched ? s.preparedDecision.decisionId : null,
        stepId: matched?.stepId, now: store.now(), profile: executionSnapshot?.digest || catalog.profile }) : null;
      if (!matched || role === 'list') { s.currentSnapshotId = null; s.focus = null; }
      // Persist the invalidated old display before I/O, including a failed refresh or process crash.
      await persist();
      durableRevision = s.revision;
      if (matched) {
        try { validateReadBinding(s, catalog, store.now()); }
        catch (e) {
          if (guard) { guard.status = 'failed'; await persist(); }
          throw e;
        }
      }
      receipt = { contextProtocolVersion: 1, contextId: id, contextState: created ? 'created' : lifecycle, historyAvailable,
        epoch: s.sessionEpoch, revision: s.revision, roundId, decisionId: matched ? s.preparedDecision.decisionId : null,
        stepId: matched?.stepId || null, snapshotId: null, operationId: guard?.operationId || null };
      try { completed = await execute(); }
      catch (e) {
        if (!write) throw e;
        completed = { raw: { error: 'context_dispatch_unknown' }, exitCode: 1, dispatched: true };
      }
      const outcome = untracked ? 'untracked' : write ? completed.dispatched === false ? 'failed' : readSucceeded(completed) ? 'acknowledged' : 'unknown'
        : readSucceeded(completed) ? 'read_success' : 'failed';
      toolOutcome = outcome;
      if (guard) guard.status = outcome;
      let snapshot;
      try {
        snapshot = captureResult(s, { tool, args, raw: completed.raw, exitCode: completed.exitCode, now: store.now(), catalog, roundId });
        if (deliver) {
          try { await deliver(completed); } catch { fail('context_delivery_failed'); }
        }
        if (snapshot && deliver) registerDisplay(s, { epoch: s.sessionEpoch, revision: s.revision, roundId,
          snapshotId: snapshot.snapshotId, order: snapshot.entities.map(e => e.entityRef), completeness: snapshot.completeness, delivered: true });
        if (matched) matched.outcome = outcome;
        else commitRound(s);
      } catch (e) {
        // The known business result must survive a capture/size failure.
        receipt = { ...receipt, reasonCode: e instanceof ContextError ? e.code : 'context_capture_failed' };
        throw e;
      }
      receipt = { ...receipt, revision: s.revision + 1, snapshotId: snapshot?.snapshotId || null,
        ...(untracked ? { reasonCode: 'context_binding_unavailable' } : {}),
        displayManifest: snapshot ? snapshotDisplay(snapshot) : null,
        displayState: snapshot ? (deliver ? 'delivered' : 'staged') : null,
        toolOutcome: outcome, contextPersistence: 'committed', retryDisposition: completed.dispatched === false ? 'safe_to_retry_before_dispatch' : 'no_automatic_retry' };
    });
    return { ...completed, receipt };
  } catch (e) {
    if (!completed) throw e;
    return { ...completed, contextExitCode: 3, receipt: { contextProtocolVersion: 1, contextId: id,
      ...receipt, revision: durableRevision, toolOutcome, contextPersistence: 'failed',
      retryDisposition: 'no_automatic_retry', reasonCode: e instanceof ContextError ? e.code : 'context_storage_failed' } };
  }
}

export async function runContextMaintenance(tokens, { store = new ContextStore() } = {}) {
  const [command, id, ...flags] = tokens;
  if (command === 'prune') {
    if (id !== '--dry-run' || flags.some(f => f !== '--json')) fail('context_usage', 2);
    return store.collect({ dryRun: true });
  }
  if (!id) fail('context_usage', 2);
  if (command === 'status' || command === 'recover') {
    if (flags.some(f => f !== '--json')) fail('context_usage', 2);
    return command === 'status' ? store.status(id) : store.recover(id);
  }
  if (command !== 'display') fail('context_usage', 2);
  const values = {};
  for (let n = 0; n < flags.length; n += 2) {
    const name = flags[n];
    if (!['--epoch', '--round', '--snapshot', '--revision', '--args'].includes(name) || Object.hasOwn(values, name) || flags[n + 1] === undefined) fail('context_usage', 2);
    values[name] = flags[n + 1];
  }
  if (Object.keys(values).length !== 5 || !/^\d+$/.test(values['--revision'])) fail('context_usage', 2);
  let display;
  try { display = JSON.parse(values['--args']); } catch { fail('context_invalid_display', 2); }
  if (!display || typeof display !== 'object') fail('context_invalid_display', 2);
  return store.transaction(id, s => ({ contextProtocolVersion: 1, display: registerDisplay(s, {
    epoch: values['--epoch'], revision: Number(values['--revision']), roundId: values['--round'], snapshotId: values['--snapshot'],
    order: display.orderedEntityRefs, completeness: display.completeness, delivered: display.delivered,
  }), revision: s.revision + 1 }), { create: false, epoch: values['--epoch'], revision: Number(values['--revision']) });
}
