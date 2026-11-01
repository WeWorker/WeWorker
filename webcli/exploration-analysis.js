import { usesWorkflowOrigins } from './page-workflow-origins.js';
import { requiresWorkflowFrameCapability } from './page-workflow-frames.js';
import { usesWorkflowControl } from './page-workflow-control.js';
import { explorationError as fail, textArg } from './exploration-commands.js';
import { usesNavigationQuery, usesNavigationHash } from './page-navigation-parameters.js';

/** Inspect structural evidence only. A successful response is not proof of a stable API. */
export function analyzeApiCandidate(candidate, index) {
  const paths = [];
  const walk = (shape, prefix = '$', depth = 0) => {
    if (!shape || depth > 6 || paths.length >= 40) return;
    paths.push({ path: prefix, type: shape.type });
    if (shape.type === 'array') walk(shape.items, prefix + '.*', depth + 1);
    if (shape.type === 'object') for (const [key, value] of Object.entries(shape.properties || {}).slice(0, 30)) walk(value, prefix + '.' + key, depth + 1);
  };
  walk(candidate.responseEvidence?.bodyShape);
  const pathname = new URL(candidate.url).pathname;
  const noise = /(?:^|[\/_-])(?:analytics|telemetry|beacon|tracking|heartbeat)(?:$|[\/_-])/i.test(pathname);
  const business = paths.some(item => /(?:\.\*\.|\.)(?:id|title|name|url|price|description|content|items|records|results|rows)$/i.test(item.path));
  const json = candidate.responseEvidence?.bodyKind === 'json';
  const reasons = [];
  let verdict;
  if (candidate.risk?.level === 'write' || candidate.requestSemantics?.operation === 'mutation') { verdict = 'excluded'; reasons.push('mutation_evidence'); }
  else if ([401, 403].includes(candidate.status)) { verdict = 'blocked'; reasons.push('authentication_or_access_denied'); }
  else if (noise) { verdict = 'noise'; reasons.push('telemetry_endpoint'); }
  else if (!(candidate.status >= 200 && candidate.status < 300)) { verdict = 'unavailable'; reasons.push('no_successful_response'); }
  else if (!json) { verdict = 'not_json'; reasons.push('no_json_structure'); }
  else {
    verdict = business ? 'likely_data' : 'maybe_data';
    reasons.push('json_structure', ...(business ? ['business_field_names'] : ['target_data_not_established']));
  }
  if (candidate.risk?.level !== 'read') reasons.push('read_semantics_not_established');
  const executable = candidate.method === 'GET' || (candidate.method === 'POST' && ['json', 'form'].includes(candidate.requestEvidence?.bodyKind));
  if (!executable) reasons.push('request_method_or_body_not_supported');
  const eligible = ['likely_data', 'maybe_data'].includes(verdict) && candidate.risk?.level === 'read' && executable;
  return { id: candidate.id, sourceApiIndex: index, url: candidate.url, method: candidate.method, status: candidate.status,
    verdict, reasons, samplePaths: paths, eligible, strategy: null,
    ...(eligible ? { strategyCandidates: ['PUBLIC_API', 'COOKIE_API', 'AUTH_API', 'EXTENSION_API', 'PAGE_FETCH'], needsExecutionAssessment: true } : {}),
    ...(candidate.risk?.level === 'write' ? { writeEligible: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(candidate.method)
      && (candidate.declared === true || (candidate.status >= 200 && candidate.status < 300)), declaredOnly: candidate.declared === true } : {}),
    contract: 'unverified', ...(pathname.includes(':id') ? { requiresPathParameters: true } : {}) };
}

export function normalizeStrategyNote(tool, strategy) {
  const note = tool.strategyNote;
  if (note === undefined) return undefined;
  if (!note || typeof note !== 'object' || Array.isArray(note) || Object.keys(note).some(key => !['reason', 'alternatives', 'limitations'].includes(key))) throw fail('INVALID_STRATEGY_NOTE', 'Provide reason and optional alternatives/limitations as public author notes.');
  const reason = textArg(note.reason, 'strategy reason', 2000);
  const result = { reason };
  for (const key of ['alternatives', 'limitations']) if (note[key] !== undefined) result[key] = textArg(note[key], key, 2000);
  if (['PAGE_FETCH', 'INTERCEPT', 'EXTENSION_API'].includes(strategy) && !result.alternatives) throw fail('INVALID_STRATEGY_NOTE', 'Explain why the alternatives do not meet the target, including host HTTP and the existing Extension background runtime; authentication alone does not require a website tab.');
  return result;
}

export function analyzeExploration(run, capabilities = []) {
  const candidates = run.candidates.map(analyzeApiCandidate);
  if (run.mode === 'http') for (const candidate of candidates) if (candidate.eligible) candidate.strategy = run.http.strategy;
  const pages = (run.pageSources || []).map(item => {
    const strategy = item.source.strategy;
    const requiredCapability = requiresWorkflowFrameCapability(item.source) ? 'page_workflow_frames_v1' : usesWorkflowOrigins(item.source) ? 'page_navigation_origin_v1' : usesWorkflowControl(item.source) ? 'page_workflow_control_v1' : usesNavigationHash(item.source) ? 'page_navigation_hash_v1' : usesNavigationQuery(item.source) ? 'page_navigation_query_v1' : item.source.mode === 'workflow' ? 'page_workflow_v1' : item.source.mode === 'navigate' ? 'page_navigation_v1' : item.source.mode === 'query' ? 'page_query_v1' : strategy === 'INTERCEPT' ? 'intercept_read_v1' : 'page_sources_v1';
    return { id: item.id, strategy, mode: item.source.mode || 'read', contract: strategy === 'INTERCEPT' ? 'internal-unstable' : 'visible-ui',
      route: { origin: item.expectedOrigin, pathname: item.expectedPath }, observedAt: item.observedAt, requiredCapability,
      available: capabilities.includes(requiredCapability), reason: item.reason };
  });
  const errors = [...(run.error ? [run.error] : []), ...(run.runtimeSummary?.errors || []), ...(run.validation?.errors || [])];
  const codes = [...new Set(errors.map(error => String(error.code || 'VALIDATION_FAILED')))];
  const auth = codes.some(code => /LOGIN|AUTH|ACCESS_DENIED|SESSION_EXPIRED/.test(code));
  const hasBlocked = candidates.some(item => item.verdict === 'blocked');
  const nextActions = [];
  if (run.writeExecutions?.some(item => item.status === 'uncertain')) nextActions.push({ action: 'exploration.write-readback', automaticFallback: false,
    reason: 'A write may already have occurred. Inspect its effect with the independent GET; do not repeat the write.' });
  if (run.status === 'write_review_ready') nextActions.push({ action: 'exploration.write-review', reason: 'Mocks and reads passed; inspect each exact write and its before/after assertions before explicitly authorizing execution.' });
  if (!run.draft && candidates.some(item => item.writeEligible)) nextActions.push({ action: 'exploration.generate', reason: 'Explicit HTTP action plans may bind a declared or observed write. A declaration is not proof of execution; author mocks and real effect assertions.' });
  if (auth) nextActions.push({ action: 'restore_session', automaticFallback: false, reason: 'Distinguish expired/denied access from missing credential transport. Inspect the observed request authentication and existing background helpers without exporting credential values. Authentication alone does not require a page; never switch sources to bypass denied access.' });
  else if (codes.length) {
    if (codes.includes('INTERCEPT_DOCUMENT_CHANGED')) nextActions.push({ action: 'exploration.query', reason: 'The read control replaces the document. Observe its same-origin result route and DOM/state before replanning.' });
    else if (codes.some(code => /PAGE_(QUERY|SOURCE|FIELD)|INTERCEPT_(TARGET|TIMEOUT|AMBIGUOUS)/.test(code))) nextActions.push({ action: 'browser.state', reason: 'Inspect the current target and result semantics before choosing another observed source.' });
    else nextActions.push({ action: 'exploration.draft-read', reason: 'Inspect the failing command and authored output contract; HTTP/schema failures need diagnosis before changing strategy.' });
    if (run.draft && !run.repairScope) nextActions.push({ action: 'exploration.replan', reason: 'Preserve this attempt before collecting another source. Revalidation and a new review are required.' });
  }
  if (hasBlocked) nextActions.push({ action: 'inspect_access', automaticFallback: false, reason: 'Observed 401/403 is not evidence that DOM or another endpoint is authorized; inspect the intended source and current session.' });
  if (!auth && pages.some(item => item.available)) nextActions.push({ action: run.draft ? 'exploration.draft-read' : 'exploration.generate', reason: 'Observed DOM/state or query sources are available. Choose the source matching the target and document its limitations.' });
  if (!auth && candidates.some(item => item.eligible)) nextActions.push({ action: run.draft ? 'exploration.draft-read' : 'exploration.generate', reason: 'Inspect candidate fields and authored verification cases. Browser traffic alone does not prove a public or official API contract.' });
  if (!pages.length && !candidates.some(item => item.eligible || item.writeEligible)) nextActions.push(run.mode === 'http'
    ? { action: 'exploration.request', reason: 'Choose a documented or known read endpoint and collect an actual HTTP response; declarations alone cannot be generated.' }
    : { action: 'browser.state', reason: 'No supported data source is established. Inspect visible content or public page state, then observe it.' });
  const selected = (run.plan?.tools || []).map(tool => ({ name: tool.name, strategy: tool.strategy || 'PAGE_FETCH',
    contract: ['UI_SELECTOR', 'DOM_STATE'].includes(tool.strategy) ? 'visible-ui' : 'internal-unstable',
    sourceApiIndexes: tool.sourceApiIndexes, sourcePageId: tool.sourcePageId,
    requiresWebsitePage: !['PUBLIC_API', 'COOKIE_API', 'AUTH_API', 'EXTENSION_API'].includes(tool.strategy),
    strategyNote: tool.strategyNote || null, needsRationale: !tool.strategyNote }));
  const actions = ['created', 'collecting', 'validating', 'installing', 'verifying_write'].includes(run.status)
    ? [{ action: 'exploration.get', reason: 'Wait for the active operation before changing the draft or evidence.' }]
    : ['installed', 'cancelled'].includes(run.status)
      ? [{ action: 'exploration.trace', reason: 'This task is terminal. Read its history and start a new task for further work.' }]
      : nextActions;
  return { taskId: run.taskId, author: 'calling-agent', candidates, pages, selected, failures: { codes, authenticationRequired: auth }, nextActions: actions,
    strategies: [
      { strategy: 'PUBLIC_API', available: true, reason: 'Independent host HTTP. Requires explicit rationale and authored cases proving credential-free execution.' },
      { strategy: 'AUTH_API', available: true, reason: 'Independent host HTTP with declared environment credentials (Bearer/header/Basic/HMAC). Host environment must supply the values; authored cases required.' },
      { strategy: 'COOKIE_API', available: capabilities.includes('http_credentials_v1'), reason: 'Independent host HTTP with explicitly named browser cookies and optional CSRF mapping. Requires http_credentials_v1 and authored cases.' },
      { strategy: 'EXTENSION_API', available: run.mode !== 'http' && capabilities.includes('background_preview_v1'), runtimeAvailable: capabilities.includes('adapter_background_v1'),
        requiresWebsitePage: false, requiresBrowser: true, reason: 'Existing Extension background runner and credential/backend helpers. Author the observed authentication contract, then validate without page helpers. Older background adapters keep their normal execution even if preview capability is absent.' },
      ...['UI_SELECTOR', 'DOM_STATE', 'PAGE_FETCH', 'INTERCEPT'].map(strategy => ({ strategy, available: run.mode !== 'http' })),
    ],
    guidance: 'Inspect installed execution metadata and request authentication before choosing a strategy. Prefer an evidenced API path without a business page when it meets the task; explain actual page dependencies. Browser login state is not a website-tab requirement. Preserve existing background execution during repair. Recommendations are structural hints, not semantic proof; no strategy is executed or silently substituted.' };
}
