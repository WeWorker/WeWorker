import fs from 'node:fs';
import path from 'node:path';
import { plannedToolNames } from './plan-binding.js';
import { GENERATION_STATUSES } from './constants.js';
import { runToolLoop } from './tool-loop.js';
import { seedAdapterDraft } from './adapter-workspace.js';
import { GenerationHarnessError, GenerationPausedError } from './errors.js';
import {
  clipText,
  dropDraftTool,
  findPlanToolByName,
  listDraftFiles,
  resolveAdapterDraftFile,
} from './draft-revision.js';
import { readOnlyV2Plan, buildPlanSemanticEnhancement } from './adapter-generation-workflow.js';

const MAX_ORCHESTRATION_STEPS = 24;
const MAX_DRAFT_FILE_CHARS = 50_000;
const MAX_BATCH_DRAFT_FILE_CHARS = 40_000;
const MAX_TRACE_EVENTS = 60;
const MAX_TRACE_CHARS = 30_000;

const ORCHESTRATOR_SYSTEM_PROMPT = `你是 Adapter 生成编排者，负责从探索证据出发自主完成「计划 → 草稿 → 验证 → 修复 → 待发布」全流程，遇到问题随机应变。

目标：按照 OpenCLI 的 agent authoring 流程，产出一个同时通过静态验证、写工具 mock 验证和真实页面安全运行验证的 API Adapter，停在等待发布确认。

必须遵循：
1. 先 inspect_generation_context：overview 必看；如果存在 previous_failure（上次失败复盘）必须读取并吸收教训。
2. save_generation_plan 保存计划：查询类工具 risk=read（最多 2 个）；action_apis 中的提交/修改类候选可计划为 write。写工具必须由你根据安全的 requestEvidence 语义化创作，明确业务参数、显式 payload 构造、access=write、确认门和业务响应判断；不得把捕获值写成默认值。requestEvidence 为 opaque/omitted/truncated 时必须 request_user_input，禁止猜测或修复前缀。未在 action_apis 出现的接口不得计划为 write。工具名一律用英文 snake_case（如 submit_request），不得使用中文或候选原始 toolName。
3. scaffold_adapter_draft 只生成安全骨架。write 骨架含 AGENT_AUTHORED_WRITE_REQUIRED，必须读取对应文件并改写为业务语义实现；禁止让占位骨架进入验证通过状态。工具定义必须包含 access: 'write' 与 writeVerification，后者至少包含 representativeArgs、expectedRequest{method,url,body}、successResponse、successExpectation、failureResponse、failureExpectation，可用 forbiddenValues 声明禁止出现的捕获值。验证器会真实执行 handler，但 fetch 为本地 mock，不会访问站点。
   writeVerification 的 representativeArgs 仅提供虚构业务参数，不要填 __confirmed；验证器会分别测试省略确认、__confirmed:false 和 __confirmed:true。successExpectation 与 failureExpectation 必须是非空 JSON 对象，用于匹配结果字段子集，例如 {"ok":true} 和 {"ok":false}；禁止填写 JavaScript 表达式字符串。successResponse/failureResponse 使用 {"status":200,"body":{...}} 格式。
4. validate_adapter_draft 做静态验证；失败就读取/修改草稿文件后重验。
5. validate_adapter_runtime 做真实页面运行验证；失败按责任域处置：
   - 输出映射问题 → 对照错误修改草稿后重验；
   - 单个工具反复失败 → mark_tool_unverifiable 转人工或 drop_planned_tool 剔除（至少保留一个工具，处理后重验）；
   - 页面不可用或需要登录 → request_user_input 请用户处理；
   - 确实无法推进 → report_blocker 说明卡点、已试方案和建议。
6. 全部通过后调用 finish_run（前置条件不满足会被拒绝并说明原因），随后输出 final。
7. 需要回顾此前轮次时调用 inspect_run_trace。
8. 不得伪造数据通过验证；不得虚构上下文外的接口；文件改动只允许发生在隔离草稿目录内。`;

function finishProblems(state, runtimeValidator) {
  const problems = [];
  if (!state.plan) problems.push('尚未保存生成计划（save_generation_plan）');
  if (!state.draft) problems.push('尚未生成草稿（scaffold_adapter_draft）');
  else {
    if (!state.staticValidation?.passed) problems.push('静态验证未通过（validate_adapter_draft）');
    if (runtimeValidator && !state.runtimeValidation?.passed) {
      problems.push('运行验证未通过（修复 / mark_tool_unverifiable / drop_planned_tool 后重验）');
    }
  }
  return problems;
}

function createOrchestratorTools(state, deps) {
  const { run, signal, store, memory, scaffoldWriter, staticValidator, runtimeValidator, adaptersDir, semanticAnalyzer, model } = deps;
  const requiresPlan = () => {
    if (!state.plan) throw new GenerationHarnessError('先调用 save_generation_plan 保存计划', 'PLAN_REQUIRED');
  };
  const requiresDraft = () => {
    if (!state.draft) throw new GenerationHarnessError('先调用 scaffold_adapter_draft 生成草稿', 'DRAFT_REQUIRED');
  };

  return [
    {
      name: 'inspect_generation_context',
      description: '读取探索结果的指定部分。overview 必看；存在 previous_failure 时必须读取。',
      parameters: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: ['overview', 'list_apis', 'action_apis', 'api_analysis', 'previous_failure'] },
        },
        required: ['section'],
        additionalProperties: false,
      },
      execute: async ({ section }) => deps.sections[section] ?? null,
    },
    {
      name: 'save_generation_plan',
      description: '保存 Adapter 生成计划（只读工具集）。',
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
        if (state.draft) throw new GenerationHarnessError('草稿生成后不能覆盖计划；请修复工具或显式记录剔除原因', 'PLAN_ALREADY_SCAFFOLDED');
        const plan = readOnlyV2Plan(nextPlan, { allowWriteTools: (Array.isArray(memory.actionApiCandidates) ? memory.actionApiCandidates.length : 0) > 0 });
        if (!Array.isArray(plan.tools) || plan.tools.length === 0) {
          throw new GenerationHarnessError('计划必须包含至少一个只读工具', 'INVALID_GENERATION_PLAN');
        }
        const actionCandidates = Array.isArray(memory.actionApiCandidates) ? memory.actionApiCandidates : [];
        const incompleteWrites = plan.tools.filter((tool) => tool?.risk === 'write').filter((tool) => {
          const indexes = Array.isArray(tool?.sourceApiIndexes) ? tool.sourceApiIndexes.map(Number).filter(Number.isInteger) : [];
          const localName = String(tool?.name || '').split('.').pop().toLowerCase();
          const candidate = indexes.map((index) => actionCandidates[index]).find(Boolean)
            || actionCandidates.find((item) => {
              const candidateName = String(item?.toolName || '').split('.').pop().replace(/_draft$/, '').toLowerCase();
              return candidateName && (candidateName === localName || localName.includes(candidateName) || candidateName.includes(localName));
            });
          const evidence = candidate?.requestEvidence || candidate?.sourceEvidence?.requestEvidence;
          return !candidate || String(candidate.method || 'GET').toUpperCase() !== 'GET'
            && (!evidence || evidence.bodyOmitted || evidence.bodyTruncated || evidence.bodyKind === 'opaque');
        });
        if (incompleteWrites.length > 0) {
          state.pendingQuestion = {
            question: `写工具 ${incompleteWrites.map((tool) => tool.name).join('、')} 的请求体证据不完整。请重新录制一次完整动作，或提供该操作的业务字段说明与完整请求结构。`,
            context: 'OpenCLI 对齐规则禁止从截断或 opaque 请求体恢复 payload，也禁止把捕获值作为默认值。',
            askedDuring: run.status,
          };
          run.setArtifact('pendingQuestion', state.pendingQuestion);
          throw new GenerationPausedError(state.pendingQuestion.question);
        }
        state.plan = plan;
        state.activeToolNames = plan.tools.map((tool) => `${memory.siteKey}.${String(tool.name || '').split('.').pop()}`);
        run.setArtifact('plan', plan);
        run.trace('planning_completed', { plan, orchestrator: true });
        return { saved: true, toolCount: plan.tools.length };
      },
    },
    {
      name: 'scaffold_adapter_draft',
      description: '按当前计划确定性生成隔离 Adapter 草稿（只能执行一次；调整工具集用 drop_planned_tool）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        requiresPlan();
        if (state.draft) throw new GenerationHarnessError('草稿已生成，不得重复 scaffold；调整请用 drop_planned_tool 或 write_draft_file', 'DRAFT_ALREADY_SCAFFOLDED');
        run.transition(GENERATION_STATUSES.DRAFTING, { currentAction: 'generate_adapter_draft' });
        const revision = run.snapshot.revisionCount;
        const draftRoot = path.join(store.getDraftRoot(run.id), `revision-${revision}`);
        run.trace('draft_phase', { phase: 'seed_adapter_started', draftRoot });
        const workspace = seedAdapterDraft({
          sourceAdapterDir: draftRoot,
          draftRoot,
          siteKey: memory.siteKey,
          adaptersDir,
        });
        run.setArtifact('workspace', workspace);
        let semanticEnhancement = buildPlanSemanticEnhancement(memory, state.plan);
        if (typeof semanticAnalyzer === 'function') {
          run.recordModelCall({ phase: 'semantic_enhancement' });
          try {
            const analyzed = await semanticAnalyzer({ memory });
            if (analyzed?.analysisSource === 'ai') semanticEnhancement = analyzed;
          } catch (error) {
            run.trace('semantic_enhancement_failed', { message: error.message });
          }
        }
        run.trace('draft_phase', { phase: 'scaffold_write_started' });
        const draft = scaffoldWriter(
          semanticEnhancement ? { ...memory, scaffoldSemanticHints: semanticEnhancement } : memory,
          { outputRoot: draftRoot, plan: state.plan },
        );
        run.trace('draft_phase', { phase: 'scaffold_write_completed', toolCount: draft.toolNames?.length || 0 });
        state.draft = {
          revision,
          rootDir: draftRoot,
          adapterDir: draft.adapterDir,
          toolNames: [...state.activeToolNames],
          files: draft.files,
        };
        state.staticValidation = null;
        state.runtimeValidation = null;
        run.setArtifact('draft', state.draft);
        run.setArtifact('draftHistory', [state.draft]);
        return { scaffolded: true, toolNames: [...state.activeToolNames] };
      },
    },
    {
      name: 'list_draft_files',
      description: '列出隔离草稿中的文件。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        requiresDraft();
        return { files: listDraftFiles(state.draft.adapterDir) };
      },
    },
    {
      name: 'read_draft_file',
      description: '读取草稿中的一个文件。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      execute: async ({ path: relativePath }) => {
        requiresDraft();
        const resolved = resolveAdapterDraftFile(state.draft.adapterDir, relativePath);
        const content = fs.readFileSync(resolved.filePath, 'utf8');
        return { path: resolved.normalized, content: content.slice(0, MAX_DRAFT_FILE_CHARS) };
      },
    },
    {
      name: 'read_draft_files',
      description: '批量读取草稿中的多个文件（≤10 个）。',
      parameters: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 } },
        required: ['paths'],
        additionalProperties: false,
      },
      execute: async ({ paths }) => {
        requiresDraft();
        let remaining = MAX_BATCH_DRAFT_FILE_CHARS;
        const files = [];
        for (const relativePath of paths.slice(0, 10)) {
          const resolved = resolveAdapterDraftFile(state.draft.adapterDir, relativePath);
          const content = fs.readFileSync(resolved.filePath, 'utf8').slice(0, Math.max(0, remaining));
          remaining -= content.length;
          files.push({ path: resolved.normalized, content });
          if (remaining <= 0) break;
        }
        return { files, truncated: remaining <= 0 };
      },
    },
    {
      name: 'write_draft_file',
      description: '新增或替换隔离草稿文件以实现计划和修复验证错误；新增工具后须更新 manifest 和注册入口。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'content', 'reason'],
        additionalProperties: false,
      },
      execute: async ({ path: relativePath, content, reason }) => {
        requiresDraft();
        if (content.length > MAX_DRAFT_FILE_CHARS) throw new GenerationHarnessError('draft file content is too large', 'DRAFT_FILE_TOO_LARGE');
        const resolved = resolveAdapterDraftFile(state.draft.adapterDir, relativePath, { mustExist: false });
        fs.mkdirSync(path.dirname(resolved.filePath), { recursive: true });
        fs.writeFileSync(resolved.filePath, content, 'utf8');
        state.writes.push({ path: resolved.normalized, reason });
        state.staticValidation = null;
        state.runtimeValidation = null;
        return { written: true, path: resolved.normalized };
      },
    },
    {
      name: 'validate_adapter_draft',
      description: '执行确定性静态验证。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        requiresDraft();
        run.transition(GENERATION_STATUSES.STATIC_VALIDATING, { currentAction: 'validate_adapter_draft' });
        state.staticValidation = staticValidator({
          adapterDir: state.draft.adapterDir,
          expectedSiteKey: run.snapshot.siteKey,
          expectedToolNames: state.activeToolNames,
        });
        run.setArtifact('staticValidation', state.staticValidation);
        run.trace('validation_completed', state.staticValidation);
        return state.staticValidation;
      },
    },
    {
      name: 'validate_adapter_runtime',
        description: '执行真实页面运行验证；要求静态验证已通过。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
        requiresDraft();
        if (!state.staticValidation?.passed) {
          throw new GenerationHarnessError('先通过 validate_adapter_draft 静态验证', 'STATIC_VALIDATION_REQUIRED');
        }
        run.transition(GENERATION_STATUSES.RUNTIME_VALIDATING, { currentAction: 'validate_adapter_runtime' });
        state.runtimeValidation = await runtimeValidator({
          run,
          signal,
          store,
          draft: { ...state.draft, toolNames: [...state.activeToolNames] },
          validation: state.staticValidation,
          plan: state.plan,
          memory,
        });
        run.setArtifact('runtimeValidation', state.runtimeValidation);
        run.trace('runtime_validation_completed', state.runtimeValidation);
        return state.runtimeValidation;
        },
    },
    {
      name: 'drop_planned_tool',
      description: '剔除一个反复无法通过验证的工具（确定性删除生成文件并更新 manifest）。至少保留一个工具。',
      parameters: {
        type: 'object',
        properties: { toolName: { type: 'string' }, reason: { type: 'string' } },
        required: ['toolName', 'reason'],
        additionalProperties: false,
      },
      execute: async ({ toolName, reason }) => {
        requiresDraft();
        const name = String(toolName || '').trim();
        if (!state.activeToolNames.includes(name)) throw new GenerationHarnessError(`unknown planned tool: ${toolName}`, 'UNKNOWN_PLANNED_TOOL');
        if (state.activeToolNames.length <= 1) throw new GenerationHarnessError('cannot drop the last remaining tool; use mark_tool_unverifiable instead', 'LAST_TOOL_PROTECTED');
        const removedFile = dropDraftTool(state.draft.adapterDir, name);
        state.activeToolNames.splice(state.activeToolNames.indexOf(name), 1);
        if (state.plan && Array.isArray(state.plan.tools)) {
          state.plan = {
            ...state.plan,
            tools: state.plan.tools.filter((tool) => findPlanToolByName([tool], name) === null ? true : false),
          };
          run.setArtifact('plan', state.plan);
        }
        state.staticValidation = null;
        state.runtimeValidation = null;
        state.writes.push({ path: `drop:${name}`, reason: clipText(reason, 400) });
        run.trace('planned_tool_dropped', { orchestrator: true, toolName: name, removedFile, reason: clipText(reason, 400) });
        return { dropped: true, toolName: name, removedFile, remainingTools: [...state.activeToolNames] };
      },
    },
    {
      name: 'mark_tool_unverifiable',
      description: '把无法自动验证的工具标记为转人工确认：运行验证跳过其自动断言并记录 warning。仅在无法修复且不适合剔除时使用。',
      parameters: {
        type: 'object',
        properties: { toolName: { type: 'string' }, reason: { type: 'string' } },
        required: ['toolName', 'reason'],
        additionalProperties: false,
      },
      execute: async ({ toolName, reason }) => {
        requiresDraft();
        const name = String(toolName || '').trim();
        const planTools = Array.isArray(state.plan?.tools) ? state.plan.tools : [];
        const planTool = findPlanToolByName(planTools, name);
        if (!planTool) throw new GenerationHarnessError(`planned tool not found: ${toolName}`, 'UNKNOWN_PLANNED_TOOL');
        if (planTool.risk === 'write') {
          throw new GenerationHarnessError('写工具不能标记为 unverifiable；请补齐 mock 验证、剔除该工具或向用户请求证据', 'WRITE_VERIFICATION_REQUIRED');
        }
        planTool.unverifiable = { reason: clipText(reason, 400), orchestrator: true };
        run.setArtifact('plan', state.plan);
        state.runtimeValidation = null;
        state.writes.push({ path: `mark-unverifiable:${name}`, reason: clipText(reason, 400) });
        run.trace('planned_tool_marked_unverifiable', { orchestrator: true, toolName: name, reason: clipText(reason, 400) });
        return { marked: true, toolName: name, note: 'runtime validation will skip this tool; re-run validate_adapter_runtime' };
      },
    },
    {
      name: 'request_user_input',
      description: '暂停生成并向用户提问（例如目标页面需要登录、需要业务确认）。用户回答后流程从当前进度继续。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          context: { type: 'string' },
        },
        required: ['question'],
        additionalProperties: false,
      },
      execute: async ({ question, context }) => {
        state.pendingQuestion = {
          question: clipText(question, 400),
          context: clipText(context, 600),
          askedDuring: run.status,
        };
        run.setArtifact('pendingQuestion', state.pendingQuestion);
        throw new GenerationPausedError(state.pendingQuestion.question);
      },
    },
    {
      name: 'report_blocker',
      description: '确实无法推进时向用户报告阻塞：卡点、已试方案和建议动作。',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' }, question: { type: 'string' } },
        required: ['summary', 'question'],
        additionalProperties: false,
      },
      execute: async ({ summary, question }) => {
        const blockerNote = {
          orchestrator: true,
          summary: clipText(summary, 600),
          question: clipText(question, 400),
          remainingTools: [...state.activeToolNames],
        };
        run.setArtifact('blockerNote', blockerNote);
        run.trace('blocker_reported', blockerNote);
        return { reported: true };
      },
    },
    {
      name: 'inspect_run_trace',
      description: '读取当前 run 的最近事件轨迹（已脱敏），回顾此前轮次。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_TRACE_EVENTS } },
        additionalProperties: false,
      },
      execute: async ({ limit } = {}) => {
        const events = store.readTrace(run.id);
        const count = Math.min(Math.max(Number(limit) || 30, 1), MAX_TRACE_EVENTS);
        let remaining = MAX_TRACE_CHARS;
        const tail = [];
        for (const event of events.slice(-count).reverse()) {
          const entry = { type: event?.type, data: event?.data };
          const size = JSON.stringify(entry).length;
          if (remaining - size < 0) break;
          remaining -= size;
          tail.unshift(entry);
        }
        return { events: tail, truncated: tail.length < Math.min(events.length, count) };
      },
    },
    {
      name: 'finish_run',
      description: '声明完成。前置条件：计划已保存、草稿已生成、静态验证通过、运行验证通过（或无运行验证器）。满足后返回 ready，此时输出 final。',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
        additionalProperties: false,
      },
      execute: async ({ summary }) => {
        const problems = finishProblems(state, runtimeValidator);
        if (problems.length > 0) {
          throw new GenerationHarnessError(`finish 前置条件不满足：${problems.join('；')}`, 'FINISH_PRECONDITION_FAILED', { problems });
        }
        return { ready: true, summary: clipText(summary, 600) };
      },
    },
  ];
}

function buildPauseResumeMessages(state, pendingQuestion, answer) {
  const base = state.lastModelMessages || [];
  return [
    ...structuredClone(base),
    {
      role: 'assistant',
      toolCalls: [{
        id: 'user-input-request',
        name: 'request_user_input',
        arguments: { question: pendingQuestion.question },
      }],
    },
    {
      role: 'tool',
      toolCallId: 'user-input-request',
      name: 'request_user_input',
      content: { answered: true, question: pendingQuestion.question, userAnswer: clipText(answer, 2000) },
      isError: false,
    },
  ];
}

async function runOrchestrationLoop(state, deps, initialMessages) {
  const { run, model, signal, runtimeValidator } = deps;
  return runToolLoop({
    model: async (input) => {
      state.lastModelMessages = input.messages;
      return model(input);
    },
    systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
    maxSteps: state.stepLimit,
    signal,
    messages: initialMessages,
    onEvent: (event) => {
      if (event.type === 'model_started') run.recordModelCall({ phase: 'orchestration', step: event.step });
      if (event.type === 'tool_started') run.recordStep(event.call.name, { phase: 'orchestration' });
      run.trace(`orchestration_loop_${event.type}`, event);
    },
    tools: createOrchestratorTools(state, deps),
  });
}

function orchestratorResult(state, runtimeValidation) {
  return {
    pause: true,
    status: GENERATION_STATUSES.AWAITING_APPROVAL,
    plan: state.plan,
    draft: state.draft ? { ...state.draft, toolNames: [...state.activeToolNames] } : null,
    validation: state.staticValidation,
    runtimeValidation,
    orchestrator: true,
  };
}

async function finishOrchestration(state, deps, provenanceWriter) {
  const { run, runtimeValidator } = deps;
  const problems = finishProblems(state, runtimeValidator);
  if (problems.length > 0) {
    const error = new GenerationHarnessError(`orchestrator finished without meeting preconditions: ${problems.join('; ')}`, 'FINISH_PRECONDITION_FAILED', { problems });
    throw error;
  }
  if (typeof provenanceWriter === 'function') {
    provenanceWriter({
      run,
      draft: state.draft,
      validation: state.staticValidation,
      runtimeValidation: state.runtimeValidation,
      plan: state.plan,
    });
  }
  run.transition(GENERATION_STATUSES.AWAITING_APPROVAL, { currentAction: 'await_publish_approval', orchestrator: true });
  return orchestratorResult(state, state.runtimeValidation);
}

async function deterministicFallbackFinish(state, deps, provenanceWriter) {
  const { run, staticValidator, runtimeValidator, signal, store, memory } = deps;
  run.trace('orchestration_loop_incomplete', {
    code: 'TOOL_LOOP_MAX_STEPS',
    stepLimit: state.stepLimit,
    writes: state.writes.length,
  });
  if (!state.draft) {
    const error = new GenerationHarnessError('orchestrator exhausted steps before scaffolding a draft', 'STATIC_VALIDATION_FAILED');
    throw error;
  }
  if (!state.staticValidation?.passed) {
    state.staticValidation = staticValidator({
      adapterDir: state.draft.adapterDir,
      expectedSiteKey: run.snapshot.siteKey,
      expectedToolNames: state.activeToolNames,
    });
    run.setArtifact('staticValidation', state.staticValidation);
  }
  if (!state.staticValidation.passed) {
    const error = new Error(`adapter draft failed static validation (${state.staticValidation.errors.length} errors)`);
    error.code = 'STATIC_VALIDATION_FAILED';
    error.details = state.staticValidation;
    throw error;
  }
  if (typeof runtimeValidator === 'function' && !state.runtimeValidation?.passed) {
    run.transition(GENERATION_STATUSES.RUNTIME_VALIDATING, { currentAction: 'validate_adapter_runtime' });
    run.recordStep('validate_adapter_runtime', { phase: 'runtime_validation' });
    state.runtimeValidation = await runtimeValidator({
      run,
      signal,
      store,
      draft: { ...state.draft, toolNames: [...state.activeToolNames] },
      validation: state.staticValidation,
      plan: state.plan,
      memory,
    });
    run.setArtifact('runtimeValidation', state.runtimeValidation);
    run.trace('runtime_validation_completed', state.runtimeValidation);
    if (!state.runtimeValidation.passed) {
      run.setArtifact('blockerNote', {
        orchestrator: true,
        summary: '编排步数耗尽且运行验证未通过',
        question: '是否携带本次进度与失败上下文重试？',
        remainingTools: [...state.activeToolNames],
      });
      const error = new Error(`adapter draft failed runtime validation (${state.runtimeValidation?.errors?.length || 0} errors)`);
      error.code = 'RUNTIME_VALIDATION_FAILED';
      error.details = state.runtimeValidation;
      throw error;
    }
  }
  run.trace('orchestrated_fallback_finished', { stepLimit: state.stepLimit });
  return finishOrchestration(state, deps, provenanceWriter);
}

export async function runGenerationOrchestrator(deps) {
  const { run, signal, model } = deps;
  run.assertNotCancelled(signal);
  if (run.status === GENERATION_STATUSES.CREATED) {
    run.transition(GENERATION_STATUSES.CONTEXT_READY, { currentAction: 'context_ready', orchestrator: true });
  }
  run.transition(GENERATION_STATUSES.PLANNING, { currentAction: 'create_generation_plan', orchestrator: true });
  const remainingModelCalls = Number(run.snapshot.budget.maxModelCalls || MAX_ORCHESTRATION_STEPS)
    - Number(run.snapshot.modelCallCount || 0);
  const state = {
    plan: null,
    draft: null,
    staticValidation: null,
    runtimeValidation: null,
    activeToolNames: [],
    writes: [],
    pendingQuestion: null,
    lastModelMessages: null,
    stepLimit: Math.max(1, Math.min(MAX_ORCHESTRATION_STEPS, remainingModelCalls, run.snapshot.budget.maxSteps || MAX_ORCHESTRATION_STEPS)),
  };
  const provenanceWriter = deps.writeGenerationHarnessProvenance;
  try {
    await runOrchestrationLoop(state, deps, [{
      role: 'user',
      content: [
        `为 ${deps.memory.siteKey} 自主完成 API Adapter 生成与验证。`,
        `用户目标：${run.snapshot.goal || '生成可验证的只读 API Adapter'}`,
      ].join('\n'),
    }]);
  } catch (error) {
    if (error instanceof GenerationPausedError) {
      run.transition(GENERATION_STATUSES.NEEDS_USER_INPUT, { currentAction: 'await_user_input', question: state.pendingQuestion?.question || '' });
      run.setArtifact('orchestrationState', {
        pendingQuestion: state.pendingQuestion,
        messages: state.lastModelMessages || [],
        activeToolNames: [...state.activeToolNames],
        stepLimit: state.stepLimit,
      });
      return {
        pause: true,
        status: GENERATION_STATUSES.NEEDS_USER_INPUT,
        pendingQuestion: state.pendingQuestion,
        orchestrator: true,
      };
    }
    if (error?.code === 'TOOL_LOOP_MAX_STEPS') {
      return deterministicFallbackFinish(state, deps, provenanceWriter);
    }
    throw error;
  }
  return finishOrchestration(state, deps, provenanceWriter);
}

export async function resumeGenerationOrchestrator(deps, answer) {
  const { run, signal, store } = deps;
  const orchestrationState = run.snapshot.artifacts?.orchestrationState;
  const pendingQuestion = run.snapshot.artifacts?.pendingQuestion || orchestrationState?.pendingQuestion;
  if (!pendingQuestion) throw new GenerationHarnessError('generation run has no pending question to resume', 'NO_PENDING_QUESTION');
  const draftArtifact = run.snapshot.artifacts?.draft;
  const planArtifact = run.snapshot.artifacts?.plan;
  run.snapshot.completedAt = null;
  const state = {
    plan: planArtifact || null,
    draft: draftArtifact || null,
    staticValidation: null,
    runtimeValidation: null,
    activeToolNames: plannedToolNames(deps.memory.siteKey, planArtifact),
    writes: [],
    pendingQuestion: null,
    lastModelMessages: orchestrationState?.messages || [],
    stepLimit: Math.max(1, Math.min(
      MAX_ORCHESTRATION_STEPS,
      Number(run.snapshot.budget.maxModelCalls || MAX_ORCHESTRATION_STEPS) - Number(run.snapshot.modelCallCount || 0),
      Number(run.snapshot.budget.maxSteps || MAX_ORCHESTRATION_STEPS) - Number(run.snapshot.stepCount || 0),
    )),
  };
  run.setArtifact('pendingQuestion', null);
  if (state.draft) {
    state.staticValidation = deps.staticValidator({
      adapterDir: state.draft.adapterDir,
      expectedSiteKey: deps.memory.siteKey,
      expectedToolNames: state.activeToolNames,
    });
    run.setArtifact('staticValidation', state.staticValidation);
  }
  run.trace('orchestration_resumed', { question: pendingQuestion.question, answerLength: String(answer || '').length });
  const provenanceWriter = deps.writeGenerationHarnessProvenance;
  try {
    await runOrchestrationLoop(state, deps, buildPauseResumeMessages(state, pendingQuestion, answer));
  } catch (error) {
    if (error instanceof GenerationPausedError) {
      run.transition(GENERATION_STATUSES.NEEDS_USER_INPUT, { currentAction: 'await_user_input', question: state.pendingQuestion?.question || '' });
      run.setArtifact('orchestrationState', {
        pendingQuestion: state.pendingQuestion,
        messages: state.lastModelMessages || [],
        activeToolNames: [...state.activeToolNames],
        stepLimit: state.stepLimit,
      });
      return {
        pause: true,
        status: GENERATION_STATUSES.NEEDS_USER_INPUT,
        pendingQuestion: state.pendingQuestion,
        orchestrator: true,
      };
    }
    if (error?.code === 'TOOL_LOOP_MAX_STEPS') {
      return deterministicFallbackFinish(state, deps, provenanceWriter);
    }
    throw error;
  }
  return finishOrchestration(state, deps, provenanceWriter);
}
