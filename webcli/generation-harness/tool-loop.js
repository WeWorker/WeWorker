import { GenerationCancelledError, GenerationHarnessError, GenerationPausedError } from './errors.js';
import { ToolRegistry } from './tool-registry.js';

function normalizeModelResponse(response) {
  if (!response || typeof response !== 'object') {
    throw new GenerationHarnessError('model returned an empty tool-loop response', 'INVALID_MODEL_RESPONSE');
  }
  if (response.type === 'final') {
    return {
      type: 'final',
      content: String(response.content || ''),
      data: response.data,
    };
  }
  const calls = response.type === 'tool_call'
    ? [response]
    : Array.isArray(response.calls) ? response.calls : [];
  if ((response.type === 'tool_call' || response.type === 'tool_calls') && calls.length > 0) {
    return {
      type: 'tool_calls',
      calls: calls.map((call, index) => ({
        id: String(call.id || `call-${index + 1}`),
        name: String(call.name || call.tool || ''),
        arguments: call.arguments ?? {},
      })),
    };
  }
  throw new GenerationHarnessError(
    `unsupported model response type: ${String(response.type || 'unknown')}`,
    'INVALID_MODEL_RESPONSE',
    { response },
  );
}

function assertActive(signal) {
  if (signal?.aborted) throw new GenerationCancelledError();
}

const REPAIRABLE_MODEL_ERRORS = new Set(['INVALID_JSON_ACTION', 'INVALID_MODEL_RESPONSE']);
const REPAIR_PREVIEW_LIMIT = 800;

function responsePreview(response) {
  try {
    const text = typeof response === 'string' ? response : JSON.stringify(response);
    if (!text) return '';
    return text.length > REPAIR_PREVIEW_LIMIT
      ? `${text.slice(0, REPAIR_PREVIEW_LIMIT)}...[truncated]`
      : text;
  } catch {
    return String(response);
  }
}

export async function runToolLoop({
  model,
  tools = [],
  messages = [],
  systemPrompt = '',
  maxSteps = 8,
  signal,
  context = {},
  onEvent = null,
}) {
  if (typeof model !== 'function') throw new Error('runToolLoop requires a model function');
  const registry = tools instanceof ToolRegistry ? tools : new ToolRegistry(tools);
  const conversation = structuredClone(messages);
  const toolDefinitions = registry.listForModel();

  for (let step = 1; step <= maxSteps; step += 1) {
    assertActive(signal);
    const modelInput = {
      systemPrompt,
      messages: structuredClone(conversation),
      tools: toolDefinitions,
      step,
      signal,
    };
    const invokeModel = (repairFeedback = null) => {
      onEvent?.({
        type: 'model_started',
        step,
        attempt: repairFeedback ? repairFeedback.attempt : 1,
        ...(repairFeedback ? { repair: true } : {}),
      });
      return model(repairFeedback ? { ...modelInput, repairFeedback } : modelInput);
    };
    // 修复预算按「本步骤累计」计：初始尝试之外还有两次修复机会，
    // 空输出、坏信封等不同格式错误可混合使用（思考型模型常见「空→裸对象」链式故障）。
    const MAX_REPAIR_ATTEMPTS_PER_STEP = 2;
    let rawResponse;
    let response;
    try {
      rawResponse = await invokeModel();
      assertActive(signal);
      response = normalizeModelResponse(rawResponse);
    } catch (error) {
      if (!REPAIRABLE_MODEL_ERRORS.has(error?.code)) throw error;
      assertActive(signal);
      let repairCode = error.code;
      let repairPreview = error.code === 'INVALID_MODEL_RESPONSE'
        ? responsePreview(error.details?.response ?? rawResponse)
        : (error.details?.preview || '');
      for (let attempt = 2; attempt <= 1 + MAX_REPAIR_ATTEMPTS_PER_STEP; attempt += 1) {
        onEvent?.({
          type: 'model_format_retry',
          step,
          attempt,
          code: repairCode,
        });
        try {
          rawResponse = await invokeModel({ code: repairCode, preview: repairPreview, attempt });
          assertActive(signal);
          response = normalizeModelResponse(rawResponse);
          break;
        } catch (retryError) {
          if (!REPAIRABLE_MODEL_ERRORS.has(retryError?.code)) throw retryError;
          assertActive(signal);
          repairCode = retryError.code;
          repairPreview = retryError.code === 'INVALID_MODEL_RESPONSE'
            ? responsePreview(retryError.details?.response ?? rawResponse)
            : (retryError.details?.preview || '');
          if (attempt >= 1 + MAX_REPAIR_ATTEMPTS_PER_STEP) throw retryError;
        }
      }
      if (!response) throw error;
    }
    onEvent?.({ type: 'model_completed', step, response });

    if (response.type === 'final') {
      conversation.push({ role: 'assistant', content: response.content });
      return {
        status: 'completed',
        steps: step,
        content: response.content,
        data: response.data,
        messages: conversation,
      };
    }

    conversation.push({ role: 'assistant', toolCalls: response.calls });
    for (const call of response.calls) {
      assertActive(signal);
      onEvent?.({ type: 'tool_started', step, call });
      let output;
      let isError = false;
      try {
        output = await registry.execute(call, { ...context, signal, step, call });
      } catch (error) {
        if (error instanceof GenerationPausedError || error instanceof GenerationCancelledError) throw error;
        isError = true;
        output = {
          error: error?.message || String(error),
          code: error?.code || 'TOOL_EXECUTION_FAILED',
          details: error?.details,
        };
      }
      const toolResult = {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: output,
        isError,
      };
      conversation.push(toolResult);
      onEvent?.({ type: 'tool_completed', step, call, output, isError });
    }
  }

  throw new GenerationHarnessError(
    `tool loop exceeded maxSteps=${maxSteps}`,
    'TOOL_LOOP_MAX_STEPS',
    { maxSteps },
  );
}
