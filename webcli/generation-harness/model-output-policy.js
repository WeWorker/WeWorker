// These are application fallbacks, not claims about any provider's model limits.
// Reasoning models share the output allowance between reasoning and visible text.
// Use one configurable fallback across exploration stages, not small per-prompt caps.
const DEFAULT_OUTPUT_LIMITS = Object.freeze({ analysis: 16_384, adapter_generation: 16_384 });
const MAX_CONFIGURED_OUTPUT_LIMIT = 1_048_576;

function limit(value, field) {
  if (value === undefined) return undefined;
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || number > MAX_CONFIGURED_OUTPUT_LIMIT) {
    const error = new Error(`${field} must be an integer between 1 and ${MAX_CONFIGURED_OUTPUT_LIMIT}`);
    error.code = 'INVALID_MODEL_OUTPUT_CONFIG';
    throw error;
  }
  return number;
}

export function normalizeOutputConfig(config = {}) {
  return Object.fromEntries(['max_output_tokens', 'model_max_output_tokens']
    .filter((key) => config[key] !== undefined)
    .map((key) => [key, limit(config[key], key)]));
}

export function resolveModelOutputLimit({ config = {}, purpose = 'analysis', requested, env = process.env } = {}) {
  const normalized = normalizeOutputConfig(config);
  const configured = requested ?? normalized.max_output_tokens
    ?? limit(purpose === 'adapter_generation' ? env.WEBCLI_GENERATION_MAX_OUTPUT_TOKENS : env.WEBCLI_ANALYSIS_MAX_OUTPUT_TOKENS, 'stage output limit')
    ?? limit(env.WEBCLI_MAX_OUTPUT_TOKENS, 'WEBCLI_MAX_OUTPUT_TOKENS');
  const desired = limit(configured, 'max_output_tokens') ?? DEFAULT_OUTPUT_LIMITS[purpose] ?? DEFAULT_OUTPUT_LIMITS.analysis;
  const ceiling = normalized.model_max_output_tokens
    ?? limit(env.WEBCLI_MODEL_MAX_OUTPUT_TOKENS, 'model_max_output_tokens');
  return ceiling ? Math.min(desired, ceiling) : desired;
}

// Never transport provider bodies, thinking, request headers, or config in errors.
export function modelOutputErrorDetails(details) {
  const safe = {};
  if (['max_tokens', 'length'].includes(details?.stopReason)) safe.stopReason = details.stopReason;
  for (const key of ['outputLimit', 'inputUnits', 'outputUnits']) {
    if (Number.isSafeInteger(details?.[key]) && details[key] >= 0) safe[key] = details[key];
  }
  return safe;
}

export function assertModelOutputComplete({ stopReason, outputLimit, usage = {} }) {
  if (!['max_tokens', 'length'].includes(stopReason)) return;
  const error = new Error(`模型输出达到单次上限（${outputLimit} tokens），结果未完整返回；请调整输出额度或模型后继续。未执行本次截断输出中的工具。`);
  error.code = 'MODEL_OUTPUT_LIMIT_EXCEEDED';
  error.details = modelOutputErrorDetails({
    stopReason, outputLimit,
    inputUnits: usage?.input_tokens ?? usage?.prompt_tokens,
    outputUnits: usage?.output_tokens ?? usage?.completion_tokens,
  });
  throw error;
}
