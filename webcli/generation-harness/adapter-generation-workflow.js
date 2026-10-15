import path from 'node:path';
import { bindGenerationPlan, plannedToolNames } from './plan-binding.js';
import { writeAdapterPackageFromSiteMemory } from '../adapter-scaffold.js';
import { resolveAdaptersDir } from '../paths.js';
import { seedAdapterDraft } from './adapter-workspace.js';
import { GENERATION_STATUSES } from './constants.js';
import { createJsonActionModel } from './json-action-model.js';
import { runToolLoop } from './tool-loop.js';
import { validateAdapterDraft } from './static-validator.js';
import { reviseAdapterDraft } from './draft-revision.js';
import { normalizePreviousFailureInput } from './failure-attribution.js';
import { runGenerationOrchestrator, resumeGenerationOrchestrator } from './generation-orchestrator.js';
import { writeGenerationHarnessProvenance } from './provenance.js';
import { normalizeRequestBodyEvidence, normalizeResponseBodyEvidence } from './source-evidence.js';
import { runQuickGeneration } from './quick-generation.js';
import { runAutomaticGeneration } from './automatic-generation.js';
import { prepareGenerationRun, allocateGenerationPlan } from './existing-site.js';

function summarizeCandidate(candidate, index, sourceApiKind) {
  let pathname = '';
  let queryKeys = [];
  try {
    const url = new URL(candidate?.url || '');
    pathname = url.pathname;
    queryKeys = [...url.searchParams.keys()].slice(0, 20);
  } catch {
    pathname = String(candidate?.url || '').slice(0, 300);
  }
  return {
    index,
    sourceApiKind,
    method: String(candidate?.method || 'GET').toUpperCase(),
    pathname,
    queryKeys,
    actionName: candidate?.actionName || '',
    toolName: candidate?.toolName || '',
    status: candidate?.status,
    responseEvidence: normalizeResponseBodyEvidence(candidate),
    requestEvidence: candidate?.requestEvidence || candidate?.sourceEvidence?.requestEvidence || null,
    sourceEvidence: sanitizeSourceEvidence(candidate?.sourceEvidence),
    responseHints: sanitizeResponseHints(candidate?.responseHints),
    evidenceId: candidate?.apiEvidence?.evidenceId || '',
    verdict: candidate?.apiEvidence?.verdict || '',
    score: candidate?.apiEvidence?.score,
    risk: candidate?.apiEvidence?.risk || '',
    strategyNote: candidate?.apiEvidence?.strategyNote || null,
    verificationFixture: sanitizeVerificationFixture(candidate?.apiEvidence?.verificationFixture),
  };
}

function sanitizeSourceEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  return {
    version: String(evidence.version || ''),
    fingerprint: String(evidence.fingerprint || ''),
    sourceKind: String(evidence.sourceKind || ''),
    method: String(evidence.method || 'GET').toUpperCase(),
    endpoint: String(evidence.endpoint || ''),
    queryKeys: (Array.isArray(evidence.queryKeys) ? evidence.queryKeys : []).map(String).slice(0, 30),
    bodyKeys: (Array.isArray(evidence.bodyKeys) ? evidence.bodyKeys : []).map(String).slice(0, 50),
    requestEvidence: normalizeRequestBodyEvidence({ requestEvidence: evidence.requestEvidence }),
    risk: evidence.risk || null,
  };
}

function sanitizeResponseHints(hints) {
  if (!hints || typeof hints !== 'object') return null;
  const strings = (value, limit = 80) => (Array.isArray(value) ? value : []).map(String).slice(0, limit);
  return {
    topLevelKeys: strings(hints.topLevelKeys, 40),
    listPath: String(hints.listPath || ''),
    itemKeys: strings(hints.itemKeys),
    idLikeKeys: strings(hints.idLikeKeys, 30),
    displayLikeKeys: strings(hints.displayLikeKeys, 30),
    availabilityLikeKeys: strings(hints.availabilityLikeKeys, 30),
    preferredIdKey: String(hints.preferredIdKey || ''),
    preferredDisplayKey: String(hints.preferredDisplayKey || ''),
    preferredAvailabilityKey: String(hints.preferredAvailabilityKey || ''),
  };
}

function sanitizeVerificationFixture(fixture) {
  if (!fixture || typeof fixture !== 'object') return null;
  const strings = (value, limit = 30) => (Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limit);
  const rowCount = fixture.rowCount && typeof fixture.rowCount === 'object'
    ? {
        min: Number(fixture.rowCount.min || 0),
        max: Number(fixture.rowCount.max || 0),
      }
    : null;
  return {
    source: fixture.source === 'captured_response' ? 'captured_response' : 'structural_evidence',
    status: (Array.isArray(fixture.status) ? fixture.status : []).map(Number).filter(Number.isFinite).slice(0, 10),
    contentTypes: strings(fixture.contentTypes, 10),
    rowCount,
    requiredPaths: strings(fixture.requiredPaths),
    types: Object.fromEntries(Object.entries(fixture.types || {}).slice(0, 50).map(([key, value]) => [key, String(value)])),
    notEmpty: strings(fixture.notEmpty),
    mustNotContain: strings(fixture.mustNotContain),
    mustBeTruthy: strings(fixture.mustBeTruthy),
  };
}

function summarizeApiAnalysis(analysis) {
  if (!analysis || analysis.schemaVersion !== 2) return null;
  return {
    schemaVersion: 2,
    likelyDataCount: Number(analysis.likelyDataCount || 0),
    maybeDataCount: Number(analysis.maybeDataCount || 0),
    noiseCount: Number(analysis.noiseCount || 0),
    blockedCount: Number(analysis.blockedCount || 0),
    recommendedNextProbe: String(analysis.recommendedNextProbe || ''),
    candidates: (Array.isArray(analysis.candidates) ? analysis.candidates : []).slice(0, 30).map((candidate) => ({
      evidenceId: String(candidate?.evidenceId || ''),
      endpointFamily: String(candidate?.endpointFamily || ''),
      method: String(candidate?.method || 'GET').toUpperCase(),
      origin: String(candidate?.origin || ''),
      path: String(candidate?.path || ''),
      queryKeys: (Array.isArray(candidate?.queryKeys) ? candidate.queryKeys : []).map(String).slice(0, 30),
      status: candidate?.status ?? null,
      contentType: String(candidate?.contentType || ''),
      sourceSteps: (Array.isArray(candidate?.sourceSteps) ? candidate.sourceSteps : []).map(String).slice(0, 20),
      requestShape: candidate?.requestShape || null,
      responseShape: candidate?.responseShape || null,
      verdict: String(candidate?.verdict || ''),
      score: Number(candidate?.score || 0),
      signals: (Array.isArray(candidate?.signals) ? candidate.signals : []).map(String).slice(0, 30),
      risk: String(candidate?.risk || ''),
      strategyNote: candidate?.strategyNote || null,
      verificationFixture: sanitizeVerificationFixture(candidate?.verificationFixture),
    })),
  };
}

export function buildContextSections(memory, previousFailure = null) {
  const listCandidates = Array.isArray(memory.listApiCandidates) ? memory.listApiCandidates : [];
  const actionCandidates = Array.isArray(memory.actionApiCandidates) ? memory.actionApiCandidates : [];
  return {
    overview: {
      siteKey: memory.siteKey,
      siteHost: memory.siteHost,
      canonicalEntryUrl: memory.canonicalEntryUrl,
      recommendedStrategy: memory.recommendedStrategy,
      verdictPattern: memory.verdictPattern,
      verdictReason: memory.verdictReason,
      listApiCount: listCandidates.length,
      actionApiCount: actionCandidates.length,
      previousFailurePresent: Boolean(previousFailure),
      ...(memory.generationBaseline ? { existingPackage: { name: memory.generationBaseline.name, reservedCommandNames: memory.generationBaseline.reservedNames, mode: 'additive' } } : {}),
    },
    list_apis: listCandidates.slice(0, 30).map((candidate, index) => summarizeCandidate(candidate, index, 'list')),
    action_apis: actionCandidates.slice(0, 30).map((candidate, index) => summarizeCandidate(candidate, index, 'action')),
    api_analysis: summarizeApiAnalysis(memory.apiAnalysisV2),
    previous_failure: previousFailure,
  };
}

const PLAN_SYSTEM_PROMPT = `你是 Adapter 生成规划器。你的任务不是直接写代码，而是分析探索结果并保存一份生成计划。

必须遵循：
1. 先调用 inspect_generation_context 查看 overview。
2. 根据 overview 再查看 list_apis 和/或 action_apis。
3. 调用 save_generation_plan 保存计划。
4. 保存成功后输出 final。
5. 查询类工具 risk 必须为 read；action_apis 中的提交、修改、删除、审批类候选可计划为 write 工具（运行验证只注册不真实执行，发布与调用均有确认门）；未在 action_apis 出现的接口不得计划为 write。查询类工具最多计划 2 个。工具名一律用英文 snake_case（写工具按动作语义命名，如 submit_request），不得使用中文或候选原始 toolName。
6. 不要虚构未在上下文中出现的接口。
7. 候选分数不是接口可用性证明；必须读取 strategyNote 和 verificationFixture，未重放候选不得描述为已验证。
8. 如果 overview 显示存在 previous_failure（同站点上一次生成失败复盘），必须查看它：剔除或替换其中反复失败的工具、规避导致失败的策略，并在计划 summary 中说明针对上次失败的应对。
9. 每个工具填写 sourceApiKind：list_apis 的候选为 list，action_apis 的候选为 action（包括补充录制的只读搜索、筛选）。sourceApiIndexes 是对应列表内的原始 index，两组索引不能混用。`;


const WRITE_TOOL_SIGNAL_RE = /(?:^|[^a-z0-9])(create|add|update|edit|delete|remove|submit|approve|reject|book|cancel|publish|upload|import|run|execute|restart|deploy|set|bind|unbind|confirm|apply|reply)(?:$|[^a-z0-9])/i;

function isReadOnlyPlannedTool(tool) {
  return tool?.risk === 'read' && !WRITE_TOOL_SIGNAL_RE.test(`${tool?.name || ''} ${tool?.purpose || ''}`);
}

export function readOnlyV2Memory(memory) {
  const analysis = memory?.apiAnalysisV2;
  if (!analysis || analysis.schemaVersion !== 2) return memory;
  const verifiedIds = new Set((Array.isArray(analysis.candidates) ? analysis.candidates : [])
    .filter((candidate) => candidate?.risk === 'read' && candidate?.strategyNote?.replayStatus === 'verified'
      && (!Array.isArray(analysis.selectedEvidenceIds) || analysis.selectedEvidenceIds.includes(candidate.evidenceId)))
    .map((candidate) => String(candidate.evidenceId || '')));
  const listApiCandidates = (Array.isArray(memory.listApiCandidates) ? memory.listApiCandidates : [])
    .filter((candidate) => verifiedIds.has(String(candidate?.apiEvidence?.evidenceId || '')));
  const apiAnalysisV2 = {
    ...analysis,
    candidates: (Array.isArray(analysis.candidates) ? analysis.candidates : [])
      .filter((candidate) => verifiedIds.has(String(candidate.evidenceId || ''))),
  };
  return {
    ...memory,
    listApiCandidates,
    apiAnalysisV2,
    // 动作捕获候选（含写操作）保留进入生成：写工具由「运行验证只注册不真实执行 +
    // 发布人工确认 + 调用时确认门」三层护栏约束，不再一刀切排除。
    actionApiCandidates: Array.isArray(memory.actionApiCandidates)
      ? memory.actionApiCandidates.filter((candidate) => Boolean(candidate?.toolName))
      : [],
    actionCaptureHistory: [],
    actionEvidenceSummary: undefined,
  };
}

export function readOnlyV2Plan(plan, { allowWriteTools = false } = {}) {
  const tools = (Array.isArray(plan?.tools) ? plan.tools : []).filter((tool) => {
    if (isReadOnlyPlannedTool(tool)) return true;
    return allowWriteTools && tool?.risk === 'write';
  });
  return {
    ...plan,
    strategy: plan?.strategy === 'action_only' ? 'api_first' : plan?.strategy,
    tools,
  };
}

export function buildPlanSemanticEnhancement(memory, plan) {
  const overrides = bindGenerationPlan(memory, plan).scaffoldSemanticHints.toolOverrides;
  const quickPrompts = (Array.isArray(plan?.tools) ? plan.tools : [])
    .slice(0, 3)
    .map((tool) => String(tool?.purpose || tool?.name || '').trim())
    .filter(Boolean)
    .map((purpose) => `帮我${purpose}`);
  return {
    analysisSource: 'harness_plan',
    manifestDescription: String(plan?.summary || '').trim(),
    quickPrompts,
    toolOverrides: overrides,
  };
}

export function createAdapterGenerationWorkflow({
  model = createJsonActionModel(),
  semanticAnalyzer = null,
  scaffoldWriter = writeAdapterPackageFromSiteMemory,
  staticValidator = validateAdapterDraft,
  adaptersDir = resolveAdaptersDir(),
  runtimeValidator = null,
  automaticRepairTimeoutMs = undefined,
} = {}) {
  return async ({ run, signal, store }) => {
    const memory = readOnlyV2Memory(prepareGenerationRun(run));
    if (!memory?.siteKey) throw new Error('generation run input.memory is required');
    if (run.snapshot.input?.mode === 'quick') return runQuickGeneration({ run, signal, store, memory, scaffoldWriter, staticValidator, runtimeValidator });
    if (run.snapshot.input?.mode === 'auto') return runAutomaticGeneration({ run, signal, store, memory, model, scaffoldWriter, staticValidator, runtimeValidator, repairTimeoutMs: automaticRepairTimeoutMs });
    const previousFailure = normalizePreviousFailureInput(run.snapshot.input?.previousFailure);
    if (previousFailure) run.trace('previous_failure_loaded', previousFailure);
    const sections = buildContextSections(memory, previousFailure);
    let plan = null;

    run.assertNotCancelled(signal);
    run.transition(GENERATION_STATUSES.CONTEXT_READY, { currentAction: 'context_ready' });

    const generationMode = String(run.snapshot.input?.mode || '') === 'agent' && typeof runtimeValidator === 'function'
      ? 'agent'
      : 'classic';
    if (generationMode === 'agent') {
      return runGenerationOrchestrator({
        run,
        signal,
        store,
        model,
        memory,
        sections,
        scaffoldWriter,
        staticValidator,
        runtimeValidator,
        adaptersDir,
        semanticAnalyzer,
        writeGenerationHarnessProvenance,
      });
    }

    run.transition(GENERATION_STATUSES.PLANNING, { currentAction: 'create_generation_plan' });

    const loopResult = await runToolLoop({
      model,
      systemPrompt: PLAN_SYSTEM_PROMPT,
      maxSteps: Math.min(5, run.snapshot.budget.maxSteps),
      signal,
      messages: [{
        role: 'user',
        content: [
          `为 ${memory.siteKey} 制定 API 类 Adapter 生成计划。`,
          `用户生成目标：${run.snapshot.goal || '生成可验证的只读 API Adapter'}`,
        ].join('\n'),
      }],
      context: { run },
      onEvent: (event) => {
        if (event.type === 'model_started') run.recordModelCall({ phase: 'planning', step: event.step });
        if (event.type === 'tool_started') run.recordStep(event.call.name, { phase: 'planning' });
        run.trace(`tool_loop_${event.type}`, event);
      },
      tools: [
        {
          name: 'inspect_generation_context',
          description: '读取探索结果的指定部分。先读取 overview，再按需读取 API 列表。',
          parameters: {
            type: 'object',
            properties: {
              section: { type: 'string', enum: ['overview', 'list_apis', 'action_apis', 'api_analysis', 'previous_failure'] },
            },
            required: ['section'],
            additionalProperties: false,
          },
          execute: async ({ section }) => sections[section] ?? null,
        },
        {
          name: 'save_generation_plan',
          description: '保存最终 Adapter 生成计划。',
          parameters: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              strategy: { type: 'string', enum: ['api_first', 'hybrid', 'action_only'] },
              tools: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    purpose: { type: 'string' },
                    risk: { type: 'string', enum: ['read', 'write'] },
                    sourceApiKind: { type: 'string', enum: ['list', 'action'] },
                    sourceApiIndexes: { type: 'array', items: { type: 'integer' } },
                  },
                  required: ['name', 'purpose', 'risk', 'sourceApiIndexes'],
                  additionalProperties: false,
                },
              },
            },
            required: ['summary', 'strategy', 'tools'],
            additionalProperties: false,
          },
          execute: async (nextPlan) => {
            plan = allocateGenerationPlan(memory, readOnlyV2Plan(nextPlan, { allowWriteTools: (Array.isArray(memory.actionApiCandidates) ? memory.actionApiCandidates.length : 0) > 0 }));
            run.setArtifact('plan', plan);
            return { saved: true, toolCount: plan.tools.length, plan };
          },
        },
      ],
    });

    if (!plan) throw new Error('planning loop completed without save_generation_plan');
    run.trace('planning_completed', { plan, loopSteps: loopResult.steps });
    run.assertNotCancelled(signal);
    run.transition(GENERATION_STATUSES.DRAFTING, { currentAction: 'generate_adapter_draft' });

    let semanticEnhancement = buildPlanSemanticEnhancement(memory, plan);
    run.trace('semantic_enhancement_from_plan', {
      toolOverrideCount: semanticEnhancement.toolOverrides.length,
      quickPromptCount: semanticEnhancement.quickPrompts.length,
    });
    if (typeof semanticAnalyzer === 'function') {
      run.recordModelCall({ phase: 'semantic_enhancement' });
      try {
        const analyzed = await semanticAnalyzer({ memory });
        if (analyzed?.analysisSource === 'ai') semanticEnhancement = analyzed;
      } catch (error) {
        run.trace('semantic_enhancement_failed', { message: error.message });
      }
    }
    run.assertNotCancelled(signal);

    const revision = run.snapshot.revisionCount;
    const draftRoot = path.join(store.getDraftRoot(run.id), `revision-${revision}`);
    run.trace('draft_phase', { phase: 'seed_adapter_started', draftRoot });
    const workspace = seedAdapterDraft({
      // Every planned run starts fresh: existing tools are not evidence that
      // the current plan requested them. Publication still checks its baseline.
      sourceAdapterDir: draftRoot,
      draftRoot,
      siteKey: memory.siteKey,
      adaptersDir,
    });
    run.trace('draft_phase', {
      phase: 'seed_adapter_completed',
      seededFromExisting: workspace.seededFromExisting,
      copiedFiles: workspace.copyStats?.fileCount || 0,
      copiedBytes: workspace.copyStats?.totalBytes || 0,
    });
    run.setArtifact('workspace', workspace);
    const memoryForDraft = semanticEnhancement
      ? { ...memory, scaffoldSemanticHints: semanticEnhancement }
      : memory;
    run.trace('draft_phase', { phase: 'scaffold_write_started' });
    const draft = scaffoldWriter(memoryForDraft, { outputRoot: draftRoot, plan });
    run.trace('draft_phase', {
      phase: 'scaffold_write_completed',
      toolCount: draft.toolNames?.length || 0,
    });
    let currentDraft = {
      packageFormat: draft.packageFormat,
      managedBaseline: draft.managedBaseline,
      revision,
      rootDir: draftRoot,
      adapterDir: draft.adapterDir,
      toolNames: plannedToolNames(memory.siteKey, plan, draft.packageFormat),
      files: draft.files,
      semanticEnhancement: semanticEnhancement ? {
        analysisSource: semanticEnhancement.analysisSource,
        provider: semanticEnhancement.provider,
        model: semanticEnhancement.model,
      } : null,
    };
    run.setArtifact('draft', currentDraft);
    run.setArtifact('draftHistory', [currentDraft]);

    run.transition(GENERATION_STATUSES.STATIC_VALIDATING, { currentAction: 'validate_adapter_draft' });
    run.recordStep('validate_adapter_draft', { phase: 'static_validation' });
    let validation = staticValidator({
      adapterDir: currentDraft.adapterDir,
      expectedSiteKey: memory.siteKey,
      expectedToolNames: currentDraft.toolNames,
    });
    run.setArtifact('staticValidation', validation);
    run.trace('validation_completed', validation);

    const applyRevision = async (feedback) => {
      const revised = await reviseAdapterDraft({
        run,
        signal,
        store,
        model,
        draft: currentDraft,
        validation: feedback,
        staticValidator,
        runtimeValidator,
        plan,
        memory,
      });
      currentDraft = revised.draft;
      validation = revised.validation;
      if (revised.plan) plan = revised.plan;
      const history = Array.isArray(run.snapshot.artifacts.draftHistory)
        ? run.snapshot.artifacts.draftHistory
        : [];
      run.setArtifact('draft', currentDraft);
      run.setArtifact('draftHistory', [...history, {
        ...currentDraft,
        writes: revised.writes,
        incomplete: revised.incomplete,
        loopErrorCode: revised.loopErrorCode,
      }]);
      run.transition(GENERATION_STATUSES.STATIC_VALIDATING, {
        currentAction: 'validate_revised_adapter_draft',
        revision: currentDraft.revision,
      });
      run.setArtifact('staticValidation', validation);
      run.trace('validation_completed', validation);
      return revised;
    };

    while (!validation.passed && run.snapshot.revisionCount < run.snapshot.budget.maxRevisions) {
      await applyRevision(validation);
    }

    if (!validation.passed) {
      const error = new Error(`adapter draft failed static validation (${validation.errors.length} errors)`);
      error.code = 'STATIC_VALIDATION_FAILED';
      error.details = validation;
      throw error;
    }

    let runtimeValidation = null;
    if (typeof runtimeValidator === 'function') {
      while (true) {
        run.assertNotCancelled(signal);
        run.transition(GENERATION_STATUSES.RUNTIME_VALIDATING, { currentAction: 'validate_adapter_runtime' });
        run.recordStep('validate_adapter_runtime', { phase: 'runtime_validation' });
        runtimeValidation = await runtimeValidator({
          run,
          signal,
          store,
          draft: currentDraft,
          validation,
          plan,
          memory,
        });
        run.setArtifact('runtimeValidation', runtimeValidation);
        run.trace('runtime_validation_completed', runtimeValidation);
        if (runtimeValidation?.passed) break;
        const runtimeErrorCodes = new Set((runtimeValidation?.errors || []).map((error) => error?.code).filter(Boolean));
        if (runtimeErrorCodes.has('TARGET_TAB_NOT_FOUND') || runtimeErrorCodes.has('LOGIN_REQUIRED') || runtimeErrorCodes.has('LOGIN_OR_HTML_RESPONSE')) {
          run.transition(GENERATION_STATUSES.NEEDS_USER_INPUT, {
            currentAction: 'open_or_login_target_page',
            runtimeErrorCodes: [...runtimeErrorCodes],
          });
          return {
            pause: true,
            status: GENERATION_STATUSES.NEEDS_USER_INPUT,
            plan,
            draft: currentDraft,
            validation,
            runtimeValidation,
          };
        }
        if (run.snapshot.revisionCount >= run.snapshot.budget.maxRevisions) {
          const error = new Error(`adapter draft failed runtime validation (${runtimeValidation?.errors?.length || 0} errors)`);
          error.code = 'RUNTIME_VALIDATION_FAILED';
          error.details = runtimeValidation;
          throw error;
        }
        const revised = await applyRevision({
          passed: false,
          validator: runtimeValidation.validator || 'adapter_runtime_validator_v1',
          errors: runtimeValidation.errors || [],
          warnings: runtimeValidation.warnings || [],
          toolResults: runtimeValidation.toolResults || [],
        });
        if (!validation.passed) {
          const error = new Error(`runtime repair introduced static validation errors (${validation.errors.length} errors)`);
          error.code = 'STATIC_VALIDATION_FAILED_AFTER_RUNTIME_REPAIR';
          error.details = validation;
          throw error;
        }
        if (revised.runtimeValidation?.passed) {
          runtimeValidation = revised.runtimeValidation;
          run.setArtifact('runtimeValidation', runtimeValidation);
          run.trace('runtime_validation_completed_in_revision', runtimeValidation);
          break;
        }
      }
    }

    writeGenerationHarnessProvenance({
      run,
      draft: currentDraft,
      validation,
      runtimeValidation,
      plan,
    });

    run.transition(GENERATION_STATUSES.AWAITING_APPROVAL, { currentAction: 'await_publish_approval' });
    return {
      pause: true,
      status: GENERATION_STATUSES.AWAITING_APPROVAL,
      plan,
      draft: currentDraft,
      validation,
      runtimeValidation,
    };
  };
}

export function createAdapterGenerationResumeWorkflow({
  model = createJsonActionModel(),
  scaffoldWriter = writeAdapterPackageFromSiteMemory,
  staticValidator = validateAdapterDraft,
  adaptersDir = resolveAdaptersDir(),
  runtimeValidator = null,
} = {}) {
  return async ({ run, signal, store, answer }) => {
    const memory = readOnlyV2Memory(run.snapshot.input?.memory);
    if (!memory?.siteKey) throw new Error('generation run input.memory is required');
    if (run.snapshot.input?.mode === 'quick') return runQuickGeneration({ run, signal, store, memory, scaffoldWriter, staticValidator, runtimeValidator, resume: true });
    if (run.snapshot.input?.mode === 'auto') return runAutomaticGeneration({ run, signal, store, memory, model, scaffoldWriter, staticValidator, runtimeValidator, resume: true });
    return resumeGenerationOrchestrator({
      run,
      signal,
      store,
      model,
      memory,
      sections: buildContextSections(memory, null),
      scaffoldWriter,
      staticValidator,
      runtimeValidator,
      adaptersDir,
      semanticAnalyzer: null,
      writeGenerationHarnessProvenance,
    }, answer);
  };
}
