import { usesWorkflowOrigins, pageSourceOriginTargets, matchesOriginTarget } from './page-workflow-origins.js';
import { usesWorkflowControl } from './page-workflow-control.js';
import { normalizePageQuery, pageQueryValues } from './exploration-query.js';
import { navigationParameters, usesNavigationQuery, usesNavigationHash } from './page-navigation-parameters.js';
import { workflowParameters } from './exploration-workflow.js';
import { analyzeApiCandidate, analyzeExploration, normalizeStrategyNote } from './exploration-analysis.js';
import { explorationDraftHash, archiveExplorationDraft, explorationRevisionView, readExplorationRevision } from './exploration-revisions.js';
import fs from 'node:fs';
import { buildBackgroundTool, isBackgroundCommand } from './exploration-background.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { explorationCommands, explorationHelp, explorationError as fail, integerArg, textArg } from './exploration-commands.js';
import { extractExplorationEvidence, structuralUrl } from './exploration-evidence.js';
import { resolveAdapterPaths } from './paths.js';
import { assertManagedDirectory, assertManagedFile, readPackageDirectory } from './adapter-package-files.js';
import { writeAdapterPackageFromSiteMemory } from './adapter-scaffold.js';
import { buildQuickGenerationPlan } from './generation-harness/quick-generation.js';
import { prepareGenerationRun, allocateGenerationPlan, verifyRetainedPackage } from './generation-harness/existing-site.js';
import { readGenerationEvidence } from './generation-harness/package-inspection.js';
import { validateAdapterDraft } from './generation-harness/static-validator.js';
import { createPreviewRuntimeValidator } from './generation-harness/runtime-validator.js';
import { describeGeneratedInstall } from './generation-harness/install-review.js';
import { createAdapterPublisher } from './generation-harness/adapter-publisher.js';
import { TabOperationLocks } from './tab-operation-locks.js';
import { normalizeVerificationCases, auditVerification } from './exploration-verification.js';
import { ExplorationKnowledge } from './exploration-knowledge.js';
import { buildAdapterCatalog } from './adapter-catalog.js';
import { repairTarget, writeRepairDraft } from './exploration-repair.js';
import { normalizePageSource, pageObservation, buildPageTool } from './exploration-page.js';
import { writePackageDraft } from './generation-harness/package-draft.js';
import { normalizePathParameters } from './generation-harness/path-parameters.js';
import { normalizeInterceptSource, interceptValues } from './exploration-intercept.js';
import { isHttpStrategy, httpToolContract, buildHttpTool } from './exploration-http.js';
import { httpCredentialsCapability } from './http-contract.js';
import { startHostExploration, collectHostEvidence } from './exploration-host.js';
import { declareWriteSource, plannedWrites, writeCase, writeReview, verifyWrite, readbackWrite, writeProofDigest, writeFixtures, finishWriteValidation, importRepairWriteFixtures } from './exploration-write.js';
import { verifyGeneratedWriteTools } from './generation-harness/write-tool-verifier.js';
import { buildUiWriteTool } from './exploration-ui-write.js';
import { buildExtensionWriteTool } from './exploration-extension-write.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const active = new Set(['collecting', 'validating', 'installing', 'verifying_write']);
const terminal = new Set(['cancelled', 'installed']);
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const helperContract = {
  PAGE_FETCH: { fetchGet: '{ok, status, url, data: parsedResponseBody, rawText}',
    example: 'const response = await fetchGet(url, params); if (!response.ok) throw Object.assign(new Error("HTTP request failed"), {code:"HTTP_ERROR"}); const body = response.data; // business status/data belong to body, not response',
    note: 'Inspect the observed response shape before selecting body.data. Missing required data is INVALID_RESPONSE, not an empty list.' },
  nextAction: 'Read the generated runtime and inspect the observed response contract before editing. Use --args-file for source content.'
};
const diagnosticHints = {
  HTTP_ERROR: ['transport', 'Check the observed HTTP status and request contract.'],
  API_ERROR: ['business', 'Check business status inside the parsed response body.'],
  INVALID_RESPONSE: ['response', 'Check the observed envelope and required fields; do not replace malformed data with an empty list.'],
  INVALID_ARGS: ['arguments', 'Check parameter types, enums and bounds.'],
  RUNTIME_EXCEPTION: ['execution', 'Read the helper return contract and module before changing code; fetchGet.data is the parsed body.'],
  TOOL_TIMEOUT: ['transport', 'Inspect runtime availability and request timing; do not repeatedly change output assertions.'],
};

/** Owned by the existing Bridge. No desktop Backend, Python, or model credentials. */
export class ExplorationService {
  constructor({ rootDir, paths, mode = 'browser', readOnly = false, requestExtension, capabilities = () => ({ connected: false, capabilities: [] }),
    runtimeValidator, publisher, tabLocks = new TabOperationLocks() } = {}) {
    this.readOnly = readOnly;
    this.mode = mode;
    this.paths = paths || resolveAdapterPaths();
    this.root = rootDir || path.join(this.paths.workspaceDir, mode === 'http' ? 'http-exploration' : 'exploration');
    assertManagedDirectory(this.root);
    if (!readOnly) fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.knowledge = new ExplorationKnowledge(path.join(this.root, 'knowledge'), { readOnly });
    this.request = mode === 'http' ? async () => { throw fail('BROWSER_NOT_AVAILABLE', 'HTTP exploration has no browser connection.'); } : requestExtension;
    this.tabLocks = tabLocks;
    this.capabilities = mode === 'http' ? () => ({ connected: false, mode: 'http', capabilities: ['host_http_exploration_v1', 'strict_output_contract_v1'] }) : capabilities;
    this.runtimeValidator = runtimeValidator || createPreviewRuntimeValidator({ requestExtension: this.request, restrictToExpectedTools: true, paths: this.paths, capabilities: () => this.capabilities().capabilities });
    this.publisher = publisher || createAdapterPublisher({ paths: this.paths });
    this.runs = new Map();
    this.controllers = new Map();
    this.jobs = new Map();
    this.readbacks = new Map();
    this.starting = new Map();
    for (const name of (fs.existsSync(this.root) ? fs.readdirSync(this.root) : [])) {
      if (!(mode === 'http' ? /^http-[a-f0-9-]{36}\.json$/ : /^[a-f0-9-]{36}\.json$/).test(name)) continue;
      const run = JSON.parse(fs.readFileSync(assertManagedFile(this.root, name), 'utf8'));
      if (run.schemaVersion !== 1 || `${run.taskId}.json` !== name || (mode === 'http' && run.mode !== 'http')) throw fail('STORE_INVALID', 'Invalid exploration task store.');
      this.runs.set(run.taskId, run);
      if (!readOnly) {
        let recoveredWrite = false;
        for (const execution of run.writeExecutions || []) if (['preparing', 'dispatching'].includes(execution.status)) {
          execution.status = execution.dispatched ? 'uncertain' : 'not_dispatched';
          execution.error = { code: 'WRITE_INTERRUPTED' };
          recoveredWrite = true;
        }
        if (active.has(run.status)) this.update(run, 'interrupted', 'Bridge restarted; inspect consumed writes before continuing. Writes are never replayed.');
        else if (recoveredWrite) this.save(run);
      }
    }
  }

  save(run) {
    const file = assertManagedFile(this.root, `${run.taskId}.json`);
    const temp = assertManagedFile(this.root, `${run.taskId}.json.tmp`);
    fs.writeFileSync(temp, JSON.stringify(run), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  update(run, status, message) {
    run.status = status;
    run.updatedAt = new Date().toISOString();
    run.sequence = (run.sequence || 0) + 1;
    run.events.push({ cursor: run.sequence, at: run.updatedAt, status, message });
    run.events = run.events.slice(-200);
    this.save(run);
  }

  summary(run) {
    const next = { collecting: ['get', 'cancel'], evidence_ready: ['analyze', 'evidence', 'actions', 'probe', 'observe', 'intercept', 'query', 'generate', 'repair-info', 'repair', 'collect'], draft: ['analyze', 'draft-read', 'draft-write', 'verification-read', 'verification-write', 'validate', 'replan'],
      validating: ['get', 'cancel'], installing: ['get'], review_ready: ['analyze', 'review', 'install', 'replan'], failed: ['analyze', 'evidence', 'collect', 'draft-read', 'validate', 'replan'], interrupted: ['analyze', 'get', 'collect', 'validate', 'replan'] };
    next.verifying_write = ['get', 'cancel'];
    next.evidence_ready.push('declare-write');
    next.draft.push('write-verification-read', 'write-verification-write');
    next.write_review_ready = ['write-review', 'write-verify', 'write-readback', 'write-verification-read', 'write-verification-write', 'draft-read', 'draft-write', 'validate'];
    if (run.mode === 'http') {
      next.evidence_ready = ['discover', 'request', 'declare-write', 'analyze', 'evidence', 'generate', 'repair-info', 'repair'];
      next.failed = ['get', 'analyze', 'evidence', 'discover', 'request', 'draft-read', 'validate', 'replan'];
      next.interrupted = ['get', 'analyze', 'discover', 'request', 'validate', 'replan'];
    }
    return { taskId: run.taskId, mode: run.mode || 'browser', status: run.status, goal: run.goal, tabId: run.tabId, site: run.origin, adapter: run.siteKey,
      ...(run.mode === 'http' ? { http: run.http, discoveryCount: run.discoveries?.length || 0, requestCount: run.requestCount || 0 } : {}),
      createdAt: run.createdAt, updatedAt: run.updatedAt, candidateCount: run.candidates.length,
      pageSourceCount: run.pageSources?.length || 0,
      draftRevision: (run.revisions?.length || 0) + 1, preservedRevisions: run.revisions?.length || 0,
      toolNames: run.draft?.toolNames || [], validation: run.validation || null, runtimeValidation: run.runtimeSummary || null,
      diagnostics: (run.runtimeSummary?.errors || []).map(error => {
        const [stage, nextAction] = diagnosticHints[error.code] || ['validation', 'Read the case result and assertion path, then collect new evidence before repairing.'];
        return { stage, nextAction };
      }),
      writeExecutions: (run.writeExecutions || []).map(({ http, effect, resultBinding, ...record }) => record),
      ...(run.repairScope ? { repair: { ...run.repairScope, editableFiles: run.editableFiles, knowledge: run.repairKnowledge } } : {}),
      error: run.error || null, nextActions: (next[run.status] || []).filter(name => name !== 'replan' || (run.draft && !run.repairScope)).map(name => `exploration.${name}`) };
  }

  async execute(command, args = {}) {
    try {
      if (!Object.hasOwn(explorationCommands, command)) throw fail('UNKNOWN_COMMAND', 'Use webcli call exploration.help.');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('INVALID_ARGUMENT', 'Arguments must be an object.');
      if (args.mode !== undefined && args.mode !== this.mode) throw fail('MODE_MISMATCH', 'Task mode does not match the selected exploration service.');
      const allowed = [...explorationCommands[command].params.map(name => name.replace(/\?$/, '')), 'mode'];
      for (const name of Object.keys(args)) if (!allowed.includes(name)) throw fail('INVALID_ARGUMENT', `Unknown argument: ${name}`);
      return { schemaVersion: 1, ok: true, command: `exploration.${command}`, data: await this.dispatch(command, args) };
    } catch (error) {
      return { schemaVersion: 1, ok: false, command: `exploration.${command}`, error: { code: error.code || 'EXPLORATION_FAILED', message: this.safeError(error) } };
    }
  }

  safeError(error) {
    // Browser/model messages may contain captured data. Only our typed messages
    // and static/package validation summaries are returned to the caller.
    return error.code && /^[A-Z_]+$/.test(error.code) ? String(error.message).replaceAll(this.root, '<workspace>').slice(0, 500) : 'Operation failed. Check task state, extension connection and draft validation.';
  }

  async tabs() {
    if (!this.capabilities().connected) throw fail('EXTENSION_UNAVAILABLE', 'Connect the WeWorker browser extension.');
    const result = await this.request({ type: 'exploration_list_tabs' }, 15000);
    return (result.tabs || []).flatMap(tab => {
      try { return [{ id: tab.id, url: structuralUrl(tab.url), active: Boolean(tab.active) }]; } catch { return []; }
    });
  }

  async checkTab(run, readTargets = []) {
    if (run.mode === 'http') return { id: null, url: run.origin };
    const tab = (await this.tabs()).find(tab => tab.id === run.tabId);
    if (!tab || new URL(tab.url).origin !== run.origin && !readTargets.some(target => matchesOriginTarget(new URL(tab.url), target, true))) throw fail('TAB_CHANGED', 'The task tab is closed or belongs to a different origin. Select the intended page before continuing.');
    if (run.browserIdentity) {
      const result = await this.request({ type: 'browser_execute', command: 'identity', args: {}, tabId: run.tabId, identity: run.browserIdentity }, 15000);
      if (!result?.ok) throw fail(result?.error?.code || 'SESSION_EXPIRED', result?.error?.message || 'Task browser tab identity expired. Start a new task in the intended tab.');
    }
    return tab;
  }

  launch(run, status, fn) {
    const release = run.mode === 'http' ? () => {} : this.tabLocks.acquire(run.tabId);
    run.error = null;
    const controller = new AbortController();
    this.controllers.set(run.taskId, controller);
    try { this.update(run, status, status); }
    catch (error) { this.controllers.delete(run.taskId); release(); throw error; }
    const job = Promise.resolve().then(() => fn(controller.signal)).catch(error => {
      if (controller.signal.aborted) return;
      run.error = { code: error.code || 'EXPLORATION_FAILED', message: this.safeError(error) };
      this.update(run, 'failed', run.error.message);
    }).finally(() => { this.controllers.delete(run.taskId); this.jobs.delete(run.taskId); release(); });
    this.jobs.set(run.taskId, job);
    return this.summary(run);
  }

  async dispatch(command, args) {
    if (command === 'help') return explorationHelp();
    if (command === 'capabilities') return { ...this.capabilities(), desktopRequired: false, modelRequired: false, author: 'calling-agent', schemaVersion: 1 };
    if (command === 'tabs') return { tabs: await this.tabs() };
    if (command === 'list') return { tasks: [...this.runs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(run => this.summary(run)) };
    if (command === 'repair-info') {
      const { target, pkg } = repairTarget(args.site, this.paths);
      return { site: pkg.name, digest: pkg.digest, version: pkg.manifest.version, source: target.source, commands: pkg.manifest.commands,
        sharedFiles: [...pkg.files.keys()].filter(file => /^(?:extension|http)\/internal\//.test(file)).sort(), sharedRepairImpact: 'all-package-commands',
        knowledge: this.knowledge.read(pkg.name, { activeDigest: pkg.digest }) };
    }
    if (command === 'knowledge-read') {
      const site = textArg(args.site, 'site', 128);
      const activePackage = buildAdapterCatalog({ paths: this.paths }).effective.find(item => item.name === site);
      return this.knowledge.read(site, { activeDigest: activePackage?.digest || null });
    }
    if (command === 'start') {
      if (this.mode === 'http') return startHostExploration(this, args);
      if (args.origin !== undefined || args.auth !== undefined) throw fail('INVALID_ARGUMENT', 'origin/auth require mode=http.');
      const requestId = textArg(args.requestId, 'requestId', 100);
      const goal = textArg(args.goal, 'goal');
      const tabId = integerArg(args.tabId, 'tabId');
      const allowedOrigins = args.allowedOrigins === undefined ? [] : args.allowedOrigins;
      if (!Array.isArray(allowedOrigins) || allowedOrigins.length > 20) throw fail('INVALID_ARGUMENT', 'allowedOrigins must be an array of at most 20 HTTP(S) origins.');
      const origins = [...new Set(allowedOrigins.map(value => {
        try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value) throw new Error(); return url.origin; }
        catch { throw fail('INVALID_ARGUMENT', 'Each allowedOrigins entry must be an exact HTTP(S) origin without a path or credentials.'); }
      }))].sort();
      // Preserve request signatures for existing same-origin tasks.
      const signature = hash(JSON.stringify({ goal, tabId, ...(origins.length ? { allowedOrigins: origins } : {}) }));
      const previous = [...this.runs.values()].find(run => run.requestId === requestId);
      if (previous) {
        if (previous.signature !== signature) throw fail('REQUEST_CONFLICT', 'requestId was already used with different arguments.');
        return this.summary(previous);
      }
      if (this.starting.has(requestId)) {
        const pending = this.starting.get(requestId);
        if (pending.signature !== signature) throw fail('REQUEST_CONFLICT', 'requestId is in use.');
        return pending.promise;
      }
      const promise = this.start({ requestId, goal, tabId, signature, allowedOrigins: origins });
      this.starting.set(requestId, { signature, promise });
      try { return await promise; } finally { this.starting.delete(requestId); }
    }
    const taskId = textArg(args.taskId, 'taskId', 100);
    const run = this.runs.get(taskId);
    if (!run) throw fail('TASK_NOT_FOUND', 'Task not found; use exploration.list.');
    if (command === 'get') return this.summary(run);
    if (command === 'analyze') return analyzeExploration(run, this.capabilities().capabilities);
    if (command === 'revisions') return { taskId, revisions: (run.revisions || []).map(explorationRevisionView) };
    if (command === 'revision-read') return readExplorationRevision(run, integerArg(args.revision, 'revision'), args.file === undefined ? undefined : textArg(args.file, 'file', 200));
    if (command === 'knowledge-save' || command === 'knowledge-revise') {
      if (!['review_ready', 'installed'].includes(run.status) || !run.runtimeDigest || readPackageDirectory(run.draft.adapterDir).digest !== run.runtimeDigest) throw fail('VALIDATION_REQUIRED', 'Knowledge requires a successfully validated current draft.');
      if (plannedWrites(run).length && run.preWriteDigest !== writeProofDigest(run)) throw fail('VALIDATION_REQUIRED', 'Write verification changed; validate again before saving knowledge.');
      if (command === 'knowledge-revise' && run.status === 'installed' && repairTarget(run.siteKey, this.paths).pkg.digest !== run.runtimeDigest) throw fail('ADAPTER_BASE_CHANGED', 'Installed package changed; verify the current package before revising knowledge.');
      const indexes = [...new Set((run.plan?.tools || []).flatMap(tool => tool.sourceApiIndexes || []))];
      const endpoints = indexes.map(index => clone(run.candidates[index])).filter(Boolean);
      const pageIds = new Set((run.plan?.tools || []).map(tool => tool.sourcePageId).filter(Boolean));
      const pages = (run.pageSources || []).filter(item => pageIds.has(item.id)).map(clone);
      const verifiedAt = run.verifiedAt || run.updatedAt;
      const commands = Object.fromEntries(run.draft.toolNames.map(tool => [tool, { verifiedAt, packageDigest: run.runtimeDigest,
        cases: clone(run.verification?.[tool] || []),
        ...(plannedWrites(run).includes(tool) ? { writeVerification: { kind: run.plan.tools.find(item => `${run.siteKey}.${item.name.replace(/_/g, '-')}` === tool)?.strategy === 'UI_SELECTOR' ? 'ui_single_submit_v1' : run.plan.tools.find(item => `${run.siteKey}.${item.name.replace(/_/g, '-')}` === tool)?.strategy === 'PAGE_FETCH' ? 'extension_single_write_v1' : 'http_single_write_v1',
          fixture: clone(writeFixtures(run).commands[tool.slice(run.siteKey.length + 1)]),
          verifiedAt: run.writeExecutions.find(item => item.tool === tool && item.digest === run.preWriteDigest && item.status === 'verified')?.at,
          replayAllowed: false } } : {}),
        pathParameters: clone(run.plan?.tools?.find(item => `${run.siteKey}.${item.name.replace(/_/g, '-')}` === tool)?.pathParameters || []),
        strategy: run.plan?.tools?.find(item => `${run.siteKey}.${item.name.replace(/_/g, '-')}` === tool)?.strategy || null,
        strategyNote: clone(run.plan?.tools?.find(item => `${run.siteKey}.${item.name.replace(/_/g, '-')}` === tool)?.strategyNote || null) }]));
      return this.knowledge.save(run.siteKey, { expectedHash: args.expectedHash, verifiedAt, packageDigest: run.runtimeDigest,
        endpoints, pages, commands, notes: args.notes, fields: args.fields,
        ...(command === 'knowledge-revise' ? { revisions: args.revisions ?? null, taskId: run.taskId } : {}) });
    }
    if (command === 'trace') return { ...this.summary(run), events: clone(run.events),
      evidence: run.candidates.map(({ id, url, method, status, risk, requestSemantics }) => ({ id, url, method, status, risk, requestSemantics })),
      pageSources: clone(run.pageSources || []),
      plannedTools: (run.plan?.tools || []).map(({ name, risk, sourceApiKind, sourceApiIndexes, strategy, sourcePageId, pathParameters, strategyNote }) => ({ name, risk, sourceApiKind, sourceApiIndexes, strategy, sourcePageId, pathParameters, strategyNote })),
      revisions: (run.revisions || []).map(({ revision, at, reason, draftHash, runtimeSummary }) => ({ revision, at, reason, draftHash, runtimeValidation: runtimeSummary })),
      files: run.draftFiles || [], structuralOnly: true };
    if (command === 'events') {
      const cursor = integerArg(args.cursor, 'cursor', 0);
      return { taskId, events: run.events.filter(event => event.cursor > cursor), cursor: run.sequence, truncated: cursor < (run.events[0]?.cursor || 1) - 1 };
    }
    if (command === 'evidence') return { taskId, candidates: clone(run.candidates), discoveries: clone(run.discoveries || []), pageSources: clone(run.pageSources || []), allowedOrigins: run.allowedOrigins || [], policy: 'declared task/API origins; structure only; captured scalar values omitted; API document operations are unverified declarations' };
    if (command === 'write-readback') return readbackWrite(this, run, textArg(args.reviewId, 'reviewId', 64));
    if (command === 'write-verify' && run.writeExecutions?.some(item => item.reviewId === args.reviewId)) return verifyWrite(this, run, args);
    if (command === 'cancel') {
      if (this.readbacks.has(taskId)) {
        this.readbacks.get(taskId).abort();
        return this.summary(run); // Cancel only the read; retain the original write outcome.
      }
      if (terminal.has(run.status)) return this.summary(run);
      if (run.status === 'installing') throw fail('INVALID_STATE', 'Installation has started; inspect its outcome before making another change.');
      this.controllers.get(taskId)?.abort();
      this.update(run, 'cancelled', 'Task cancelled; dispatched writes may have effects. Inspect writeExecutions and use write-readback without replaying.');
      return this.summary(run);
    }
    if (command === 'install' && run.status === 'installed') return this.summary(run);
    if (this.readbacks.has(taskId)) throw fail('TASK_BUSY', 'Wait for the independent effect read or cancel it before changing the task.');
    if (active.has(run.status) && !(this.readOnly && ['draft-read', 'verification-read'].includes(command))) throw fail('TASK_BUSY', 'Wait for the current operation or cancel the task.');
    if (terminal.has(run.status) && !['draft-read', 'verification-read', 'write-verification-read'].includes(command)) throw fail('INVALID_STATE', 'This task is terminal. Start a new task.');
    if (command === 'replan') {
      const revisions = archiveExplorationDraft(run, args.expectedDraftHash, textArg(args.reason, 'reason'));
      run.revisions = revisions;
      for (const key of ['draft', 'plan', 'memory', 'validation', 'runtimeSummary', 'runtimeDigest', 'review', 'verifiedAt', 'error', 'preWriteDigest', 'generationRequestDigest']) run[key] = null;
      run.verification = {}; run.verificationWarnings = {}; run.draftFiles = []; run.actions = [];
      this.update(run, 'evidence_ready', 'Previous draft preserved. Inspect alternatives, collect evidence and generate a new plan; all verification must run again.');
      return this.summary(run);
    }
    if (['collect', 'actions', 'probe', 'observe', 'intercept', 'query', 'discover', 'request', 'declare-write'].includes(command)) {
      if (run.draft) throw fail('INVALID_STATE', 'Preserve the current attempt with exploration.replan before changing source evidence.');
    }
    if (command === 'declare-write') return declareWriteSource(this, run, args);
    if (['discover', 'request'].includes(command)) {
      if (run.mode !== 'http') throw fail('HTTP_TASK_REQUIRED', 'Create an exploration.start task with mode=http for host API discovery.');
      return collectHostEvidence(this, run, args, command === 'discover');
    }
    if (run.mode === 'http' && ['collect', 'actions', 'probe', 'observe', 'intercept', 'query'].includes(command)) throw fail('BROWSER_NOT_AVAILABLE', 'Use discovery/request in this HTTP task, or start a separate browser task for page evidence.');
    if (command === 'observe' || command === 'intercept' || command === 'query') {
      if (!this.capabilities().capabilities.includes('page_sources_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension to observe page sources.');
      const intercept = command === 'intercept', query = command === 'query';
      if (query && !this.capabilities().capabilities.includes('page_query_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension to run navigation-aware page queries.');
      if (query && args.source?.mode === 'navigate' && !this.capabilities().capabilities.includes('page_navigation_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension to navigate parameterized page routes.');
      if (query && args.source?.mode === 'workflow' && !this.capabilities().capabilities.includes('page_workflow_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension to execute ordered page workflows.');
      if (intercept && !this.capabilities().capabilities.includes('intercept_read_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension to observe intercepted page queries.');
      const source = query ? normalizePageQuery(args.source) : intercept ? normalizeInterceptSource(args.source, run.candidates) : normalizePageSource(args.source), reason = textArg(args.reason, 'reason');
      if (query && usesWorkflowOrigins(source) && !this.capabilities().capabilities.includes('page_navigation_origin_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the selected extension before explicit cross-origin page reading.');
      if (query && usesWorkflowControl(source) && !this.capabilities().capabilities.includes('page_workflow_control_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the selected extension before conditional or repeated page workflows.');
      if (query && usesNavigationHash(source) && !this.capabilities().capabilities.includes('page_navigation_hash_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the selected extension before hash navigation.');
      if (query && usesNavigationQuery(source) && !this.capabilities().capabilities.includes('page_navigation_query_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension before navigating public URL query parameters.');
      const values = query ? pageQueryValues(source, args.values) : intercept ? interceptValues(source, args.values) : undefined;
      return this.launch(run, 'collecting', async signal => {
        const tab = await this.checkTab(run);
        if (signal.aborted) return;
        const page = new URL(tab.url);
        const readTargets = query && usesWorkflowOrigins(source) ? pageSourceOriginTargets(source, run.origin, page.pathname) : [];
        if (readTargets.some(target => ![run.origin, ...(run.allowedOrigins || [])].includes(target.origin))) throw fail('PAGE_ORIGIN_NOT_ALLOWED', 'Declare each navigation origin in start.allowedOrigins before observing it.');
        const operationId = source.mode === 'workflow' || usesNavigationHash(source) || usesWorkflowOrigins(source) ? randomUUID() : undefined;
        const cancel = () => { this.request({ type: 'exploration_cancel_workflow', tabId: run.tabId, operationId }, 5000).catch(() => {}); };
        if (operationId) signal.addEventListener('abort', cancel, { once: true });
        let result;
        try {
          result = await this.request({ type: query ? 'exploration_page_query' : intercept ? 'exploration_intercept_read' : 'exploration_observe_page', tabId: run.tabId,
            payload: { source, expectedOrigin: page.origin, expectedPath: source.mode === 'workflow' ? source.steps[0].pathname : page.pathname, ...(intercept || query ? { values } : {}), ...(operationId ? { operationId } : {}) } }, query ? 45000 : 30000);
        } finally { if (operationId) signal.removeEventListener('abort', cancel); }
        if (signal.aborted) return;
        if (!result?.ok) throw fail(result?.error?.code || 'PAGE_SOURCE_MISSING', result?.error?.message || 'Unable to observe the page source.');
        const current = await this.checkTab(run, readTargets);
        if (signal.aborted) return;
        // The extension verifies the exact resolved route for navigation; tabs
        // summaries normalize numeric IDs, so they cannot compare raw arguments.
        if (!['navigate', 'workflow'].includes(source.mode) && new URL(current.url).pathname !== (query ? source.resultPathname : page.pathname)) throw fail('TAB_CHANGED', 'Page route changed during observation.');
        const observed = pageObservation({ source, url: tab.url, shape: result.shape, reason });
        run.pageSources = [...new Map([...(run.pageSources || []), observed].map(item => [item.id, item])).values()].slice(-100);
        this.update(run, 'evidence_ready', 'Page source structure observed. Choose its ID and strategy in a plan.');
      });
    }
    if (command === 'actions') {
      await this.checkTab(run);
      if (active.has(run.status) || terminal.has(run.status) || run.draft) throw fail('INVALID_STATE', 'Task state changed.');
      if (!this.capabilities().capabilities.includes('safe_api_probe_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension to enable safe API probes.');
      const release = this.tabLocks.acquire(run.tabId);
      let result;
      try { result = await this.request({ type: 'exploration_safe_actions_inspect', tabId: run.tabId }, 15000); }
      finally { release(); }
      await this.checkTab(run);
      if (active.has(run.status) || terminal.has(run.status) || run.draft) throw fail('INVALID_STATE', 'Task state changed.');
      run.actions = (result.candidates || []).filter(item => item.risk === 'read' && ['search', 'filter', 'pagination'].includes(item.kind))
        .map(item => ({ id: String(item.id), kind: item.kind, requiresValue: item.requiresValue === true, risk: 'read' }));
      this.save(run);
      return { taskId, candidates: run.actions, remainingProbes: Math.max(0, 3 - (run.probeCount || 0)) };
    }
    if (command === 'probe') {
      if ((run.probeCount || 0) >= 3) throw fail('PROBE_LIMIT', 'Three safe probes have been used. Review evidence before starting another task.');
      const candidateId = textArg(args.candidateId, 'candidateId', 200);
      const action = run.actions?.find(item => item.id === candidateId);
      if (!action) throw fail('STALE_ACTION', 'Inspect exploration.actions before probing.');
      if (action.requiresValue) textArg(args.value, 'value', 80);
      if (args.value !== undefined && (typeof args.value !== 'string' || args.value.length > 80)) throw fail('INVALID_ARGUMENT', 'value must contain at most 80 characters.');
      run.probeCount = (run.probeCount || 0) + 1;
      run.actions = [];
      return this.collect(run, false, { type: 'exploration_safe_probe_run', candidateId, value: args.value || '' });
    }
    if (command === 'collect') {
      return this.collect(run, false);
    }
    if (command === 'generate' || command === 'repair') return this.generate(run, args.plan, command === 'repair' ? args : null);
    if (!run.draft) throw fail('INVALID_STATE', 'Generate a draft first.');
    if (command === 'write-verification-read' || command === 'write-verification-write') return writeCase(this, run, args, command === 'write-verification-write');
    if (command === 'write-review') return writeReview(this, run, args.tool);
    if (command === 'write-verify') return verifyWrite(this, run, args);
    if (command === 'verification-read' || command === 'verification-write') {
      const tool = textArg(args.tool, 'tool', 200);
      if (!run.draft.toolNames.includes(tool)) throw fail('INVALID_ARGUMENT', 'Select a tool generated or selected for repair by this task.');
      if (plannedWrites(run).includes(tool)) throw fail('WRITE_CASE_REQUIRED', 'Use write-verification-read/write for a write command. Ordinary cases never authorize writes.');
      const cases = run.verification?.[tool] || [];
      if (command === 'verification-read') return { tool, cases: clone(cases), hash: hash(JSON.stringify(cases)) };
      if (!this.capabilities().capabilities.includes('strict_output_contract_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension to enable authored output assertions.');
      if (args.expectedHash !== hash(JSON.stringify(cases))) throw fail('STALE_VERIFICATION', 'Cases changed; read their current hash before editing.');
      const normalized = normalizeVerificationCases(args.cases);
      run.verificationWarnings = { ...run.verificationWarnings, [tool]: [
        ...(run.verificationWarnings?.[tool] || []).filter(item => item.code === 'VERIFICATION_CHANGED'),
        ...auditVerification(normalized, cases),
      ].slice(-100) };
      run.verification = { ...run.verification, [tool]: normalized };
      run.validation = null; run.runtimeSummary = null; run.runtimeDigest = null; run.review = null;
      this.update(run, 'draft', 'Verification cases changed; validate again.');
      return { tool, caseCount: normalized.length, hash: hash(JSON.stringify(normalized)), warnings: run.verificationWarnings[tool] };
    }
    if (command === 'draft-add') {
      if (run.repairScope) throw fail('REPAIR_SCOPE_CHANGED', 'Scoped repair cannot add shared or command files. Edit only the selected modules and their schema/description.');
      const file = textArg(args.file, 'file', 200);
      if (!(file === 'guidance.md' || /^(?:extension|http)\/(?:internal|commands)\/[a-zA-Z0-9][a-zA-Z0-9_/-]*\.js$/.test(file)) || file.includes('..') || path.basename(file) === 'index.js') throw fail('INVALID_ARGUMENT', 'Add guidance.md or a non-index JavaScript file under extension/ or http/ commands/internal.');
      if (run.draftFiles.some(name => name.toLowerCase() === file.toLowerCase())) throw fail('FILE_EXISTS', 'File already exists; use draft-write with its current hash.');
      if (run.draftFiles.length >= 512 || typeof args.content !== 'string' || args.content.length > 250000) throw fail('INVALID_ARGUMENT', 'Draft file count or content size exceeds the package limit.');
      const target = assertManagedFile(run.draft.adapterDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, args.content, { flag: 'wx', mode: 0o600 });
      run.draftFiles = [...run.draftFiles, file].sort();
      run.validation = null; run.runtimeSummary = null; run.runtimeDigest = null; run.review = null;
      this.update(run, 'draft', 'Draft file added; validate again.');
      return { file, hash: hash(args.content) };
    }
    if (command === 'draft-read') {
      if (args.file === undefined) return { files: run.draftFiles, draftHash: explorationDraftHash(run), helperContract, revision: (run.revisions?.length || 0) + 1, ...(run.repairScope ? { editableFiles: run.editableFiles } : {}) };
      const file = textArg(args.file, 'file', 200);
      if (!run.draftFiles.includes(file)) throw fail('INVALID_ARGUMENT', 'File is not in this draft.');
      const content = fs.readFileSync(assertManagedFile(run.draft.adapterDir, file));
      return { file: args.file, content: content.toString('utf8'), hash: hash(content) };
    }
    if (command === 'draft-write') {
      const file = textArg(args.file, 'file', 200);
      if (!run.draftFiles.includes(file)) throw fail('INVALID_ARGUMENT', 'Only existing draft files can be edited.');
      if (run.repairScope && !run.editableFiles.includes(file)) throw fail('REPAIR_SCOPE_CHANGED', 'This file belongs to an unselected command or shared package content.');
      const prior = fs.readFileSync(assertManagedFile(run.draft.adapterDir, file));
      if (args.expectedHash !== hash(prior)) throw fail('STALE_DRAFT', 'File changed; read it again before editing.');
      if (typeof args.content !== 'string' || args.content.length > 250000) throw fail('INVALID_ARGUMENT', 'content must be a string of at most 250000 characters.');
      fs.writeFileSync(assertManagedFile(run.draft.adapterDir, file), args.content, 'utf8');
      run.validation = null; run.runtimeSummary = null; run.runtimeDigest = null; run.review = null;
      this.update(run, 'draft', 'Draft edited; validate again.');
      return { file, hash: hash(args.content) };
    }
    if (command === 'validate') return this.validate(run);
    if (command === 'review') {
      this.assertValidated(run);
      run.review = describeGeneratedInstall(run.draft, { paths: this.paths });
      this.save(run);
      return { ...run.review, tools: readPackageDirectory(run.draft.adapterDir).manifest.commands,
        qualityWarnings: (run.plan?.tools || []).filter(tool => /^(?:t\d+|test|debug)$/i.test(tool.name)).map(tool => ({ code: 'TEMPORARY_TOOL_NAME', tool: tool.name, message: 'Review the final command name; aliases do not change the standard ID. Use replan for an unpublished draft.' })),
        verificationCoverage: Object.entries(run.verification || {}).map(([tool, cases]) => ({ tool, cases: clone(cases), warnings: run.verificationWarnings?.[tool] || auditVerification(cases) })),
        plannedExecution: (run.plan?.tools || []).map(tool => ({ name: tool.name, strategy: tool.strategy,
          note: 'Declared strategy is not proof of page-free ordinary calls. Check the actual runner and page creation/fallback during acceptance.' })),
        ...(run.repairScope ? { repair: { ...run.repairScope, editableFiles: run.editableFiles } } : {}) };
    }
    if (command === 'install') {
      this.assertValidated(run);
      if (args.confirmed !== true && args.confirmed !== 'true') throw fail('CONFIRMATION_REQUIRED', 'Obtain explicit user consent to the current installation review.');
      const review = describeGeneratedInstall(run.draft, { paths: this.paths });
      if (!run.review || args.reviewId !== run.review.reviewId || args.reviewId !== review.reviewId) throw fail('STALE_REVIEW', 'Run exploration.review and obtain consent to that exact review.');
      // Lock before awaiting publisher; concurrent edits/installs must not race.
      return this.launch(run, 'installing', async signal => {
        if (signal.aborted) return;
        const result = await this.publisher({ run: this.facade(run), store: {}, approval: { reviewId: review.reviewId, acceptChanges: true } });
        // Installation is atomic and cannot be undone by a late cancel.
        run.installed = { digest: result.digest, version: result.version };
        this.update(run, 'installed', 'Adapter installed locally.');
      });
    }
  }

  async start({ requestId, goal, tabId, signature, allowedOrigins }) {
    if (this.runs.size >= 200) throw fail('TASK_LIMIT', 'Exploration task limit reached; archive task data before creating more.');
    const caps = this.capabilities();
    if (!caps.capabilities.includes('passive_exploration_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension to enable passive API exploration.');
    const tab = (await this.tabs()).find(tab => tab.id === tabId);
    if (!tab) throw fail('TAB_CHANGED', 'Select a tab from exploration.tabs.');
    this.assertTabAvailable(tabId);
    let browserIdentity;
    if (caps.capabilities.includes('browser_profiles_v1')) {
      const result = await this.request({ type: 'browser_execute', command: 'bind', args: {}, tabId }, 15000);
      if (!result?.ok || !result.data?.identity) throw fail('SESSION_EXPIRED', 'Could not retain the task browser tab identity.');
      browserIdentity = result.data.identity;
    }
    const now = new Date().toISOString();
    const run = { schemaVersion: 1, taskId: randomUUID(), requestId, signature, goal, tabId, ...(browserIdentity ? { browserIdentity } : {}), allowedOrigins, origin: new URL(tab.url).origin,
      siteKey: new URL(tab.url).hostname, createdAt: now, updatedAt: now, status: 'created', candidates: [], events: [], sequence: 0 };
    this.runs.set(run.taskId, run);
    try { return this.collect(run, true); }
    catch (error) { this.runs.delete(run.taskId); throw error; }
  }

  collect(run, reload, probe) {
    this.assertTabAvailable(run.tabId, run.taskId);
    return this.launch(run, 'collecting', async signal => {
      await this.checkTab(run);
      if (signal.aborted) return;
      const capture = await this.request({ ...(probe || { type: reload ? 'exploration_capture_passive' : 'browser_network', includeTelemetry: true }), tabId: run.tabId }, 90000);
      if (signal.aborted) return;
      await this.checkTab(run);
      if (signal.aborted) return;
      const found = extractExplorationEvidence(capture, run.origin, run.allowedOrigins || []);
      run.candidates = [...new Map([...run.candidates, ...found].map(item => [item.id, item])).values()].slice(-100);
      this.update(run, 'evidence_ready', found.length ? 'Structural evidence collected; calling agent may select APIs.' : 'No usable evidence from permitted origins; interact with the page and collect again.');
    });
  }

  generate(run, proposedPlan, repair = null) {
    const requestDigest = hash(canonical({ plan: proposedPlan || null, repair: repair || null }));
    if (run.draft) {
      if (proposedPlan && run.generationRequestDigest !== requestDigest) throw fail('PLAN_CONFLICT', 'An existing draft uses another plan (or predates plan fingerprints). Read draft-read for expectedDraftHash, then use exploration.replan with a reason before generate. No changes were applied.');
      return { ...this.summary(run), generation: { reused: true, applied: false, draftHash: explorationDraftHash(run) } };
    }
    if (run.mode === 'http' && (!proposedPlan?.tools?.length || proposedPlan.tools.some(tool => !['PUBLIC_API', 'AUTH_API'].includes(tool?.strategy) || tool.sourcePageId))) throw fail('HTTP_PLAN_REQUIRED', 'Host tasks require an explicit PUBLIC_API/AUTH_API plan bound to actual HTTP evidence.');
    if (repair && (!proposedPlan || typeof proposedPlan !== 'object')) throw fail('INVALID_PLAN', 'Repair requires an explicit plan naming existing command IDs and current source indexes.');
    const candidates = run.candidates.filter(item => analyzeApiCandidate(item).eligible);
    if (!candidates.length && !proposedPlan?.tools?.some(tool => tool?.sourcePageId || tool?.risk === 'write')) throw fail('NO_READ_EVIDENCE', 'Collect a successful read query or observe a page source before generating.');
    if (!proposedPlan && candidates.length && candidates.every(item => new URL(item.url).pathname.includes(':id'))) throw fail('PATH_PLAN_REQUIRED', 'Dynamic endpoints need an explicit plan with pathParameters and authored verification cases.');
    if (!proposedPlan && (run.pageSources?.length || !candidates.some(item => analyzeApiCandidate(item).verdict === 'likely_data'))) throw fail('STRATEGY_PLAN_REQUIRED', 'Use exploration.analyze and choose an explicit plan when page alternatives exist or target API data is uncertain.');
    // Keep original evidence indexes stable for agent-authored plans.
    run.memory = { siteKey: run.siteKey, siteHost: new URL(run.origin).hostname, siteOrigin: run.origin, canonicalEntryUrl: run.origin + '/',
      listApiCandidates: run.candidates.map(item => clone(item)), actionApiCandidates: [], pageSources: clone(run.pageSources || []) };
    const facade = this.facade(run);
    prepareGenerationRun(facade, { paths: this.paths });
    run.siteKey = facade.snapshot.siteKey; run.memory = facade.snapshot.input.memory;
    const plan = clone(proposedPlan || buildQuickGenerationPlan({ ...run.memory, listApiCandidates: run.memory.listApiCandidates.map(item => item.method === 'GET' && !new URL(item.url).pathname.includes(':id') && analyzeApiCandidate(item).verdict === 'likely_data' && candidates.some(candidate => candidate.id === item.id) ? item : { ...item, url: '' }) }));
    if (!Array.isArray(plan.tools) || !plan.tools.length || plan.tools.length > 50) throw fail('INVALID_PLAN', 'Provide 1–50 tools per draft. Split larger plans into incremental tasks.');
    if (!repair && plan.tools.some(tool => tool?.risk !== 'write' && !tool?.sourcePageId && (!tool?.strategy || tool.strategy === 'PAGE_FETCH') && (typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(tool.name)))) throw fail('INVALID_PLAN', 'New PAGE_FETCH API plan tool names must use snake_case, for example list_items. Installed command IDs are normalized to kebab-case.');
    for (const tool of plan.tools) {
      if (tool?.sourcePageId) {
        const observed = (run.pageSources || []).find(item => item.id === tool.sourcePageId);
        if (!observed || tool.risk !== 'read' || tool.strategy !== observed.source.strategy || tool.sourceApiIndexes !== undefined || tool.sourceApiKind !== undefined || tool.pathParameters !== undefined) throw fail('INVALID_PLAN', 'Page tools must bind an observed page ID and matching strategy without API evidence.');
        textArg(tool.readReason, 'readReason');
        tool.strategyNote = normalizeStrategyNote(tool, tool.strategy);
        continue;
      }
      const candidate = run.candidates[tool.sourceApiIndexes?.[0]];
      if (tool.risk === 'write') {
        if (tool.sourceApiKind !== 'action' || (!isHttpStrategy(tool.strategy) && !['PAGE_FETCH', 'UI_SELECTOR'].includes(tool.strategy)) || tool.sourceApiIndexes?.length !== 1 || !candidate || candidate.risk?.level !== 'write'
          || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(candidate.method)
          || (!candidate.declared && !(candidate.status >= 200 && candidate.status < 300))) throw fail('INVALID_PLAN', 'Write plans require one declared or successfully observed write source and an explicit HTTP, PAGE_FETCH or UI_SELECTOR strategy.');
        if (tool.strategy === 'UI_SELECTOR') buildUiWriteTool(run.siteKey, tool, candidate, run.origin);
        else if (tool.strategy === 'PAGE_FETCH') buildExtensionWriteTool(run.siteKey, tool, candidate, run.origin);
        else httpToolContract(tool, candidate);
        if (tool.pathParameters?.length) throw fail('INVALID_PLAN', 'Initial write verification uses exact authored requests; path templates are not generated.');
        textArg(tool.writeReason, 'writeReason');
        if (!tool.strategyNote) throw fail('STRATEGY_PLAN_REQUIRED', 'Writes require an explicit source rationale and limitations.');
        tool.strategyNote = normalizeStrategyNote(tool, tool.strategy);
        continue;
      }
      if (tool.risk !== 'read' || tool.sourceApiKind !== 'list' || !candidate || !candidates.some(item => item.id === candidate.id)) throw fail('INVALID_PLAN', 'Each tool must reference a successful observed read query by index.');
      if (tool.strategy !== undefined && !['PAGE_FETCH', 'EXTENSION_API'].includes(tool.strategy) && !isHttpStrategy(tool.strategy)) throw fail('STRATEGY_UNSUPPORTED', 'Choose EXTENSION_API, PAGE_FETCH, PUBLIC_API, COOKIE_API or AUTH_API for observed API sources.');
      tool.strategy ||= 'PAGE_FETCH';
      if (tool.strategy === 'EXTENSION_API') {
        if (!this.capabilities().capabilities.includes('background_preview_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'The selected extension must support background_preview_v1; do not substitute a page preview.');
        textArg(tool.readReason, 'readReason');
        if (!tool.strategyNote) throw fail('STRATEGY_PLAN_REQUIRED', 'Explain the background authentication source, alternatives and limitations.');
      }
      if (isHttpStrategy(tool.strategy)) {
        httpToolContract(tool, candidate);
        textArg(tool.readReason, 'readReason');
        if (!tool.strategyNote) throw fail('STRATEGY_PLAN_REQUIRED', 'Host HTTP requires an explicit source rationale and limitations.');
      }
      tool.strategyNote = normalizeStrategyNote(tool, tool.strategy);
      try { normalizePathParameters(candidate, tool.pathParameters); }
      catch (error) { throw fail('INVALID_PLAN', error.message); }
      if (tool.pathParameters?.length) textArg(tool.readReason, 'readReason');
      if (candidate.method !== 'GET' && (typeof tool.readReason !== 'string' || !tool.readReason.trim() || tool.readReason.length > 2000)) throw fail('INVALID_PLAN', 'POST queries require an authored readReason explaining their read semantics.');
    }
    if (repair) {
      if (plan.tools.some(tool => typeof tool.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tool.name) || (!tool.sourcePageId && tool.sourceApiIndexes?.length !== 1))) throw fail('INVALID_PLAN', 'Repair plans use exact existing kebab-case IDs and one fresh API or page source per tool.');
      const prepared = writeRepairDraft({ site: textArg(repair.site, 'site', 128), expectedDigest: textArg(repair.expectedDigest, 'expectedDigest', 64),
        plan, memory: run.memory, candidates: run.candidates, sharedFiles: repair.sharedFiles,
        outputRoot: path.join(this.root, run.taskId, randomUUID()), paths: this.paths });
      const knowledge = this.knowledge.read(run.siteKey, { activeDigest: prepared.scope.digest });
      const repairKnowledge = { hash: knowledge.hash, stale: knowledge.stale, staleReasons: knowledge.staleReasons,
        staleCommands: knowledge.staleCommands, importedTools: [] };
      const verification = {};
      for (const tool of prepared.draft.toolNames) {
        if (prepared.scope.writeCommandIds?.includes(tool.slice(run.siteKey.length + 1))) continue;
        const cases = knowledge.knowledge?.commands?.[tool]?.cases;
        if (cases?.length) { verification[tool] = normalizeVerificationCases(cases); repairKnowledge.importedTools.push(tool); }
      }
      const repairRun = { ...run, plan: clone(plan), draft: prepared.draft, repairScope: prepared.scope };
      if (prepared.scope.writeCommandIds?.length) Object.assign(repairKnowledge, importRepairWriteFixtures(repairRun, knowledge.knowledge));
      run.plan = repairRun.plan; run.draft = prepared.draft; run.repairScope = prepared.scope; run.editableFiles = prepared.editableFiles;
      run.repairKnowledge = repairKnowledge; run.verification = verification;
      run.draftFiles = [...readPackageDirectory(run.draft.adapterDir).files.keys()];
      run.generationRequestDigest = requestDigest;
      this.update(run, 'draft', 'Scoped repair created. Review historical cases and verify against the current page before installation.');
      return this.summary(run);
    }
    run.plan = allocateGenerationPlan(run.memory, plan);
    const outputRoot = path.join(this.root, run.taskId, randomUUID());
    const apiTools = run.plan.tools.filter(tool => tool.risk !== 'write' && !tool.sourcePageId && !isHttpStrategy(tool.strategy) && tool.strategy !== 'EXTENSION_API');
    const pageTools = [
      ...run.plan.tools.filter(tool => tool.strategy === 'EXTENSION_API').map(tool => buildBackgroundTool(run.siteKey, tool, run.candidates[tool.sourceApiIndexes[0]])),
      ...run.plan.tools.filter(tool => tool.risk === 'write' && tool.strategy === 'UI_SELECTOR').map(tool => buildUiWriteTool(run.siteKey, tool, run.candidates[tool.sourceApiIndexes[0]], run.origin)),
      ...run.plan.tools.filter(tool => tool.sourcePageId).map(tool => buildPageTool(run.siteKey, tool, run.pageSources.find(item => item.id === tool.sourcePageId))),
      ...run.plan.tools.filter(tool => isHttpStrategy(tool.strategy)).map(tool => buildHttpTool(run.siteKey, tool, run.candidates[tool.sourceApiIndexes[0]])),
      ...run.plan.tools.filter(tool => tool.risk === 'write' && tool.strategy === 'PAGE_FETCH').map(tool => buildExtensionWriteTool(run.siteKey, tool, run.candidates[tool.sourceApiIndexes[0]], run.origin)),
    ];
    const draft = apiTools.length
      ? writeAdapterPackageFromSiteMemory(run.memory, { outputRoot, plan: { ...run.plan, tools: apiTools }, additionalTools: pageTools, adapterPaths: this.paths })
      : writePackageDraft({ memory: run.memory, adapterDir: path.join(outputRoot, run.siteKey), supportBundle: { toolFiles: pageTools }, paths: this.paths });
    run.draft = { ...draft, toolNames: run.plan.tools.map(tool => `${run.siteKey}.${tool.name.replace(/_/g, '-')}`) };
    run.draftFiles = [...readPackageDirectory(run.draft.adapterDir).files.keys()];
    run.generationRequestDigest = requestDigest;
    this.update(run, 'draft', 'Draft created. Inspect and edit it, then validate. No model was called.');
    return this.summary(run);
  }

  facade(run) {
    return { id: run.taskId, snapshot: { siteKey: run.siteKey, repairScope: run.repairScope, input: { tabId: run.tabId, memory: run.memory },
      artifacts: { draft: run.draft, staticValidation: run.validation } }, setArtifact() {} };
  }

  assertTabAvailable(tabId, taskId) {
    if ([...this.controllers.keys()].some(id => id !== taskId && this.runs.get(id)?.tabId === tabId)) {
      throw fail('TAB_BUSY', 'Another task still owns an in-flight operation on this tab. Wait for it to settle.');
    }
  }

  assertPlannedDraft(run) {
    const pkg = readPackageDirectory(run.draft.adapterDir);
    const retained = verifyRetainedPackage(pkg, readGenerationEvidence(run.draft.adapterDir), { paths: this.paths, repairScope: run.repairScope });
    const writes = plannedWrites(run);
    for (const tool of run.plan?.tools || []) {
      const command = pkg.commands.find(item => item.name === `${run.siteKey}.${tool.name.replace(/_/g, '-')}`);
      if (tool.strategy === 'EXTENSION_API' || isBackgroundCommand(command)) {
        if (tool.strategy !== 'EXTENSION_API' || !isBackgroundCommand(command) || command.pageRoute || command.pageWorkflow || command.pageStrategy
          || command.schema?.['x-webcli-agent-authored'] !== true) throw fail('BACKGROUND_CONTRACT_REQUIRED', 'Preserve background execution, author the request/authentication, and validate without a page route.');
      }
    }
    for (const tool of run.plan?.tools || []) if (tool.risk === 'write') {
      const command = pkg.commands.find(item => item.name === `${run.siteKey}.${tool.name.replace(/_/g, '-')}`);
      if (!command || (tool.strategy === 'UI_SELECTOR' ? !command.uiWrite : tool.strategy === 'PAGE_FETCH' ? !command.pageWrite : command.runtime !== 'http')) throw fail('WRITE_RUNTIME_REQUIRED', 'Write runtime must match the explicit plan.');
    }
    if (pkg.commands.some(command => !retained.has(command.id) && (writes.includes(command.name)
      ? command.safety !== 'write' || !(command.runtime === 'http' || command.pageWrite || command.uiWrite) || command.schema?.['x-webcli-agent-authored'] !== true
      : command.safety !== 'read' || !['extension', 'http'].includes(command.runtime)))) throw fail('READ_ONLY_REQUIRED', 'Draft safety/runtime must match the explicit read or write plan.');
    if (run.mode === 'http' && pkg.commands.some(command => run.draft.toolNames.includes(command.name) && (command.runtime !== 'http' || command.http.cookies))) throw fail('HTTP_PLAN_REQUIRED', 'Host tasks can only validate browser-independent HTTP commands.');
    return pkg;
  }

  validate(run) {
    for (const tool of run.plan?.tools || []) {
      const source = run.pageSources?.find(item => item.id === tool.sourcePageId)?.source;
      if (source?.mode === 'workflow') {
        const cases = run.verification?.[`${run.siteKey}.${tool.name.replace(/_/g, '-')}`] || [];
        for (const { name } of workflowParameters(source)) {
          const values = cases.map(item => item.args[name]);
          if (values.some(value => typeof value !== 'string' || !value.trim()) || new Set(values).size < 2) throw fail('VERIFICATION_REQUIRED', 'Every workflow parameter requires at least two distinct authored values.');
        }
      }
      if ((source?.strategy === 'INTERCEPT' || source?.mode === 'query') && source.trigger.parameter) {
        const cases = run.verification?.[`${run.siteKey}.${tool.name.replace(/_/g, '-')}`] || [];
        const values = cases.map(item => item.args[source.trigger.parameter]);
        if (values.some(value => typeof value !== 'string' || !value.trim()) || new Set(values).size < 2) {
          throw fail('VERIFICATION_REQUIRED', 'Parameterized page queries require at least two authored cases with distinct trigger values.');
        }
      }
      const bindings = source?.mode === 'navigate' ? navigationParameters(source) : tool.pathParameters;
      if (!bindings?.length) continue;
      const cases = run.verification?.[`${run.siteKey}.${tool.name.replace(/_/g, '-')}`] || [];
      const pathValues = cases.map(item => bindings.map(binding => item.args[binding.name]));
      if (cases.length < 2 || pathValues.some(values => values.some(value => typeof value !== 'string' || !value.trim()))
        || new Set(pathValues.map(values => JSON.stringify(values))).size < 2) {
        throw fail('VERIFICATION_REQUIRED', 'Dynamic paths require at least two authored cases with distinct path argument combinations.');
      }
      if (source?.hashNavigation && navigationParameters(source).some(binding => new Set(cases.map(item => item.args[binding.name])).size < 2)) throw fail('VERIFICATION_REQUIRED', 'Each hash navigation parameter needs two distinct authored values.');
      if (source?.queryParameters?.some(binding => new Set(cases.map(item => item.args[binding.name])).size < 2)) throw fail('VERIFICATION_REQUIRED', 'Each navigation query parameter needs two distinct authored values.');
    }
    if ((run.pageSources || []).some(item => ['query', 'navigate', 'workflow'].includes(item.source.mode)) && !this.capabilities().capabilities.includes('page_query_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension before validating navigation-aware page queries.');
    if ((run.pageSources || []).some(item => item.source.mode === 'workflow') && !this.capabilities().capabilities.includes('page_workflow_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension before validating ordered page workflows.');
    if ((run.pageSources || []).some(item => item.source.mode === 'navigate') && !this.capabilities().capabilities.includes('page_navigation_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension before validating parameterized page routes.');
    if ((run.pageSources || []).some(item => usesWorkflowOrigins(item.source)) && !this.capabilities().capabilities.includes('page_navigation_origin_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the selected extension before validating explicit cross-origin page reading.');
    if ((run.pageSources || []).some(item => usesWorkflowControl(item.source)) && !this.capabilities().capabilities.includes('page_workflow_control_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the selected extension before validating conditional or repeated page workflows.');
    if ((run.pageSources || []).some(item => usesNavigationHash(item.source)) && !this.capabilities().capabilities.includes('page_navigation_hash_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the selected extension before validating hash navigation.');
    if ((run.pageSources || []).some(item => usesNavigationQuery(item.source)) && !this.capabilities().capabilities.includes('page_navigation_query_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension before validating public URL query navigation.');
    const pageTools = (run.plan?.tools || []).filter(tool => tool.risk !== 'write' && (tool.sourcePageId || isHttpStrategy(tool.strategy) || tool.strategy === 'EXTENSION_API')).map(tool => `${run.siteKey}.${tool.name.replace(/_/g, '-')}`);
    for (const command of readPackageDirectory(run.draft.adapterDir).commands.filter(command => run.draft.toolNames.includes(command.name))) {
      if (isBackgroundCommand(command) && !this.capabilities().capabilities.includes('background_preview_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the selected extension for real background validation; page preview is not equivalent.');
      if (command.uiWrite && !this.capabilities().capabilities.includes('ui_write_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the selected extension before validating UI writes.');
      if (command.uiWrite?.result && !this.capabilities().capabilities.includes('ui_write_result_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the selected extension before validating UI receipt IDs.');
      if (command.pageWrite && !this.capabilities().capabilities.includes('page_write_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the selected extension before validating page writes.');
      const capability = httpCredentialsCapability(command.http);
      if (capability && !this.capabilities().capabilities.includes(capability)) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the selected extension before validating scoped HTTP cookies.');
    }
    if (run.plan?.tools?.some(tool => tool.strategy === 'INTERCEPT') && !this.capabilities().capabilities.includes('intercept_read_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension before validating intercepted queries.');
    if (run.plan?.tools?.some(tool => tool.sourcePageId) && !this.capabilities().capabilities.includes('page_sources_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension before validating page sources.');
    if ((run.repairScope ? run.draft.toolNames.filter(tool => !plannedWrites(run).includes(tool)) : pageTools).some(tool => !run.verification?.[tool]?.length)) throw fail('VERIFICATION_REQUIRED', 'Every repaired read or page-based command needs authored verification cases; write commands require independent write fixtures.');
    if (Object.keys(run.verification || {}).length && !this.capabilities().capabilities.includes('strict_output_contract_v1')) throw fail('CAPABILITY_UNAVAILABLE', 'Reload the extension before validating authored assertions.');
    const selectedCommands = readPackageDirectory(run.draft.adapterDir).commands.filter(command => run.draft.toolNames.includes(command.name));
    const needsPage = selectedCommands.some(command => command.runtime === 'extension' && !isBackgroundCommand(command));
    if (run.mode !== 'http' && needsPage) this.assertTabAvailable(run.tabId, run.taskId);
    run.review = null; run.runtimeDigest = null; run.runtimeSummary = null; run.preWriteDigest = null;
    const pageIds = new Set((run.plan?.tools || []).filter(tool => tool.risk === 'read').map(tool => tool.sourcePageId));
    const readTargets = (run.pageSources || []).filter(item => pageIds.has(item.id) && usesWorkflowOrigins(item.source)).flatMap(item => pageSourceOriginTargets(item.source, item.expectedOrigin, item.expectedPath));
    return this.launch(run, 'validating', async signal => {
      if (needsPage) await this.checkTab(run, readTargets);
      if (signal.aborted) return;
      run.validation = validateAdapterDraft({ adapterDir: run.draft.adapterDir, expectedSiteKey: run.siteKey, expectedToolNames: run.draft.toolNames, paths: this.paths, repairScope: run.repairScope });
      if (!run.validation.passed) { this.update(run, 'draft', 'Static validation failed; inspect validation errors.'); return; }
      this.assertPlannedDraft(run);
      const writes = plannedWrites(run);
      const proof = writes.length ? writeProofDigest(run) : null;
      if (writes.length) {
        const mock = await verifyGeneratedWriteTools({ adapterDir: run.draft.adapterDir, expectedSiteKey: run.siteKey, paths: this.paths, repairScope: run.repairScope, signal });
        if (signal.aborted) return;
        if (!mock.passed) {
          run.runtimeSummary = { passed: false, errors: mock.errors.map(({ code, toolName }) => ({ code, tool: toolName })) };
          this.update(run, 'draft', 'Write mock verification failed; no real write was dispatched.'); return;
        }
      }
      const readDraft = { ...run.draft, toolNames: run.draft.toolNames.filter(name => !writes.includes(name)) };
      const runtime = readDraft.toolNames.length ? await this.runtimeValidator({ run: this.facade(run), draft: readDraft, signal, plan: run.plan, memory: run.memory, validation: run.validation, verification: run.verification })
        : { passed: true, executionSummary: { attempted: 0, passed: 0, failed: 0, skipped: 0 } };
      if (signal.aborted) return;
      if (needsPage) await this.checkTab(run, readTargets);
      if (signal.aborted) return;
      // Persist only verifier summaries, never observed result bodies/test inputs.
      const counts = runtime.executionSummary;
      run.runtimeSummary = { passed: runtime.passed === true, ...(writes.length ? { writeMocks: { passed: true, count: writes.length } } : {}), executionSummary: counts ? { attempted: counts.attempted, passed: counts.passed, skipped: counts.skipped, failed: counts.failed } : null,
        errors: (runtime.errors || []).slice(0, 20).map(error => ({ code: String(error.code || 'VALIDATION_FAILED'),
          ...(error.toolName ? { tool: String(error.toolName).slice(0, 200) } : {}),
          ...(error.caseId ? { caseId: String(error.caseId).slice(0, 64) } : {}),
          ...(error.path ? { path: String(error.path).slice(0, 200) } : {}) })) };
      const count = readDraft.toolNames.reduce((total, name) => total + (run.verification?.[name]?.length || 1), 0);
      if (!runtime.passed || !counts || counts.attempted !== count || counts.passed !== count || counts.skipped !== 0 || counts.failed !== 0) {
        this.update(run, 'draft', 'Runtime validation incomplete; repair the draft or page state and validate again.'); return;
      }
      if (readPackageDirectory(run.draft.adapterDir).digest !== run.validation.packageDigest) throw fail('STALE_DRAFT', 'Draft changed during verification.');
      if (writes.length) {
        if (writeProofDigest(run) !== proof) throw fail('STALE_DRAFT', 'Write cases changed during verification.');
        run.preWriteDigest = proof;
        finishWriteValidation(this, run);
        return;
      }
      run.runtimeDigest = run.validation.packageDigest;
      run.verifiedAt = new Date().toISOString();
      this.update(run, 'review_ready', 'Read tools passed validation. Review before installation.');
    });
  }

  assertValidated(run) {
    const pkg = this.assertPlannedDraft(run);
    if (run.status !== 'review_ready' || !run.validation?.passed || run.runtimeDigest !== pkg.digest) throw fail('VALIDATION_REQUIRED', 'Validate the current draft before review or installation.');
    if (plannedWrites(run).length && (run.preWriteDigest !== writeProofDigest(run) || plannedWrites(run).some(tool => !run.writeExecutions?.some(item => item.tool === tool && item.digest === run.preWriteDigest && item.status === 'verified')))) throw fail('VALIDATION_REQUIRED', 'Every current write requires mock and real effect verification.');
  }
}
