import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, createHash } from 'node:crypto';
import { verifyAdapters } from './adapter-verification.js';
import { explorationError as fail } from './exploration-commands.js';

export const DIAGNOSTIC_LIMITS = Object.freeze({ rows: 200, sectionBytes: 256 * 1024, screenshotBytes: 2 * 1024 * 1024, traceIds: 10 });
const statuses = ['created','collecting','evidence_ready','draft','validating','review_ready','installing','installed','failed','interrupted','cancelled','verifying_write','write_review_ready','preparing','dispatching','verified','uncertain','not_dispatched','running'];
const known = (value, values, fallback = 'unknown') => values.includes(value) ? value : fallback;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const diagnosticCodes = ['HTTP_ERROR','API_ERROR','INVALID_RESPONSE','INVALID_ARGS','RUNTIME_EXCEPTION','TOOL_TIMEOUT','SESSION_EXPIRED','TAB_CHANGED','PROFILE_DISCONNECTED','WRITE_INTERRUPTED','VALIDATION_FAILED','ADAPTER_CONTENT_CHANGED','EXPLORATION_FAILED'];
const iso = value => Number.isFinite(typeof value === 'number' ? value : Date.parse(value)) ? new Date(value).toISOString() : null;
const inside = (root, target) => { const rel = path.relative(path.resolve(root), target); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };

// Check every ancestor, including junctions and dangling links. Do not mkdir -p,
// follow a user-selected link, overwrite, roll back or delete partial exports.
export function checkDiagnosticDirectory(directory, protectedRoots = []) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')
      || directory.split(/[\\/]/).some(p => p === '..' || p === '.') || /^[/\\]{2}/.test(directory)) throw fail('EXPORT_DIRECTORY_INVALID', 'Select an absolute new directory with an existing parent, without traversal or links.');
  const target = path.resolve(directory), parent = path.dirname(target);
  if (target === parent || /[:*?"<>|\x00-\x1f]/.test(path.basename(target)) || /[. ]$/.test(target)
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(path.basename(target))) throw fail('EXPORT_DIRECTORY_INVALID', 'Select a regular directory name.');
  for (let item = parent; ; item = path.dirname(item)) {
    let stat; try { stat = fs.lstatSync(item); } catch { throw fail('EXPORT_PARENT_UNAVAILABLE', 'The export parent must already exist.'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('EXPORT_LINK_REJECTED', 'Export ancestors must be regular directories without links.');
    if (item === path.dirname(item)) break;
  }
  if (protectedRoots.filter(Boolean).some(root => inside(root, target))) throw fail('EXPORT_MANAGED_DESTINATION', 'Export outside managed task, profile and Adapter storage.');
  try { fs.lstatSync(target); throw fail('EXPORT_DESTINATION_EXISTS', 'The destination already exists. Select a new directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}

function optionsFor(args, run, now, mode) {
  const parse = (value, fallback) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw fail('INVALID_ARGUMENT', 'since/until must be UTC ISO timestamps.');
    return Date.parse(value);
  };
  const lower = parse(args.since, Date.parse(run.createdAt)), upper = parse(args.until, now);
  if (!Number.isFinite(lower) || lower > upper || lower < Date.parse(run.createdAt) || upper > now) throw fail('INVALID_ARGUMENT', 'The inclusive window must be within task creation and export start.');
  const limit = args.limit === undefined ? 200 : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !['number','string'].includes(typeof (args.limit ?? 200))) throw fail('INVALID_ARGUMENT', 'limit must be 1–200 per source.');
  if (args.screenshot !== undefined && ![true,false,'true','false'].includes(args.screenshot)) throw fail('INVALID_ARGUMENT', 'screenshot must be boolean; true explicitly includes unredacted task viewport pixels.');
  const traceIds = args.traceIds ?? [];
  const validTraceId = id => typeof id === 'string' && (/^[a-f0-9]{12,32}$/.test(id)
    || (mode === 'http' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)));
  if (!Array.isArray(traceIds) || traceIds.length > 10 || traceIds.some(id => !validTraceId(id)) || new Set(traceIds).size !== traceIds.length) throw fail('INVALID_ARGUMENT', 'traceIds must be at most 10 unique supported call trace IDs.');
  return { lower, upper, limit, screenshot: args.screenshot === true || args.screenshot === 'true', traceIds };
}

/** An export of existing evidence, never a Runner or write-effect verifier. */
export async function exportTaskDiagnostics(service, originalRun, args) {
  const started = Date.now(), opts = optionsFor(args, originalRun, started, service.mode);
  const protectedRoots = [service.root, ...['workspaceDir','builtinDir','userDir','stateDir','packageDir','cacheDir'].map(key => service.paths[key])];
  const destination = checkDiagnosticDirectory(args.directory, protectedRoots);
  const run = structuredClone(originalRun); // One task snapshot; async collection cannot mix task revisions.
  const key = randomBytes(32), ref = value => value == null ? null : createHmac('sha256', key).update(String(value)).digest('hex').slice(0, 16);
  const caps = service.capabilities(), environment = { runtime: service.mode === 'http' ? 'host-http' : 'browser-extension', platform: process.platform,
    node: process.versions.node, profileRef: ref(caps.contextId), connected: caps.connected === true };
  const sections = {}, files = new Map();
  const window = { since: iso(opts.lower), until: iso(opts.upper), inclusive: true, appliesTo: 'retained event timestamps; state/static/history/screenshot have their own collection times' };
  const inWindow = at => { const value = typeof at === 'number' ? at : Date.parse(at); return Number.isFinite(value) && value >= opts.lower && value <= opts.upper; };
  const add = (name, source, evidence, rows = [], meta = {}) => {
    const lines = []; let bytes = 0;
    for (const row of rows.slice(0, opts.limit)) { const line = JSON.stringify(row) + '\n'; if (bytes + Buffer.byteLength(line) > DIAGNOSTIC_LIMITS.sectionBytes) break; lines.push(line); bytes += Buffer.byteLength(line); }
    const truncated = meta.truncated === true || lines.length < rows.length;
    sections[name] = { source, evidence, environment, collectedAt: new Date().toISOString(), rowLimit: opts.limit, byteLimit: DIAGNOSTIC_LIMITS.sectionBytes,
      count: lines.length, bytes, truncated, status: truncated ? 'partial' : 'available', ...meta, ...(truncated ? { truncated: true, status: 'partial' } : {}) };
    files.set(`${name}.jsonl`, lines.join(''));
  };
  const missing = (name, source, reason, status = 'missing', evidence = 'current-observation') => add(name, source, evidence, [], { status, reason });
  const eventRows = (run.events || []).filter(row => inWindow(row.at)).map(row => ({ at: iso(row.at), cursor: count(row.cursor), status: known(row.status, statuses) }));
  add('task-trace', 'exploration.trace/events', 'historical-task-record', eventRows, { truncated: (run.events[0]?.cursor || 1) > 1,
    retention: 'last 200 task transitions; missing older history cannot be reconstructed', omitted: ['event messages','goal','arguments','responses','source code','paths'] });
  add('task-state', 'exploration.get', 'historical-task-snapshot', [{ status: known(run.status, statuses), createdAt: iso(run.createdAt), updatedAt: iso(run.updatedAt),
    errorCode: run.error ? known(run.error.code, diagnosticCodes, 'UNCLASSIFIED_ERROR') : null,
    candidates: count(run.candidates?.length), plannedTools: count(run.plan?.tools?.length), revision: count((run.revisions?.length || 0) + 1),
    readCases: count(run.runtimeSummary?.executionSummary?.attempted), writeOutcomes: (run.writeExecutions || []).slice(-200).map(record => ({ at: iso(record.at), status: known(record.status, statuses), independentlyVerifiedHistorically: record.status === 'verified' })),
    currentEffectVerified: false, replayAllowed: false }], { truncated: (run.writeExecutions?.length || 0) > 200 });
  try {
    const report = await verifyAdapters({ name: run.siteKey, paths: service.paths, knowledgeDir: service.knowledge.root, now: started });
    add('adapter', 'adapter.verify (existing catalog/static inspection)', 'static-check', report.results.map(item => ({ adapterRef: ref(item.name), digest: item.digest,
      source: known(item.source, ['builtin','user','development','directory']), staticOk: item.ok === true, commands: count(item.commands), errors: item.errors?.length || 0, warnings: item.warnings?.length || 0 })),
    { status: report.staticOk && report.results.length ? 'available' : 'partial', reason: report.staticOk && report.results.length ? null : 'ADAPTER_MISSING_OR_INVALID', executed: false });
    const evidence = report.results.flatMap(item => (item.evidence || []).map(proof => ({ commandRef: ref(proof.command),
      status: known(proof.status, ['HISTORICAL_READ_CASES','HISTORICAL_WRITE_EFFECT','EVIDENCE_INVALID','EVIDENCE_MISSING','EVIDENCE_DIGEST_MISMATCH','EVIDENCE_STALE','READ_CASES_MISSING','WRITE_EFFECT_EVIDENCE_MISSING']),
      verifiedAt: iso(proof.verifiedAt), cases: count(proof.cases), currentEffectVerified: false, replayAllowed: false })));
    add('knowledge', 'adapter.verify / selected task knowledge', 'historical-author-evidence', evidence,
      { status: report.evidenceComplete ? 'available' : 'partial', reason: report.evidenceComplete ? null : 'HISTORICAL_EVIDENCE_INCOMPLETE', executed: false, currentEffectVerified: false });
  } catch { missing('adapter', 'adapter.verify', 'STATIC_INSPECTION_FAILED', 'failed', 'static-check'); missing('knowledge', 'selected task knowledge', 'KNOWLEDGE_UNAVAILABLE', 'failed', 'historical-author-evidence'); }

  const liveReason = service.mode === 'http' ? 'NOT_APPLICABLE_HOST_HTTP' : !run.browserIdentity ? 'TASK_BROWSER_IDENTITY_MISSING'
    : !caps.connected ? 'PROFILE_DISCONNECTED' : !caps.capabilities.includes('browser_diagnostics_v1') ? 'EXTENSION_UPGRADE_REQUIRED' : null;
  const read = async (command, input = {}) => {
    const response = await service.request({ type: 'browser_execute', command, tabId: run.tabId, identity: run.browserIdentity,
      args: { ...input, diagnosticOrigin: run.origin } }, command === 'screenshot' ? 15000 : 5000);
    if (!response?.ok) throw fail(response?.error?.code || 'DIAGNOSTIC_READ_FAILED', 'The task-bound observation could not be read.');
    return response.data;
  };
  const readFailure = error => known(error.code, ['SESSION_EXPIRED','TAB_CHANGED','PROFILE_DISCONNECTED','OBSERVATION_CONTEXT_EXPIRED','OBSERVATION_CURSOR_EXPIRED','TAB_BUSY','SCREENSHOT_DOCUMENT_CHANGED','SCREENSHOT_RESTORE_FAILED','SCREENSHOT_DIMENSION_MISMATCH','SCREENSHOT_INVALID','DIAGNOSTIC_ORIGIN_CHANGED','DIAGNOSTIC_READ_FAILED'], 'OBSERVATION_READ_FAILED');
  for (const channel of ['network','console']) {
    if (liveReason) { missing(channel, 'browser.events', liveReason, service.mode === 'http' ? 'not-applicable' : 'missing'); continue; }
    try {
      const data = await read('events', { channel, limit: 200, ...(channel === 'network' ? { all: true } : {}) });
      const rows = data.entries.filter(row => inWindow(row.timestamp)).map(row => channel === 'network' ? {
        at: iso(row.timestamp), sequence: count(row.sequence), source: known(row.source, ['main-target','child-frame']), endpointRef: ref(row.url),
        method: known(row.method, ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']), phase: known(row.phase, ['complete','failed','redirect','gap']),
        status: count(row.status), bytes: count(row.size), dropped: count(row.dropped), body: 'omitted' }
        : { at: iso(row.timestamp), sequence: count(row.sequence), source: known(row.source, ['main-target','child-frame']), level: known(row.level, ['log','info','debug','warning','warn','error','assert']), text: 'omitted' });
      add(channel, 'browser.events / task-bound tab', 'historical-browser-buffer', rows, { capturedAt: iso(data.capturedAt), truncated: data.truncated || data.hasMore || rows.some(row => row.phase === 'gap'),
        retention: 'last 200 channel events; pending requests and incremental bodies are not retained events', omitted: ['URLs','headers','request and response bodies','console text'] });
    } catch (error) { missing(channel, 'browser.events', readFailure(error), 'failed'); }
  }
  if (liveReason) missing('state', 'browser.state metricsOnly', liveReason, service.mode === 'http' ? 'not-applicable' : 'missing');
  else try {
    const data = await read('state', { metricsOnly: true, limit: 200 });
    add('state', 'browser.state metricsOnly / task-bound main document', 'current-observation', [{ interactiveNodes: count(data.metrics?.interactiveNodes), namedInteractiveNodes: count(data.metrics?.namedInteractiveNodes), textChars: count(data.metrics?.textChars), domText: 'omitted', currentEffectVerified: false }], { truncated: data.metrics?.truncated === true });
  } catch (error) { missing('state', 'browser.state metricsOnly', readFailure(error), 'failed'); }
  if (!opts.traceIds.length) missing('call-trace', 'explicit call trace IDs', 'TRACE_IDS_NOT_SELECTED', 'not-selected', 'historical-call-trace');
  else if (liveReason) missing('call-trace', 'extension trace buffer', liveReason, 'missing', 'historical-call-trace');
  else {
    const rows = []; let failures = 0, unknownTimes = 0, absent = 0, unavailableContent = 0, truncated = false;
    for (const traceID of opts.traceIds) try {
      const data = await read('diagnostic-trace', { traceID });
      if (!data.logs?.length) absent++;
      if (data.contentAvailable === false) unavailableContent++;
      truncated ||= data.truncated === true;
      for (const line of data.logs || []) {
        const at = /^\[(\d{4}-\d\d-\d\dT[^\]]+Z)\]/.exec(line)?.[1];
        if (!at || !iso(at)) { unknownTimes++; continue; }
        if (inWindow(at)) rows.push({ at: iso(at), traceRef: ref(traceID), message: 'omitted',
          phase: /调用失败|call_tool 错误/.test(line) ? 'call-failed' : /调用成功|call_tool 完成/.test(line) ? 'call-completed' : /收到调用|开始执行/.test(line) ? 'call-started' : 'diagnostic',
          layer: line.includes('[ServiceWorker]') ? 'extension-worker' : line.includes('[ContentScript]') ? 'task-content-script' : 'extension' });
      }
    } catch { failures++; }
    add('call-trace', 'selected extension / SW and task-tab trace buffers', 'historical-call-trace', rows, { truncated, status: 'partial', reason: 'TRACE_RETENTION_NOT_CERTIFIED',
      failedTraces: failures, missingTraces: absent, unavailableContentSources: unavailableContent, recordsWithoutUsableTime: unknownTimes, taskAssociation: 'explicit IDs only; not independently certified', retention: 'at most 100 records per SW/task-tab source per ID, 8000 characters per input line; completeness cannot be certified', completenessKnown: false });
  }
  if (!opts.screenshot) missing('screenshot', 'browser.screenshot', 'SCREENSHOT_NOT_SELECTED', 'not-selected');
  else if (liveReason) missing('screenshot', 'browser.screenshot', liveReason);
  else try {
    const release = service.tabLocks.acquire(run.tabId);
    let data; try { data = await read('screenshot', { fullPage: false }); } finally { release(); }
    if (data.mimeType !== 'image/png' || typeof data.data !== 'string' || data.data.length > Math.ceil(DIAGNOSTIC_LIMITS.screenshotBytes / 3) * 4) throw fail('SCREENSHOT_INVALID', 'Screenshot unavailable or over budget.');
    const bytes = Buffer.from(data.data, 'base64');
    if (bytes.length > DIAGNOSTIC_LIMITS.screenshotBytes || bytes.length < 24 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw fail('SCREENSHOT_INVALID', 'Invalid screenshot.');
    files.set('screenshot.png', bytes);
    add('screenshot', 'browser.screenshot / task-bound current viewport', 'current-observation', [{ width: count(data.width), height: count(data.height), pixelsRedacted: false, explicitlyRequested: true }], { pixelBytes: bytes.length, pixelByteLimit: DIAGNOSTIC_LIMITS.screenshotBytes, scope: 'current task viewport, including visible child frames; no other tabs' });
  } catch (error) { missing('screenshot', 'browser.screenshot', readFailure(error), 'failed'); }

  const timeline = [...eventRows.map(row => ({ ...row, source: 'task' }))];
  for (const name of ['network','console','call-trace']) for (const line of String(files.get(`${name}.jsonl`) || '').trim().split('\n').filter(Boolean)) { const row = JSON.parse(line); timeline.push({ at: row.at, source: name, sequence: row.sequence ?? null }); }
  timeline.sort((a,b) => a.at.localeCompare(b.at));
  add('timeline', 'selected source timestamps', 'historical-evidence-timeline', timeline, { truncated: ['task-trace','network','console','call-trace'].some(name => sections[name].truncated) });
  const complete = Object.values(sections).every(item => ['available','not-selected','not-applicable'].includes(item.status) && item.completenessKnown !== false);
  const receipt = { schemaVersion: 1, kind: 'weworker-task-diagnostics', status: complete ? 'complete-within-contract' : 'partial', complete,
    createdAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), taskRef: ref(run.taskId), adapterRef: ref(run.siteKey), environment, window, limits: DIAGNOSTIC_LIMITS,
    toolExecuted: false, currentEffectVerified: false, replayAllowed: false, sections,
    redaction: 'Allowlisted structure only; per-export keyed references; no raw URL, account, credential, body, message, source or local path. Explicit screenshot pixels are not redacted.',
    files: [...files].map(([name, data]) => ({ name, bytes: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') })) };
  files.set('summary.md', `# Task diagnostic export\n\nStatus: ${receipt.status}. No tools executed; no current effect certification; no replay permission.\n\n${Object.entries(sections).map(([name,s]) => `- ${name}: ${s.status}; ${s.count} records; ${s.reason || s.evidence}; truncated=${s.truncated}`).join('\n')}\n\n${receipt.redaction}\n`);
  files.set('receipt.json', JSON.stringify(receipt, null, 2) + '\n'); // Commit marker written last.
  // Revalidate after async collection; exclusive mkdir and wx writes. Keep any
  // partial directory on filesystem failure, and report failure to the caller.
  checkDiagnosticDirectory(destination, protectedRoots);
  try {
    fs.mkdirSync(destination, { mode: 0o700 });
    for (const [name, data] of files) {
      const stat = fs.lstatSync(destination); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('directory changed');
      fs.writeFileSync(path.join(destination, name), data, { flag: 'wx', mode: 0o600 });
    }
  } catch { throw fail('EXPORT_SAVE_FAILED', 'Export could not finish; any partial directory was retained and will never be overwritten.'); }
  return { directory: destination, status: receipt.status, complete, files: files.size, sections, currentEffectVerified: false, replayAllowed: false };
}
