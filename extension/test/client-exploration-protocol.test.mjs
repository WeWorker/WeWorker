import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.resolve(testDir, '../background/service-worker.js'), 'utf8')

function analysisHarness(response) {
  const requests = []
  let state = { type: 'action_capture', tabId: 7, siteKey: 'example.com', result: {
    tabId: 7, site: 'example.com', actionName: 'like_article', finishedAt: '2026-01-01T00:00:00Z',
    capturedActions: [{ method: 'POST', url: 'https://example.com/api/like', userSelectedPrimary: true }],
  } }
  const context = vm.createContext({
    sanitizeActionCaptureResult: (value) => structuredClone(value),
    requestBridge: async (message) => { requests.push(message); return response(message) },
    persistActionCaptureToSiteMemory: async () => ({ ok: true }),
    cdpActionCaptureSessions: new Map(),
    chrome: { storage: { local: {
      get: async () => ({ actionCaptureLastResult: structuredClone(state) }),
      set: async (value) => { state = structuredClone(value.actionCaptureLastResult) },
    } } },
  })
  vm.runInContext(source.slice(source.indexOf('function actionCaptureAnalysisFailure('), source.indexOf('\n}', source.indexOf('async function finalizeActionCaptureResult(')) + 2), context)
  const msg = { id: 'retry-1', tabId: 7, siteKey: 'example.com', actionName: 'like_article', analysisContextId: 'opaque-fixture-context' }
  return { context, msg, requests, state: () => state, replace: (value) => { state = value } }
}

test('analysis retry retains captured write evidence and selection without touching the site', async () => {
  let finish
  const harness = analysisHarness(() => new Promise((resolve) => { finish = resolve }))
  const before = structuredClone(harness.state().result)
  const loading = await harness.context.retryStoredActionCaptureAnalysis(harness.msg)
  assert.equal(loading.type, 'action_capture_ai_loading')
  await assert.rejects(harness.context.retryStoredActionCaptureAnalysis(harness.msg), /仍在进行中/)
  finish({ ok: true, analysis: { model: 'glm-5.3', summary: 'complete', candidateAnalyses: [] } })
  for (let i = 0; i < 20 && harness.state().type !== 'action_capture'; i++) await new Promise(setImmediate)
  assert.equal(harness.state().type, 'action_capture')
  assert.equal(harness.state().result.actionAnalysis.model, 'glm-5.3')
  assert.deepEqual(harness.state().result.capturedActions, before.capturedActions)
  assert.equal(harness.state().result.finishedAt, before.finishedAt)
  assert.equal(harness.requests.length, 1)
  assert.equal(harness.requests[0].type, 'analyze_action_capture_result')
  assert.doesNotMatch(JSON.stringify(harness.state()), /analysisContextId|opaque-fixture-context|api_key/)
})

test('analysis transport failure keeps evidence and permits another analysis-only retry', async () => {
  let count = 0
  const harness = analysisHarness(async () => {
    if (++count === 1) throw new Error('fixture connection timeout')
    return { ok: true, analysis: { summary: 'complete', candidateAnalyses: [] } }
  })
  await harness.context.retryStoredActionCaptureAnalysis(harness.msg)
  for (let i = 0; i < 20 && harness.state().type !== 'action_capture'; i++) await new Promise(setImmediate)
  assert.equal(harness.state().result.capturedActions.length, 1)
  assert.equal(harness.state().result.actionAnalysis.aiError, 'fixture connection timeout')
  await harness.context.retryStoredActionCaptureAnalysis({ ...harness.msg, id: 'retry-2' })
  for (let i = 0; i < 20 && harness.state().type !== 'action_capture'; i++) await new Promise(setImmediate)
  assert.equal(harness.state().result.actionAnalysis.analysisSource, 'ai')
  assert.equal(harness.requests.length, 2)
})

test('output exhaustion stays visible and retry refuses unrelated or missing capture evidence', async () => {
  const harness = analysisHarness(async () => ({ ok: false, code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', error: 'fixture output limit', details: { outputLimit: 2200 } }))
  await assert.rejects(harness.context.retryStoredActionCaptureAnalysis({ ...harness.msg, siteKey: 'other.example.com' }), /不匹配/)
  assert.equal(harness.requests.length, 0)
  await harness.context.retryStoredActionCaptureAnalysis(harness.msg)
  for (let i = 0; i < 20 && harness.state().type !== 'action_capture'; i++) await new Promise(setImmediate)
  assert.equal(harness.state().result.actionAnalysis.errorCode, 'MODEL_OUTPUT_LIMIT_EXCEEDED')
  assert.equal(harness.state().result.actionAnalysis.outputLimit, 2200)
  harness.replace(null)
  await assert.rejects(harness.context.retryStoredActionCaptureAnalysis(harness.msg), /没有保留的捕获证据/)
})

test('late analysis does not overwrite a newer capture state', async () => {
  let finish
  const harness = analysisHarness(() => new Promise((resolve) => { finish = resolve }))
  await harness.context.retryStoredActionCaptureAnalysis(harness.msg)
  harness.replace({ type: 'action_capture', tabId: 8, result: { site: 'other.example.com' } })
  finish({ ok: true, analysis: { candidateAnalyses: [] } })
  await new Promise(setImmediate)
  assert.equal(harness.state().tabId, 8)
})

test('capture analysis passes only an ephemeral context ID and never stores it in results', async () => {
  assert.match(source, /'action_capture_model_context_v1'/)
  const startHandler = source.slice(source.indexOf("} else if (msg.type === 'exploration_action_capture_start')"), source.indexOf("} else if (msg.type === 'exploration_action_capture_stop')"))
  assert.match(startHandler, /finalizeActionCaptureResult\(captureResult,\s*\{\s*timeoutMs: 120000,\s*analysisContextId: msg\.analysisContextId/)
  assert.doesNotMatch(startHandler, /modelConfig|api_key/)
  const requests = []
  const persisted = []
  const context = vm.createContext({
    sanitizeActionCaptureResult: (value) => value,
    requestBridge: async (message) => { requests.push(message); return { ok: true, analysis: { model: 'glm-5.3', candidateAnalyses: [] } } },
    persistActionCaptureToSiteMemory: async (value) => { persisted.push(JSON.stringify(value)); return { ok: true } },
  })
  const functions = source.slice(source.indexOf('function actionCaptureAnalysisFailure('), source.indexOf('\n}', source.indexOf('async function finalizeActionCaptureResult(')) + 2)
  vm.runInContext(functions, context)
  const result = await context.finalizeActionCaptureResult({ site: 'example.com', capturedActions: [] }, { analysisContextId: 'opaque-fixture-id' })
  assert.equal(requests[0].analysisContextId, 'opaque-fixture-id')
  assert.equal(requests[0].captureResult.analysisContextId, undefined)
  assert.equal(result.actionAnalysis.model, 'glm-5.3')
  assert.doesNotMatch(JSON.stringify(result), /opaque-fixture-id|analysisContextId|modelConfig|api_key/)
  assert.doesNotMatch(persisted.join(''), /opaque-fixture-id|analysisContextId/)
  await context.finalizeActionCaptureResult({ site: 'example.com', capturedActions: [] })
  assert.equal(Object.hasOwn(requests[1], 'analysisContextId'), false)
})

test('extension advertises passive exploration and lists only explorable tabs', () => {
  assert.match(source, /'passive_exploration_v1'/)
  assert.match(source, /'safe_api_probe_v1'/)
  assert.match(source, /'api_replay_v1'/)
  assert.match(source, /'action_capture_v1'/)
  assert.match(source, /function buildExtensionHello\(extra = \{\}\)/)
  assert.match(source, /msg\.type === 'exploration_list_tabs'/)
  assert.match(source, /filter\(\(tab\) => Number\.isInteger\(tab\.id\) && shouldHandleTabUrl\(tab\.url\)\)/)
  assert.match(source, /type: 'call_tool_result', id: msg\.id, result: \{ tabs: explorableTabs \}/)
})

test('candidate replay is capture-bound and blocks write-like requests', () => {
  assert.match(source, /msg\.type === 'exploration_replay_candidate'/)
  assert.match(source, /API_REPLAY_REQUIRES_CAPTURED_REQUEST/)
  assert.match(source, /API_REPLAY_WRITE_SIGNAL_BLOCKED/)
  assert.match(source, /credentials: 'include'/)
  assert.match(source, /world: 'MAIN'/)
  assert.match(source, /maxBytes: 16384/)
})

test('candidate replay write detection does not reject read-only bookTime parameters', () => {
  const writeSignalRe = /(?:^|[^a-z0-9])(approve|book|buy|cancel|commit|create|delete|edit|finish|mutation|pay|publish|reject|reserve|save|submit|update|upload)(?:$|[^a-z0-9])/i
  assert.equal(writeSignalRe.test('/meetingrooms/getRooms?bookTime=2026-01-01'), false)
  assert.equal(writeSignalRe.test('/meetingrooms/book?room=1106'), true)
  assert.equal(writeSignalRe.test('/meetings/cancel?booking=1'), true)
})

test('generation preview can resolve capture-bound arguments without persisting them', () => {
  assert.match(source, /function findCaptureBoundEntry\(tabId, endpointFamily, contract = \{\}\)/)
  assert.match(source, /selectCompatibleCaptureBoundEntry\(candidates, contract\)/)
  assert.match(source, /function buildCaptureBoundArguments\(entry, tool, testCase\)/)
  assert.match(source, /CAPTURE_BOUND_SENSITIVE_PARAM_RE/)
  assert.match(source, /CAPTURE_BOUND_ARGUMENTS_NOT_FOUND/)
  assert.match(source, /runtimeArguments = buildCaptureBoundArguments\(capturedEntry, tool, testCase\)/)
  assert.match(source, /arguments: testCase\.arguments \|\| \{\}/)
  assert.doesNotMatch(source, /arguments: runtimeArguments/)
})

test('safe API probing exposes only semantic read candidates and returns Network deltas', () => {
  const injector = fs.readFileSync(path.resolve(testDir, '../content/injector.js'), 'utf8')
  assert.match(source, /msg\.type === 'exploration_safe_actions_inspect'/)
  assert.match(source, /msg\.type === 'exploration_safe_probe_run'/)
  assert.match(source, /runSafeApiProbe\(/)
  assert.match(source, /buildActionNetworkDelta\(step, deltaEntries\)/)
  assert.match(injector, /allowedKinds: \['search', 'filter', 'pagination'\]/)
  assert.match(injector, /SAFE_DATE_FILTER_RE/)
  assert.match(injector, /function nextDateValue\(input\)/)
  assert.match(injector, /function findSafeSearchTrigger\(scope, input = null\)/)
  assert.match(injector, /findSafeSearchTrigger\(scope, input\)/)
  assert.match(injector, /element\.parentElement === input\.parentElement/)
  assert.match(injector, /inputValue: nextDateValue\(input\)/)
  assert.match(injector, /candidate\.inputValue/)
  assert.match(injector, /labelParts\.some\(\(part\) => SAFE_NEXT_RE\.test\(part\)\)/)
  assert.match(injector, /writeActionsBlocked: true/)
  assert.match(injector, /UNSAFE_ACTION_RE/)
  assert.doesNotMatch(injector, /allowedKinds:.*submit/)
})

test('client action capture exposes start, stop and state polling over the native bridge', () => {
  assert.match(source, /msg\.type === 'exploration_action_capture_start'/)
  assert.match(source, /msg\.type === 'exploration_action_capture_stop'/)
  assert.match(source, /msg\.type === 'exploration_action_capture_get'/)
  assert.match(source, /msg\.type === 'exploration_action_capture_select'/)
  assert.match(source, /msg\.type === 'exploration_action_capture_clear'/)
  assert.match(source, /runActionCaptureWorkflow\(/)
  assert.match(source, /finalizeActionCaptureResult\(/)
  assert.match(source, /selectStoredActionCapturePrimaryCandidate\(/)
  assert.match(source, /action_capture_stopping/)
  assert.match(source, /ACTION_CAPTURE_SESSION_LOST/)
  assert.match(source, /completionReason === 'target_tab_closed'/)
  assert.match(source, /actionCaptureSession\.requestStop\('target_tab_closed'\)/)
  assert.match(source, /captureReadRequests: true/)
  assert.match(source, /allowRead: session\.captureReadRequests/)
  assert.match(source, /onReady: resolveCaptureReady/)
  assert.match(source, /await Promise\.race\(\[\s*captureReady/)
  assert.match(source, /const unique = new Map\(\)/)
  assert.match(source, /const key = `\$\{method\} \$\{String\(entry\?\.url \|\| ''\)\} \$\{String\(entry\?\.requestBodyPreview \|\| ''\)\}`/)
  assert.match(source, /requestBodyFullSize/)
  assert.match(source, /requestBodyTruncated/)
  assert.match(source, /function buildSafeRequestEvidence/)
  assert.match(source, /bodyKind:\s*'opaque'/)
  assert.match(source, /function sanitizeActionCaptureResult/)
})

test('client passive capture bypasses the plugin-side model analysis', () => {
  const handlerStart = source.indexOf("msg.type === 'exploration_capture_passive'")
  assert.ok(handlerStart >= 0)
  const handlerEnd = source.indexOf('} else if', handlerStart + 20)
  const handler = source.slice(handlerStart, handlerEnd)
  assert.match(handler, /runExploreWorkflow\(\{ tabId: msg\.tabId/)
  assert.doesNotMatch(handler, /runLegacyActiveExploreWorkflow/)
  assert.doesNotMatch(handler, /enhanceExplorationResultWithAI/)
})

test('persisted site memory keeps structural evidence instead of captured response values', () => {
  assert.match(source, /function structuralizeStoredTextUrls\(value\)/)
  assert.match(source, /responseHints: extractStoredActionResponseHints\(entry\.responsePreview\)/)
  assert.match(source, /responseHints: mergeStoredActionResponseHints\(candidate\.responseHints, extractStoredActionResponseHints\(candidate\.responsePreview\)\)/)
  assert.match(source, /responsePreview:\s*undefined/)
  assert.match(source, /keywordSeed:\s*''/)
  assert.doesNotMatch(source, /requestBody:\s*entry\.requestBodyPreview,\s*responsePreview:\s*entry\.responsePreview/)
})

test('client generation can refresh tabs after publishing a v1 adapter', () => {
  assert.match(source, /msg\.type === "refresh_adapter_tabs"/)
assert.match(source, /refreshAdapterTabs\(String\(msg\.siteKey \|\| ''\)\.trim\(\)/)
assert.match(source, /function sendTabMessage\(tabId, message, timeoutMs = 2000\)/)
assert.match(source, /tab message timed out after \$\{timeoutMs\}ms/)
assert.match(source, /const adapterManifest = await loadAdapterManifestAnywhere\(adapterId\)/)
assert.match(source, /directAdapterLoadPromises\.clear\(\)/)
assert.match(source, /chrome\.offscreen\?\.closeDocument\?\.\(\)/)
assert.match(source, /clearTabInjectedAdapters\(tab\.id\)/)
assert.match(source, /chrome\.tabs\.reload\(tab\.id\)/)
assert.match(source, /waitForTabLoad\(tab\.id, 15000\)/)
assert.doesNotMatch(source, /async function refreshAdapterTabs[\s\S]*?resolveAdapterForHostname\(hostname\)[\s\S]*?for \(const tab of matchedTabs\)/)
  assert.match(source, /type: "call_tool_result", id: msg\.id, result/)
})
