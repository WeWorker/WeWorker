import { callConfiguredLanguageModel } from '../ai-analyzer.js';
import { GenerationHarnessError } from './errors.js';

const MESSAGE_TEXT_LIMIT = 16_000;

function truncateText(value, limit = MESSAGE_TEXT_LIMIT) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}...[truncated]` : text;
}

function extractJson(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    for (let start = candidate.indexOf('{'); start >= 0; start = candidate.indexOf('{', start + 1)) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = start; index < candidate.length; index += 1) {
        const char = candidate[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') {
          inString = true;
        } else if (char === '{') {
          depth += 1;
        } else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            try {
              return JSON.parse(candidate.slice(start, index + 1));
            } catch {
              break;
            }
          }
          if (depth < 0) break;
        }
      }
    }
  }
  throw new GenerationHarnessError(
    'model did not return a valid JSON action',
    'INVALID_JSON_ACTION',
    { preview: truncateText(trimmed, 800) },
  );
}

function serializeMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        toolCallId: message.toolCallId,
        name: message.name,
        isError: Boolean(message.isError),
        content: truncateText(message.content),
      };
    }
    if (message.toolCalls) {
      return { role: message.role, toolCalls: message.toolCalls };
    }
    return { role: message.role, content: truncateText(message.content) };
  });
}

function buildJsonActionPrompt({ systemPrompt, messages, tools, step, repairFeedback = null }) {
  const repairInstruction = repairFeedback
    ? `
## 上次输出修复

上一次输出为空、不是合法的单个 JSON action、或缺少必需的 type 信封（${repairFeedback.code || 'INVALID_JSON_ACTION'}）。
原始响应预览：${JSON.stringify(truncateText(repairFeedback.preview, 800))}
请保持同一个决策，仅重新输出修复后的单个 JSON 对象，必须包含 "type":"tool_call" 或 "type":"final" 信封，不要解释原因。\n`
    : '';
  return `${systemPrompt}

你正在运行一个受限的 Adapter Generation Tool Loop。

## 可用工具

${JSON.stringify(tools, null, 2)}

## 当前对话

${JSON.stringify(serializeMessages(messages), null, 2)}

## 当前步骤

${step}
${repairInstruction}

## 输出协议

你每次只能输出一个 JSON 对象，不要输出 Markdown 或解释文字。

调用工具：
{"type":"tool_call","name":"工具名","arguments":{}}

完成任务：
{"type":"final","content":"简短结果","data":{}}

必须使用上方定义过的工具名，arguments 必须符合工具参数 Schema。`;
}

export function createJsonActionModel({
  callModel = callConfiguredLanguageModel,
  taskLabelPrefix = 'adapter generation loop',
  config = null,
} = {}) {
  return async ({ systemPrompt, messages, tools, step, signal, repairFeedback = null }) => {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const response = await callModel({
      prompt: buildJsonActionPrompt({ systemPrompt, messages, tools, step, repairFeedback }),
      // 思考型模型（glm/DeepSeek 等）的 thinking token 计入 max_tokens：
      // 预算过小会导致思考吃光额度、正文为空（stop=max_tokens 且 response=0B）。
      maxTokens: 8000,
      taskLabel: `${taskLabelPrefix} step ${step}`,
      ...(config ? { config } : {}),
    });
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return extractJson(typeof response === 'string' ? response : response?.text);
  };
}

export function parseJsonActionResponse(text) {
  return extractJson(text);
}
