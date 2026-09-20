import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.resolve(testDir, '../background/service-worker.js'), 'utf8')

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
