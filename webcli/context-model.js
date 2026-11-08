import { createHash, randomUUID } from 'node:crypto';

export const LIMITS = Object.freeze({ history: 3, idle: 86400000, evidence: 1800000, objects: 20,
  round: 49152, file: 262144, guards: 20, guardBytes: 16384, files: 1000,
  mainBytes: 268435456, rootBytes: 536870912, input: 8192 });
export class ContextError extends Error {
  constructor(code, exitCode = 3) { super(code); this.code = code; this.exitCode = exitCode; }
}
export const fail = (code, exitCode) => { throw new ContextError(code, exitCode); };
export const bytes = value => Buffer.byteLength(JSON.stringify(value));
export const fingerprint = value => createHash('sha256').update(value).digest('hex');
export function contextKey(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail('context_invalid_id', 2);
  return fingerprint(id);
}
export function newState(now = Date.now()) {
  return { storageVersion: 1, sessionEpoch: randomUUID(), revision: 0, createdAt: now,
    lastInteractionAt: now, status: 'active', rounds: [], activeRound: null, snapshots: {},
    currentSnapshotId: null, focus: null, pendingIntent: null, preparedDecision: null, operationGuards: [] };
}
export function validateState(s) {
  if (!s || typeof s !== 'object') fail('context_corrupt');
  if (s.storageVersion !== 1) fail('context_version_unsupported');
  if (typeof s.sessionEpoch !== 'string' || !Number.isSafeInteger(s.revision) || s.revision < 0 ||
      !Number.isFinite(s.createdAt) || !Number.isFinite(s.lastInteractionAt) ||
      !Array.isArray(s.rounds) || s.rounds.length > 3 || !s.snapshots || Array.isArray(s.snapshots) ||
      !Array.isArray(s.operationGuards)) fail('context_corrupt');
  const rounds = [...s.rounds, ...(s.activeRound ? [s.activeRound] : [])];
  if (!['active', 'expired'].includes(s.status) || rounds.some(r => !r || typeof r.roundId !== 'string' ||
      !Number.isFinite(r.createdAt) || !Array.isArray(r.snapshotIds)) ||
      new Set(rounds.map(r => r.roundId)).size !== rounds.length ||
      Object.entries(s.snapshots).some(([id, x]) => !x || x.snapshotId !== id || typeof x.sourceRoundId !== 'string' ||
        !Number.isFinite(x.capturedAt) || !Array.isArray(x.entities) || x.entities.some(e => !e || typeof e.entityRef !== 'string' ||
          typeof e.businessId !== 'string' || typeof e.title !== 'string') || new Set(x.entities.map(e => e.entityRef)).size !== x.entities.length) ||
      s.operationGuards.some(g => !g || !['dispatching', 'unknown', 'acknowledged', 'verified_success', 'failed'].includes(g.status))) fail('context_corrupt');
  enforceLimits(s);
  return s;
}
export function enforceLimits(s) {
  const rounds = [...s.rounds, ...(s.activeRound ? [s.activeRound] : [])];
  if (bytes(s) > LIMITS.file || rounds.some(r => bytes(r) + Object.values(s.snapshots)
    .filter(x => x.sourceRoundId === r.roundId).reduce((size, x) => size + bytes(x), 0) > LIMITS.round) ||
      s.operationGuards.length > LIMITS.guards || bytes(s.operationGuards) > LIMITS.guardBytes ||
      Object.values(s.snapshots).some(x => !Array.isArray(x.entities) || x.entities.length > LIMITS.objects)) fail('context_limit');
}
export function expired(s, now) {
  return s.status !== 'active' || now < s.lastInteractionAt || now - s.lastInteractionAt >= LIMITS.idle;
}
export function beginRound(s, text, now, { freshRead = false } = {}) {
  if (text !== null && (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.input)) fail('context_input_limit');
  let state = 'continued';
  if (expired(s, now)) {
    if (!freshRead || s.operationGuards.some(g => ['dispatching', 'unknown', 'acknowledged'].includes(g.status))) fail('context_expired');
    for (const key of Object.keys(s)) delete s[key];
    Object.assign(s, newState(now)); state = 'reinitialized_after_expiry';
  }
  if (s.activeRound) { s.activeRound.status = 'interrupted'; s.rounds.push(s.activeRound); s.activeRound = null; }
  s.rounds = s.rounds.slice(-3);
  s.preparedDecision = null;
  s.pendingIntent = null;
  s.activeRound = { roundId: randomUUID(), text, createdAt: now, status: 'active', snapshotIds: [] };
  s.lastInteractionAt = now;
  return state;
}
export function commitRound(s) {
  if (s.activeRound) {
    s.activeRound.status = 'committed'; s.rounds.push(s.activeRound); s.activeRound = null;
    s.rounds = s.rounds.slice(-3);
  }
  const valid = new Set(s.rounds.map(r => r.roundId));
  const pinned = s.preparedDecision?.source?.snapshotId;
  for (const [id, x] of Object.entries(s.snapshots)) if (!valid.has(x.sourceRoundId) && id !== pinned) delete s.snapshots[id];
  if (s.focus && !valid.has(s.focus.sourceRoundId)) s.focus = null;
  if (s.pendingIntent && !(s.pendingIntent.sourceRoundId ? valid.has(s.pendingIntent.sourceRoundId)
    : valid.has(s.pendingIntent.roundId))) s.pendingIntent = null;
  enforceLimits(s);
}
export function sources(s, now) {
  const valid = new Set(s.rounds.map(r => r.roundId));
  return Object.values(s.snapshots).filter(x => valid.has(x.sourceRoundId) &&
    x.capturedAt <= now && now - x.capturedAt < LIMITS.evidence);
}
export function registerDisplay(s, { epoch, revision, roundId, snapshotId, order, completeness, delivered }) {
  const x = s.snapshots[snapshotId];
  if (epoch !== s.sessionEpoch || revision !== s.revision) fail('context_revision_conflict', 4);
  if (!x || x.sourceRoundId !== roundId || delivered !== true || !Array.isArray(order) ||
      order.length !== new Set(order).size || order.some(id => !x.entities.some(e => e.entityRef === id)) ||
      !['complete', 'page', 'truncated', 'unknown'].includes(completeness) ||
      (completeness === 'complete' && (x.completeness !== 'complete' || order.length !== x.entities.length))) fail('context_invalid_display', 2);
  x.display = { version: randomUUID(), order, completeness, delivered: true };
  s.currentSnapshotId = snapshotId;
  return x.display;
}
export const exact = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  return x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
}
export function matchStep(s, tool, args, decisionId, stepId) {
  const d = s.preparedDecision;
  if (decisionId || stepId) {
    if (!decisionId || !stepId || d?.decisionId !== decisionId) fail('context_stale_decision', 4);
    const step = d.steps.find(x => x.stepId === stepId && x.tool === tool && exact(x.args, args));
    if (!step || step.outcome) fail('context_stale_step', 4);
    return step;
  }
  const matches = d?.steps.filter(x => x.tool === tool && exact(x.args, args) && !x.outcome) || [];
  if (matches.length > 1) fail('context_ambiguous_step', 4);
  return matches[0] || null;
}
export function recordDispatch(s, { tool, args, roundId, decisionId, stepId, now, profile }) {
  const argsHash = fingerprint(JSON.stringify(canonical(args)));
  // Unknown outcomes block this tool even if arguments change; a fresh route cannot authorize a retry.
  if (s.operationGuards.some(g => g.tool === tool && (['dispatching', 'unknown'].includes(g.status) ||
      (g.status === 'acknowledged' && g.argsHash === argsHash)))) fail('context_operation_unresolved', 4);
  // Only settled facts free guard slots; unresolved operations are never evicted.
  s.operationGuards = s.operationGuards.filter(g => !['verified_success', 'failed'].includes(g.status));
  const guard = { operationId: randomUUID(), tool, requestId: argsHash, profile, roundId,
    decisionId: decisionId || null, stepId: stepId || null, createdAt: now, status: 'dispatching',
    argsHash };
  s.operationGuards.push(guard); enforceLimits(s);
  return guard;
}
