import path from 'node:path';
import { classifyApiCandidateRisk } from './source-evidence.js';
import { plannedToolNames } from './plan-binding.js';
import { GENERATION_STATUSES as S } from './constants.js';
import { writeGenerationHarnessProvenance } from './provenance.js';
import { allocateGenerationPlan } from './existing-site.js';

export function buildQuickGenerationPlan(memory) {
  const tools = [];
  for (const [kind, candidates] of [['list', memory.listApiCandidates], ['action', memory.actionApiCandidates]]) {
    for (const [index, candidate] of (candidates || []).entries()) {
      const sourceKind = kind === 'list' ? 'passive_list' : 'action_capture';
      const risk = classifyApiCandidateRisk(candidate, { sourceKind });
      if (risk.level !== 'read' || risk.confidence < 0.75 || !candidate.url) continue;
      // Captured non-GET actions need authored request semantics, even if their
      // endpoint name looks like a query. Quick mode never guesses a payload.
      if (kind === 'action' && (String(candidate.method || 'GET').toUpperCase() !== 'GET' || !candidate.toolName)) continue;
      tools.push({ name: `query_${kind}_${index + 1}`, purpose: '查询探索中发现的接口', risk: 'read', sourceApiKind: kind, sourceApiIndexes: [index] });
      if (tools.length === 2) break;
    }
    if (tools.length === 2) break;
  }
  if (!tools.length) throw Object.assign(new Error('没有可快速生成的查询接口，请使用智能生成处理动作证据。'), { code: 'QUICK_GENERATION_NO_READ_APIS' });
  return { summary: '依据已有查询证据生成并验证草稿', strategy: 'api_first', tools };
}

/** No model calls, no installation, and no fresh generation on resume. */
export async function runQuickGeneration({ run, signal, store, memory, scaffoldWriter, staticValidator, runtimeValidator, resume = false }) {
  run.assertNotCancelled(signal);
  let plan = run.snapshot.artifacts?.plan;
  let draft = run.snapshot.artifacts?.draft;
  if (!resume) {
    run.setArtifact('generationMode', run.snapshot.input?.mode === 'auto' ? 'auto' : 'quick');
    run.transition(S.CONTEXT_READY, { currentAction: 'context_ready' });
    run.transition(S.PLANNING, { currentAction: 'create_quick_generation_plan' });
    plan = allocateGenerationPlan(memory, buildQuickGenerationPlan(memory));
    run.setArtifact('plan', plan);
    run.transition(S.DRAFTING, { currentAction: 'generate_adapter_draft' });
    const rootDir = path.join(store.getDraftRoot(run.id), 'revision-0');
    const generated = scaffoldWriter(memory, { outputRoot: rootDir, plan });
    draft = { revision: 0, rootDir, adapterDir: generated.adapterDir, packageFormat: generated.packageFormat,
      managedBaseline: generated.managedBaseline, files: generated.files, toolNames: plannedToolNames(memory.siteKey, plan, generated.packageFormat) };
    run.setArtifact('draft', draft);
    run.setArtifact('draftHistory', [draft]);
  } else if (!draft || draft.packageFormat !== 2 || !plan) throw new Error('Quick generation has no recoverable package draft.');
  run.setArtifact('pendingQuestion', null);
  run.transition(S.STATIC_VALIDATING, { currentAction: 'validate_adapter_draft' });
  run.recordStep('validate_adapter_draft', { mode: 'quick' });
  const validation = staticValidator({ adapterDir: draft.adapterDir, expectedSiteKey: memory.siteKey, expectedToolNames: draft.toolNames });
  run.setArtifact('staticValidation', validation);
  if (!validation.passed) throw Object.assign(new Error('快速草稿未通过静态验证，请检查草稿或改用智能生成。'), { code: 'STATIC_VALIDATION_FAILED', details: validation });
  if (typeof runtimeValidator !== 'function') throw new Error('Quick generation requires a browser preview validator.');
  run.transition(S.RUNTIME_VALIDATING, { currentAction: 'validate_adapter_runtime' });
  run.recordStep('validate_adapter_runtime', { mode: 'quick' });
  const runtimeValidation = await runtimeValidator({ run, signal, store, draft, plan, memory, validation });
  run.setArtifact('runtimeValidation', runtimeValidation);
  if (!runtimeValidation?.passed) {
    const needsPage = runtimeValidation?.errors?.some(error => ['TARGET_TAB_NOT_FOUND', 'LOGIN_REQUIRED', 'LOGIN_OR_HTML_RESPONSE'].includes(error.code));
    if (!needsPage) throw Object.assign(new Error('快速草稿未通过运行验证，请检查验证结果或改用智能生成。'), { code: 'RUNTIME_VALIDATION_FAILED', details: runtimeValidation });
    run.setArtifact('pendingQuestion', { question: '请打开对应站点并登录，完成后继续验证当前草稿。', askedDuring: run.status });
    run.transition(S.NEEDS_USER_INPUT, { currentAction: 'open_or_login_target_page' });
    return { pause: true, status: S.NEEDS_USER_INPUT };
  }
  run.assertNotCancelled(signal);
  run.assertWithinBudget();
  if (run.snapshot.input?.mode === 'auto') {
    const summary = runtimeValidation.executionSummary;
    const count = draft.toolNames.length;
    if (!count || !summary || summary.attempted !== count || summary.passed !== count || summary.skipped !== 0 || summary.failed !== 0) {
      throw Object.assign(new Error('全部目标工具必须通过真实执行验证，不能跳过。'), { code: 'RUNTIME_EXECUTION_REQUIRED' });
    }
    if (run.snapshot.artifacts.automaticRepair?.attempted) {
      run.setArtifact('automaticRepair', { ...run.snapshot.artifacts.automaticRepair, outcome: 'passed' });
    }
  }
  writeGenerationHarnessProvenance({ run, draft, plan, validation, runtimeValidation });
  run.transition(S.AWAITING_APPROVAL, { currentAction: 'await_install_approval' });
  return { pause: true, status: S.AWAITING_APPROVAL, plan, draft, validation, runtimeValidation };
}
