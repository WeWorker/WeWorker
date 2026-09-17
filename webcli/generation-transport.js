import { GENERATION_STATUSES } from './generation-harness/constants.js';
import { sanitizeGenerationValue } from './generation-harness/run-store.js';
import { attributeGenerationFailure } from './generation-harness/failure-attribution.js';

export function createGenerationEventTransport(event) {
  const data = event?.data || {};
  const safeData = event?.type === 'state_changed'
    ? {
        from: data.from,
        to: data.to,
        currentAction: data.currentAction,
      }
    : event?.type === 'step_recorded'
      ? { action: data.action, stepCount: data.stepCount, phase: data.phase }
      : event?.type === 'model_called'
        ? { modelCallCount: data.modelCallCount, phase: data.phase, step: data.step }
        : event?.type === 'revision_recorded'
          ? { revisionCount: data.revisionCount }
          : {};
  return {
    timestamp: event?.timestamp,
    runId: event?.runId,
    type: event?.type,
    data: safeData,
  };
}

export function createGenerationRunTransportSnapshot(snapshot, { rootDir = '' } = {}) {
  if (!snapshot) return snapshot;
  const artifacts = { ...(snapshot.artifacts || {}) };
  delete artifacts.draftHistory;
  delete artifacts.workspace;
  delete artifacts.previewAdapter;
  const failureAttribution = attributeGenerationFailure(snapshot);
  return sanitizeGenerationValue({
    ...snapshot,
    input: {
      tabId: Number.isInteger(snapshot.input?.tabId) ? snapshot.input.tabId : null,
    },
    artifacts,
    ...(failureAttribution ? { failureAttribution } : {}),
    result: snapshot.status === GENERATION_STATUSES.COMPLETED ? snapshot.result : null,
  }, { rootDir });
}
