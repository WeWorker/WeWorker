import { workflowOriginRoutes, workflowOriginTargets } from './page-workflow-origins.js';
import { matchesPagePath, resolvePageDestination } from './page-navigation.js';
import { normalizeWorkflowControl, workflowConditionMatches, workflowValue, usesWorkflowControl } from './page-workflow-control.js';
import { navigationParameters } from './page-navigation-parameters.js';
import { workflowContextKey, validateWorkflowFrameSequence } from './page-workflow-frames.js';
import { resolvePageFrame } from './page-frame-context.js';
import { executeFramePageQuery } from './page-frame-query.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const namesFor = query => query.mode === 'navigate' ? navigationParameters(query).map(binding => binding.name) : query.trigger?.parameter ? [query.trigger.parameter] : [];
export function pageWorkflowContract(source) {
  return { steps: source.steps.map(({ pathname, query, ...control }) => {
    const { result, ...action } = query;
    return { pathname, query: action, ...control };
  }), timeoutMs: source.timeoutMs };
}
export function pageRoutePaths(route) {
  return [route.pathname, ...(route.additionalPaths || []), ...(route.navigation ? [route.navigation.pathname] : []),
    ...(route.workflow?.steps || []).map(step => step.query.resultPathname)];
}

export function pageRouteTargets(route) {
  if (route.workflow) return workflowOriginTargets(route.workflow, route.origin, route.pathname);
  return [{ origin: route.origin, pathname: route.pathname },
    ...(route.additionalPaths || []).map(pathname => ({ origin: route.origin, pathname })),
    ...(route.navigation ? [{ origin: route.navigation.resultOrigin || route.origin, pathname: route.navigation.pathname }] : [])];
}

/** A sequence has one owner and one deadline. Only observations are polled. */
export async function executePageWorkflow(options, executeStep) {
  const { chrome, tabId, payload, now } = options;
  const { source, values = {}, expectedOrigin, expectedPath } = payload;
  if (!Array.isArray(source.steps) || source.steps.length < 2 || source.steps.length > 8
    || !Number.isSafeInteger(source.timeoutMs) || source.timeoutMs < 1000 || source.timeoutMs > 30000) throw fail('INVALID_PAGE_WORKFLOW', 'Invalid workflow steps or total deadline.');
  let originRoutes;
  try { validateWorkflowFrameSequence(source.steps); originRoutes = workflowOriginRoutes(source, expectedOrigin); } catch (error) { throw fail('INVALID_PAGE_WORKFLOW', error.message); }
  const names = new Set(source.steps.flatMap(step => namesFor(step.query)));
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(name => !names.has(name))) throw fail('INVALID_PAGE_QUERY_ARGUMENT', 'Unexpected workflow parameter.');
  // Validate every parameter before dispatching the first action.
  for (let i = 0; i < source.steps.length; i++) {
    const { pathname, query } = source.steps[i];
    try { normalizeWorkflowControl(source.steps[i], i); } catch (error) { throw fail('INVALID_PAGE_WORKFLOW', error.message); }
    if (!['navigate', 'query', 'filter', 'read'].includes(query?.mode) || !query.result || query.mode === 'read' && query.resultPathname !== pathname) throw fail('INVALID_PAGE_WORKFLOW', 'Workflow paths and steps must form an ordered chain.');
    const argumentsForStep = Object.fromEntries(namesFor(query).filter(name => Object.hasOwn(values, name)).map(name => [name, values[name]]));
    if (query.mode === 'navigate') resolvePageDestination(originRoutes[i].origin, query, argumentsForStep, true);
    else if (namesFor(query).some(name => typeof values[name] !== 'string' || !values[name].trim() || values[name].length > 1000)) throw fail('INVALID_PAGE_QUERY_ARGUMENT', 'Provide every declared workflow parameter.');
  }
  const initial = new URL((await chrome.tabs.get(tabId)).url);
  const entry = source.steps[0];
  const entryTargets = entry.query.mode === 'navigate' && !entry.frames ? workflowOriginTargets(source, expectedOrigin, expectedPath) : [{ origin: expectedOrigin, pathname: expectedPath }];
  if (!entryTargets.some(target => initial.origin === target.origin && matchesPagePath(initial.pathname, target.pathname))) throw fail('PAGE_QUERY_ROUTE_CHANGED', 'Open a declared workflow entry page.');
  const deadline = now() + source.timeoutMs;
  const assertRunning = () => {
    options.assertRunning();
    if (now() >= deadline) throw fail('PAGE_WORKFLOW_TIMEOUT', 'Workflow deadline reached; remaining steps were not dispatched.');
  };
  let completedSteps = 0, output, skippedSteps = 0, executedActions = 0, collectionBytes = 0;
  const pages = new Map(), framePins = new Map();
  const collections = [], controlled = usesWorkflowControl(source);
  const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  const condition = (data, expected) => {
    try { return workflowConditionMatches(data, expected); }
    catch (error) { throw fail('PAGE_WORKFLOW_CONDITION', error.message); }
  };
  try {
  for (const [index, step] of source.steps.entries()) {
    let iterations = 0;
    try {
      assertRunning();
      const key = workflowContextKey(step);
      let pin = framePins.get(key);
      if (step.frames && !pin) {
        pin = await resolvePageFrame({ chrome, tabId, frames: step.frames, ensureCdpAttached: options.ensureCdpAttached, assertRunning, deadline });
        framePins.set(key, pin);
      }
      const currentPage = async () => pin ? pin.snapshot() : { url: (await chrome.tabs.get(tabId)).url };
      const current = new URL((await currentPage()).url);
      const assertPage = async url => {
        const previousPage = pages.get(key);
        if (!previousPage) return;
        const frame = pin ? await pin.tree() : (await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree'))?.frameTree?.frame;
        if (url.href !== previousPage.url || frame?.id !== previousPage.frameId || frame?.loaderId !== previousPage.loaderId) {
          throw fail('PAGE_QUERY_ROUTE_CHANGED', 'The completed document was replaced; remaining actions were not dispatched.');
        }
      };
      await assertPage(current);
      const startPath = index === 0 && step.query.mode === 'navigate' && !pin ? initial.pathname : step.pathname;
      const startOrigin = index === 0 && step.query.mode === 'navigate' && !pin ? initial.origin : originRoutes[index].origin;
      if (current.origin !== startOrigin || !matchesPagePath(current.pathname, startPath)) throw fail('PAGE_QUERY_ROUTE_CHANGED', 'Page changed between workflow steps.');
      const collected = [], identities = new Map();
      const collect = result => {
        const spec = step.repeat?.collect;
        if (!spec) return { rows: 0, added: 0 };
        let rows;
        try { rows = workflowValue(result?.data, spec.path); } catch (error) { throw fail('PAGE_WORKFLOW_COLLECTION', error.message); }
        if (!Array.isArray(rows)) throw fail('PAGE_WORKFLOW_COLLECTION', 'The collection result must be an array.');
        let added = 0;
        for (const row of rows) {
          let id;
          try { id = workflowValue(row, spec.identityPath); } catch (error) { throw fail('PAGE_WORKFLOW_COLLECTION', error.message); }
          if (!(typeof id === 'string' && id.length > 0 || typeof id === 'number' && Number.isFinite(id))) throw fail('PAGE_WORKFLOW_COLLECTION', 'Every collected row needs a public scalar identity.');
          const key = JSON.stringify([typeof id, id]), serialized = canonical(row);
          if (identities.has(key)) {
            if (identities.get(key) !== serialized) throw fail('PAGE_WORKFLOW_IDENTITY_CONFLICT', 'A repeated identity returned different fields; partial rows were not returned.');
            continue;
          }
          if (collected.length >= spec.maxItems) throw fail('PAGE_WORKFLOW_COLLECTION_LIMIT', 'Collection limit reached; partial rows were not returned.');
          collectionBytes += new TextEncoder().encode(serialized).byteLength;
          if (collectionBytes > 1000000) throw fail('PAGE_WORKFLOW_COLLECTION_LIMIT', 'Workflow collections exceed one million bytes; partial rows were not returned.');
          identities.set(key, serialized); collected.push(row); added++;
        }
        return { rows: rows.length, added };
      };
      if (step.repeat?.collect?.includePrevious) collect(output);
      const shouldRun = !step.when || condition(output?.data, step.when);
      if (!shouldRun) skippedSteps++;
      let finished = !shouldRun;
      for (; shouldRun && iterations < (step.repeat?.maxIterations || 1);) {
        assertRunning();
        const currentUrl = new URL((await currentPage()).url);
        await assertPage(currentUrl);
        const budget = deadline - now();
        if (budget < 1000) throw fail('PAGE_WORKFLOW_TIMEOUT', 'Workflow deadline reached before the next action.');
        const query = { ...step.query, ...(step.query.mode === 'navigate' && currentUrl.origin !== originRoutes[index].resultOrigin ? { resultOrigin: originRoutes[index].resultOrigin } : {}), timeoutMs: Math.min(step.query.timeoutMs, budget) };
        output = await (pin ? executeFramePageQuery : executeStep)({ ...options, assertRunning, ...(pin ? { frameContext: pin } : {}), payload: { source: query, values: Object.fromEntries(namesFor(query).map(name => [name, values[name]])),
          expectedOrigin: currentUrl.origin, expectedPath: currentUrl.pathname, metadataOnly: !controlled && payload.metadataOnly && index === source.steps.length - 1 }, allowStaticNavigation: true, captureWorkflowPage: true });
        executedActions++; iterations++;
        if (!output?.ok) throw fail(output?.error?.code || 'PAGE_QUERY_FAILED', output?.error?.message || 'Later steps were not dispatched.');
        assertRunning();
        const previousPage = output.internalWorkflowPage;
        if (!previousPage?.frameId || !previousPage.loaderId) throw fail('PAGE_QUERY_ROUTE_CHANGED', 'Workflow step did not retain its completed document identity.');
        pages.set(key, previousPage);
        const progress = collect(output);
        const done = !step.repeat || condition(output.data, step.repeat.until);
        if (step.repeat?.collect && progress.added === 0 && (progress.rows > 0 || !done)) throw fail('PAGE_WORKFLOW_NO_PROGRESS', 'The repeated page added no new identities; partial results were not returned.');
        if (done) { finished = true; break; }
      }
      if (!finished) throw fail('PAGE_WORKFLOW_ITERATION_LIMIT', 'The declared stop condition was not reached; no further action or partial result was returned.');
      if (step.repeat?.collect) collections.push({ stepIndex: index, iterations, path: step.repeat.collect.path, items: collected });
      completedSteps++;
    } catch (error) {
      return { ok: false, error: { code: error.code || 'PAGE_WORKFLOW_FAILED', message: error.code ? error.message : 'Unable to complete the declared workflow.',
        stepIndex: index, iteration: iterations, completedSteps, ...(controlled ? { skippedSteps, executedActions } : {}) } };
    }
  }
  const { internalWorkflowPage, ...result } = output;
  if (controlled && payload.metadataOnly) {
    const shape = (value, depth = 0) => {
      const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
      if (depth >= 8) return { type };
      if (type === 'array') return { type, length: value.length, items: value.length ? shape(value[0], depth + 1) : { type: 'unknown' } };
      if (type === 'object') return { type, properties: Object.fromEntries(Object.entries(value).filter(([key]) => /^[a-zA-Z_$][a-zA-Z0-9_$-]{0,99}$/.test(key)).map(([key, child]) => [key, shape(child, depth + 1)])) };
      return { type };
    };
    return { ok: true, shape: shape(result.data), workflow: { completedSteps, skippedSteps, executedActions, collectedCounts: collections.map(item => item.items.length) } };
  }
  return { ...result, workflow: { completedSteps, ...(controlled ? { skippedSteps, executedActions, collections } : {}) } };
  } finally { await Promise.all([...framePins.values()].map(pin => pin.release())); }
}
