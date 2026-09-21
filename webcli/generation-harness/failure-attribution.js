/**
 * Generation failure attribution.
 *
 * 把失败 run 归因到四类之一，并产出两类派生物：
 * - failureAttribution：给人看的归因（一句话中文 + 建议动作），随 transport 快照下发；
 * - previousFailure：给下一次 planning 循环看的机器可读复盘，注入 inspect_generation_context。
 *
 * 纯函数、无 IO；所有输出不得包含文件系统路径或敏感值。
 */

const FAILURE_STATUSES = new Set(['failed', 'budget_exceeded']);
const MAX_TOOL_ERRORS = 20;
const MAX_ERROR_CODES = 12;
const MAX_MESSAGE_CHARS = 200;

const SITE_ENVIRONMENT_ERROR_CODES = new Set([
  'TARGET_TAB_NOT_FOUND',
  'LOGIN_REQUIRED',
  'LOGIN_OR_HTML_RESPONSE',
  'OUTPUT_FORBIDDEN_CONTENT',
  'GENERATION_EXTENSION_REQUEST_FAILED',
  'NETWORK',
]);

const HARNESS_LIMIT_ERROR_CODES = new Set([
  'TOOL_LOOP_MAX_STEPS',
  'INVALID_MODEL_RESPONSE',
  'INVALID_JSON_ACTION',
  'BUDGET_EXCEEDED',
  'GENERATION_BUDGET_EXCEEDED',
  'MODEL_OUTPUT_LIMIT_EXCEEDED',
  'INVALID_MODEL_OUTPUT_CONFIG',
  'GENERATION_WORKER_CRASHED',
  'GENERATION_WORKER_INTERRUPTED',
  'GENERATION_RUN_INTERRUPTED',
]);

const DRAFT_ERROR_CODE_RE = /^(?:OUTPUT_|STATIC_|CAPTURED_PARAMETER|RUNTIME_VALIDATION_FAILED|INVALID_TOOL_ARGUMENTS|UNKNOWN_GENERATION_TOOL)/;

const CATEGORY_LABELS = {
  draft: '草稿未通过验证',
  site: '目标页面环境问题',
  user_action: '需要用户操作',
  harness: '生成流程能力限制',
  unknown: '未知原因',
};

function clip(value, limit = MAX_MESSAGE_CHARS) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function collectValidationErrors(run) {
  const artifacts = run?.artifacts || {};
  const staticErrors = Array.isArray(artifacts.staticValidation?.errors) ? artifacts.staticValidation.errors : [];
  const runtimeErrors = Array.isArray(artifacts.runtimeValidation?.errors) ? artifacts.runtimeValidation.errors : [];
  return { staticErrors, runtimeErrors };
}

function toolErrorsFrom(runtimeErrors) {
  const seen = new Set();
  const toolErrors = [];
  for (const error of runtimeErrors) {
    const toolName = String(error?.toolName || '').trim();
    const code = String(error?.code || '').trim();
    if (!toolName || !code) continue;
    const key = `${toolName}:${code}:${String(error?.path || '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    toolErrors.push({
      toolName,
      code,
      path: clip(error?.path, 120),
      message: clip(error?.message),
    });
    if (toolErrors.length >= MAX_TOOL_ERRORS) break;
  }
  return toolErrors;
}

export function isGenerationFailureStatus(status) {
  return FAILURE_STATUSES.has(String(status || ''));
}

/**
 * 归因一个失败 run。非失败状态返回 null。
 */
export function attributeGenerationFailure(run) {
  if (!run || typeof run !== 'object' || !isGenerationFailureStatus(run.status)) return null;

  const lastErrorCode = String(run.lastError?.code || '').trim();
  const { staticErrors, runtimeErrors } = collectValidationErrors(run);
  const codes = [];
  const pushCode = (code) => {
    const text = String(code || '').trim();
    if (text && !codes.includes(text) && codes.length < MAX_ERROR_CODES) codes.push(text);
  };
  pushCode(lastErrorCode);
  for (const error of runtimeErrors) pushCode(error?.code);
  for (const error of staticErrors) pushCode(error?.code);

  const toolErrors = toolErrorsFrom(runtimeErrors);
  const failedTools = [...new Set(toolErrors.map((error) => error.toolName))];

  let category = 'unknown';
  if (codes.some((code) => SITE_ENVIRONMENT_ERROR_CODES.has(code))) {
    category = 'site';
  } else if (codes.some((code) => HARNESS_LIMIT_ERROR_CODES.has(code))) {
    category = 'harness';
  } else if (codes.some((code) => DRAFT_ERROR_CODE_RE.test(code))) {
    category = 'draft';
  }

  const runtimeFailed = run.artifacts?.runtimeValidation && run.artifacts.runtimeValidation.passed === false;
  const staticFailed = run.artifacts?.staticValidation && run.artifacts.staticValidation.passed === false;
  const phaseLabel = runtimeFailed ? '页面运行' : staticFailed ? '静态' : '';

  let summary = '';
  const outputConfigurationError = ['MODEL_OUTPUT_LIMIT_EXCEEDED', 'INVALID_MODEL_OUTPUT_CONFIG'].includes(lastErrorCode);
  if (outputConfigurationError) {
    category = 'harness';
    summary = '模型输出额度耗尽或配置无效。请检查输出额度及模型支持的上限，再继续或重新生成；不建议原样重复请求。';
  } else if (category === 'site') {
    summary = `目标页面不可用或需要登录（${codes[0] || '页面状态异常'}）。请打开并登录目标页面后，再点击「重新智能生成」。`;
  } else if (category === 'harness') {
    summary = `生成流程自身受限（${lastErrorCode || codes[0] || '预算或协议异常'}）。点击「重新智能生成」会携带本次失败上下文重试。`;
  } else if (category === 'draft') {
    const toolNote = failedTools.length > 0 ? `工具 ${failedTools.slice(0, 4).join('、')} ` : '';
    summary = `${phaseLabel ? `草稿未通过${phaseLabel}验证` : '草稿未通过验证'}：${toolNote}${codes.slice(0, 3).join('、') || '验证失败'}。重试时规划器会读取失败明细并调整计划。`;
  } else {
    summary = `生成失败（${lastErrorCode || codes[0] || '未知错误'}）。点击「重新智能生成」会携带失败上下文重试。`;
  }
  const blocker = run.artifacts?.blockerNote;
  if (blocker && typeof blocker === 'object') {
    const blockerText = clip(blocker.question) || clip(blocker.summary);
    if (blockerText) summary = `${summary} 修订智能体报告：${blockerText}`;
  }

  return {
    category,
    categoryLabel: CATEGORY_LABELS[category],
    summary,
    recommendedAction: outputConfigurationError ? 'adjust_model_output_config' : category === 'site' ? 'reopen_and_retry' : 'retry_with_context',
    errorCodes: codes,
    toolErrors,
  };
}

function planToolNames(run) {
  const tools = Array.isArray(run?.artifacts?.plan?.tools) ? run.artifacts.plan.tools : [];
  return tools
    .map((tool) => String(tool?.name || '').trim())
    .filter(Boolean)
    .slice(0, 10);
}

/**
 * 从失败 run 构建下一次 planning 的复盘上下文（脱敏、紧凑）。
 */
export function buildPreviousFailureContext(run) {
  const attribution = attributeGenerationFailure(run);
  if (!attribution) return null;
  const blocker = run?.artifacts?.blockerNote;
  return {
    schemaVersion: 1,
    previousRunId: String(run.id || ''),
    siteKey: String(run.siteKey || ''),
    status: String(run.status || ''),
    failedAt: String(run.completedAt || run.updatedAt || ''),
    category: attribution.category,
    summary: attribution.summary,
    lastErrorCode: String(run.lastError?.code || ''),
    blocker: blocker && typeof blocker === 'object'
      ? { summary: clip(blocker.summary, 400), question: clip(blocker.question, 300) }
      : null,
    plannedTools: planToolNames(run),
    failedTools: attribution.toolErrors.map((error) => error.toolName).filter((value, index, list) => list.indexOf(value) === index).slice(0, 10),
    toolErrors: attribution.toolErrors,
    revisionCount: Number(run.revisionCount) || 0,
    modelCallCount: Number(run.modelCallCount) || 0,
    stepCount: Number(run.stepCount) || 0,
  };
}

/**
 * 防御性整理 worker payload 里的 previousFailure 输入；无效输入返回 null。
 */
export function normalizePreviousFailureInput(value) {
  if (!value || typeof value !== 'object') return null;
  const previousRunId = String(value.previousRunId || '').trim();
  const category = String(value.category || '').trim();
  if (!previousRunId || !category) return null;
  return {
    schemaVersion: 1,
    previousRunId,
    siteKey: String(value.siteKey || ''),
    status: String(value.status || ''),
    failedAt: String(value.failedAt || ''),
    category,
    summary: clip(value.summary, 600),
    lastErrorCode: clip(value.lastErrorCode, 120),
    blocker: value.blocker && typeof value.blocker === 'object'
      ? { summary: clip(value.blocker.summary, 400), question: clip(value.blocker.question, 300) }
      : null,
    plannedTools: Array.isArray(value.plannedTools)
      ? value.plannedTools.filter((tool) => typeof tool === 'string').map((tool) => clip(tool, 120)).filter(Boolean).slice(0, 10)
      : [],
    failedTools: Array.isArray(value.failedTools)
      ? value.failedTools.filter((tool) => typeof tool === 'string').map((tool) => clip(tool, 120)).filter(Boolean).slice(0, 10)
      : [],
    toolErrors: Array.isArray(value.toolErrors)
      ? value.toolErrors
        .filter((error) => error && typeof error === 'object')
        .map((error) => ({
          toolName: clip(error.toolName, 120),
          code: clip(error.code, 80),
          path: clip(error.path, 120),
          message: clip(error.message),
        }))
        .filter((error) => error.toolName && error.code)
        .slice(0, MAX_TOOL_ERRORS)
      : [],
    revisionCount: Number(value.revisionCount) || 0,
    modelCallCount: Number(value.modelCallCount) || 0,
    stepCount: Number(value.stepCount) || 0,
  };
}
