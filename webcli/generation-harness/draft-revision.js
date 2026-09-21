import fs from 'node:fs';
import path from 'node:path';
import { plannedToolNames } from './plan-binding.js';
import { GENERATION_STATUSES } from './constants.js';
import { runToolLoop } from './tool-loop.js';
import { copyAdapterDirectorySafe } from './adapter-workspace.js';

const ALLOWED_DRAFT_FILE_RE = /\.(?:js|json|md|txt)$/i;
const MAX_DRAFT_FILE_CHARS = 50_000;
const MAX_BATCH_DRAFT_FILE_CHARS = 40_000;
const MAX_REVISION_STEPS = 12;

function resolveDraftFile(adapterDir, relativePath, { mustExist = true } = {}) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized || path.isAbsolute(normalized) || /[:\x00-\x1f]/.test(normalized)
    || normalized.split('/').some((part) => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    || !ALLOWED_DRAFT_FILE_RE.test(normalized)) {
    throw new Error(`draft file path is not allowed: ${relativePath}`);
  }
  const absoluteAdapterDir = path.resolve(adapterDir);
  const filePath = path.resolve(absoluteAdapterDir, normalized);
  const relative = path.relative(absoluteAdapterDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`draft file escapes adapter directory: ${relativePath}`);
  }
  // Reject symlink/junction parents even for a not-yet-created leaf.
  for (let current = filePath; ; current = path.dirname(current)) {
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) {
      throw new Error('draft file path contains a symbolic link');
    }
    if (current === absoluteAdapterDir) break;
  }
  if (mustExist && !fs.existsSync(filePath)) throw new Error(`draft file not found: ${normalized}`);
  return { normalized, filePath };
}

export function listDraftFiles(adapterDir) {
  const result = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (entry.isFile() && ALLOWED_DRAFT_FILE_RE.test(entry.name)) {
        result.push(path.relative(adapterDir, filePath).replace(/\\/g, '/'));
      }
    }
  };
  walk(adapterDir);
  return result.sort().slice(0, 200);
}

function cloneDraftRevision({ previousAdapterDir, nextDraftRoot, siteKey }) {
  const nextAdapterDir = path.join(nextDraftRoot, siteKey);
  fs.mkdirSync(nextDraftRoot, { recursive: true });
  copyAdapterDirectorySafe(previousAdapterDir, nextAdapterDir);
  return nextAdapterDir;
}

function normalizedToolLocalName(value) {
  return String(value || '').trim().split('.').pop();
}

function fileToken(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

/**
 * 确定性剔除草稿中的一个生成工具：从 manifest.support_files 移除其生成文件并删除该文件。
 */
export function dropDraftTool(adapterDir, toolName) {
  const localName = normalizedToolLocalName(toolName);
  const manifestPath = path.join(adapterDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('draft manifest.json not found');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const supportFiles = Array.isArray(manifest.support_files) ? manifest.support_files.map(String) : [];
  const target = supportFiles.find((relativePath) => {
    const normalized = relativePath.replace(/\\/g, '/');
    return normalized.startsWith('webcli-generated/tools/')
      && normalized.endsWith('.generated.js')
      && fileToken(path.basename(normalized, '.generated.js')) === fileToken(localName);
  });
  if (!target) throw new Error(`generated tool file not found for ${toolName}`);
  manifest.support_files = supportFiles.filter((relativePath) => relativePath !== target);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.rmSync(path.join(adapterDir, target), { force: true });
  return target;
}

export function clipText(value, limit) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function findPlanToolByName(planTools, toolName) {
  const target = normalizedToolLocalName(toolName);
  return (planTools || []).find((tool) => normalizedToolLocalName(tool?.name) === target) || null;
}

function remapDraftFiles(files, previousAdapterDir, nextAdapterDir) {
  if (!files || typeof files !== 'object') return files;
  return Object.fromEntries(Object.entries(files).map(([key, value]) => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return [key, value];
    const relative = path.relative(previousAdapterDir, value);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return [key, value];
    return [key, path.join(nextAdapterDir, relative)];
  }));
}

const REVISION_SYSTEM_PROMPT = `你是 Adapter 草稿修复器，只能在隔离草稿中修复结构化验证错误或真实页面运行验证错误。

必须遵循：
1. 先调用 inspect_validation_errors。错误可能来自静态验证或真实页面运行验证。
2. 使用 list_draft_files 定位文件；需要读取多个文件时优先使用 read_draft_files，避免逐文件耗尽步骤。
3. 先判断错误责任域：静态错误修草稿；运行时 OUTPUT_* 错误要对照返回契约修复输出映射，不得为了通过验证伪造数据。
4. 只修改解决验证错误所需的文件，禁止改变无关业务逻辑。
5. 修改后必须先调用 validate_adapter_draft；处理运行时错误时还必须调用 validate_adapter_runtime。
6. 静态修订只有 validate_adapter_draft passed=true 后才能 final；运行时修订只有 validate_adapter_runtime passed=true 后才能 final。
7. 不得创建目录，不得访问草稿目录外的文件。
8. 单个工具反复无法通过验证时按优先级处置：能修复则修复；确实无法自动验证但有保留价值时调用 mark_tool_unverifiable 转人工确认；确认不可用时可调用 drop_planned_tool 剔除（至少保留一个工具，剔除后需重新验证）。
9. 无法继续推进时先调用 report_blocker 向用户说明卡点、已尝试的方案和建议动作，再输出 final。
10. 需要回顾此前轮次的验证详情或失败原因时可调用 inspect_run_trace。`;

export async function reviseAdapterDraft({
  run,
  signal,
  store,
  model,
  draft,
  validation,
  staticValidator,
  runtimeValidator = null,
  plan = null,
  memory = null,
}) {
  run.recordRevision({ validationErrors: validation.errors?.length || 0 });
  const revision = run.snapshot.revisionCount;
  const nextDraftRoot = path.join(store.getDraftRoot(run.id), `revision-${revision}`);
  const adapterDir = cloneDraftRevision({
    previousAdapterDir: draft.adapterDir,
    nextDraftRoot,
    siteKey: run.snapshot.siteKey,
  });
  let latestValidation = validation;
  let latestFeedback = validation;
  let runtimeValidation = null;
  const writes = [];
  const activeToolNames = plan?.tools
    ? plannedToolNames(run.snapshot.siteKey, plan)
    : [...(Array.isArray(draft.toolNames) ? draft.toolNames : [])];
  let activePlan = plan && Array.isArray(plan.tools)
    ? { ...plan, tools: plan.tools.map((tool) => ({ ...tool })) }
    : plan;
  const revisionDraft = () => ({
    ...draft,
    revision,
    rootDir: nextDraftRoot,
    adapterDir,
    toolNames: [...activeToolNames],
    files: remapDraftFiles(draft.files, draft.adapterDir, adapterDir),
  });
  const runtimeDirected = validation?.validator === 'adapter_runtime_validator_v1'
    || (validation?.errors || []).some((error) => /^(?:OUTPUT_|RUNTIME_|CAPTURE_BOUND_)/.test(String(error?.code || '')));
  const remainingModelCalls = Number(run.snapshot.budget.maxModelCalls || MAX_REVISION_STEPS)
    - Number(run.snapshot.modelCallCount || 0);
  const revisionStepLimit = Math.max(1, Math.min(MAX_REVISION_STEPS, remainingModelCalls));

  run.transition(GENERATION_STATUSES.REVISING, { currentAction: 'revise_adapter_draft', revision });
  let loopResult = { steps: 0 };
  let incomplete = false;
  try {
    loopResult = await runToolLoop({
      model,
      systemPrompt: REVISION_SYSTEM_PROMPT,
      maxSteps: revisionStepLimit,
      signal,
      messages: [{
        role: 'user',
        content: runtimeDirected
          ? `修复 revision-${revision - 1} 的真实页面运行验证错误。先确认静态验证通过，再重新执行运行时验证。`
          : `修复 revision-${revision - 1} 的静态验证错误，并确保草稿重新通过静态验证。`,
      }],
      onEvent: (event) => {
        if (event.type === 'model_started') run.recordModelCall({ phase: 'revision', revision, step: event.step });
        if (event.type === 'tool_started') run.recordStep(event.call.name, { phase: 'revision', revision });
        run.trace(`revision_loop_${event.type}`, event);
      },
      tools: [
      {
        name: 'inspect_validation_errors',
        description: '读取当前草稿的结构化验证错误，包括静态或真实运行错误。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => latestFeedback,
      },
      {
        name: 'list_draft_files',
        description: '列出隔离 Adapter 草稿中允许读取和修改的文件。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({ files: listDraftFiles(adapterDir) }),
      },
      {
        name: 'read_draft_file',
        description: '读取隔离草稿中的一个现有文件。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        execute: async ({ path: relativePath }) => {
          const resolved = resolveDraftFile(adapterDir, relativePath);
          const content = fs.readFileSync(resolved.filePath, 'utf8');
          return { path: resolved.normalized, content: content.slice(0, MAX_DRAFT_FILE_CHARS) };
        },
      },
      {
        name: 'read_draft_files',
        description: '批量读取隔离草稿中的多个现有文件，适合一次检查 manifest、入口和支持脚本。',
        parameters: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
          },
          required: ['paths'],
          additionalProperties: false,
        },
        execute: async ({ paths }) => {
          let remaining = MAX_BATCH_DRAFT_FILE_CHARS;
          const files = [];
          for (const relativePath of paths.slice(0, 10)) {
            const resolved = resolveDraftFile(adapterDir, relativePath);
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
          if (content.length > MAX_DRAFT_FILE_CHARS) throw new Error('draft file content is too large');
          const resolved = resolveDraftFile(adapterDir, relativePath, { mustExist: false });
          fs.mkdirSync(path.dirname(resolved.filePath), { recursive: true });
          fs.writeFileSync(resolved.filePath, content, 'utf8');
          writes.push({ path: resolved.normalized, reason });
          return { written: true, path: resolved.normalized };
        },
      },
      {
        name: 'validate_adapter_draft',
        description: '重新执行确定性静态验证。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          latestValidation = staticValidator({
            adapterDir,
            expectedSiteKey: run.snapshot.siteKey,
            expectedToolNames: activeToolNames,
          });
          latestFeedback = latestValidation;
          return latestValidation;
        },
      },
      {
        name: 'drop_planned_tool',
        description: '从草稿中剔除一个反复无法通过验证的工具：确定性删除其生成文件并更新 manifest。至少保留一个工具，剔除后需重新验证。',
        parameters: {
          type: 'object',
          properties: {
            toolName: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['toolName', 'reason'],
          additionalProperties: false,
        },
        execute: async ({ toolName, reason }) => {
          const name = String(toolName || '').trim();
          if (!activeToolNames.includes(name)) throw new Error(`unknown planned tool: ${toolName}`);
          if (activeToolNames.length <= 1) throw new Error('cannot drop the last remaining tool; use mark_tool_unverifiable instead');
          const removedFile = dropDraftTool(adapterDir, name);
          activeToolNames.splice(activeToolNames.indexOf(name), 1);
          if (activePlan && Array.isArray(activePlan.tools)) {
            activePlan = {
              ...activePlan,
              tools: activePlan.tools.filter((tool) => normalizedToolLocalName(tool?.name) !== normalizedToolLocalName(name)),
            };
            run.setArtifact('plan', activePlan);
          }
          writes.push({ path: `drop:${name}`, reason: clipText(reason, 400) });
          run.trace('planned_tool_dropped', { revision, toolName: name, removedFile, reason: clipText(reason, 400) });
          return { dropped: true, toolName: name, removedFile, remainingTools: [...activeToolNames] };
        },
      },
      {
        name: 'mark_tool_unverifiable',
        description: '把一个无法自动验证的工具标记为转人工确认：运行验证将跳过该工具的自动断言，发布评审时会显示标记与原因。仅在确实无法修复且不适合剔除时使用。',
        parameters: {
          type: 'object',
          properties: {
            toolName: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['toolName', 'reason'],
          additionalProperties: false,
        },
        execute: async ({ toolName, reason }) => {
          const name = String(toolName || '').trim();
          const planTools = Array.isArray(activePlan?.tools) ? activePlan.tools : [];
          const planTool = findPlanToolByName(planTools, name);
          if (!planTool) throw new Error(`planned tool not found: ${toolName}`);
          planTool.unverifiable = { reason: clipText(reason, 400), revision };
          run.setArtifact('plan', activePlan);
          writes.push({ path: `mark-unverifiable:${name}`, reason: clipText(reason, 400) });
          run.trace('planned_tool_marked_unverifiable', { revision, toolName: name, reason: clipText(reason, 400) });
          return { marked: true, toolName: name, note: 'runtime validation will skip this tool and surface it for manual confirmation' };
        },
      },
      {
        name: 'report_blocker',
        description: '当确实无法在当前条件下完成修复时向用户报告阻塞：说明卡在哪里、已尝试什么、建议用户做什么。报告后可以输出 final 结束本轮修订。',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            question: { type: 'string' },
          },
          required: ['summary', 'question'],
          additionalProperties: false,
        },
        execute: async ({ summary, question }) => {
          const blockerNote = {
            revision,
            summary: clipText(summary, 600),
            question: clipText(question, 400),
            remainingTools: [...activeToolNames],
          };
          run.setArtifact('blockerNote', blockerNote);
          run.trace('blocker_reported', blockerNote);
          return { reported: true };
        },
      },
      {
        name: 'inspect_run_trace',
        description: '读取当前 run 的最近事件轨迹（已脱敏），用于回顾之前修订轮次、验证结果和已执行的动作。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 60 },
          },
          additionalProperties: false,
        },
        execute: async ({ limit } = {}) => {
          const events = store.readTrace(run.id);
          const count = Math.min(Math.max(Number(limit) || 30, 1), 60);
          let remaining = 60_000;
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
      ...(typeof runtimeValidator === 'function' ? [{
        name: 'validate_adapter_runtime',
        description: '重新执行真实页面运行验证；仅用于检查修订后的工具输出与探索契约是否一致。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          latestValidation = staticValidator({
            adapterDir,
            expectedSiteKey: run.snapshot.siteKey,
            expectedToolNames: activeToolNames,
          });
          if (!latestValidation.passed) {
            latestFeedback = latestValidation;
            return latestValidation;
          }
          runtimeValidation = await runtimeValidator({
            run,
            signal,
            store,
            draft: revisionDraft(),
            validation: latestValidation,
            plan: activePlan,
            memory,
          });
          latestFeedback = runtimeValidation;
          return runtimeValidation;
        },
      }] : []),
      ],
    });
  } catch (error) {
    if (error?.code !== 'TOOL_LOOP_MAX_STEPS') throw error;
    incomplete = true;
    loopResult = { steps: revisionStepLimit };
    run.trace('revision_loop_incomplete', {
      revision,
      code: error.code,
      maxSteps: revisionStepLimit,
      writes: writes.length,
    });
  }

  latestValidation = staticValidator({
    adapterDir,
    expectedSiteKey: run.snapshot.siteKey,
    expectedToolNames: activeToolNames,
  });
  return {
    draft: revisionDraft(),
    plan: activePlan,
    validation: latestValidation,
    runtimeValidation,
    writes,
    loopSteps: loopResult.steps,
    incomplete,
    loopErrorCode: incomplete ? 'TOOL_LOOP_MAX_STEPS' : '',
  };
}

export function resolveAdapterDraftFile(adapterDir, relativePath, options) {
  return resolveDraftFile(adapterDir, relativePath, options);
}
