/**
 * AI Analyzer — 使用可配置的大模型分析网络请求并生成 adapter 代码
 */

import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { normalizeOutputConfig, resolveModelOutputLimit, assertModelOutputComplete, modelOutputErrorDetails } from './generation-harness/model-output-policy.js';
import {
  normalizeApiEndpoint,
  normalizeRequestBodyEvidence,
  normalizeResponseBodyEvidence,
} from "./generation-harness/source-evidence.js";

const CONFIG_DIR = join(homedir(), ".webcli");
const CONFIG_PATH = join(homedir(), ".webcli", "config.json");
const PROVIDER_PRESETS = {
  anthropic: {
    protocol: "anthropic",
    base_url: "https://api.anthropic.com",
    model: "claude-opus-4-7",
  },
  openai: {
    protocol: "openai",
    base_url: "https://api.openai.com/v1",
    model: "gpt-5.5",
  },
  deepseek: {
    protocol: "openai",
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
  },
  zhipu: {
    protocol: "openai",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.1",
  },
  qwen: {
    protocol: "openai",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3-max",
  },
  custom: {
    protocol: "openai",
    base_url: "",
    model: "",
  },
};

function inferProvider(config = {}) {
  const provider = String(config.provider || "").trim();
  if (provider && PROVIDER_PRESETS[provider]) return provider;

  const baseUrl = String(config.base_url || "").toLowerCase();
  if (baseUrl.includes("anthropic.com")) return "anthropic";
  if (baseUrl.includes("api.openai.com")) return "openai";
  if (baseUrl.includes("api.deepseek.com")) return "deepseek";
  if (baseUrl.includes("bigmodel.cn")) return "zhipu";
  if (baseUrl.includes("dashscope.aliyuncs.com")) return "qwen";
  if (baseUrl) return "custom";
  return "openai";
}

export function normalizeAiConfig(config = {}) {
  const provider = inferProvider(config);
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.anthropic;
  const baseUrl = String(config.base_url ?? "").trim();
  const model = String(config.model ?? "").trim();
  return {
    provider,
    protocol: String(config.protocol || preset.protocol || "openai").trim() || "openai",
    api_key: String(config.api_key || "").trim(),
    base_url: baseUrl || preset.base_url || "",
    model: model || preset.model || "",
    ...normalizeOutputConfig(config),
  };
}

export function getAiConfigPath() {
  return CONFIG_PATH;
}

export function readAiConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return normalizeAiConfig({});
  }
  return normalizeAiConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")));
}

export function saveAiConfig(config = {}) {
  const normalized = normalizeAiConfig(config);
  validateAiConfig(normalized, "保存配置失败");
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        ...normalized,
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  return normalized;
}

function loadRequiredConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `未找到配置文件 ${CONFIG_PATH}，请先在扩展的“配置”页保存 API Key / Base URL / Model`
    );
  }
  const config = readAiConfig();
  validateAiConfig(config, "config.json");
  return config;
}

function validateAiConfig(config, label = "配置") {
  if (!config.api_key) {
    throw new Error(`${label} 中未配置 api_key`);
  }
  if (!config.base_url) {
    throw new Error(`${label} 中未配置 base_url`);
  }
  if (!config.model) {
    throw new Error(`${label} 中未配置 model`);
  }
  if (config.provider === "zhipu" && !String(config.base_url).includes("/api/paas/v4")) {
    throw new Error(`${label} 中智谱的 base_url 不正确，应为 https://open.bigmodel.cn/api/paas/v4`);
  }
}

function structuralUrl(value) {
  return normalizeApiEndpoint({ url: String(value || "") }).endpoint;
}

export function buildPrompt(siteKey, apiEntries, existingCode) {
  const apiDescriptions = apiEntries
    .map((entry, i) => {
      const endpoint = normalizeApiEndpoint(entry);
      let section = `### API ${i + 1}\n`;
      section += `- Method: ${entry.method || "GET"}\n`;
      section += `- URL: ${endpoint.endpoint}\n`;
      if (endpoint.queryKeys.length) section += `- Query Keys: ${endpoint.queryKeys.join(", ")}\n`;
      const requestEvidence = normalizeRequestBodyEvidence({
        ...entry,
        requestBodyPreview: entry.requestBodyPreview ?? entry.requestBody,
      });
      if (requestEvidence.bodyKind !== 'none')
        section += `- Request Evidence: ${JSON.stringify(requestEvidence)}\n`;
      const responseEvidence = normalizeResponseBodyEvidence(entry);
      if (responseEvidence.bodyKind !== 'none')
        section += `- Response Evidence: ${JSON.stringify(responseEvidence)}\n`;
      if (entry.status) section += `- Status: ${entry.status}\n`;
      return section;
    })
    .join("\n");

  const mergeInstruction = existingCode
    ? `
## 已有 Adapter 代码（必须保留并合并）

以下是该网站已有的 adapter 代码，你必须保留其中所有已有的工具，
然后将新发现的 API 作为新工具添加进去。如果新 API 和已有工具功能重复，跳过不添加。

\`\`\`javascript
${existingCode.slice(0, 6000)}
\`\`\`

`
    : '';

  return `你是一个 WebMCP adapter 代码生成器。根据以下抓取到的 API 请求信息，为网站 ${siteKey} 生成一个完整的 adapter。
${mergeInstruction}
## 抓取到的 API 请求数据

${apiDescriptions}

## Adapter 规范

1. 每个有意义的业务 API 生成一个 tool（过滤掉埋点、静态资源、无意义的请求）
2. tool name 格式: \`${siteKey}.<动作名>\`，动作名用英文下划线命名（如 search_movies、get_user_info）
3. 从 URL query params 和 request body 中提取用户可控的参数，定义在 parameters.properties 中
4. 每个参数需要 type（string/number/boolean）和 description（中文描述）
5. 固定值参数（如 apikey、version、format）不要暴露给用户，直接硬编码在 handler 中
6. handler 中使用 fetch 调用 API，必须带 credentials: 'include' 以携带 cookie
7. 从 response JSON 中提取有用字段返回，不要返回整个原始响应
8. 如果 response 是列表，返回 items 数组和 total 数量

## 输出要求

直接输出可运行的 JavaScript 代码。格式如下：

window.__webmcpRegister({
  name: '${siteKey} adapter',
  tools: [
    {
      name: '${siteKey}.xxx',
      description: '中文描述这个工具做什么',
      parameters: {
        type: 'object',
        properties: {
          param1: { type: 'string', description: '参数描述' },
        },
        required: ['param1'],
      },
      handler: async ({ param1 }) => {
        const resp = await fetch(\`...\`, { credentials: 'include' });
        const data = await resp.json();
        return { ... };
      },
    },
  ],
});

注意：
- 只输出 JavaScript 代码，不要输出 markdown 代码块标记（不要 \`\`\`）
- 不要输出任何解释文字
- 确保代码可以直接在浏览器的 isolated world 中运行`;
}

function extractCodeFromResponse(text) {
  let code = text.trim();
  if (code.startsWith("```")) {
    code = code.replace(/^```(?:javascript|js)?\n?/, "").replace(/\n?```$/, "");
  }
  return code.trim();
}

function extractJsonFromResponse(text) {
  const trimmed = String(text || "").trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {}

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));
  }
  throw new Error("模型返回结果不是合法 JSON");
}

function truncateForModel(value, limit = 500) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function summarizeNetworkEntry(entry = {}) {
  const endpoint = normalizeApiEndpoint(entry);
  const requestEvidence = normalizeRequestBodyEvidence(entry);
  return {
    method: String(entry.method || "GET").toUpperCase(),
    url: endpoint.endpoint,
    status: entry.status ?? null,
    responseContentType: String(entry.responseContentType || entry.contentType || ""),
    queryKeys: endpoint.queryKeys.slice(0, 12),
    requestEvidence,
    responseEvidence: normalizeResponseBodyEvidence(entry),
  };
}

function summarizeActionStep(action = {}) {
  return {
    step: String(action.step || ""),
    executed: action?.result?.executed !== false,
    action: String(action?.result?.action || ""),
    value: truncateForModel(action?.result?.value, 200),
    mode: String(action?.result?.mode || ""),
    networkDelta: Array.isArray(action?.networkDelta?.entries)
      ? action.networkDelta.entries.slice(0, 6).map(summarizeNetworkEntry)
      : [],
  };
}

function summarizeStateHints(stateHints = {}) {
  return {
    hasNextDataScript: Boolean(stateHints.nextDataScript),
    hasInitialStateText: Boolean(stateHints.initialStateText),
    hasNuxtData: Boolean(stateHints.nuxtData),
    hasApolloStateText: Boolean(stateHints.apolloStateText),
  };
}

export function buildExplorationAnalysisPayload({ siteKey, explorationResult, heuristicVerdict }) {
  const pageStateAfter = explorationResult?.pageStateAfter || {};
  const resultPageState = explorationResult?.resultPageState || {};
  const networkEntries = Array.isArray(explorationResult?.network?.entries)
    ? explorationResult.network.entries
    : [];
  const topNetworkEntries = networkEntries.slice(0, 12).map(summarizeNetworkEntry);

  return {
    siteKey,
    heuristicVerdict: heuristicVerdict || null,
    workflow: {
      version: String(explorationResult?.workflow?.version || ""),
      strategy: truncateForModel(explorationResult?.workflow?.strategy, 400),
    },
    page: {
      finalUrl: structuralUrl(pageStateAfter?.url),
      finalTitle: truncateForModel(pageStateAfter?.title, 120),
      resultUrl: structuralUrl(resultPageState?.url),
      resultTitle: truncateForModel(resultPageState?.title, 120),
      resultSignals: {
        listCandidates: Number(resultPageState?.listCandidates || 0),
        paginationCandidates: Number(resultPageState?.paginationCandidates || 0),
      },
      stateHints: summarizeStateHints(pageStateAfter?.stateHints || {}),
    },
    actions: Array.isArray(explorationResult?.actions)
      ? explorationResult.actions.slice(0, 6).map(summarizeActionStep)
      : [],
    finalNetwork: topNetworkEntries,
  };
}

function buildExplorationAnalysisPrompt({ siteKey, explorationResult, heuristicVerdict }) {
  const payload = buildExplorationAnalysisPayload({ siteKey, explorationResult, heuristicVerdict });

  return `你是一个 WebMCP 网站探索分析器。你的任务是根据页面状态、交互步骤和抓到的网络请求，判断这个网站后续应该如何接入 adapter。

你必须只输出一个 JSON 对象，不要输出 markdown，不要输出解释文字。

允许的枚举：
- pattern: "api_driven" | "dom_driven" | "state_or_ssr"
- recommendedStrategy: "COOKIE_API" | "UI" | "HYBRID"

输出 JSON schema：
{
  "pattern": "api_driven",
  "recommendedStrategy": "COOKIE_API",
  "reason": "中文，1-3句，说明为什么这么判断",
  "observedSummary": "中文，简洁总结你观察到的关键信号",
  "confidence": 0.0,
  "topApiCandidates": [
    { "method": "GET", "url": "https://...", "why": "中文说明" }
  ],
  "nextSteps": ["中文建议1", "中文建议2", "中文建议3"]
}

要求：
1. 所有说明文字必须是中文。
2. reason 要明确引用真实信号，例如 SSR 痕迹、列表接口、分页参数、写操作接口、请求体字段、返回结构等。
3. confidence 是 0 到 1 的数字。
4. topApiCandidates 最多返回 5 条，必须是你认为最值得做 adapter 的业务接口。
5. 如果网络接口信号很弱，就把 pattern 判成 dom_driven，不要硬判成 API。
6. 如果既有明显页面状态注水，又有较强接口信号，优先考虑 state_or_ssr + HYBRID。
7. 可以参考 heuristicVerdict，但不要盲从，最终结论以你自己的分析为准。

输入数据：
${JSON.stringify(payload, null, 2)}`;
}

function normalizeExplorationAnalysis(raw = {}, fallbackVerdict = {}) {
  const allowedPatterns = new Set(["api_driven", "dom_driven", "state_or_ssr"]);
  const allowedStrategies = new Set(["COOKIE_API", "UI", "HYBRID"]);

  const pattern = allowedPatterns.has(raw.pattern) ? raw.pattern : (fallbackVerdict.pattern || "dom_driven");
  const recommendedStrategy = allowedStrategies.has(raw.recommendedStrategy)
    ? raw.recommendedStrategy
    : (fallbackVerdict.recommendedStrategy || "UI");
  const reason = String(raw.reason || "").trim() || String(fallbackVerdict.reason || "").trim() || "模型未返回有效理由";
  const observedSummary = String(raw.observedSummary || "").trim();
  const confidenceRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(confidenceRaw, 1))
    : null;
  const topApiCandidates = Array.isArray(raw.topApiCandidates)
    ? raw.topApiCandidates
      .filter((item) => item && typeof item === "object" && item.url)
      .slice(0, 5)
      .map((item) => ({
        method: String(item.method || "GET").toUpperCase(),
        url: structuralUrl(item.url),
        why: String(item.why || "").trim(),
      }))
    : [];
  const nextSteps = Array.isArray(raw.nextSteps)
    ? raw.nextSteps.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3)
    : [];

  return {
    pattern,
    recommendedStrategy,
    reason,
    observedSummary,
    confidence,
    topApiCandidates,
    nextSteps,
  };
}

function summarizeActionCaptureCandidate(candidate = {}) {
  const endpoint = normalizeApiEndpoint(candidate);
  const requestEvidence = normalizeRequestBodyEvidence(candidate);
  return {
    method: String(candidate.method || "GET").toUpperCase(),
    url: endpoint.endpoint,
    intercepted: Boolean(candidate.intercepted),
    blockedReason: String(candidate.blockedReason || ""),
    responseContentType: String(candidate.responseContentType || ""),
    queryKeys: endpoint.queryKeys.slice(0, 12),
    requestEvidence,
    responseEvidence: normalizeResponseBodyEvidence(candidate),
  };
}

export function buildActionCaptureAnalysisPayload({ captureResult }) {
  return {
    site: String(captureResult?.site || ""),
    actionName: String(captureResult?.actionName || ""),
    mode: String(captureResult?.mode || ""),
    pattern: String(captureResult?.pattern || ""),
    timeoutSeconds: Number(captureResult?.timeoutSeconds || 0),
    recommendation: {
      toolName: String(captureResult?.recommendation?.toolName || ""),
      nextStep: String(captureResult?.recommendation?.nextStep || ""),
      canGenerateAdapterTool: Boolean(captureResult?.recommendation?.canGenerateAdapterTool),
    },
    page: {
      beforeUrl: structuralUrl(captureResult?.beforeTab?.url),
      finalUrl: structuralUrl(captureResult?.finalTab?.url),
      beforeTitle: truncateForModel(captureResult?.beforeTab?.title, 120),
      finalTitle: truncateForModel(captureResult?.finalTab?.title, 120),
    },
    capturedActions: Array.isArray(captureResult?.capturedActions)
      ? captureResult.capturedActions.slice(0, 8).map(summarizeActionCaptureCandidate)
      : [],
    workflow: {
      version: String(captureResult?.workflow?.version || ""),
      strategy: truncateForModel(captureResult?.workflow?.strategy, 300),
    },
  };
}

function buildActionCaptureAnalysisPrompt({ captureResult }) {
  const payload = buildActionCaptureAnalysisPayload({ captureResult });
  return `你是一个 WebMCP 动作捕获分析器。你的任务是根据一次手动动作捕获得到的请求候选，判断这次动作最可能对应什么业务意图、哪个请求最值得生成成工具，以及这些请求各自大概在做什么。

你必须只输出一个 JSON 对象，不要输出 markdown，不要输出解释文字。

输出 JSON schema：
{
  "summary": "中文，1-3句，总结这次动作捕获最可能是什么业务动作",
  "recommendedToolName": "site.xxx_draft",
  "recommendedNextStep": "中文，下一步建议",
  "actionKind": "read|write|mixed|unknown",
  "confidence": 0.0,
  "candidateAnalyses": [
    {
      "method": "POST",
      "url": "https://...",
      "purpose": "中文，说明接口大概做什么",
      "why": "中文，为什么判断它与本次动作相关",
      "isPrimary": true,
      "toolNameSuggestion": "site.xxx_draft",
      "parameterHints": ["roomId", "startTime"],
      "risk": "low|medium|high"
    }
  ]
}

要求：
1. 所有说明都用中文。
2. summary 要尽量站在用户业务动作视角，不要只是重复 URL。
3. candidateAnalyses 最多返回 5 条，并按相关性从高到低排序。
4. purpose 要让普通用户能看懂接口大概在做什么。
5. 如果是写操作、提交、完成任务、保存等副作用接口，risk 不要给 low。
6. toolNameSuggestion 尽量复用已有 recommendedToolName 风格。
7. 如果没有足够信号，也要老实给出 uncertainty，不要瞎编。
8. 必须区分“真正触发业务状态变化的主请求”和“操作完成后自动刷新的详情、列表、统计请求”；info/detail/summary/list/history/count 即使使用 POST，也通常只是后续刷新。
9. approve/agree/reject/audit/submit/commit/complete 等动作型 URL，以及与 actionName 语义一致且携带业务参数的请求，应优先考虑为主请求。
10. isPrimary 最多只能有一个；如果无法可靠判断，所有候选均设为 false，并在 recommendedNextStep 中要求用户人工选择主接口。

输入数据：
${JSON.stringify(payload, null, 2)}`;
}

function normalizeActionCaptureAnalysis(raw = {}, fallbackResult = {}) {
  const allowedKinds = new Set(["read", "write", "mixed", "unknown"]);
  const actionKind = allowedKinds.has(raw.actionKind) ? raw.actionKind : "unknown";
  const confidenceRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(confidenceRaw, 1))
    : null;
  const summary = String(raw.summary || "").trim() || "AI 未返回有效动作摘要";
  const recommendedToolName = String(raw.recommendedToolName || "").trim() || String(fallbackResult?.recommendation?.toolName || "").trim();
  const recommendedNextStep = String(raw.recommendedNextStep || "").trim() || String(fallbackResult?.recommendation?.nextStep || "").trim();
  const candidateAnalyses = Array.isArray(raw.candidateAnalyses)
    ? raw.candidateAnalyses
      .filter((item) => item && typeof item === "object" && item.url)
      .slice(0, 5)
      .map((item) => ({
        method: String(item.method || "GET").toUpperCase(),
        url: structuralUrl(item.url),
        purpose: String(item.purpose || "").trim(),
        why: String(item.why || "").trim(),
        isPrimary: Boolean(item.isPrimary),
        toolNameSuggestion: String(item.toolNameSuggestion || "").trim(),
        parameterHints: Array.isArray(item.parameterHints)
          ? item.parameterHints.map((hint) => String(hint || "").trim()).filter(Boolean).slice(0, 8)
          : [],
        risk: ["low", "medium", "high"].includes(String(item.risk || "")) ? String(item.risk) : "",
      }))
    : [];

  return {
    summary,
    recommendedToolName,
    recommendedNextStep,
    actionKind,
    confidence,
    candidateAnalyses,
  };
}

function extractPreviewFieldNames(preview, limit = 20) {
  const text = String(preview || "").trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return [];
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.keys(parsed).slice(0, limit);
    }
    if (Array.isArray(parsed)) {
      const first = parsed[0];
      if (first && typeof first === "object" && !Array.isArray(first)) {
        return Object.keys(first).slice(0, limit);
      }
    }
  } catch {}
  return [];
}

function summarizeScaffoldCandidate(candidate = {}) {
  const endpoint = normalizeApiEndpoint(candidate);
  const requestEvidence = normalizeRequestBodyEvidence(candidate);
  return {
    actionName: String(candidate.actionName || "").trim(),
    toolName: String(candidate.toolName || "").trim(),
    method: String(candidate.method || "GET").toUpperCase(),
    url: endpoint.endpoint,
    queryKeys: endpoint.queryKeys.slice(0, 20),
    mode: String(candidate.mode || "").trim(),
    requestFieldNames: requestEvidence.bodyKeys.slice(0, 20),
    requestEvidence,
    responseEvidence: normalizeResponseBodyEvidence(candidate),
    responseHints: candidate.responseHints && typeof candidate.responseHints === "object"
      ? {
          listPath: String(candidate.responseHints.listPath || "").trim(),
          itemKeys: Array.isArray(candidate.responseHints.itemKeys) ? candidate.responseHints.itemKeys.slice(0, 16) : [],
          preferredIdKey: String(candidate.responseHints.preferredIdKey || "").trim(),
          preferredDisplayKey: String(candidate.responseHints.preferredDisplayKey || "").trim(),
          preferredAvailabilityKey: String(candidate.responseHints.preferredAvailabilityKey || "").trim(),
        }
      : null,
  };
}

export function buildScaffoldSemanticPayload(memory = {}) {
  const siteKey = String(memory.siteKey || "").trim();
  const listCandidates = Array.isArray(memory.listApiCandidates) ? memory.listApiCandidates.slice(0, 2) : [];
  const actionCandidates = Array.isArray(memory.actionApiCandidates) ? memory.actionApiCandidates.slice(0, 5) : [];
  return {
    siteKey,
    siteHost: String(memory.siteHost || "").trim(),
    recommendedStrategy: String(memory.recommendedStrategy || "").trim(),
    verdictPattern: String(memory.verdictPattern || "").trim(),
    verdictReason: truncateForModel(memory.verdictReason, 500),
    currentGeneratedTools: [
      `${siteKey}.check_login_status`,
      ...(listCandidates[0] ? [`${siteKey}.search_records`] : []),
      ...(listCandidates[1] ? [`${siteKey}.fetch_summary_groups`] : []),
      ...actionCandidates.map((candidate) => String(candidate.toolName || "").trim()).filter(Boolean),
    ],
    listApiCandidates: listCandidates.map((candidate, index) => ({
      sourceToolName: index === 0 ? `${siteKey}.search_records` : `${siteKey}.fetch_summary_groups`,
      method: String(candidate.method || "GET").toUpperCase(),
      url: structuralUrl(candidate.url),
      queryKeys: normalizeApiEndpoint(candidate).queryKeys.slice(0, 20),
      requestFieldNames: normalizeRequestBodyEvidence(candidate).bodyKeys.slice(0, 16),
      requestEvidence: normalizeRequestBodyEvidence(candidate),
    })),
    actionApiCandidates: actionCandidates.map(summarizeScaffoldCandidate),
  };
}

function buildScaffoldSemanticPrompt(memory = {}) {
  const payload = buildScaffoldSemanticPayload(memory);
  return `你是一个 WebCLI Scaffold 语义增强器。你的任务不是生成代码，而是根据站点记忆与候选接口，为即将生成的 scaffold 提供更好的中文工具名、中文描述和参数描述。

你必须只输出一个 JSON 对象，不要输出 markdown，不要输出解释文字。

输出 JSON schema：
{
  "manifestDescription": "中文，简短描述该站点适配器能做什么",
  "quickPrompts": ["中文提示词1", "中文提示词2"],
  "toolOverrides": [
    {
      "sourceToolName": "${payload.siteKey}.search_records",
      "toolName": "${payload.siteKey}.search_xxx",
      "description": "中文，描述这个工具是干什么的，给插件用户看",
      "parameterDescriptions": {
        "keyword": "中文参数说明",
        "pageSize": "中文参数说明"
      },
      "parameterUiHints": {
        "keyword": {
          "widget": "text",
          "placeholder": "请输入任务关键词",
          "example": "会议室"
        },
        "startTime": {
          "widget": "datetime",
          "placeholder": "请选择开始时间",
          "example": "2026-05-21T14:30"
        }
      }
    }
  ]
}

要求：
1. 所有说明必须是中文。
2. toolName 必须保留站点前缀 ${payload.siteKey}.，只优化后半段动作名。
3. 不要虚构不存在的参数；parameterDescriptions 只能描述输入里真实出现过的字段。
4. \`parameterUiHints\` 也只能引用真实存在的字段。
5. 如果现有工具名已经合理，可以保持不变。
6. 工具描述要站在客户端或 Agent 调用者视角，直接说明它能做什么，不要假设用户必须进入插件特定页面。
7. quickPrompts 最多返回 3 条，适合作为该适配器的快捷引导语。
8. 优先优化这些工具：
   - 主列表/搜索工具 ${payload.siteKey}.search_records
   - 次级摘要工具 ${payload.siteKey}.fetch_summary_groups
   - 明显的动作工具，例如 *_draft
9. 如果无法判断某个工具的业务语义，就不要硬改名字，只补中文描述即可。
10. \`parameterUiHints.widget\` 只能从这些值里选：\`text\`、\`textarea\`、\`date\`、\`time\`、\`datetime\`、\`number\`、\`boolean\`。
11. \`placeholder\` 和 \`example\` 都必须是中文友好的展示文本；不要输出脚本、表达式或长段说明。

输入数据：
${JSON.stringify(payload, null, 2)}`;
}

function sanitizeToolNameForSite(toolName, siteKey, fallbackToolName) {
  const raw = String(toolName || "").trim();
  if (!raw) return fallbackToolName;
  const prefix = `${siteKey}.`;
  const local = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw.includes(".") ? raw.split(".").slice(1).join(".") : raw;
  const sanitizedLocal = local
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!sanitizedLocal) return fallbackToolName;
  return `${siteKey}.${sanitizedLocal}`;
}

function normalizeScaffoldSemanticAnalysis(raw = {}, memory = {}) {
  const siteKey = String(memory.siteKey || "").trim();
  const payload = buildScaffoldSemanticPayload(memory);
  const allowedSourceTools = new Set(Array.isArray(payload.currentGeneratedTools) ? payload.currentGeneratedTools : []);
  const manifestDescription = String(raw.manifestDescription || "").trim();
  const quickPrompts = Array.isArray(raw.quickPrompts)
    ? raw.quickPrompts.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3)
    : [];
  const toolOverrides = Array.isArray(raw.toolOverrides)
    ? raw.toolOverrides
        .map((item) => {
          const sourceToolName = String(item?.sourceToolName || "").trim();
          if (!sourceToolName || !allowedSourceTools.has(sourceToolName)) return null;
          const parameterDescriptions = item?.parameterDescriptions && typeof item.parameterDescriptions === "object" && !Array.isArray(item.parameterDescriptions)
            ? Object.fromEntries(
                Object.entries(item.parameterDescriptions)
                  .map(([key, value]) => [String(key || "").trim(), String(value || "").trim()])
                  .filter(([key, value]) => key && value),
              )
            : {};
          const parameterUiHints = item?.parameterUiHints && typeof item.parameterUiHints === "object" && !Array.isArray(item.parameterUiHints)
            ? Object.fromEntries(
                Object.entries(item.parameterUiHints)
                  .map(([key, value]) => [String(key || "").trim(), normalizeScaffoldUiHint(value)])
                  .filter(([key, value]) => key && value),
              )
            : {};
          return {
            sourceToolName,
            toolName: sanitizeToolNameForSite(item?.toolName, siteKey, sourceToolName),
            description: String(item?.description || "").trim(),
            parameterDescriptions,
            parameterUiHints,
          };
        })
        .filter(Boolean)
    : [];

  const dedupedOverrides = [];
  const seenSources = new Set();
  const seenToolNames = new Set();
  for (const item of toolOverrides) {
    if (seenSources.has(item.sourceToolName)) continue;
    const fallbackToolName = item.sourceToolName;
    const nextToolName = seenToolNames.has(item.toolName) ? fallbackToolName : item.toolName;
    seenSources.add(item.sourceToolName);
    seenToolNames.add(nextToolName);
    dedupedOverrides.push({
      ...item,
      toolName: nextToolName,
    });
  }

  return {
    manifestDescription,
    quickPrompts,
    toolOverrides: dedupedOverrides,
  };
}

function normalizeScaffoldUiHint(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const widget = String(raw.widget || "").trim().toLowerCase();
  const allowedWidgets = new Set(["text", "textarea", "date", "time", "datetime", "number", "boolean"]);
  if (!allowedWidgets.has(widget)) return null;
  const placeholder = String(raw.placeholder || "").trim();
  const example = String(raw.example || "").trim();
  return {
    widget,
    placeholder,
    example,
  };
}

function buildOpenAiChatEndpoint(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("OpenAI 兼容协议需要配置 base_url");
  }
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

export function extractAnthropicTextContent(content = []) {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .join('')
    .trim();
}

async function callAnthropicModel(prompt, config, maxTokens, taskLabel) {
  const client = new Anthropic({
    apiKey: config.api_key,
    baseURL: config.base_url || undefined,
    maxRetries: 1,
    timeout: 120000,
  });

  const promptBytes = Buffer.byteLength(String(prompt || ""), "utf8");
  const memoryBefore = process.memoryUsage();
  process.stderr.write(
    `[AI] Calling Anthropic (${config.model}) for ${taskLabel} `
      + `(prompt=${promptBytes}B rss=${Math.round(memoryBefore.rss / 1024 / 1024)}MB)...\n`
  );

  const response = await client.messages.create({
    model: config.model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  assertModelOutputComplete({ stopReason: response.stop_reason, outputLimit: maxTokens, usage: response.usage });

  // Anthropic-compatible providers may prepend a thinking/redacted-thinking
  // block before the text block. Read every text block instead of assuming
  // content[0] contains the action payload.
  const text = extractAnthropicTextContent(response.content);
  const memoryAfter = process.memoryUsage();
  const emptyDetail = text
    ? ''
    : ` stop=${response.stop_reason || 'unknown'} blocks=${(response.content || []).map((block) => block?.type || 'unknown').join(',') || 'none'}`;
  process.stderr.write(
    `[AI] Completed ${taskLabel} `
      + `(response=${Buffer.byteLength(text, "utf8")}B${emptyDetail} rss=${Math.round(memoryAfter.rss / 1024 / 1024)}MB)\n`
  );
  return text;
}

async function callOpenAiCompatibleModel(prompt, config, maxTokens, taskLabel) {
  const endpoint = buildOpenAiChatEndpoint(config.base_url);
  const promptBytes = Buffer.byteLength(String(prompt || ""), "utf8");
  const memoryBefore = process.memoryUsage();
  process.stderr.write(
    `[AI] Calling OpenAI-compatible (${config.model}) for ${taskLabel} via ${endpoint} `
      + `(prompt=${promptBytes}B rss=${Math.round(memoryBefore.rss / 1024 / 1024)}MB)\n`
  );

  const requestBody = {
    model: config.model,
    messages: [{ role: "user", content: prompt }],
  };
  if (config.provider === "openai") {
    requestBody.max_completion_tokens = maxTokens;
  } else {
    requestBody.max_tokens = maxTokens;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.api_key}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI-compatible 请求失败: ${response.status} ${truncateError(errorText)}`);
  }

  const payload = await response.json();
  if (payload?.error?.message) {
    throw new Error(`OpenAI-compatible 响应错误: ${payload.error.message}`);
  }
  assertModelOutputComplete({ stopReason: payload?.choices?.[0]?.finish_reason, outputLimit: maxTokens, usage: payload?.usage });
  if (payload?.msg && !payload?.choices?.[0]?.message?.content) {
    throw new Error(`OpenAI-compatible 响应错误: ${payload.msg}`);
  }
  const messageContent = payload?.choices?.[0]?.message?.content;
  if (typeof messageContent === "string") {
    const text = messageContent.trim();
    const memoryAfter = process.memoryUsage();
    process.stderr.write(
      `[AI] Completed ${taskLabel} `
        + `(response=${Buffer.byteLength(text, "utf8")}B rss=${Math.round(memoryAfter.rss / 1024 / 1024)}MB)\n`
    );
    return text;
  }
  if (Array.isArray(messageContent)) {
    const text = messageContent
      .map((item) => (typeof item?.text === "string" ? item.text : ""))
      .join("")
      .trim();
    const memoryAfter = process.memoryUsage();
    process.stderr.write(
      `[AI] Completed ${taskLabel} `
        + `(response=${Buffer.byteLength(text, "utf8")}B rss=${Math.round(memoryAfter.rss / 1024 / 1024)}MB)\n`
    );
    return text;
  }
  throw new Error(`OpenAI-compatible 响应中未找到 message.content: ${truncateError(JSON.stringify(payload), 800)}`);
}

function truncateError(text, limit = 500) {
  const value = String(text || "");
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

async function callLanguageModelDirect(prompt, config, maxTokens, taskLabel) {
  if (config.protocol === "anthropic") {
    return callAnthropicModel(prompt, config, maxTokens, taskLabel);
  }
  return callOpenAiCompatibleModel(prompt, config, maxTokens, taskLabel);
}

function formatWorkerExitCode(code, signal) {
  if (signal) return `signal ${signal}`;
  const numeric = Number(code);
  if (!Number.isFinite(numeric)) return String(code);
  const unsigned = numeric >>> 0;
  const hex = `0x${unsigned.toString(16).padStart(8, "0")}`;
  return `${numeric} (${hex})`;
}

export function runLanguageModelWorker({
  prompt,
  config,
  maxTokens,
  taskLabel,
  workerScript = process.argv[1],
  execPath = process.execPath,
}) {
  return new Promise((resolve, reject) => {
    if (!workerScript) {
      reject(new Error("AI worker entry script is unavailable"));
      return;
    }
    const reportDir = String(process.env.WEBCLI_AI_REPORT_DIR || "").trim();
    const execArgs = [
      "--max-old-space-size=1536",
      "--report-on-fatalerror",
      "--report-uncaught-exception",
      ...(reportDir ? [`--report-directory=${reportDir}`] : []),
      workerScript,
      "internal-ai-call",
    ];
    const child = spawn(execPath, execArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        WEBCLI_AI_WORKER: "1",
      },
    });
    let stdout = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(() => {
        const error = new Error(`AI worker timed out for ${taskLabel}`);
        error.code = "AI_WORKER_TIMEOUT";
        reject(error);
      });
    }, 150000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout, "utf8") > 8 * 1024 * 1024) {
        try { child.kill(); } catch {}
        finish(() => {
          const error = new Error(`AI worker response exceeded 8MB for ${taskLabel}`);
          error.code = "AI_WORKER_RESPONSE_TOO_LARGE";
          reject(error);
        });
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.stdin.on("error", (error) => {
      // If the worker fail-fasts before consuming stdin, Windows can surface an
      // EPIPE here. The close event carries the authoritative crash code.
      if (error?.code !== "EPIPE") finish(() => reject(error));
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code, signal) => {
      finish(() => {
        if (code !== 0) {
          const error = new Error(`AI worker crashed for ${taskLabel}: ${formatWorkerExitCode(code, signal)}`);
          error.code = "AI_WORKER_CRASHED";
          error.details = { code, signal, taskLabel };
          reject(error);
          return;
        }
        try {
          const payload = JSON.parse(stdout || "{}");
          if (!payload.ok) {
            const error = new Error(payload.error || `AI worker failed for ${taskLabel}`);
            error.code = payload.code || "AI_WORKER_REQUEST_FAILED";
            if (error.code === 'MODEL_OUTPUT_LIMIT_EXCEEDED') error.details = modelOutputErrorDetails(payload.details);
            reject(error);
            return;
          }
          resolve(String(payload.result?.text || "").trim());
        } catch (error) {
          const wrapped = new Error(`AI worker returned invalid JSON for ${taskLabel}: ${error.message}`);
          wrapped.code = "AI_WORKER_INVALID_RESPONSE";
          reject(wrapped);
        }
      });
    });

    child.stdin.end(JSON.stringify({ prompt, config, maxTokens, taskLabel }));
  });
}

export function shouldRunLanguageModelDirect(env = process.env) {
  return env.WEBCLI_AI_WORKER === "1"
    || env.WEBCLI_AI_DIRECT === "1"
    || env.WEBCLI_GENERATION_WORKER === "1";
}

async function callLanguageModel(prompt, config, maxTokens, taskLabel) {
  // Generation normally injects one persistent AI session. If a fallback model
  // call reaches this global transport inside a disposable Harness worker, run
  // it directly instead of creating another Electron-as-Node grandchild.
  if (shouldRunLanguageModelDirect()) {
    return callLanguageModelDirect(prompt, config, maxTokens, taskLabel);
  }
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await runLanguageModelWorker({ prompt, config, maxTokens, taskLabel });
    } catch (error) {
      lastError = error;
      if (error?.code !== "AI_WORKER_CRASHED" || attempt >= 2) throw error;
      process.stderr.write(`[AI] Worker crashed during ${taskLabel}; retrying in a fresh process...\n`);
    }
  }
  throw lastError || new Error(`AI worker failed for ${taskLabel}`);
}

/**
 * Low-level configured model call used by the generation harness. Keeping the
 * provider-specific transport here lets the harness remain model agnostic.
 */
export async function callConfiguredLanguageModel({
  prompt,
  maxTokens,
  purpose = 'analysis',
  taskLabel = 'generation harness step',
  config = null,
} = {}) {
  const resolvedConfig = config ? normalizeAiConfig(config) : loadRequiredConfig();
  validateAiConfig(resolvedConfig, taskLabel);
  const outputLimit = resolveModelOutputLimit({ config: resolvedConfig, purpose, requested: maxTokens });
  const text = await callLanguageModel(String(prompt || ''), resolvedConfig, outputLimit, taskLabel);
  return {
    text,
    provider: resolvedConfig.provider,
    model: resolvedConfig.model,
  };
}

export async function analyzeExplorationResult({ siteKey, explorationResult, heuristicVerdict, modelConfig }) {
  const config = resolveTaskModelConfig(modelConfig);
  const prompt = buildExplorationAnalysisPrompt({ siteKey, explorationResult, heuristicVerdict });
  const { text: rawText } = await callConfiguredLanguageModel({ prompt, config,
    taskLabel: `${siteKey || "unknown-site"} exploration analysis` });
  const parsed = extractJsonFromResponse(rawText);
  const analysis = normalizeExplorationAnalysis(parsed, heuristicVerdict || {});

  return {
    ...analysis,
    analysisSource: "ai",
    model: config.model,
    provider: config.provider,
  };
}

export function resolveTaskModelConfig(modelConfig) {
  // Only an absent injection may use the standalone extension configuration.
  if (modelConfig === undefined) return loadRequiredConfig();
  if (!modelConfig || ['api_key', 'base_url', 'model'].some((key) => (
    typeof modelConfig[key] !== 'string' || !modelConfig[key].trim()
  )) || !['anthropic', 'openai'].includes(modelConfig.protocol)) {
    throw new Error('客户端模型配置不完整，请检查客户端模型设置');
  }
  const config = normalizeAiConfig(modelConfig);
  validateAiConfig(config, '客户端模型配置');
  return config;
}

export const resolveActionCaptureModelConfig = resolveTaskModelConfig;

export async function analyzeActionCaptureResult({ captureResult, modelConfig }) {
  const config = resolveActionCaptureModelConfig(modelConfig);
  const prompt = buildActionCaptureAnalysisPrompt({ captureResult });
  const { text: rawText } = await callConfiguredLanguageModel({ prompt, config,
    taskLabel: `${captureResult?.site || "unknown-site"} action capture analysis` });
  const parsed = extractJsonFromResponse(rawText);
  const analysis = normalizeActionCaptureAnalysis(parsed, captureResult || {});
  return {
    ...analysis,
    analysisSource: "ai",
    model: config.model,
    provider: config.provider,
  };
}

export async function analyzeScaffoldSemantics({ memory, modelConfig }) {
  const config = resolveTaskModelConfig(modelConfig);
  const prompt = buildScaffoldSemanticPrompt(memory || {});
  const { text: rawText } = await callConfiguredLanguageModel({ prompt, config,
    taskLabel: `${memory?.siteKey || "unknown-site"} scaffold semantic enhancement` });
  const parsed = extractJsonFromResponse(rawText);
  const analysis = normalizeScaffoldSemanticAnalysis(parsed, memory || {});
  return {
    ...analysis,
    analysisSource: "ai",
    model: config.model,
    provider: config.provider,
  };
}

export async function testAiConfig(inputConfig = {}) {
  const config = normalizeAiConfig(inputConfig || {});
  validateAiConfig(config, "测试配置");
  const startedAt = Date.now();
  const { text: rawText } = await callConfiguredLanguageModel({ prompt: '请只回复 OK', config,
    taskLabel: `${config.provider || "unknown"} connectivity test` });
  const latencyMs = Date.now() - startedAt;
  return {
    provider: config.provider,
    model: config.model,
    latencyMs,
    preview: truncateForModel(rawText, 120),
  };
}

/**
 * 调用已配置的大模型生成 adapter 代码
 * @param {{ siteKey: string, apiEntries: Array, existingCode?: string }} options
 * @returns {Promise<{ adapterCode: string, toolNames: string[] }>}
 */
export async function generateAdapterWithAI({ siteKey, apiEntries, existingCode, modelConfig }) {
  const config = resolveTaskModelConfig(modelConfig);
  const prompt = buildPrompt(siteKey, apiEntries, existingCode || null);

  process.stderr.write(
    `[AI] Generating adapter for ${siteKey} with ${apiEntries.length} API entries${existingCode ? ' (merge mode)' : ''}...\n`
  );

  const { text: rawText } = await callConfiguredLanguageModel({ prompt, config, purpose: 'adapter_generation',
    taskLabel: `${siteKey} adapter generation` });
  const adapterCode = extractCodeFromResponse(rawText);

  if (!adapterCode.includes("__webmcpRegister")) {
    throw new Error("AI 生成的代码不包含 __webmcpRegister 调用，可能生成失败");
  }

  const toolNames = [];
  const toolNameRegex = /name:\s*['"`]([^'"`]+)['"`]/g;
  let match;
  while ((match = toolNameRegex.exec(adapterCode)) !== null) {
    if (match[1].includes(".")) toolNames.push(match[1]);
  }

  process.stderr.write(
    `[AI] Generated adapter for ${siteKey}: ${toolNames.length} tools\n`
  );

  return { adapterCode, toolNames };
}

/**
 * 调用 Claude API 生成 Skill.md
 * @param {{ siteKey: string, adapterCode: string, toolNames: string[] }} options
 * @returns {Promise<string>} Skill.md 内容
 */
export async function generateSkillMd({ siteKey, adapterCode, toolNames, modelConfig }) {
  const config = resolveTaskModelConfig(modelConfig);

  const prompt = `根据以下 WebMCP adapter 代码，为网站 ${siteKey} 生成一份 SKILL.md 文档。

## Adapter 代码

\`\`\`javascript
${adapterCode.slice(0, 6000)}
\`\`\`

## 工具列表

${toolNames.map(t => `- ${t}`).join('\n')}

## SKILL.md 格式要求

生成的文档应包含：

1. **标题**：# ${siteKey} Adapter
2. **概述**：一句话描述这个 adapter 能做什么
3. **工具列表**：每个工具一个小节，包含：
   - 工具名
   - 功能描述
   - 参数说明（表格形式：参数名 | 类型 | 必填 | 描述）
   - 返回值说明
   - 使用示例（自然语言描述用户可能怎么用）
4. **使用前提**：需要登录、需要打开哪个页面等
5. **注意事项**：限制、已知问题等

用中文撰写。直接输出 markdown 内容，不要包裹在代码块中。`;

  process.stderr.write(`[AI] Generating SKILL.md for ${siteKey}...\n`);

  const { text: skillMd } = await callConfiguredLanguageModel({ prompt, config, purpose: 'adapter_generation',
    taskLabel: `${siteKey} skill generation` });
  process.stderr.write(`[AI] SKILL.md generated for ${siteKey} (${skillMd.length} chars)\n`);
  return skillMd;
}
