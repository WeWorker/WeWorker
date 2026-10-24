import { uiWriteRequest } from './ui-write.js';
import { browserContextId } from './browser-profile.js';
import { readHttpCookies } from './http-credentials.js';
import { executePageRequest, pageWriteRequest } from './page-write.js';
import { scopedGenerationPreviewScripts } from './generation-preview-bundle.js';
import { validateBackgroundPreview, backgroundPreviewRequest } from './generation-background-preview.js';
import { buildV2Bootstrap, v2CommandDefs, v2InjectionFiles } from "./v2-loader.js";
import { injectAdapterSources } from './adapter-script-loader.js';
import { createPackagedAdapterMatcher, injectPackagedAdapter } from './packaged-adapter-loader.js';
import { createHostAdapterClient } from './host-adapter-client.js';
import { createHostAdapterRuntime, assertAdapterNavigationUrl, createNavigationGuard, navigateAdapterTab, waitForAdapterPageRecovery } from './host-adapter-runtime.js';
import {
  adapterHelperPatterns,
  adapterPrimaryHost,
  createRouteRedirects,
  hostMatchesPattern,
  pickRecentScopeTab,
  pickRouteTab,
} from './host-scope.js';
import { createManagedBackgroundRuntime, MANAGED_RUNNER_PATH } from './managed-background-runtime.js';
import {
  authErrorFields,
  authRequiredError,
  cookieFingerprint,
  declaredHosts as authDeclaredHosts,
  displayUrl as authDisplayUrl,
  evaluateCookieCheck,
  isLoginPageUrl,
  loginStartUrl,
  siteAuth,
} from './site-auth.js';
import {
  browserInstanceHelloFields,
  createBrowserTab,
  focusBrowserWindow,
  loadBrowserInstance,
  revealWindowOnUserFocus,
  watchBrowserInstance,
} from './browser-instance.js';
import {
  captureTabViaDebugger,
  createToolTabTracker,
  debuggerTargetId,
  displayPageUrl,
  pickScreenshotTab,
  selectTabForScreenshot,
} from './screenshot.js';
import { executeBrowserCommand } from './browser-commands.js';
import { browserResponseEvidence } from './browser-network.js';
import { executePageSource } from './page-source.js';
import { executeInterceptRead } from './intercept-read.js';
import { executePageQuery, cancelPageWorkflow, cancelAllPageWorkflows, assertPageWorkflowActive } from './page-query.js';
import { matchesPagePath, assertPageQueryRoute } from './page-navigation.js';
import { pageRoutePaths, pageRouteTargets } from './page-workflow.js';
import { usesWorkflowOrigins, matchesOriginTarget } from './page-workflow-origins.js';
import { recordBrowserObservation, clearBrowserObservations } from './browser-observations.js';
import { recordBrowserFrameEvent, clearBrowserFrames } from './browser-frames.js';
import { recordBrowserDownload, clearBrowserDownloads } from './browser-downloads.js';
import { recordBrowserEvent, clearBrowserEvents } from './browser-events.js';

/**
 * Background Service Worker
 *
 * 职责：
 * 1. 通过 WebSocket 连接 WebCLI Bridge（ws://localhost:3711）
 * 2. 维护每个 Tab 注册的工具列表（toolRegistry）
 * 3. 处理来自 content script 的工具注册消息
 * 4. 处理来自 WebCLI 的工具调用请求，转发到对应 Tab
 * 5. 管理本地已安装 adapter，检测 Tab URL 并注入
 */

import {
  selectCompatibleCaptureBoundEntry,
  validateGenerationPreviewOutputV2,
} from './generation-output-validator.js';

const WS_URL = "ws://localhost:3711";
const EXTENSION_CAPABILITIES = [
  'adapter_catalog_v1',
  'adapter_background_v1',
  'background_preview_v1',
  'passive_exploration_v1',
  'safe_api_probe_v1',
  'api_replay_v1',
  'action_capture_v1',
  'action_capture_model_context_v1',
  'action_capture_analysis_retry_v1',
  'generation_harness_v1',
  'runtime_validation_v1',
  'browser_commands_v1',
  'browser_profiles_v1',
  'http_credentials_v1',
  'http_credentials_v2',
  'browser_frames_v1',
  'browser_downloads_v1',
  'browser_frame_pointer_v1',
  'browser_events_v1',
  'browser_accessibility_v1',
  'browser_screenshot_v1',
  'browser_shadow_query_v1',
  'browser_compound_v1',
  'browser_upload_target_v1',
  'strict_output_contract_v1',
  'page_sources_v1',
  'intercept_read_v1',
  'page_query_v1',
  'page_navigation_v1',
  'page_navigation_query_v1',
  'page_navigation_hash_v1',
  'page_workflow_v1',
  'page_workflow_control_v1',
  'page_navigation_origin_v1',
  'page_write_v1',
  'ui_write_v1',
  'ui_write_result_v1',
];

let currentBrowserContextId;
function buildExtensionHello(extra = {}) {
  return {
    type: 'extension_hello',
    contextId: currentBrowserContextId,
    version: chrome.runtime.getManifest().version,
    capabilities: EXTENSION_CAPABILITIES,
    // WeWorker 浏览器 proves itself with the token the desktop stored for it.
    ...browserInstanceHelloFields(),
    ...extra,
  };
}

// 截图配置
// 根据 Claude Code 限制：约 1MB
// 策略：等比缩放到最大尺寸内，保留完整内容
const SCREENSHOT_CONFIG = {
  maxSizeBytes: 800 * 1024,  // 最大 800KB（留有余量）
  maxWidth: 1200,             // 最大宽度
  maxHeight: 800,             // 最大高度
};

// ─── 图片裁剪工具 ────────────────────────────────────────────────────────────

/**
 * 等比缩放图片到最大尺寸内，保留完整内容
 * @param {string} dataUrl - 原始图片的 data URL
 * @returns {Promise<{data: string, originalSize: number, croppedSize: number, cropped: boolean}>}
 */
async function cropImage(dataUrl) {
  // 将 data URL 转换为 Blob
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const originalSize = blob.size;

  // 使用 createImageBitmap 创建图片
  const imageBitmap = await createImageBitmap(blob);
  const originalWidth = imageBitmap.width;
  const originalHeight = imageBitmap.height;

  // 如果图片已经足够小，直接返回
  if (originalWidth <= SCREENSHOT_CONFIG.maxWidth && originalHeight <= SCREENSHOT_CONFIG.maxHeight && originalSize <= SCREENSHOT_CONFIG.maxSizeBytes) {
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }

    return {
      data: btoa(binary),
      originalSize,
      croppedSize: originalSize,
      cropped: false,
      width: originalWidth,
      height: originalHeight
    };
  }

  // 等比缩放：计算缩放比例，保留完整内容
  const scale = Math.min(
    SCREENSHOT_CONFIG.maxWidth / originalWidth,
    SCREENSHOT_CONFIG.maxHeight / originalHeight
  );
  const targetWidth = Math.round(originalWidth * scale);
  const targetHeight = Math.round(originalHeight * scale);

  // 创建画布并缩放绘制完整图片
  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imageBitmap, 0, 0, targetWidth, targetHeight);

  // 转换为 JPEG（高质量）
  const scaledBlob = await canvas.convertToBlob({
    type: 'image/jpeg',
    quality: 0.92
  });

  // 转换为 base64
  const arrayBuffer = await scaledBlob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return {
    data: btoa(binary),
    originalSize,
    croppedSize: scaledBlob.size,
    cropped: true,
    width: targetWidth,
    height: targetHeight
  };
}

// ─── 状态 ──────────────────────────────────────────────────────────────────

/** @type {WebSocket | null} */
let ws = null;

/**
 * 工具注册表：domain -> { tools: [...], tabIds: Set<tabId> }
 * @type {Map<string, {tools: Array<{name: string, description: string, parameters: object}>, tabIds: Set<number>}>}
 */
const toolRegistry = new Map();

/**
 * 公开工具名 -> 路由信息。
 * @type {Map<string, {
 *   publicName: string,
 *   handlerName: string,
 *   adapterId: string,
 *   routeDomain: string,
 *   tabDomain?: string,
 *   excludeTabDomain?: string,
 *   allowedHosts?: string[]
 * }>}
 */
const toolRouteIndex = new Map();

/**
 * Static tool route index keyed by publicName (e.g. "wcs.ls").
 * Populated at startup from adapters/<id>/wecli.generated.json.
 * Used as a fallback when toolRouteIndex has no live entry (no tab open)
 * so that routeDomain lookup returns the real adapter hostname
 * (e.g. "tools.example.com") instead of the short prefix from
 * extractDomainFromToolName (e.g. "wcs").
 */
const staticToolRouteIndex = new Map();

/**
 * Static tool definitions keyed by publicName and handlerName.
 * Loaded from adapters/<id>/wecli.generated.json so no-tab calls can still
 * validate args before the adapter registers from a page or direct import.
 */
const staticToolDefinitionIndex = new Map();
const RUNTIME_STORAGE_CACHE_KEY = "wecli_runtime_storage_cache_v1";

/**
 * Direct adapter registry for no-tab execution. Migrated WeCLI adapters are
 * plain scripts that register handlers through window.__webmcpRegister and use
 * window.__webmcpWecliRuntime for privileged cookie/fetch helpers. In the
 * service worker we provide the same globals and execute request-only handlers
 * without requiring a content-script tab.
 */
const directToolRegistry = new Map();
const directAdapterLoadPromises = new Map();
let directToolExecutionQueue = Promise.resolve();
let directRuntimeContext = null;
let offscreenCreatePromise = null;
const OFFSCREEN_DIRECT_RUNNER_PATH = "offscreen/direct-runner.html";

globalThis.window = globalThis.window || globalThis;
globalThis.__webmcpWecliRuntime = createDirectWecliRuntime();
globalThis.__webmcpRegister = registerDirectAdapter;

/** Pending write requests: id -> { resolve, reject } */
const pendingWriteRequests = new Map();

/**
 * Tab到域名的映射：tabId -> domain
 * @type {Map<number, string>}
 */
const tabDomainMap = new Map();

/**
 * 待安装适配器表：tabId -> adapterMeta（registry 里找到但未安装的 adapter）
 * 供 popup 查询当前 tab 状态用
 * @type {Map<number, object>}
 */
const tabAvailableAdapter = new Map();

/**
 * 最近一次 adapter 注入状态：adapterId -> { ok, error, tabId, updatedAt }
 * 供 sidepanel 在“已发现适配器但无工具”时展示可诊断错误。
 * @type {Map<string, {ok: boolean, error?: string, tabId?: number, updatedAt: number}>}
 */
const adapterInjectionStatus = new Map();


const cdpAttachedTabs = new Set();
const cdpNetworkState = new Map();
const cdpActionCaptureSessions = new Map();
const adapterNetworkCaptureSessions = new Map();
const cdpExecutionContexts = new Map();
const CDP_NETWORK_ENTRY_LIMIT = 200;
const CDP_RESPONSE_PREVIEW_LIMIT = 4000;
const CDP_REQUEST_PREVIEW_LIMIT = 2000;
const ADAPTER_RESPONSE_CAPTURE_LIMIT = 8 * 1024 * 1024;
const ADAPTER_CAPTURE_ENTRY_LIMIT = 20;
const ACTION_CAPTURE_VERSION = 'opencli-action-capture-v1';

function ensureCdpState(tabId) {
  if (!cdpNetworkState.has(tabId)) {
    cdpNetworkState.set(tabId, {
      attachedAt: 0,
      entries: [],
      requests: new Map(),
      lastError: null,
      totalCaptured: 0,
    });
  }
  return cdpNetworkState.get(tabId);
}

function sanitizeNetworkEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const { captureIndex, ...rest } = entry;
  return rest;
}

function truncateText(value, limit) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : String(value);
  return text.length > limit ? `${text.slice(0, limit)}...[truncated]` : text;
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return undefined;
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    result[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

function getEntryContentType(entry) {
  return String(entry?.responseContentType || entry?.responseHeaders?.['content-type'] || '').toLowerCase();
}

function isStaticAssetEntry(entry) {
  const url = String(entry?.url || '').toLowerCase();
  const contentType = getEntryContentType(entry);
  return (
    /\.(?:css|js|mjs|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|map)(?:$|[?#])/i.test(url)
    || /^(?:text\/css|application\/javascript|text\/javascript|image\/|font\/)/.test(contentType)
  );
}

function isLikelyBusinessEntry(entry) {
  if (!entry?.url || isTelemetryLikeEntry(entry) || isStaticAssetEntry(entry)) return false;

  const url = String(entry.url || '').toLowerCase();
  const method = String(entry.method || 'GET').toUpperCase();
  const requestHeaders = JSON.stringify(entry.requestHeaders || {}).toLowerCase();
  const requestBody = String(entry.requestBodyPreview || '').toLowerCase();
  const responsePreview = String(entry.responsePreview || '');
  const contentType = getEntryContentType(entry);

  if (/\/api\/|graphql|\.json(?:$|[?#])|\.spr(?:$|[?#])/.test(url)) return true;
  if (/xmlhttprequest|application\/json/.test(requestHeaders)) return true;
  if (looksJsonPayload(responsePreview)) return true;
  if (/currentpage|pagesize|keyword|offset|limit|filtertabs|status|query|search/.test(requestBody)) return true;
  if (method !== 'GET' && /application\/json|text\/json|text\/html/.test(contentType)) return true;

  return false;
}

function formatNetworkEntries(entries, options = {}) {
  const sorted = entries.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const businessOnly = !!options.businessOnly;
  const filtered = businessOnly ? sorted.filter(entry => isLikelyBusinessEntry(entry)
    || (options.includeTelemetry === true && !isStaticAssetEntry(entry) && /json/.test(getEntryContentType(entry)))) : sorted;
  const limit = options.limit ?? null;
  const limited = typeof limit === 'number' ? filtered.slice(0, limit) : filtered;

  return {
    entries: limited.map(sanitizeNetworkEntry),
    totalEntries: sorted.length,
    returnedEntries: limited.length,
    filteredOutCount: sorted.length - filtered.length,
  };
}

function pushCdpNetworkEntry(tabId, entry) {
  const state = ensureCdpState(tabId);
  state.totalCaptured += 1;
  state.entries.push({ ...entry, captureIndex: state.totalCaptured });
  if (state.entries.length > CDP_NETWORK_ENTRY_LIMIT) {
    state.entries.splice(0, state.entries.length - CDP_NETWORK_ENTRY_LIMIT);
  }
}

function normalizeCapturePatterns(pattern) {
  if (!pattern || typeof pattern !== 'string') return [];
  return pattern
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function matchesCapturePattern(value, patterns) {
  if (!patterns?.length) return true;
  const text = String(value || '').toLowerCase();
  return patterns.some((pattern) => text.includes(String(pattern || '').toLowerCase()));
}

function isSideEffectMethod(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}

function isLikelyActionRequest(requestLike, patterns = [], { allowRead = false } = {}) {
  const url = String(requestLike?.url || '');
  const method = String(requestLike?.method || 'GET').toUpperCase();
  const requestBody = String(requestLike?.requestBodyPreview || requestLike?.postData || '');
  const probe = `${url} ${requestBody}`.toLowerCase();

  if (!matchesCapturePattern(`${url} ${requestBody}`, patterns)) return false;
  if (isTelemetryLikeEntry({ url, requestBodyPreview: requestBody }) || isStaticAssetEntry({ url })) return false;
  if (patterns.length > 0) return true;
  if (!isSideEffectMethod(method)) {
    return allowRead && /\/api\/|\.json(?:$|[?#])|\.spr(?:$|[?#])|graphql/.test(probe);
  }
  return /\/api\/|\.json(?:$|[?#])|\.spr(?:$|[?#])|graphql|book|reserve|meeting|room|submit|create|save|apply|order|calendar|appointment|booking/.test(probe)
    || requestBody.length > 0;
}

function normalizeFetchHeaders(headers) {
  if (!Array.isArray(headers)) return {};
  const result = {};
  for (const item of headers) {
    if (!item?.name) continue;
    result[String(item.name).toLowerCase()] = String(item.value ?? '');
  }
  return result;
}

function getActionCaptureEntries(tabId, baselineCaptureCount, upperBoundCaptureCount = null, patterns = [], allowRead = false) {
  return getCapturedEntriesSince(tabId, baselineCaptureCount, upperBoundCaptureCount)
    .filter((entry) => isLikelyActionRequest(entry, patterns, { allowRead }))
    .map((entry) => ({
      ...sanitizeNetworkEntry(entry),
      intercepted: false,
    }));
}

function rankActionCaptureEntries(entries, actionName = '') {
  const actionTokens = normalizeStoredActionTokens(actionName);
  const writeIntent = hasStoredWriteActionIntent(actionTokens);
  const ranked = entries.slice().sort((a, b) => {
    const score = (entry) => {
      let value = 0;
      const method = String(entry?.method || 'GET').toUpperCase();
      const probe = `${entry?.url || ''} ${entry?.requestBodyPreview || ''} ${entry?.responsePreview || ''}`.toLowerCase();
      if (isSideEffectMethod(method)) value += 20;
      if (/book|reserve|meeting|room|submit|create|save|apply|approve|agree|reject|audit|commit|complete|order|calendar|appointment|booking/.test(probe)) value += 15;
      if (entry?.requestBodyPreview) value += 8;
      if (/success|retcode|retdetail|data|error|message/.test(probe)) value += 4;
      if (writeIntent && isStoredReadLikeActionUrl(entry?.url)) value -= 18;
      for (const token of actionTokens) {
        if (token.length >= 2 && probe.includes(token)) value += 6;
      }
      return value;
    };
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return (b.timestamp || 0) - (a.timestamp || 0);
  });
  const unique = new Map();
  for (const entry of ranked) {
    const method = String(entry?.method || 'GET').toUpperCase();
    const key = `${method} ${String(entry?.url || '')} ${String(entry?.requestBodyPreview || '')}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, { ...entry });
      continue;
    }
    existing.responsePreview ||= entry?.responsePreview || '';
    existing.responseContentType ||= entry?.responseContentType || '';
    existing.responseHeaders ||= entry?.responseHeaders || {};
    existing.requestHeaders ||= entry?.requestHeaders || {};
    if (existing.status == null && entry?.status != null) existing.status = entry.status;
    existing.intercepted = Boolean(existing.intercepted || entry?.intercepted);
  }
  return [...unique.values()];
}

async function ensureCdpAttached(tabId) {
  if (cdpAttachedTabs.has(tabId)) return ensureCdpState(tabId);

  // An attachment owned by another debugger must not be reused.
  await chrome.debugger.attach({ tabId }, '1.3');

  cdpAttachedTabs.add(tabId);
  const state = ensureCdpState(tabId);
  state.attachedAt = Date.now();
  state.lastError = null;

  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
    maxTotalBufferSize: 10485760,
    maxResourceBufferSize: 524288,
    maxPostDataSize: 262144,
  });

  return state;
}

async function getCdpNetworkSnapshot(tabId, options = {}) {
  const state = await ensureCdpAttached(tabId);
  const normalized = formatNetworkEntries(state.entries, options);
  return {
    source: 'cdp',
    entries: normalized.entries,
    totalEntries: normalized.totalEntries,
    returnedEntries: normalized.returnedEntries,
    filteredOutCount: normalized.filteredOutCount,
    advice: normalized.totalEntries > 0
      ? (options.businessOnly
        ? '已提炼当前探索阶段的业务请求。'
        : '已通过 Chrome Debugger / CDP 捕获请求明细。')
      : 'CDP 已启用，但当前标签页还没有捕获到新的网络请求。请先执行搜索、翻页或进入详情后再重试。',
    attachedAt: state.attachedAt,
    lastError: state.lastError,
  };
}


async function clearCdpNetworkEntries(tabId) {
  const state = ensureCdpState(tabId);
  state.entries = [];
  state.requests.clear();
  state.totalCaptured = 0;
}

function adapterCaptureAllowsUrl(session, url) {
  try {
    const targetHost = new URL(url).hostname;
    return isRuntimeHelperHostAllowed(session.tabHost, targetHost, session.allowedHosts)
      && matchesCapturePattern(url, session.patterns);
  } catch {
    return false;
  }
}

async function startAdapterNetworkCapture(tab, payload, allowedHosts) {
  const pattern = String(payload.pattern || '').trim();
  if (!pattern || pattern.length > 256 || /[\x00-\x1f]/.test(pattern)) {
    throw createRuntimeHelperError('INVALID_ARGS', 'network_capture_start requires a pattern of at most 256 characters');
  }
  const tabHost = new URL(tab.url).hostname;
  const existing = adapterNetworkCaptureSessions.get(tab.id);
  const wasAttached = cdpAttachedTabs.has(tab.id);
  await ensureCdpAttached(tab.id);
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable', {
    maxTotalBufferSize: ADAPTER_RESPONSE_CAPTURE_LIMIT * 2,
    maxResourceBufferSize: ADAPTER_RESPONSE_CAPTURE_LIMIT,
    maxPostDataSize: 262144,
  });
  adapterNetworkCaptureSessions.set(tab.id, {
    tabHost,
    allowedHosts: normalizeRouteHosts(allowedHosts),
    patterns: normalizeCapturePatterns(pattern),
    entries: [],
    requestIds: new Set(),
    lastEventAt: Date.now(),
    ownedAttachment: existing?.ownedAttachment ?? !wasAttached,
  });
  return { started: true, pattern };
}

async function finishAdapterNetworkCapture(tabId, session) {
  adapterNetworkCaptureSessions.delete(tabId);
  if (!session?.ownedAttachment || !cdpAttachedTabs.has(tabId)) return;
  await clearCdpNetworkEntries(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch { }
  clearBrowserDebuggerState(tabId, 'Adapter capture attachment released.');
}

async function readAdapterNetworkCapture(tab, payload) {
  const session = adapterNetworkCaptureSessions.get(tab.id);
  if (!session) throw createRuntimeHelperError('CAPTURE_NOT_STARTED', 'No Adapter network capture is active for this tab');
  const waitMs = payload.waitMs === undefined ? 0 : Number(payload.waitMs);
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 20000) {
    throw createRuntimeHelperError('INVALID_ARGS', 'network_capture_read waitMs must be an integer between 0 and 20000');
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (session.entries.length > 0 && session.requestIds.size === 0 && Date.now() - session.lastEventAt >= 300) break;
    await delay(100);
  }
  const result = { entries: session.entries.slice() };
  if (payload.finish !== false) await finishAdapterNetworkCapture(tab.id, session);
  return result;
}

async function delay(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForTabLoad(tabId, timeoutMs = 15000) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.status === 'complete') return;
  } catch {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, timeoutMs);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId !== tabId) return;
      if (info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function getTabRuntimeState(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return {
      url: tab?.url || '',
      title: tab?.title || '',
      status: tab?.status || 'unknown',
    };
  } catch {
    return {
      url: '',
      title: '',
      status: 'unknown',
    };
  }
}

function hasMeaningfulPageChange(beforeState, afterState, pageSignal = null) {
  if (pageSignal?.changed) return true;
  if (!beforeState || !afterState) return false;
  if (beforeState.url && afterState.url && beforeState.url !== afterState.url) return true;
  if (beforeState.title && afterState.title && beforeState.title !== afterState.title) return true;

  const beforeInteractive = Array.isArray(beforeState.interactiveElements) ? beforeState.interactiveElements.length : 0;
  const afterInteractive = Array.isArray(afterState.interactiveElements) ? afterState.interactiveElements.length : 0;
  const beforeLists = Number(beforeState.listCandidates || 0);
  const afterLists = Number(afterState.listCandidates || 0);
  const beforeDialogs = Number(beforeState.dialogs || 0);
  const afterDialogs = Number(afterState.dialogs || 0);

  return (
    Math.abs(afterInteractive - beforeInteractive) >= 4
    || Math.abs(afterLists - beforeLists) >= 1
    || Math.abs(afterDialogs - beforeDialogs) >= 1
  );
}

function getPageStateRichnessScore(pageState) {
  if (!pageState || typeof pageState !== 'object') return 0;
  const interactive = Array.isArray(pageState.interactiveElements) ? pageState.interactiveElements.length : 0;
  const lists = Number(pageState.listCandidates || 0);
  const pagination = Number(pageState.paginationCandidates || 0);
  const dialogs = Number(pageState.dialogs || 0);
  const forms = Number(pageState.forms || 0);
  return interactive + (lists * 6) + (pagination * 8) + (dialogs * 2) + forms;
}

async function cdpEvaluate(tabId, expression) {
  await ensureCdpAttached(tabId);
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });

  if (result?.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'CDP evaluate error';
    throw new Error(errMsg);
  }

  return result?.result?.value ?? null;
}

function getCdpExecutionContextMap(tabId) {
  if (!cdpExecutionContexts.has(tabId)) cdpExecutionContexts.set(tabId, new Map());
  return cdpExecutionContexts.get(tabId);
}

async function findExtensionIsolatedWorldContext(tabId) {
  await ensureCdpAttached(tabId);
  const marker = `__webmcpPreviewContext_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: (markerName) => {
      globalThis[markerName] = true;
    },
    args: [marker],
  });
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');

  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const contexts = [...getCdpExecutionContextMap(tabId).values()];
    for (const context of contexts) {
      try {
        const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: `Boolean(globalThis[${JSON.stringify(marker)}])`,
          contextId: context.id,
          returnByValue: true,
          silent: true,
        });
        if (result?.result?.value === true) {
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: `delete globalThis[${JSON.stringify(marker)}]`,
            contextId: context.id,
            returnByValue: true,
            silent: true,
          }).catch(() => {});
          return context.id;
        }
      } catch {}
    }
    await delay(50);
  }
  throw new Error('unable to locate the extension isolated-world execution context');
}

async function injectGenerationPreviewSourcesWithCdp(tabId, scripts) {
  return injectAdapterSources({
    tabId, scripts,
    borrowedSession: cdpAttachedTabs.has(tabId),
    existingContexts: () => [...getCdpExecutionContextMap(tabId).values()],
  });
}

async function runExplorationAction(tabId, expression, waitMs = 1200) {
  const result = await cdpEvaluate(tabId, expression);
  if (waitMs > 0) await delay(waitMs);
  return result;
}

async function waitForExplorationEffects(tabId, options = {}) {
  const start = Date.now();
  const minWaitMs = options.minWaitMs ?? 900;
  const maxWaitMs = options.maxWaitMs ?? 6000;
  const idleMs = options.idleMs ?? 900;
  const pollMs = options.pollMs ?? 200;
  const baselineCaptureCount = options.baselineCaptureCount ?? ensureCdpState(tabId).totalCaptured;
  const beforeTab = options.beforeTab || await getTabRuntimeState(tabId);

  let lastEntryCount = baselineCaptureCount;
  let lastTab = beforeTab;
  let lastActivityAt = start;
  let observedNetwork = false;
  let observedTabChange = false;
  let lastTabChangeAt = null;
  const postTabChangeGraceMs = options.postTabChangeGraceMs ?? 0;

  while ((Date.now() - start) < maxWaitMs) {
    await delay(pollMs);

    const currentEntries = ensureCdpState(tabId).totalCaptured;
    const currentTab = await getTabRuntimeState(tabId);

    if (currentEntries !== lastEntryCount) {
      lastEntryCount = currentEntries;
      lastActivityAt = Date.now();
      observedNetwork = true;
    }

    if (
      currentTab.url !== lastTab.url
      || currentTab.title !== lastTab.title
      || currentTab.status !== lastTab.status
    ) {
      lastTab = currentTab;
      lastActivityAt = Date.now();
      lastTabChangeAt = lastActivityAt;
      observedTabChange = true;
    }

    if ((Date.now() - start) < minWaitMs) continue;
    if (currentTab.status && currentTab.status !== 'complete') continue;
    if (
      postTabChangeGraceMs > 0
      && observedTabChange
      && !observedNetwork
      && lastTabChangeAt
      && (Date.now() - lastTabChangeAt) < postTabChangeGraceMs
    ) {
      continue;
    }
    if ((Date.now() - lastActivityAt) >= idleMs) {
      return {
        before: beforeTab,
        after: currentTab,
        changed: beforeTab.url !== currentTab.url || beforeTab.title !== currentTab.title,
        observedNetwork,
        observedTabChange,
        waitedMs: Date.now() - start,
        timedOut: false,
      };
    }
  }

  const finalTab = await getTabRuntimeState(tabId);
  return {
    before: beforeTab,
    after: finalTab,
    changed: beforeTab.url !== finalTab.url || beforeTab.title !== finalTab.title,
    observedNetwork,
    observedTabChange,
    waitedMs: Date.now() - start,
    timedOut: true,
  };
}

async function waitForHydratedPageState(tabId, seedState, options = {}) {
  const start = Date.now();
  const minWaitMs = options.minWaitMs ?? 800;
  const maxWaitMs = options.maxWaitMs ?? 5000;
  const idleMs = options.idleMs ?? 800;
  const pollMs = options.pollMs ?? 250;
  const targetScore = options.targetScore ?? 0;
  const targetListCandidates = options.targetListCandidates ?? 0;
  const targetPaginationCandidates = options.targetPaginationCandidates ?? 0;
  const state = ensureCdpState(tabId);

  let bestState = seedState;
  let bestScore = getPageStateRichnessScore(seedState);
  let lastState = seedState;
  let lastScore = bestScore;
  let lastEntryCount = state.totalCaptured;
  let lastActivityAt = start;

  const meetsTarget = (pageState, score) => {
    if (!pageState || typeof pageState !== 'object') return false;
    if (score >= targetScore) return true;
    if (Number(pageState.listCandidates || 0) >= targetListCandidates) return true;
    if (Number(pageState.paginationCandidates || 0) >= targetPaginationCandidates) return true;
    return false;
  };

  while ((Date.now() - start) < maxWaitMs) {
    await delay(pollMs);

    const currentState = await sendExplorationMessage(tabId, { type: 'browser_state' });
    const currentScore = getPageStateRichnessScore(currentState);
    const currentEntryCount = ensureCdpState(tabId).totalCaptured;
    const scoreChanged = currentScore !== lastScore;
    const countChanged = currentEntryCount !== lastEntryCount;
    const stateChanged = hasMeaningfulPageChange(lastState, currentState);

    if (scoreChanged || countChanged || stateChanged) {
      lastActivityAt = Date.now();
      lastState = currentState;
      lastScore = currentScore;
      lastEntryCount = currentEntryCount;
    }

    if (currentScore >= bestScore) {
      bestState = currentState;
      bestScore = currentScore;
    }

    if ((Date.now() - start) < minWaitMs) continue;
    if ((Date.now() - lastActivityAt) >= idleMs && meetsTarget(bestState, bestScore)) {
      return {
        state: bestState,
        signal: {
          bestScore,
          finalScore: currentScore,
          waitedMs: Date.now() - start,
          timedOut: false,
        },
      };
    }
  }

  return {
    state: bestState,
    signal: {
      bestScore,
      finalScore: lastScore,
      waitedMs: Date.now() - start,
      timedOut: true,
    },
  };
}

async function runExplorationStep(tabId, step, expression, options = {}) {
  const state = ensureCdpState(tabId);
  const baselineCaptureCount = state.totalCaptured;
  const beforeTab = await getTabRuntimeState(tabId);
  const initialWaitMs = options.initialWaitMs ?? 250;
  const result = await runExplorationAction(tabId, expression, initialWaitMs);
  const pageSignal = await waitForExplorationEffects(tabId, {
    baselineCaptureCount,
    beforeTab,
    minWaitMs: options.minWaitMs,
    maxWaitMs: options.maxWaitMs,
    idleMs: options.idleMs,
    pollMs: options.pollMs,
    postTabChangeGraceMs: options.postTabChangeGraceMs,
  });
  const deltaEntries = ensureCdpState(tabId).entries.filter((entry) => Number(entry.captureIndex || 0) > baselineCaptureCount);
  const networkDelta = buildActionNetworkDelta(step, deltaEntries);
  return {
    step,
    result,
    networkDelta,
    pageSignal,
    captureBaselineCount: baselineCaptureCount,
    captureSettledCount: ensureCdpState(tabId).totalCaptured,
  };
}

function extractActivePaginationPage(pageState) {
  const items = Array.isArray(pageState?.interactiveElements) ? pageState.interactiveElements : [];
  for (const item of items) {
    const text = String(item?.text || '').trim();
    const selector = String(item?.selector || '');
    if (!/^\d{1,4}$/.test(text)) continue;
    if (/active|current|selected|pwactive/i.test(selector)) {
      return Number(text);
    }
  }
  return null;
}

function hasTargetPageRequest(entries, targetPage) {
  if (!Number.isFinite(targetPage) || targetPage <= 1) return false;
  return (entries || []).some((entry) => {
    const probe = `${entry?.url || ''} ${entry?.requestBodyPreview || ''} ${entry?.responsePreview || ''}`.toLowerCase();
    return (
      probe.includes(`currentpage=${targetPage}`) ||
      probe.includes(`"currentpage":${targetPage}`) ||
      probe.includes(`currentpage\\":${targetPage}`) ||
      probe.includes(`page=${targetPage}`) ||
      probe.includes(`"page":${targetPage}`)
    );
  });
}

function collectWorkflowNetworkEntries(...collections) {
  const entries = [];
  const seen = new Set();

  for (const collection of collections) {
    for (const entry of collection || []) {
      const key = [
        entry?.method || '',
        entry?.url || '',
        entry?.timestamp || '',
        entry?.requestBodyPreview || '',
      ].join('|');
      if (!entry?.url || seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }

  return entries;
}

function isExplorationNoiseProbe(probe) {
  return /globalsearch\.html|static\/tpls|systemmanage\/getsysvaluebykey|getmappinguser|getenv|menu\/getmenus|gettotalitems|horn_info|contact_users|append_keyword|is_new_transfer/.test(probe || '');
}

function isReusableListApiEntry(entry) {
  const probe = `${entry?.url || ''} ${entry?.requestBodyPreview || ''} ${entry?.responsePreview || ''}`.toLowerCase();
  if (isExplorationNoiseProbe(probe)) {
    return false;
  }

  const hasCanonicalListEndpoint = /getcilist|getcigroup/.test(probe);
  const hasListEndpointShape = /(?:\/|^)(?:get[a-z0-9]*list|list|search|query)(?:\.spr|\b)/.test(probe);
  const hasRequestSignals = /currentpage|pagesize|offset|limit|page(size|num|count)?|keyword|query|search|filter|history=/.test(probe);
  const hasResponseSignals = /totalcount|totalpage|maxresult|firstresult|records|rows|\"data\":\s*\[|\"data\":\s*\{/.test(probe);
  const hasRowSignals = /detailurl|title|name|securitytitle|requesttitle|eventtitle|problemtitle|changetitle|ci(group|list)/.test(probe);
  const score = getReusableApiCandidateScore(entry);

  if (hasCanonicalListEndpoint) {
    return score >= 18 && (hasRequestSignals || hasResponseSignals || hasRowSignals);
  }

  if (!hasListEndpointShape) return false;
  if (!(hasRequestSignals && (hasResponseSignals || hasRowSignals))) return false;
  return score >= 18;
}

function hasReusableListApiCandidate(entries) {
  return (entries || []).some(isReusableListApiEntry);
}

function extractDetailUrlCandidatesFromNetworkEntries(entries, limit = 5) {
  const seen = new Set();
  const results = [];
  const patterns = [
    /https?:\/\/[^"'\\\s]+?(?:detail|requestdetail|eventdetail|changedetail|problemdetail|securitydetail)[^"'\\\s]*/gi,
    /\/itsm\/[^"'\\\s#]*?(?:detail|requestdetail|eventdetail|changedetail|problemdetail|securitydetail)[^"'\\\s]*/gi,
    /#\/(?:requestDetail|eventDetail|changeDetail|problemDetail|securityDetail)\/\d+/gi,
  ];

  for (const entry of entries || []) {
    const source = `${entry?.responsePreview || ''} ${entry?.requestBodyPreview || ''}`;
    if (!source) continue;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match = null;
      while ((match = pattern.exec(source))) {
        const value = String(match[0] || '').trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        results.push(value);
        if (results.length >= limit) return results;
      }
    }
  }

  return results;
}

function getCapturedEntriesSince(tabId, baselineCaptureCount, upperBoundCaptureCount = null) {
  return ensureCdpState(tabId).entries.filter((entry) => {
    const captureIndex = Number(entry?.captureIndex || 0);
    if (!(captureIndex > baselineCaptureCount)) return false;
    if (Number.isFinite(upperBoundCaptureCount)) return captureIndex <= upperBoundCaptureCount;
    return true;
  });
}

function refreshActionNetworkDelta(tabId, action, upperBoundCaptureCount = null) {
  if (!action || !Number.isFinite(Number(action.captureBaselineCount || 0))) return action;
  const finalUpperBound = Number.isFinite(upperBoundCaptureCount)
    ? upperBoundCaptureCount
    : ensureCdpState(tabId).totalCaptured;
  const entries = getCapturedEntriesSince(tabId, Number(action.captureBaselineCount || 0), finalUpperBound);
  action.captureSettledCount = finalUpperBound;
  action.networkDelta = buildActionNetworkDelta(action.step, entries);
  return action;
}

async function verifyPaginationProgress(tabId, beforePageState, paginationAction) {
  const afterPageState = await sendExplorationMessage(tabId, { type: 'browser_state' });
  const rawResult = paginationAction?.result || {};
  const targetPage = Number(rawResult?.targetPage || 0) || null;
  const activePageBefore = Number(rawResult?.activePageBefore || 0) || extractActivePaginationPage(beforePageState);
  const activePageAfter = extractActivePaginationPage(afterPageState);
  const evidence = [];

  if (Number.isFinite(targetPage) && targetPage > 0 && activePageAfter === targetPage) {
    evidence.push('active_page_matches_target');
  }
  if (hasTargetPageRequest(paginationAction?.networkDelta?.entries || [], targetPage)) {
    evidence.push('network_delta_contains_target_page');
  }
  if (
    paginationAction?.pageSignal?.changed &&
    Number.isFinite(activePageBefore) &&
    Number.isFinite(activePageAfter) &&
    activePageAfter !== activePageBefore
  ) {
    evidence.push('page_signal_and_active_page_changed');
  }

  const confirmed = evidence.length > 0;
  const result = {
    ...rawResult,
    targetPage,
    activePageBefore,
    activePageAfter,
    verified: confirmed,
    verification: {
      confirmed,
      evidence,
    },
  };

  if (rawResult?.executed && !confirmed) {
    result.reason = 'next-page-not-confirmed';
  }

  return { result, afterPageState };
}

async function runExploreWorkflow({ tabId = null, url = null, includeTelemetry = false } = {}) {
  let targetTabId = tabId;
  let opened = null;

  if (!targetTabId && url) {
    const created = await createBrowserTab({ url: 'about:blank', active: true });
    targetTabId = created?.id ?? null;
    opened = { tabId: targetTabId, url };
  }

  if (!targetTabId) {
    targetTabId = await getExplorationTabId(null);
  }
  if (!targetTabId) throw new Error('未找到可用于探索的标签页');

  await ensureCdpAttached(targetTabId);
  await clearCdpNetworkEntries(targetTabId);

  if (url) {
    await chrome.tabs.update(targetTabId, { url, active: true });
    await waitForTabLoad(targetTabId, 15000);
    await delay(1500);
  } else {
    // Passive exploration always starts from a clean page load. It never
    // writes form values, clicks search/pagination, or navigates into details.
    await chrome.tabs.reload(targetTabId);
    await waitForTabLoad(targetTabId, 15000);
    await delay(1500);
  }

  const pageStateBefore = await sendExplorationMessage(targetTabId, { type: 'browser_state' });
  const initialNetwork = await getCdpNetworkSnapshot(targetTabId, { businessOnly: true, includeTelemetry, limit: 60 });
  const hydrated = await waitForHydratedPageState(targetTabId, pageStateBefore, {
    minWaitMs: 1200,
    maxWaitMs: 8000,
    idleMs: 1200,
    pollMs: 250,
    // Passive capture waits for network/DOM activity to become idle; it does
    // not require the page to expose a recognizable list or pager.
    targetScore: 0,
    targetListCandidates: 0,
    targetPaginationCandidates: 0,
  });
  const resultPageState = hydrated.state || pageStateBefore;
  const pageStateAfter = await sendExplorationMessage(targetTabId, { type: 'browser_state' });
  const network = await getCdpNetworkSnapshot(targetTabId, { businessOnly: true, includeTelemetry, limit: 100 });
  const verdictEntries = collectWorkflowNetworkEntries(initialNetwork?.entries, network?.entries);
  const verdict = classifySitePattern(pageStateAfter, verdictEntries);

  return {
    tabId: targetTabId,
    opened,
    pageStateBefore,
    resultPageState,
    pageStateAfter,
    actions: [],
    initialNetwork,
    network,
    verdict,
    pageTransition: {
      mode: 'passive',
      changed: hasMeaningfulPageChange(pageStateBefore, pageStateAfter),
      before: {
        url: pageStateBefore?.url || '',
        title: pageStateBefore?.title || '',
      },
      after: {
        url: pageStateAfter?.url || '',
        title: pageStateAfter?.title || '',
      },
      signal: null,
      refineSignal: null,
      resultPageSignal: hydrated.signal || null,
    },
    workflow: {
      version: 'opencli-like-v13',
      mode: 'passive_network_capture',
      strategy: 'open_page -> attach_cdp -> reload -> wait_for_hydration -> capture_fetch_xhr -> classify_without_dom_mutation',
      executionEngine: 'chrome.debugger.Network',
    },
  };
}

async function inspectSafeApiActions(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('A valid tabId is required');
  await ensureCdpAttached(tabId);
  const result = await sendExplorationMessage(tabId, { type: 'exploration_safe_actions' });
  return {
    tabId,
    ...(result && typeof result === 'object' ? result : { candidates: [] }),
    workflow: {
      version: 'safe-api-probe-v1',
      scope: 'network_delta_only',
    },
  };
}

async function runSafeApiProbe({ tabId, candidateId, value = '' }) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('A valid tabId is required');
  if (!candidateId || typeof candidateId !== 'string') throw new Error('candidateId required');
  const state = await ensureCdpAttached(tabId);
  const baselineCaptureCount = state.totalCaptured;
  const beforeTab = await getTabRuntimeState(tabId);
  const pageStateBefore = await sendExplorationMessage(tabId, { type: 'browser_state' });
  const actionResult = await sendExplorationMessage(tabId, {
    type: 'exploration_safe_probe',
    candidateId,
    value: String(value || '').slice(0, 80),
  });
  const pageSignal = await waitForExplorationEffects(tabId, {
    baselineCaptureCount,
    beforeTab,
    minWaitMs: 700,
    maxWaitMs: 8000,
    idleMs: 1000,
    pollMs: 200,
    postTabChangeGraceMs: 1200,
  });
  const pageStateAfter = await sendExplorationMessage(tabId, { type: 'browser_state' });
  const deltaEntries = getCapturedEntriesSince(tabId, baselineCaptureCount);
  const step = `safe_${String(actionResult?.kind || 'read_action')}`;
  return {
    tabId,
    step,
    result: actionResult,
    networkDelta: buildActionNetworkDelta(step, deltaEntries),
    pageStateBefore,
    pageStateAfter,
    pageSignal,
    workflow: {
      version: 'safe-api-probe-v1',
      scope: 'network_delta_only',
      writeActionsBlocked: true,
    },
  };
}

function sanitizeExplorationReplayHeaders(headers = {}) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = String(name || '').toLowerCase();
    if (!name
      || /authorization|cookie|credential|password|secret|session|ticket|token|csrf|xsrf/.test(lower)
      || /^(?:connection|content-length|host|origin|referer|sec-|proxy-)/.test(lower)) continue;
    const normalized = String(value ?? '');
    if (!normalized || normalized.includes('[redacted]')) continue;
    result[name] = normalized.slice(0, 2000);
  }
  if (!Object.keys(result).some((name) => name.toLowerCase() === 'accept')) result.Accept = 'application/json, text/plain;q=0.9';
  return result;
}

async function runExplorationCandidateReplay({ tabId, url, method = 'GET', headers = {}, body = '' }) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('A valid tabId is required');
  const normalizedMethod = String(method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'POST'].includes(normalizedMethod)) throw new Error('API_REPLAY_METHOD_NOT_ALLOWED');
  let parsedUrl;
  try { parsedUrl = new URL(String(url || '')); } catch { throw new Error('API_REPLAY_URL_NOT_ALLOWED'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('API_REPLAY_URL_NOT_ALLOWED');

  const state = await ensureCdpAttached(tabId);
  const captured = state.entries.some((entry) => String(entry?.url || '') === parsedUrl.toString()
    && String(entry?.method || 'GET').toUpperCase() === normalizedMethod);
  if (!captured) throw new Error('API_REPLAY_REQUIRES_CAPTURED_REQUEST');
  const probe = `${parsedUrl.pathname} ${parsedUrl.search} ${String(body || '')}`;
  if (/(?:^|[^a-z0-9])(approve|book|buy|cancel|commit|create|delete|edit|finish|mutation|pay|publish|reject|reserve|save|submit|update|upload)(?:$|[^a-z0-9])/i.test(probe)) {
    throw new Error('API_REPLAY_WRITE_SIGNAL_BLOCKED');
  }
  if (normalizedMethod === 'POST' && !/detail|filter|get|list|page|query|read|search|sort|status/i.test(probe)) {
    throw new Error('API_REPLAY_POST_READ_SIGNAL_REQUIRED');
  }

  const request = {
    url: parsedUrl.toString(),
    method: normalizedMethod,
    headers: sanitizeExplorationReplayHeaders(headers),
    body: ['GET', 'HEAD'].includes(normalizedMethod) ? undefined : String(body || '').slice(0, 4000),
    // Article feeds often exceed 16 KiB. Keep a hard bound while allowing
    // complete JSON to reach the structural evidence parser.
    maxBytes: 1024 * 1024,
  };
  const startedAt = Date.now();
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [request],
    func: async (input) => {
      try {
        const response = await fetch(input.url, {
          method: input.method,
          credentials: 'include',
          headers: input.headers || {},
          ...(input.body === undefined ? {} : { body: input.body }),
          redirect: 'manual',
        });
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let size = 0;
        let text = '';
        let truncated = false;
        if (reader) {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            const remaining = input.maxBytes - size;
            const chunk = next.value.slice(0, remaining);
            size += chunk.byteLength;
            text += decoder.decode(chunk, { stream: true });
            if (chunk.byteLength < next.value.byteLength) {
              truncated = true;
              break;
            }
          }
          text += decoder.decode();
          await reader.cancel().catch(() => {});
        }
        return {
          status: response.status,
          ok: response.ok,
          contentType: response.headers.get('content-type') || '',
          responsePreview: truncated ? `${text}...[truncated]` : text,
          truncated,
        };
      } catch (error) {
        return { error: error?.message || String(error) };
      }
    },
  });
  if (result?.error) {
    return { transport: 'browser_page', status: null, ok: false, contentType: '', responsePreview: '', durationMs: Date.now() - startedAt, errorCode: 'NETWORK' };
  }
  return {
    transport: 'browser_page',
    status: Number(result?.status || 0),
    ok: Boolean(result?.ok),
    contentType: String(result?.contentType || ''),
    responsePreview: String(result?.responsePreview || ''),
    durationMs: Date.now() - startedAt,
    errorCode: result?.truncated ? 'RESPONSE_TOO_LARGE' : '',
  };
}

// Kept temporarily as an implementation reference for explicit/manual probe
// design. The public exploration entry no longer calls this active workflow.
async function runLegacyActiveExploreWorkflow({ tabId = null, url = null } = {}) {
  let targetTabId = tabId;
  let opened = null;

  if (!targetTabId && url) {
    const created = await createBrowserTab({ url: 'about:blank', active: true });
    targetTabId = created?.id ?? null;
    opened = { tabId: targetTabId, url };
  }

  if (!targetTabId) {
    targetTabId = await getExplorationTabId(null);
  }
  if (!targetTabId) throw new Error('未找到可用于探索的标签页');

  await ensureCdpAttached(targetTabId);
  await clearCdpNetworkEntries(targetTabId);

  if (url) {
    await chrome.tabs.update(targetTabId, { url, active: true });
    await waitForTabLoad(targetTabId, 15000);
    await delay(1500);
  } else {
    // Reload the page to capture all initial network requests from scratch
    await chrome.tabs.reload(targetTabId);
    await waitForTabLoad(targetTabId, 15000);
    await delay(1500);
  }

  const pageStateBefore = await sendExplorationMessage(targetTabId, { type: 'browser_state' });
  await delay(1200);
  const initialNetwork = await getCdpNetworkSnapshot(targetTabId, { businessOnly: true, limit: 40 });

  const actions = [];
  const searchAction = await runExplorationStep(targetTabId, 'search', `(() => {
    const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
    };
    const isDisabled = (el) => !!(el.disabled || el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true');
    const keywordPattern = /搜索|查询|关键字|关键词|keyword|search|id|标题/i;
    const triggerPattern = /搜索|查询|查找|筛选|Search/i;
    const rejectPattern = /重置|清空|导出|下载|新增|新建|创建|排序|刷新|切换/i;
    const inputs = Array.from(document.querySelectorAll('input, textarea')).filter((el) => {
      if (!isVisible(el) || isDisabled(el)) return false;
      const probe = [el.placeholder || '', el.getAttribute('aria-label') || '', el.name || '', el.id || '', el.className || ''].join(' ');
      return keywordPattern.test(probe);
    });
    if (!inputs.length) return { executed: false, reason: 'search-input-not-found' };

    const input = inputs.sort((a, b) => {
      const sa = ((a.placeholder || '').length ? 3 : 0) + (/标题|keyword|search/i.test(a.placeholder || '') ? 2 : 0);
      const sb = ((b.placeholder || '').length ? 3 : 0) + (/标题|keyword|search/i.test(b.placeholder || '') ? 2 : 0);
      return sb - sa;
	    })[0];
	    input.focus();
	    const seed = String(input.value || '').trim();
	    if (!seed) {
	      return {
	        executed: false,
	        reason: 'search-input-empty-skip',
	        message: '探索不会自动填入测试关键词；如需探索搜索结果，请先在页面输入关键词后再点击探索。',
	      };
	    }
	    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement?.prototype || {}, 'value')?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(input, seed);
    } else {
      input.value = seed;
    }
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: seed,
      inputType: 'insertText',
    }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const inputRect = input.getBoundingClientRect();

    const containers = [];
    const preferredRoots = [
      input.closest('form'),
      input.closest('.el-form'),
      input.closest('.toolbar'),
      input.closest('.search'),
      input.closest('.filter'),
      input.closest('.header'),
    ].filter(Boolean);
    containers.push(...preferredRoots);
    let parent = input.parentElement;
    for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
      containers.push(parent);
    }

    const seen = new Set();
    const buttons = [];
    for (const container of containers) {
      if (!container || seen.has(container)) continue;
      seen.add(container);
      const found = Array.from(container.querySelectorAll('button, a, [role="button"], .btn, .el-button, .el-input-group__append, .el-input-group__suffix'));
      buttons.push(...found);
    }

    const scored = buttons.map((button) => {
      if (!isVisible(button) || isDisabled(button)) return null;
      const text = textOf(button);
      const meta = [text, button.getAttribute('aria-label') || '', button.getAttribute('title') || '', button.className || ''].join(' ');
      if (rejectPattern.test(meta)) return null;
      let score = 0;
      if (triggerPattern.test(meta)) score += 10;
      if (/icon-search|search/i.test(button.className || '')) score += 6;
      if (button.closest('form') && input.closest('form') && button.closest('form') === input.closest('form')) score += 5;
      if (button.parentElement === input.parentElement) score += 4;
      const rect = button.getBoundingClientRect();
      const distance = Math.abs(rect.top - inputRect.top) + Math.abs(rect.left - inputRect.right);
      if (distance < 240) score += 4;
      if (rect.left >= inputRect.left - 24 && rect.top >= inputRect.top - 40 && rect.top <= inputRect.bottom + 40) score += 3;
      if (text && text.length > 12) score -= 3;
      if (!text && !/icon-search|search/i.test(meta)) score -= 4;
      return { button, text, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best && best.score >= 6) {
      best.button.click();
      return { executed: true, action: 'search_click', text: best.text, score: best.score };
    }

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    return { executed: true, action: 'search_enter', text: input.placeholder || input.name || '', value: seed };
  })()`, {
    minWaitMs: 1200,
    maxWaitMs: 9000,
    idleMs: 1200,
    pollMs: 200,
    postTabChangeGraceMs: 2600,
  });
  actions.push(searchAction);

  let resultPageState = pageStateBefore;
  let resultPageSignal = null;
  if (searchAction?.result?.executed) {
    await delay(400);
    const initialResultPageState = await sendExplorationMessage(targetTabId, { type: 'browser_state' });
    const hydratedResult = await waitForHydratedPageState(targetTabId, initialResultPageState, {
      minWaitMs: 1200,
      maxWaitMs: 7000,
      idleMs: 900,
      pollMs: 250,
      targetScore: 40,
      targetListCandidates: 3,
      targetPaginationCandidates: 2,
    });
    resultPageState = hydratedResult.state;
    resultPageSignal = hydratedResult.signal;
    refreshActionNetworkDelta(targetTabId, searchAction);
  }

  const refineSearchAction = await runExplorationStep(targetTabId, 'refine_search', `(() => {
    const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
    };
    const isDisabled = (el) => !!(el.disabled || el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true');
    const getSeed = () => {
      try {
        const params = new URLSearchParams(window.location.hash.split('?')[1] || window.location.search.slice(1));
        const keyword = params.get('keyword') || params.get('q') || params.get('query') || params.get('search');
	        if (keyword) return keyword;
	      } catch {}
	      const filled = Array.from(document.querySelectorAll('input, textarea')).map((el) => String(el.value || '').trim()).find(Boolean);
	      return filled || '';
	    };
    const keywordPattern = /搜索|查询|关键字|关键词|keyword|search|query|标题|title|id/i;
    const inputs = Array.from(document.querySelectorAll('input, textarea')).filter((el) => {
      if (!isVisible(el) || isDisabled(el)) return false;
      const probe = [el.placeholder || '', el.getAttribute('aria-label') || '', el.name || '', el.id || '', el.className || ''].join(' ');
      return keywordPattern.test(probe);
    }).sort((a, b) => {
      const score = (el) => {
        const probe = [el.placeholder || '', el.name || '', el.id || '', el.className || '', el.closest('form, .search, [class*="search"], [class*="filter"]')?.className || ''].join(' ');
        let value = 0;
        if (/keyword|search|query|关键字|标题|id/i.test(probe)) value += 8;
        if (/search-keyword|searchinput|form-control/i.test(probe)) value += 6;
        if (el.closest('form, .search, [class*="search"], [class*="filter"]')) value += 4;
        return value;
      };
      return score(b) - score(a);
    });
    const input = inputs[0];
    if (!input) return { executed: false, reason: 'result-search-input-not-found' };

	    const seed = getSeed();
	    if (!seed) {
	      return {
	        executed: false,
	        reason: 'refine-search-empty-skip',
	        message: '探索不会自动填入测试关键词；如需探索搜索结果，请先在页面输入关键词后再点击探索。',
	      };
	    }
	    input.focus();
    const setter = input instanceof HTMLTextAreaElement
      ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement?.prototype || {}, 'value')?.set
      : Object.getOwnPropertyDescriptor(window.HTMLInputElement?.prototype || {}, 'value')?.set;
    if (setter) {
      setter.call(input, seed);
    } else {
      input.value = seed;
    }
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: seed, inputType: 'insertText' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const inputRect = input.getBoundingClientRect();
    const roots = [
      input.closest('form'),
      input.closest('.search'),
      input.closest('[class*="search"]'),
      input.closest('[class*="filter"]'),
      input.parentElement,
      input.parentElement?.parentElement,
      document.body,
    ].filter(Boolean);
    const seenRoots = new Set();
    const buttons = [];
    for (const root of roots) {
      if (!root || seenRoots.has(root)) continue;
      seenRoots.add(root);
      buttons.push(...Array.from(root.querySelectorAll('button, a, [role="button"], .btn, .input-group, [class*="search"], [global-search-click]')));
    }

    const scored = buttons.map((button) => {
      if (!isVisible(button) || isDisabled(button) || button === input || button.contains(input)) return null;
      const text = textOf(button);
      const meta = [text, button.getAttribute('aria-label') || '', button.getAttribute('title') || '', button.className || '', button.getAttribute('global-search-click') || ''].join(' ');
      if (/重置|清空|导出|下载|新增|新建|创建|排序|刷新|切换|返回/i.test(meta)) return null;
      let score = 0;
      if (/搜索|查询|查找|筛选|search|query/i.test(meta)) score += 10;
      if (/glyphicon-search|icon-search|search-servlist|search/i.test(meta)) score += 8;
      if (button.closest('form') && input.closest('form') && button.closest('form') === input.closest('form')) score += 5;
      const rect = button.getBoundingClientRect();
      const distance = Math.abs(rect.top - inputRect.top) + Math.abs(rect.left - inputRect.right);
      if (distance < 260) score += 5;
      if (rect.top >= inputRect.top - 48 && rect.top <= inputRect.bottom + 48) score += 3;
      if (text && text.length > 16) score -= 4;
      return { button, text, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best && best.score >= 7) {
      best.button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      best.button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      best.button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      best.button.click();
      return { executed: true, action: 'refine_search_click', text: best.text, value: seed, score: best.score };
    }

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    return { executed: true, action: 'refine_search_enter', text: input.placeholder || input.name || '', value: seed };
  })()`, {
    minWaitMs: 1400,
    maxWaitMs: 8000,
    idleMs: 1100,
    pollMs: 200,
    postTabChangeGraceMs: 1800,
  });
  if (refineSearchAction?.result?.executed) {
    actions.push(refineSearchAction);
    await delay(400);
    const refinedPageState = await sendExplorationMessage(targetTabId, { type: 'browser_state' });
    const refinedHydratedResult = await waitForHydratedPageState(targetTabId, refinedPageState, {
      minWaitMs: 1000,
      maxWaitMs: 6000,
      idleMs: 900,
      pollMs: 250,
      targetScore: 40,
      targetListCandidates: 3,
      targetPaginationCandidates: 2,
    });
    resultPageState = refinedHydratedResult.state;
    resultPageSignal = refinedHydratedResult.signal;
    refreshActionNetworkDelta(targetTabId, refineSearchAction);
  } else {
    actions.push(refineSearchAction);
  }

  const searchTransition = {
    changed: hasMeaningfulPageChange(pageStateBefore, resultPageState, searchAction?.pageSignal),
    before: {
      url: pageStateBefore?.url || searchAction?.pageSignal?.before?.url || '',
      title: pageStateBefore?.title || searchAction?.pageSignal?.before?.title || '',
    },
    after: {
      url: resultPageState?.url || searchAction?.pageSignal?.after?.url || '',
      title: resultPageState?.title || searchAction?.pageSignal?.after?.title || '',
    },
    signal: searchAction?.pageSignal || null,
    refineSignal: refineSearchAction?.pageSignal || null,
    resultPageSignal,
  };

  const paginationAction = await runExplorationStep(targetTabId, 'pagination', `(() => {
    const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
    };
    const isDisabled = (el) => !!(el.disabled || el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true' || /disabled|is-disabled/.test(el.className || ''));
    const roots = Array.from(document.querySelectorAll('.el-pagination, .pagination, [class*="pagination"], [class*="pager"], #paging, nav[aria-label*="page" i], [aria-label*="pagination" i]'));
    const pools = roots.length ? roots : [document.body];
    const activateNode = (node) => {
      if (!node) return { mode: 'none' };
      const target = node.matches('a, button, [role="button"]') ? node : (node.querySelector('a, button, [role="button"]') || node);
      const href = target?.getAttribute?.('href') || '';
      if (target?.tagName === 'A' && href && href !== '#' && !/^javascript:/i.test(href)) {
        window.location.href = href;
        return { mode: 'navigate_href', href };
      }
      const interactiveAncestors = [target, target.closest('li'), target.closest('[role="button"]')].filter(Boolean);
      const seen = new Set();
      for (const current of interactiveAncestors) {
        if (seen.has(current)) continue;
        seen.add(current);
        for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
          current.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      }
      if (typeof target.click === 'function') target.click();
      return { mode: 'dispatch_click' };
    };

    const findNumericNext = (root) => {
      const items = Array.from(root.querySelectorAll('a, button, [role="button"], li')).map((node) => node.matches('li') ? (node.querySelector('a, button, [role="button"]') || node) : node).filter((node) => {
        if (!isVisible(node) || isDisabled(node)) return false;
        return /^\\d{1,4}$/.test(textOf(node));
      });
      const scoredItems = items.map((node) => ({
        node,
        page: Number(textOf(node)),
        active: /active|current|selected|pwactive/i.test([node.className || '', node.getAttribute('aria-current') || '', node.parentElement?.className || ''].join(' ')),
      })).filter((item) => Number.isFinite(item.page));
      const active = scoredItems.find((item) => item.active) || scoredItems[0];
      if (!active) return null;
      const next = scoredItems.filter((item) => item.page > active.page).sort((a, b) => a.page - b.page)[0];
      return next ? {
        node: next.node,
        text: textOf(next.node),
        score: 11,
        mode: 'numeric',
        targetPage: next.page,
        activePageBefore: active.page,
      } : null;
    };

    for (const root of pools) {
      const numericNext = findNumericNext(root);
      if (numericNext) {
        const activation = activateNode(numericNext.node);
        return {
          executed: true,
          action: 'next_page_numeric',
          text: numericNext.text,
          score: numericNext.score,
          targetPage: numericNext.targetPage,
          activePageBefore: numericNext.activePageBefore,
          ...activation,
        };
      }
    }

    const candidates = [];
    for (const root of pools) {
      const nodes = Array.from(root.querySelectorAll('button, a, [role="button"], li, .btn-next, .page-next, .el-pager li'));
      candidates.push(...nodes.map((node) => {
        const target = node.matches('li') ? (node.querySelector('a, button, [role="button"]') || node) : node;
        return { node, target };
      }));
    }

    const scored = candidates.map(({ node, target }) => {
      if (!isVisible(target) || isDisabled(target)) return null;
      const text = textOf(target) || textOf(node);
      const childProbe = Array.from(node.querySelectorAll('a, button, span')).slice(0, 4).map(textOf).join(' ');
      const meta = [
        text,
        target.getAttribute('aria-label') || '',
        target.getAttribute('title') || '',
        target.getAttribute('rel') || '',
        target.className || '',
        node.className || '',
        childProbe,
      ].join(' ');
      let score = 0;
      if (/下一页|下一頁|next/i.test(meta)) score += 10;
      if (/arrow-right|chevron-right|btn-next|page-next|next/.test(meta)) score += 6;
      if (target.closest('.el-pagination, .pagination, [class*="pagination"], [class*="pager"], #paging')) score += 4;
      if (/^\>|\u203a|\u00bb$/.test(text)) score += 3;
      if (/上一页|上一頁|prev|previous/i.test(meta)) score -= 8;
      if (/首页|末页|尾页|第一页/.test(meta)) score -= 4;
      return { node: target, text, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < 6) return { executed: false, reason: 'next-page-not-found' };
    const activation = activateNode(best.node);
    return { executed: true, action: 'next_page', text: best.text, score: best.score, ...activation };
  })()`, {
    minWaitMs: 1000,
    maxWaitMs: 5000,
    idleMs: 900,
    pollMs: 200,
  });
  if (paginationAction?.result?.executed) {
    const verifiedPagination = await verifyPaginationProgress(targetTabId, resultPageState, paginationAction);
    paginationAction.result = verifiedPagination.result;
    refreshActionNetworkDelta(targetTabId, paginationAction);
  }
  actions.push(paginationAction);

  const preDetailNetworkEntries = collectWorkflowNetworkEntries(actions.flatMap((action) => action?.networkDelta?.entries || []));
  let detailAction = null;
  if (hasReusableListApiCandidate(preDetailNetworkEntries)) {
    const networkDetailCandidates = extractDetailUrlCandidatesFromNetworkEntries(preDetailNetworkEntries, 5);
    const detailInspection = await cdpEvaluate(targetTabId, `(() => {
    const textOf = (el) => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
    };
    const isDisabled = (el) => !!(el.disabled || el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true');
    const genericRejectText = /^(home|index|dashboard|workspace|menu|more)$/i;
    const roots = Array.from(document.querySelectorAll('table, tbody, .el-table__body, .el-table__body-wrapper, .list, .table, [class*="table"], [class*="list"], [class*="result"], [class*="search"]'));
    const rankedRoots = roots.map((root) => {
      const rows = root.querySelectorAll('tr, li, [role="row"], .el-table__row');
      const linkedRows = Array.from(rows).filter((row) => row.querySelector('a, button, [role="button"]')).length;
      const score = rows.length * 3 + linkedRows * 4 + (root.matches('table, tbody, .el-table__body, .el-table__body-wrapper') ? 8 : 0);
      return { root, score };
    }).sort((a, b) => b.score - a.score);
    const poolRoots = rankedRoots.length ? rankedRoots.slice(0, 4).map((item) => item.root) : [document.body];
    const candidates = [];
    for (const root of poolRoots) {
      const rows = Array.from(root.querySelectorAll('tr, li, [role="row"], .el-table__row'));
      if (rows.length) {
        for (const row of rows.slice(0, 12)) {
          const rowNodes = Array.from(row.querySelectorAll('a, button, [role="button"]'));
          candidates.push(...rowNodes);
        }
      } else {
        const nodes = Array.from(root.querySelectorAll('a, button, [role="button"]'));
        candidates.push(...nodes);
      }
    }

    const scored = candidates.map((node) => {
      if (!isVisible(node) || isDisabled(node)) return null;
      if (node.closest('nav, header, aside, .menu, .sidebar, .breadcrumb, [role="navigation"], [role="tablist"], .tabs, .toolbar')) return null;
      const text = textOf(node);
      const href = node.getAttribute('href') || '';
      const isDetailHref = /detail|requestdetail|eventdetail|changedetail|problemdetail|security/i.test(href);
      if (!text || genericRejectText.test(text) || text.length < 4 || (!isDetailHref && text.length > 120) || (isDetailHref && text.length > 260)) return null;
      const meta = [text, node.getAttribute('title') || '', href, node.className || ''].join(' ');
      let score = 0;
      if (/\[\s*\d{4,}\s*\]/.test(text) || /\b\d{6,}\b/.test(text)) score += 10;
      if (isDetailHref) score += 12;
      if (/详情|detail|view|ticket|request|event|change|problem|security/i.test(meta)) score += 6;
      if (node.closest('tr, li, [role="row"], .el-table__row')) score += 5;
      if (node.closest('table, tbody, .el-table__body, .el-table__body-wrapper, .list, .table, [class*="table"], [class*="list"]')) score += 4;
      if (node.tagName === 'A') score += 3;
      if (node.closest('td, .cell, .el-table__cell')) score += 2;
      if (node.closest('tbody tr:first-child, tr:first-child, li:first-child')) score += 2;
      const rect = node.getBoundingClientRect();
      if (rect.top > 180) score += 3;
      if (rect.top < 120) score -= 8;
      if (text.length >= 6 && text.length <= 40) score += 1;
      return { node, text, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score);

    const best = scored[0];
    const fallback = Array.from(document.querySelectorAll('a[href*="Detail"], a[href*="detail"], tbody tr a, tr a, li a, [class*="result"] a, a')).map((node) => {
      if (!isVisible(node) || node.closest('nav, header, aside, .menu, .sidebar, .breadcrumb, [role="navigation"], [role="tablist"], .tabs, .toolbar')) return null;
      const text = textOf(node);
      const href = node.getAttribute('href') || '';
      if (!(/detail|requestdetail|eventdetail|changedetail|problemdetail|security/i.test(href) || /\[\s*\d{4,}\s*\]/.test(text) || /\b\d{6,}\b/.test(text))) return null;
      return { text: text.slice(0, 120), href, score: 8, fallback: true };
    }).filter(Boolean)[0];

    const chosen = best && best.score >= 8
      ? { text: best.text.slice(0, 120), href: best.node.getAttribute('href') || '', score: best.score, fallback: false }
      : fallback;

    return {
      executed: false,
      action: 'detail_inspect_only',
      mode: 'inspect_only',
      reason: chosen ? 'detail-navigation-skipped-permission-safe' : 'detail-candidate-not-found',
      listApiCandidateFound: true,
      bestCandidate: chosen || null,
      candidateCount: scored.length,
    };
  })()`);
    detailAction = {
      step: 'detail',
      result: {
        ...(detailInspection || {}),
        networkDetailCandidates,
      },
      networkDelta: buildActionNetworkDelta('detail', []),
      pageSignal: null,
    };
  } else {
    detailAction = {
      step: 'detail',
      result: {
        executed: false,
        reason: 'detail-deferred-until-list-api-candidate',
        listApiCandidateFound: false,
      },
      networkDelta: buildActionNetworkDelta('detail', []),
      pageSignal: null,
    };
  }
  actions.push(detailAction);

  const pageStateAfter = await sendExplorationMessage(targetTabId, { type: 'browser_state' });
  const network = await getCdpNetworkSnapshot(targetTabId, { businessOnly: true, limit: 100 });
  const verdictEntries = collectWorkflowNetworkEntries(
    initialNetwork?.entries,
    actions.flatMap((action) => action?.networkDelta?.entries || []),
    network?.entries,
  );
  const verdict = classifySitePattern(pageStateAfter, verdictEntries);

  return {
    tabId: targetTabId,
    opened,
    pageStateBefore,
    resultPageState,
    pageStateAfter,
    actions,
    initialNetwork,
    network,
    verdict,
    pageTransition: searchTransition,
    workflow: {
      version: 'opencli-like-v12',
      strategy: 'open_page -> attach_cdp -> navigate -> capture_initial -> runtime_evaluate(search_region) -> wait_route_and_network -> recapture_hydrated_result_context(thresholded) -> backfill_search_delta_from_hydration_window -> runtime_evaluate(refine_search_region) -> recapture_refined_context -> backfill_refine_delta_from_hydration_window -> runtime_evaluate(pagination_region) -> require_strong_pre_detail_list_api_signal -> inspect_detail_without_navigation -> attribute_by_capture_counter -> rank_reusable_list_apis_higher -> verify_pagination_progress',
      executionEngine: 'chrome.debugger.Runtime.evaluate',
    },
  };
}

async function runActionCaptureWorkflow({
  tabId = null,
  url = null,
  site = '',
  actionName = 'unknown_action',
  mode = 'intercept',
  timeoutSeconds = 90,
  pattern = '',
  captureReadRequests = false,
  onReady = null,
} = {}) {
  const normalizedMode = ['observe', 'intercept', 'commit'].includes(mode) ? mode : 'intercept';
  const safeTimeoutSeconds = Math.max(5, Math.min(Number(timeoutSeconds || 90), 300));
  const patterns = normalizeCapturePatterns(pattern);
  let targetTabId = tabId;
  let opened = null;

  if (!targetTabId && url) {
    const created = await createBrowserTab({ url: 'about:blank', active: true });
    targetTabId = created?.id ?? null;
    opened = { tabId: targetTabId, url };
  }

  if (!targetTabId) {
    targetTabId = await getExplorationTabId(null);
  }
  if (!targetTabId) throw new Error('未找到可用于动作捕获的标签页');

  try {
    const targetTab = await chrome.tabs.get(targetTabId);
    if (!targetTab || !shouldHandleTabUrl(targetTab.url)) throw new Error('TARGET_TAB_NOT_FOUND');
  } catch {
    throw new Error('TARGET_TAB_NOT_FOUND');
  }

  await ensureCdpAttached(targetTabId);

  if (url) {
    await chrome.tabs.update(targetTabId, { url, active: true });
    await waitForTabLoad(targetTabId, 15000);
    await delay(1500);
  } else {
    try {
      await chrome.tabs.update(targetTabId, { active: true });
    } catch { }
  }

  const beforeTab = await getTabRuntimeState(targetTabId);
  const pageStateBefore = await sendExplorationMessage(targetTabId, { type: 'browser_state' }).catch((err) => ({ error: err.message }));
  const state = ensureCdpState(targetTabId);
  const baselineCaptureCount = state.totalCaptured;
  const startedAt = new Date().toISOString();

  const session = {
    mode: normalizedMode,
    actionName: String(actionName || 'unknown_action'),
    site: String(site || ''),
    patterns,
    startedAt,
    entries: [],
    errors: [],
    captureReadRequests: Boolean(captureReadRequests),
    stopReason: 'timeout',
    stopRequestedAt: '',
  };
  session.stopPromise = new Promise((resolve) => {
    session.requestStop = (reason = 'manual_stop') => {
      if (session.stopRequestedAt) return false;
      session.stopRequestedAt = new Date().toISOString();
      session.stopReason = reason;
      resolve(reason);
      return true;
    };
  });
  cdpActionCaptureSessions.set(targetTabId, session);

  let fetchEnabled = false;
  if (normalizedMode === 'intercept') {
    await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
    fetchEnabled = true;
  }

  if (typeof onReady === 'function') {
    await onReady({ tabId: targetTabId, startedAt });
  }

  let completionReason = 'timeout';
  try {
    completionReason = await Promise.race([
      delay(safeTimeoutSeconds * 1000).then(() => 'timeout'),
      session.stopPromise,
    ]);
    if (completionReason !== 'timeout') {
      await delay(1200);
    }
  } finally {
    if (fetchEnabled) {
      try {
        await chrome.debugger.sendCommand({ tabId: targetTabId }, 'Fetch.disable');
      } catch (err) {
        session.errors.push(err?.message || String(err));
      }
    }
    cdpActionCaptureSessions.delete(targetTabId);
  }

  if (completionReason === 'target_tab_closed') {
    throw new Error('TARGET_TAB_NOT_FOUND');
  }

  const pageStateAfter = await sendExplorationMessage(targetTabId, { type: 'browser_state' }).catch((err) => ({ error: err.message }));
  const finalTab = await getTabRuntimeState(targetTabId);
  const observedEntries = getActionCaptureEntries(
    targetTabId,
    baselineCaptureCount,
    ensureCdpState(targetTabId).totalCaptured,
    patterns,
    session.captureReadRequests,
  );
  const capturedActions = rankActionCaptureEntries([
    ...session.entries,
    ...observedEntries,
  ], session.actionName).slice(0, 20);

  const inferredSiteHost = (() => {
    if (site) return site;
    try {
      return new URL(finalTab.url || beforeTab.url || '').hostname;
    } catch {
      return '';
    }
  })();

  const result = {
    tabId: targetTabId,
    opened,
    site: inferredSiteHost,
    actionName: session.actionName,
    mode: normalizedMode,
    pattern,
    timeoutSeconds: safeTimeoutSeconds,
    startedAt,
    finishedAt: new Date().toISOString(),
    stopReason: session.stopReason || 'timeout',
    stopRequestedAt: session.stopRequestedAt || '',
    stoppedEarly: Boolean(session.stopRequestedAt),
    beforeTab,
    finalTab,
    pageStateBefore,
    pageStateAfter,
    capturedActions,
    errors: session.errors,
    recommendation: {
      canGenerateAdapterTool: capturedActions.length > 0,
      toolName: inferredSiteHost ? `${inferredSiteHost}.${session.actionName}_draft` : `${session.actionName}_draft`,
      nextStep: capturedActions.length > 0
        ? 'review_captured_request_and_generate_adapter_tool'
        : 'repeat_capture_with_more_specific_pattern_or_longer_timeout',
    },
    workflow: {
      version: ACTION_CAPTURE_VERSION,
      strategy: normalizedMode === 'intercept'
        ? 'attach_cdp -> enable_network -> enable_fetch_request_intercept -> user_manual_action_window -> continue_live_requests_and_capture_candidates -> summarize_capture'
        : 'attach_cdp -> enable_network -> user_manual_action_window -> summarize_network_delta',
      executionEngine: 'chrome.debugger.Network + chrome.debugger.Fetch',
    },
  };

  return result;
}

function isTelemetryLikeEntry(entry) {
  const raw = `${entry?.url || ''} ${entry?.requestBodyPreview || ''}`.toLowerCase();
  return /trace|telemetry|analytics|collect|beacon|metrics|sentry|report|monitor/.test(raw);
}

function looksJsonPayload(text) {
  if (!text || typeof text !== 'string') return false;
  const normalized = text.trim();
  return /^[\[{]/.test(normalized) || /"(retCode|retDetail|data|list|rows|records|totalCount|currentPage|pageSize)"/.test(normalized);
}

function scoreApiEntry(entry) {
  const url = String(entry?.url || '');
  const urlLower = url.toLowerCase();
  const method = String(entry?.method || 'GET').toUpperCase();
  const contentType = String(entry?.responseContentType || entry?.responseHeaders?.['content-type'] || '').toLowerCase();
  const requestHeaders = JSON.stringify(entry?.requestHeaders || {}).toLowerCase();
  const requestBody = String(entry?.requestBodyPreview || '');
  const requestBodyLower = requestBody.toLowerCase();
  const responsePreview = String(entry?.responsePreview || '');
  let score = 0;
  const signals = [];

  if (/\/api\/|graphql|\.json(?:$|[?#])|\.spr(?:$|[?#])/.test(urlLower)) {
    score += 4;
    signals.push('url_pattern');
  }
  if (/xmlhttprequest|application\/json/.test(requestHeaders)) {
    score += 2;
    signals.push('xhr_or_json_header');
  }
  if (method !== 'GET') {
    score += 1;
    signals.push('non_get');
  }
  if (requestBody) {
    score += 1;
    signals.push('request_body');
  }
  if (/currentpage|pagesize|keyword|offset|limit|filtertabs|status|query|search/.test(requestBodyLower)) {
    score += 2;
    signals.push('query_payload');
  }
  if (/application\/json|text\/json/.test(contentType)) {
    score += 2;
    signals.push('json_content_type');
  }
  if (looksJsonPayload(responsePreview)) {
    score += 2;
    signals.push('json_like_response');
  }
  if (/retcode|retdetail|totalcount|currentpage|pagesize|"data"|"rows"|"records"/.test(responsePreview.toLowerCase())) {
    score += 2;
    signals.push('business_payload');
  }
  if (/text\/html/.test(contentType) && looksJsonPayload(responsePreview)) {
    score += 1;
    signals.push('json_in_html_content_type');
  }

  return { score, signals };
}

function getReusableApiCandidateScore(entry) {
  const base = scoreApiEntry(entry);
  const probe = `${entry?.url || ''} ${entry?.requestBodyPreview || ''} ${entry?.responsePreview || ''}`.toLowerCase();
  let score = base.score;

  if (/list|search|query|records|rows|getci|currentpage|pagesize|totalcount|keyword|detailurl/.test(probe)) score += 12;
  if (/currentpage|pagesize|offset|limit|keyword|query|search|filter|history=/.test(probe)) score += 8;
  if (/detailurl|href|url|title|name|id/.test(probe) && /totalcount|currentpage|pagesize|rows|records|list|ciList/i.test(probe)) score += 6;
  if (/getcilist|getcigroup/.test(probe)) score += 16;
  if (isExplorationNoiseProbe(probe)) score -= 18;
  if (/requestdetail|eventdetail|changedetail|problemdetail|getrequestdetail|getstatuslistby/.test(probe) && !/currentpage|pagesize|totalcount|rows|records|list/.test(probe)) score -= 6;

  return score;
}

function scoreActionDeltaEntry(step, entry) {
  const base = scoreApiEntry(entry);
  const probe = `${entry?.url || ''} ${entry?.requestBodyPreview || ''} ${entry?.responsePreview || ''}`.toLowerCase();
  let score = base.score;

  if (step === 'search' || step === 'refine_search') {
    if (/getcilist|getcigroup/.test(probe)) score += 18;
    if (/keyword|search|currentpage|pagesize|totalcount|pagetotal|typeid|history=|history\\":|detailurl/.test(probe)) score += 10;
    if (/globalsearch\.html|gettotalitems|systemmanage\/getsysvaluebykey|getmappinguser|getenv|menu\/getmenus|itsm_horn_info|contact_users|llm_append_keyword/.test(probe)) score -= 8;
  } else if (step === 'pagination') {
    if (/getcilist/.test(probe)) score += 18;
    if (/currentpage|pagesize|pagecount|paging/.test(probe)) score += 10;
    if (/currentpage\":1|currentpage=1/.test(probe)) score -= 4;
    if (/currentpage\":([2-9]\d*)|currentpage=([2-9]\d*)/.test(probe)) score += 10;
    if (/gettotalitems|systemmanage\/getsysvaluebykey|getmappinguser|getenv|menu\/getmenus/.test(probe)) score -= 6;
  } else if (step === 'detail') {
    if (/detail|requestdetail|eventdetail|changedetail|problemdetail|security/.test(probe)) score += 10;
  }

  return score;
}

function buildActionNetworkDelta(step, entries) {
  const sorted = entries.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const filtered = sorted.filter(isLikelyBusinessEntry);
  const ranked = filtered.slice().sort((a, b) => {
    const scoreDiff = scoreActionDeltaEntry(step, b) - scoreActionDeltaEntry(step, a);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.timestamp || 0) - (a.timestamp || 0);
  });
  const limited = ranked.slice(0, 12).map(sanitizeNetworkEntry);

  return {
    source: 'cdp',
    entries: limited,
    totalEntries: sorted.length,
    returnedEntries: limited.length,
    filteredOutCount: sorted.length - filtered.length,
  };
}

function classifySitePattern(pageState, networkEntries) {
  const entries = (networkEntries || []).filter((entry) => entry?.url && !isTelemetryLikeEntry(entry));
  const scoredEntries = entries.map((entry) => ({ entry, ...scoreApiEntry(entry) }));
  const apiLikeEntries = scoredEntries.filter((item) => item.score >= 5);
  const listLikeEntries = apiLikeEntries.filter(({ entry }) => {
    const probe = `${entry.url || ''} ${entry.requestBodyPreview || ''} ${entry.responsePreview || ''}`.toLowerCase();
    return /list|page|pagesize|currentpage|totalcount|rows|records|filtertabs|keyword|search/.test(probe);
  });
  const rankedApiLikeEntries = apiLikeEntries.slice().sort((a, b) => {
    const scoreDiff = getReusableApiCandidateScore(b.entry) - getReusableApiCandidateScore(a.entry);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.entry.timestamp || 0) - (a.entry.timestamp || 0);
  });
  const hasStateHints = !!(
    pageState?.stateHints?.nextDataScript ||
    pageState?.stateHints?.initialStateText ||
    pageState?.stateHints?.nuxtData ||
    pageState?.stateHints?.apolloStateText
  );

  if (hasStateHints) {
    return {
      pattern: 'state_or_ssr',
      recommendedStrategy: apiLikeEntries.length > 0 ? 'HYBRID' : 'UI',
      reason: apiLikeEntries.length > 0
        ? `页面同时存在 SSR / 初始状态线索，以及 ${apiLikeEntries.length} 条疑似业务接口请求，优先走状态 + 接口混合策略。`
        : '页面包含 SSR / 初始状态线索，可优先检查页面状态与接口结合方式。',
    };
  }

  if (apiLikeEntries.length > 0) {
    const top = rankedApiLikeEntries[0];
    const topUrl = top?.entry?.url ? top.entry.url.split('?')[0] : '';
    return {
      pattern: 'api_driven',
      recommendedStrategy: 'COOKIE_API',
      reason: listLikeEntries.length > 0
        ? `观察到 ${apiLikeEntries.length} 条疑似业务接口请求，其中 ${listLikeEntries.length} 条呈现列表/分页特征；最强候选为 ${topUrl}。`
        : `观察到 ${apiLikeEntries.length} 条疑似业务接口请求；最强候选为 ${topUrl}。`,
    };
  }

  return {
    pattern: 'dom_driven',
    recommendedStrategy: 'UI',
    reason: '暂未观察到明显 JSON 接口或页面状态线索，优先走 DOM/UI 自动化。',
  };
}

async function getExplorationTabId(preferredTabId) {
  if (preferredTabId) return preferredTabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function isMissingExplorationReceiverError(error) {
  const message = String(error?.message || error || '');
  return message.includes('Receiving end does not exist')
    || message.includes('Could not establish connection');
}

async function ensureExplorationContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: ['content/injector.js'],
  });
}

async function sendExplorationMessage(tabId, payload) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, payload);
    if (response?.error) throw new Error(response.error);
    return response?.result ?? response;
  } catch (err) {
    if (isMissingExplorationReceiverError(err)) {
      try {
        await ensureExplorationContentScript(tabId);
        const response = await chrome.tabs.sendMessage(tabId, payload);
        if (response?.error) throw new Error(response.error);
        return response?.result ?? response;
      } catch (retryError) {
        throw new Error(`探索能力调用失败: ${retryError.message}`);
      }
    }
    throw new Error(`探索能力调用失败: ${err.message}`);
  }
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source?.tabId;
  if (!tabId || !cdpAttachedTabs.has(tabId)) return;
  void recordBrowserFrameEvent(chrome, source, method, params);
  recordBrowserDownload(tabId, method, params);
  recordBrowserEvent(tabId, source, method, params);
  // Child target context/request IDs are scoped to their debugger session.
  // Existing preview and network caches belong to the main target only.
  if (source.sessionId) return;
  recordBrowserObservation(tabId, method, params);

  if (method === 'Runtime.executionContextCreated') {
    const context = params?.context;
    if (Number.isInteger(context?.id)) getCdpExecutionContextMap(tabId).set(context.id, context);
    return;
  }
  if (method === 'Runtime.executionContextDestroyed') {
    getCdpExecutionContextMap(tabId).delete(params?.executionContextId);
    return;
  }
  if (method === 'Runtime.executionContextsCleared') {
    getCdpExecutionContextMap(tabId).clear();
    return;
  }

  const state = ensureCdpState(tabId);
  const requests = state.requests;

  try {
    if (method === 'Fetch.requestPaused') {
      const session = cdpActionCaptureSessions.get(tabId);
      const request = params.request || {};
      const rawPostData = String(request.postData || '');
      const requestInfo = {
        kind: 'cdp_fetch_intercept',
        url: request.url || '',
        method: request.method || 'GET',
        timestamp: Date.now(),
        requestHeaders: normalizeFetchHeaders(request.headers),
        requestBodyPreview: truncateText(rawPostData, CDP_REQUEST_PREVIEW_LIMIT),
        requestBodyFullSize: rawPostData.length,
        requestBodyTruncated: rawPostData.length > CDP_REQUEST_PREVIEW_LIMIT,
      };
      const shouldCapture = session && isLikelyActionRequest(requestInfo, session.patterns, {
        allowRead: session.captureReadRequests,
      });

      if (shouldCapture) {
        session.entries.push({
          ...requestInfo,
          intercepted: false,
          blockedReason: '',
          actionName: session.actionName,
        });
      }

      await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', {
        requestId: params.requestId,
      });
      return;
    }

    if (method === 'Network.requestWillBeSent') {
      const request = params.request || {};
      const rawPostData = String(request.postData || '');
      requests.set(params.requestId, {
        requestId: params.requestId,
        url: request.url || '',
        method: request.method || 'GET',
        timestamp: Date.now(),
        requestHeaders: normalizeHeaders(request.headers),
        requestBodyPreview: truncateText(rawPostData, CDP_REQUEST_PREVIEW_LIMIT),
        requestBodyFullSize: rawPostData.length,
        requestBodyTruncated: rawPostData.length > CDP_REQUEST_PREVIEW_LIMIT,
      });
      const adapterSession = adapterNetworkCaptureSessions.get(tabId);
      if (adapterSession && adapterCaptureAllowsUrl(adapterSession, request.url || '')) {
        adapterSession.requestIds.add(params.requestId);
        adapterSession.lastEventAt = Date.now();
      }
      return;
    }

    if (method === 'Network.responseReceived') {
      const pending = requests.get(params.requestId);
      if (!pending) return;
      const response = params.response || {};
      pending.status = response.status;
      pending.statusText = response.statusText || '';
      pending.mimeType = response.mimeType || '';
      pending.responseHeaders = normalizeHeaders(response.headers);
      pending.responseContentType = response.headers?.['content-type'] || response.headers?.['Content-Type'] || response.mimeType || '';
      return;
    }

    if (method === 'Network.loadingFinished') {
      const pending = requests.get(params.requestId);
      if (!pending) return;

      let responsePreview = '';
      let responseBody = '';
      try {
        const body = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: params.requestId });
        if (body?.base64Encoded) {
          const binary = atob(body.body || '');
          responseBody = new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
        } else {
          responseBody = body?.body || '';
        }
        responsePreview = truncateText(responseBody, CDP_RESPONSE_PREVIEW_LIMIT);
      } catch { }

      pushCdpNetworkEntry(tabId, {
        kind: 'cdp',
        requestId: params.requestId,
        url: pending.url,
        method: pending.method,
        timestamp: pending.timestamp,
        requestHeaders: pending.requestHeaders,
        requestBodyPreview: pending.requestBodyPreview || '',
        requestBodyFullSize: Number(pending.requestBodyFullSize || 0),
        requestBodyTruncated: Boolean(pending.requestBodyTruncated),
        status: pending.status,
        statusText: pending.statusText || '',
        responseHeaders: pending.responseHeaders,
        responseContentType: pending.responseContentType || pending.mimeType || '',
        responsePreview,
        responseEvidence: browserResponseEvidence(responseBody),
        encodedDataLength: params.encodedDataLength || 0,
      });
      const adapterSession = adapterNetworkCaptureSessions.get(tabId);
      if (adapterSession?.requestIds.has(params.requestId)) {
        const encodedBody = new TextEncoder().encode(responseBody);
        const truncated = encodedBody.byteLength > ADAPTER_RESPONSE_CAPTURE_LIMIT;
        adapterSession.entries.push({
          kind: 'cdp',
          url: pending.url,
          method: pending.method,
          timestamp: pending.timestamp,
          responseStatus: pending.status,
          responseContentType: pending.responseContentType || pending.mimeType || '',
          responsePreview: truncated
            ? new TextDecoder().decode(encodedBody.subarray(0, ADAPTER_RESPONSE_CAPTURE_LIMIT))
            : responseBody,
          responseBodyFullSize: encodedBody.byteLength,
          responseBodyTruncated: truncated,
        });
        if (adapterSession.entries.length > ADAPTER_CAPTURE_ENTRY_LIMIT) {
          adapterSession.entries.splice(0, adapterSession.entries.length - ADAPTER_CAPTURE_ENTRY_LIMIT);
        }
        adapterSession.requestIds.delete(params.requestId);
        adapterSession.lastEventAt = Date.now();
      }
      requests.delete(params.requestId);
      return;
    }

    if (method === 'Network.loadingFailed') {
      const pending = requests.get(params.requestId);
      if (!pending) return;
      pushCdpNetworkEntry(tabId, {
        kind: 'cdp',
        requestId: params.requestId,
        url: pending.url,
        method: pending.method,
        timestamp: pending.timestamp,
        requestHeaders: pending.requestHeaders,
        requestBodyPreview: pending.requestBodyPreview || '',
        requestBodyFullSize: Number(pending.requestBodyFullSize || 0),
        requestBodyTruncated: Boolean(pending.requestBodyTruncated),
        errorText: params.errorText || 'loading failed',
        canceled: !!params.canceled,
      });
      const adapterSession = adapterNetworkCaptureSessions.get(tabId);
      if (adapterSession?.requestIds.has(params.requestId)) {
        adapterSession.entries.push({
          kind: 'cdp',
          url: pending.url,
          method: pending.method,
          timestamp: pending.timestamp,
          responseStatus: pending.status,
          errorText: params.errorText || 'loading failed',
        });
        adapterSession.requestIds.delete(params.requestId);
        adapterSession.lastEventAt = Date.now();
      }
      requests.delete(params.requestId);
    }
  } catch (err) {
    state.lastError = err?.message || String(err);
  }
});

function clearBrowserDebuggerState(tabId, reason) {
  clearBrowserFrames(tabId);
  clearBrowserDownloads(tabId);
  clearBrowserEvents(tabId);
  cdpAttachedTabs.delete(tabId);
  clearBrowserObservations(tabId);
  cdpExecutionContexts.delete(tabId);
  adapterNetworkCaptureSessions.delete(tabId);
  const state = cdpNetworkState.get(tabId);
  if (state) state.lastError = reason || 'detached';
}
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source?.tabId && !source.sessionId) clearBrowserDebuggerState(source.tabId, reason);
});

// ─── WebSocket 连接 ──────────────────────────────────────────────────────────

let isConnecting = false;
let lastNativeAckAt = 0;
let lastBridgeDisconnectReason = '';
let bridgeCapabilities = [];
let nativeHeartbeatAckTimer = null;
const NATIVE_ACK_GRACE_MS = 10000;

function clearNativeHeartbeatAckTimer() {
  if (nativeHeartbeatAckTimer) {
    clearTimeout(nativeHeartbeatAckTimer);
    nativeHeartbeatAckTimer = null;
  }
}

function failPendingBridgeRequests(reason = 'Bridge 连接已断开') {
  for (const pending of pendingWriteRequests.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, error: reason });
  }
  pendingWriteRequests.clear();
}

function scheduleNativeHeartbeatAckCheck(socket, sentAt) {
  clearNativeHeartbeatAckTimer();
  nativeHeartbeatAckTimer = setTimeout(() => {
    nativeHeartbeatAckTimer = null;
    if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    if (lastNativeAckAt < sentAt) {
      resetNativeSocket('native heartbeat ack timeout');
    }
  }, NATIVE_ACK_GRACE_MS);
}

function sendNativeHeartbeat() {
  const socket = ws;
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  if (!currentBrowserContextId) return false;
  const sentAt = Date.now();
  const sent = sendToNative(buildExtensionHello({ heartbeat: true }));
  if (sent) scheduleNativeHeartbeatAckCheck(socket, sentAt);
  return sent;
}

function resetNativeSocket(reason) {
  bridgeCapabilities = [];
  console.warn("[WebMCP] Reset native socket:", reason);
  lastBridgeDisconnectReason = `Bridge 连接已断开：${reason || '连接异常'}`;
  clearNativeHeartbeatAckTimer();
  failPendingBridgeRequests(lastBridgeDisconnectReason);
  const socket = ws;
  ws = null;
  try {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close();
    }
  } catch (err) {
    console.warn("[WebMCP] Failed to close native socket:", err.message);
  }
  isConnecting = false;
  setTimeout(connectToNativeHost, 1000);
}

function connectToNativeHost() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.log("[WebMCP] Already connected or connecting, skipping");
    return;
  }

  if (isConnecting) {
    console.log("[WebMCP] Connection attempt already in progress");
    return;
  }

  isConnecting = true;

  try {
    console.log("[WebMCP] Attempting to connect to native host...");
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.warn("[WebMCP] Failed to create WebSocket:", err.message);
    isConnecting = false;
    setTimeout(connectToNativeHost, 5000);
    return;
  }

  const socket = ws;
  socket.addEventListener("open", async () => {
    if (ws !== socket) return;
    console.log("[WebMCP] Connected to native host");
    isConnecting = false;
    lastNativeAckAt = Date.now();

    try { currentBrowserContextId = await browserContextId(chrome.storage.local); }
    catch (error) { console.error('[WebMCP] Browser profile unavailable:', error.message); socket.close(1008, 'PROFILE_ID_INVALID'); return; }
    if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    // 每次连接都重新读取 WeWorker 浏览器标记，避免启动时错过存储变更事件。
    await loadBrowserInstance();
    if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    sendToNative(buildExtensionHello());

    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: "resync_tools" }, () => {
          void chrome.runtime.lastError;
        });
      }
    });

    // 延迟扫描所有 tab 的 adapter 状态：处理 extension reload 后 adapter 被删除的情况
    // （resync_tools 可能把旧工具重新注入，这里再做一次清理校验）
    setTimeout(() => {
      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          if (tab.url && !tab.url.startsWith("chrome://") && !tab.url.startsWith("chrome-extension://")) {
            injectAdapters(tab.id, tab.url);
          }
        }
      });
    }, 800);
  });

  socket.addEventListener("message", async (event) => {
    if (ws !== socket) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === "extension_hello_ack") {
      bridgeCapabilities = Array.isArray(msg.capabilities) ? msg.capabilities : [];
      lastNativeAckAt = Date.now();
      clearNativeHeartbeatAckTimer();
      return;
    }
    // ③ 扩展内部耗时观测的起点（结果/错误回传时在 sendToNative 里结算）。
    noteCallToolStart(msg);
    await handleNativeMessage(msg);
  });

  socket.addEventListener("close", (event) => {
    if (ws !== socket) return;
    cancelAllPageWorkflows();
    bridgeCapabilities = [];
    clearNativeHeartbeatAckTimer();
    const closeDetail = event?.reason || (event?.code ? `WebSocket close code ${event.code}` : 'WebSocket 已关闭');
    lastBridgeDisconnectReason = `Bridge 连接已断开：${closeDetail}`;
    failPendingBridgeRequests(lastBridgeDisconnectReason);
    isConnecting = false;
    ws = null;
    setTimeout(connectToNativeHost, 3000);
  });

  socket.addEventListener("error", () => {
    if (ws !== socket) return;
    // Suppress console error — reconnection is handled by the close handler
    isConnecting = false;
  });
}

// ─── 处理来自 Native Host 的消息 ───────────────────────────────────────────

async function handleNativeMessage(msg) {
  if (msg.type === 'http_credentials') {
    console.log('[WebMCP] <- native: http_credentials', { id: msg.id });
  } else if (msg.type === 'validate_generation_preview') {
    console.log('[WebMCP] <- native: validate_generation_preview', {
      id: msg.id,
      previewAdapterId: msg.previewAdapterId,
      siteKey: msg.siteKey,
      scriptCount: Array.isArray(msg.previewBundle?.scripts) ? msg.previewBundle.scripts.length : 0,
      testCaseCount: Array.isArray(msg.testCases) ? msg.testCases.length : 0,
    });
  } else {
    console.log("[WebMCP] <- native:", msg);
  }

  if (
    msg.type === "adapter_catalog_result"
    || msg.type === "adapter_bundle_result"
    || msg.type === "write_adapter_file_result"
    || msg.type === "generate_adapter_with_ai_result"
    || msg.type === "generate_adapter_scaffold_result"
    || msg.type === "get_ai_config_result"
    || msg.type === "save_ai_config_result"
    || msg.type === "test_ai_config_result"
    || msg.type === "analyze_action_capture_result"
    || msg.type === "analyze_exploration_result"
    || msg.type === "start_generation_run_result"
    || msg.type === "resume_generation_run_result"
    || msg.type === "get_generation_run_result"
    || msg.type === "cancel_generation_run_result"
    || msg.type === "publish_generation_run_result"
    || msg.type === "wecli_backend_fetch_result"
    || msg.type === "wecli_backend_file_read_result"
    || msg.type === "wecli_backend_xlsx_read_result"
    || msg.type === "wecli_backend_file_write_result"
  ) {
    const pending = pendingWriteRequests.get(msg.id);
    if (pending) {
      pendingWriteRequests.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve(msg);
    }
    return;
  }

  if (msg.type === 'adapter_state_changed') {
    try {
      const { registry, refreshedTabs } = await refreshAdapterState(msg);
      chrome.runtime.sendMessage({ ...msg, registry, refreshedTabs }, () => void chrome.runtime.lastError);
    } catch (error) {
      console.error("[WebMCP] Adapter state refresh failed:", error?.message || error);
      chrome.runtime.sendMessage({ ...msg, error: error?.message || String(error) }, () => void chrome.runtime.lastError);
    }
    return;
  }

  if (msg.type === 'generation_run_event') {
    chrome.runtime.sendMessage(msg, () => {
      void chrome.runtime.lastError;
    });
    return;
  }

  if (msg.type === 'validate_generation_preview') {
    try {
      const result = await validateGenerationPreview(msg);
      sendToNative({
        type: 'validate_generation_preview_result',
        id: msg.id,
        ok: true,
        result,
      });
    } catch (error) {
      sendToNative({
        type: 'validate_generation_preview_result',
        id: msg.id,
        ok: false,
        error: error?.message || String(error),
      });
    }
    return;
  }

  if (msg.type === "list_tools") {
    const tools = await getHostAdapterClient().tools(gatherAllTools());
    sendToNative({ type: "list_tools_result", id: msg.id, tools });

  } else if (msg.type === "call_tool") {
    const { toolName, args } = msg;
    const traceID = msg.traceID || null;
    const tracePrefix = traceID ? `[${traceID}] ` : '';
    console.log(`${tracePrefix}[WebMCP] <- native: call_tool ${toolName}`);
    traceLog(traceID, `[ServiceWorker] 收到 call_tool: ${toolName}`);
    let selectedManifest = null;
    try {
      const selected = await getHostAdapterClient().tool(toolName);
      if (selected.managed) selectedManifest = selected.manifest;
      if (msg.adapterSnapshot && (!selected.managed || msg.adapterSnapshot.name !== selected.manifest.name
        || msg.adapterSnapshot.digest !== selected.manifest._hostSnapshot.digest
        || msg.adapterSnapshot.profile !== selected.manifest._hostSnapshot.profile)) {
        throw new Error('Adapter changed since this call started; refresh the catalog.');
      }
      if (selected.managed) {
        if (selected.command.runtime !== 'extension') throw new Error('This command requires the host Toolkit runtime.');
        if ((selected.command.pageWrite || selected.command.uiWrite || (selected.command.requires_confirmation ?? selected.command.safety === 'write')) && args?.__confirmed !== true) throw new Error('Explicit confirmation is required for this command.');
        if (selected.command.execution?.runtime === 'background') {
          const result = await callManagedBackgroundTool(selected.manifest, selected.command, args || {}, traceID);
          sendToNative({ type: 'call_tool_result', id: msg.id, result, traceID });
          return;
        }
        const tabs = await chrome.tabs.query({});
        const declaredRoute = selected.command.tabDomain || selected.command.routeDomain;
        const route = declaredRoute || adapterPrimaryHost(selected.manifest);
        const excludeTabDomain = selected.command.excludeTabDomain;
        let pageTab;
        if (selected.command.pageRoute) {
          const { origin, pathname } = selected.command.pageRoute;
          assertAdapterNavigationUrl(selected.manifest, origin + pathname);
          const matches = tabs.filter(entry => {
            try { const url = new URL(entry.url); return pageRouteTargets(selected.command.pageRoute).some(target => matchesOriginTarget(url, target)); }
            catch { return false; }
          });
          const activeMatches = matches.filter(entry => entry.active);
          pageTab = matches.length === 1 ? matches[0] : activeMatches.length === 1 ? activeMatches[0] : null;
          if (!pageTab?.id) {
            sendToNative({ type: 'call_tool_result', id: msg.id, traceID, result: { ok: false, error: {
              code: matches.length ? 'PAGE_SOURCE_AMBIGUOUS' : 'PAGE_SOURCE_ROUTE_MISSING',
              message: matches.length ? 'Activate one matching page before calling this command.' : `Open ${origin}${pathname} before calling this command.`,
            } } });
            return;
          }
        }
        // The route host, or the host it was last redirected to (order.jd.com → order.jd.hk).
        let tab = pageTab || pickRouteTab(tabs, route, { aliases: managedRouteRedirects.aliases(selected.manifest, route), excludeTabDomain });
        // A command without a declared route runs on any page of its package (match and
        // domains, never runtime_allowed_hosts helpers): a page command may have moved its
        // tab to another host in its scope (search.*, order.* …).
        if (!tab && !declaredRoute) tab = pickRecentScopeTab(tabs, selected.manifest, excludeTabDomain);
        if (!tab?.id) {
          // A preceding generic open_browser may have redirected the only site tab to SSO.
          // Do not open a second business tab: hand the existing SSO tab to the host login flow,
          // which already recognises pendingUrl and reuses it.
          const loginTab = selected.manifest.auth
            ? tabs.find((candidate) => Number.isInteger(candidate?.id)
              && isLoginPageUrl(selected.manifest, loginTabUrl(selected.manifest, candidate), { root: true }))
            : null;
          if (loginTab) {
            throw authRequiredError({
              site: selected.manifest.name,
              phase: 'navigation',
              pageUrl: authDisplayUrl(loginTabUrl(selected.manifest, loginTab)),
              message: '网站正在登录，登录完成后将继续调用。',
            });
          }
          // HTTP is the neutral managed-page entry: HTTPS-only sites redirect themselves,
          // while internal sites that do not serve HTTPS remain reachable.
          const startUrl = assertAdapterNavigationUrl(selected.manifest, 'http://' + route + '/');
          tab = await createBrowserTab({ url: startUrl, active: false });
          // Learn where the site sends this host (regional or brand domains) before the first call.
          const landed = await waitForManagedPageReady(tab.id, selected.manifest, true, 25000);
          managedRouteRedirects.note(selected.manifest, startUrl, landed);
          tab = { ...tab, url: landed };
        }
        // All managed foreground commands, including pageWrite/uiWrite, become the
        // target of a following capture_screenshot call.
        screenshotToolTabs.note(tab.id);
        if (selected.command.pageWrite || selected.command.uiWrite) {
          const connection = ws, request = (selected.command.uiWrite ? uiWriteRequest : pageWriteRequest)(selected.command, args || {}), deadline = Date.now() + 30000;
          const reply = await getHostAdapterRuntime().exclusive(tab.id, () => executePageRequest({ chrome, ensureCdpAttached, tabId: tab.id,
            payload: { route: selected.command.pageRoute, request, confirmed: true, deadline,
              ...(selected.command.uiWrite ? { ui: selected.command.uiWrite } : { idempotency: { header: selected.command.pageWrite.idempotency.header, key: crypto.randomUUID() } }) },
            assertRunning: () => { if (connection !== ws) throw new Error('Connection changed.'); } }));
          sendToNative({ type: 'call_tool_result', id: msg.id, result: reply.ok ? reply.value : { ok: false, errorCode: reply.error.code }, traceID });
          return;
        }
        const result = await getHostAdapterRuntime().execute(tab.id, selected.manifest, tab.url,
          (remainingMs, continuation) => callToolInTab(tab.id, selected.manifest.name + '.' + selected.command.id, args || {}, traceID, false, remainingMs, continuation), selected.command, traceID);
        sendToNative({ type: 'call_tool_result', id: msg.id, result, traceID });
        return;
      }
      if (isLegacyWecliHandlerName(toolName)) {
        throw new Error(`"${toolName}" is an internal handler name. Use the public WebCLI command name without "wecli_".`);
      }
      const liveRoute = toolRouteIndex.get(toolName);
      const staticRoute = staticToolRouteIndex.get(toolName);
      const explicitRoute = mergeToolRoute(liveRoute, staticRoute);
      // 未注册显式路由时，保留原有 domain.action 推导方式。
      const domain = explicitRoute?.routeDomain ?? extractDomainFromToolName(toolName);
      if (!domain) {
        throw new Error(`无法从工具名 "${toolName}" 提取域名`);
      }
      traceLog(traceID, `[ServiceWorker] 路由域名: ${domain}`);

      // 读取工具元数据（tabDomain / excludeTabDomain）
      const meta = explicitRoute ?? getToolMeta(toolName);
      // routeDomain 用于查 adapter registry；tabDomain 只约束实际 tab hostname。
      const routeDomain = explicitRoute?.routeDomain ?? meta?.tabDomain ?? domain;
      const tabDomain = explicitRoute?.tabDomain;
      const excludeTabDomain = meta?.excludeTabDomain;
      const handlerName = explicitRoute?.handlerName ?? toolName;
      const isDirectRoute = Boolean(staticRoute && explicitRoute?.adapterId && isDirectCapableRoute(explicitRoute));
      const rawArgs = args || {};
      const toolDefinition = getRegisteredToolDefinition(toolName, handlerName);
      const validatedArgs = validateToolCallArgs(rawArgs, toolDefinition?.parameters);

      let directError = null;
      if (isDirectRoute) {
        try {
          traceLog(traceID, `[ServiceWorker] 尝试后台执行: adapter=${explicitRoute.adapterId} command=${toolName}`);
          const result = await callToolDirect(explicitRoute, handlerName, validatedArgs, traceID);
          const resultError = getToolErrorResultMessage(result);
          if (resultError) throw new Error(resultError);
          sendToNative({ type: "call_tool_result", id: msg.id, result, traceID });
          traceLog(traceID, `[ServiceWorker] call_tool 后台完成: ${toolName}`);
          return;
        } catch (err) {
          directError = err;
          if (err?.code !== "PAGE_CONTEXT_REQUIRED") {
            throw err;
          }
          if (isStorageContextRequiredError(err)) {
            const refreshed = await refreshDirectStorageContext({
              routeDomain,
              tabDomain,
              excludeTabDomain,
              details: err.details || {},
              traceID,
            });
            if (refreshed) {
              traceLog(traceID, `[ServiceWorker] 已刷新 storage 登录态，重试后台执行: ${toolName}`);
              const result = await callToolDirect(explicitRoute, handlerName, validatedArgs, traceID);
              const resultError = getToolErrorResultMessage(result);
              if (resultError) throw new Error(resultError);
              sendToNative({ type: "call_tool_result", id: msg.id, result, traceID });
              traceLog(traceID, `[ServiceWorker] call_tool 后台重试完成: ${toolName}`);
              return;
            }
          }
          traceLog(traceID, `[ServiceWorker] 融合 adapter 不回退整条命令到 Content Script: ${err.message}`);
          throw err;
        }
      }

      // 查找匹配域名的tab
      let tabId = await findTabByDomain(routeDomain, excludeTabDomain, tabDomain);
      let autoOpened = false;
      if (!tabId) {
        traceLog(traceID, `[ServiceWorker] 未找到域名 ${routeDomain} 的标签页`);
        // 自动打开站点首页并等待注入，然后重试（浏览器/登录预检查）
        traceLog(traceID, `[ServiceWorker] 尝试自动打开站点 ${routeDomain}`);
        const openedTabId = await autoOpenHomepageTab(routeDomain);
        autoOpened = openedTabId !== null && openedTabId !== undefined;
        tabId = await findTabByDomain(routeDomain, excludeTabDomain, tabDomain);
        if (tabId) {
          traceLog(traceID, `[ServiceWorker] 自动打开站点成功，路由到 tab ${tabId}`);
        }
      }
      if (!tabId) {
        if (directError) {
          throw directError;
        }
        if (autoOpened) {
          // 已自动打开站点但仍找不到工具注册 —— 常见原因是跳转到登录页
          throw new Error(`已自动打开站点 "${routeDomain}"，但该站点工具尚未就绪。若浏览器跳转到了登录页，请先完成登录后重新执行命令`);
        }
        throw new Error(`未找到域名 "${routeDomain}" 的标签页，且该工具无法后台执行（已尝试自动打开站点，但打开失败）`);
      }
      traceLog(traceID, `[ServiceWorker] 路由到 tab ${tabId}`);

      const result = await callToolInTab(tabId, handlerName, validatedArgs, traceID);
      const resultError = getToolErrorResultMessage(result);
      if (resultError) throw new Error(resultError);
      sendToNative({ type: "call_tool_result", id: msg.id, result, traceID });
      traceLog(traceID, `[ServiceWorker] call_tool 完成: ${toolName}`);
    } catch (caught) {
      // An HTTP 401 from Adapter helpers means the session is missing or expired.
      const err = caught?.code === 'HTTP_ERROR' && Number(caught?.details?.status) === 401
        ? authRequiredError({ site: selectedManifest?.name, phase: 'handler', message: caught.message })
        : caught;
      const auth = authErrorFields(err, selectedManifest);
      sendToNative({
        type: "call_tool_error", id: msg.id, error: err.message,
        ...(typeof err?.code === 'string' && err.code ? { code: err.code } : {}),
        ...(auth ? { auth } : {}),
        traceID,
      });
      traceLog(traceID, `[ServiceWorker] call_tool 错误: ${err.message}${err?.code ? ` (${err.code})` : ''}`);
    }

  } else if (msg.type === 'auth_open_login') {
    try {
      sendToNative({ type: 'call_tool_result', id: msg.id, result: await openSiteLoginTab(msg) });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }

  } else if (msg.type === 'auth_check') {
    try {
      sendToNative({ type: 'call_tool_result', id: msg.id, result: await checkSiteLogin(msg) });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }

  } else if (msg.type === 'http_credentials') {
    try {
      const result = await readHttpCookies(chrome, msg.payload);
      sendToNative({ type: 'call_tool_result', id: msg.id, result }, true);
    } catch {
      sendToNative({ type: 'call_tool_error', id: msg.id, code: 'HTTP_CREDENTIALS_UNAVAILABLE', error: 'Cannot read declared HTTP credentials from this browser.' });
    }
  } else if (msg.type === 'exploration_list_tabs') {
    try {
      const tabs = await chrome.tabs.query({});
      const explorableTabs = tabs
        .filter((tab) => Number.isInteger(tab.id) && shouldHandleTabUrl(tab.url))
        .map((tab) => ({
          id: tab.id,
          title: tab.title || '',
          url: tab.url || '',
          active: Boolean(tab.active),
          windowId: Number.isInteger(tab.windowId) ? tab.windowId : -1,
        }))
        .sort((left, right) => Number(right.active) - Number(left.active));
      sendToNative({ type: 'call_tool_result', id: msg.id, result: { tabs: explorableTabs } });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }

  } else if (msg.type === 'exploration_page_write') {
    const connection = ws;
    const result = await getHostAdapterRuntime().exclusive(Number(msg.tabId), () => executePageRequest({ chrome, ensureCdpAttached, tabId: Number(msg.tabId), payload: msg.payload,
      assertRunning: () => {
        if (connection !== ws) throw new Error('Connection changed before page request.');
        assertPageWorkflowActive(Number(msg.tabId), msg.payload?.operationId);
      } }));
    sendToNative({ type: 'call_tool_result', id: msg.id, result }, true);
  } else if (msg.type === 'exploration_cancel_workflow') {
    sendToNative({ type: 'call_tool_result', id: msg.id, result: { cancelled: cancelPageWorkflow(Number(msg.tabId), msg.operationId) } });
  } else if (msg.type === 'exploration_page_query') {
    const connection = ws;
    const result = await getHostAdapterRuntime().exclusive(Number(msg.tabId), () => connection !== ws
      ? { ok: false, error: { code: 'PAGE_WORKFLOW_CANCELLED', message: 'Connection changed before the workflow could start.' } }
      : executePageQuery({ chrome, ensureCdpAttached, tabId: Number(msg.tabId), payload: { ...msg.payload, metadataOnly: true } }));
    sendToNative({ type: 'call_tool_result', id: msg.id, result });
  } else if (msg.type === 'exploration_intercept_read') {
    const result = await getHostAdapterRuntime().exclusive(Number(msg.tabId), () => executeInterceptRead({ chrome, ensureCdpAttached, tabId: Number(msg.tabId), payload: { ...msg.payload, metadataOnly: true } }));
    sendToNative({ type: 'call_tool_result', id: msg.id, result });
  } else if (msg.type === 'exploration_observe_page') {
    try {
      const result = await getHostAdapterRuntime().exclusive(Number(msg.tabId), () => executePageSource(chrome, Number(msg.tabId), { ...msg.payload, metadataOnly: true }));
      sendToNative({ type: 'call_tool_result', id: msg.id, result });
    } catch {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: 'Unable to observe the selected page.' });
    }

  } else if (msg.type === 'exploration_capture_passive') {
    try {
      const tabId = await getExplorationTabId(msg.tabId);
      if (!tabId) throw new Error('未找到可用于探索的标签页');
      const result = await getHostAdapterRuntime().exclusive(tabId, () => runExploreWorkflow({ tabId, includeTelemetry: msg.includeTelemetry === true }));
      sendToNative({ type: 'call_tool_result', id: msg.id, result });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }

  } else if (msg.type === 'exploration_safe_actions_inspect') {
    try {
      const result = await getHostAdapterRuntime().exclusive(Number(msg.tabId), () => inspectSafeApiActions(Number(msg.tabId)));
      sendToNative({ type: 'call_tool_result', id: msg.id, result });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }

  } else if (msg.type === 'exploration_safe_probe_run') {
    try {
      const result = await getHostAdapterRuntime().exclusive(Number(msg.tabId), () => runSafeApiProbe({
        tabId: Number(msg.tabId),
        candidateId: String(msg.candidateId || ''),
        value: String(msg.value || ''),
      }));
      sendToNative({ type: 'call_tool_result', id: msg.id, result });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }

  } else if (msg.type === 'exploration_replay_candidate') {
    try {
      const result = await getHostAdapterRuntime().exclusive(Number(msg.tabId), () => runExplorationCandidateReplay({
        tabId: Number(msg.tabId),
        url: String(msg.url || ''),
        method: String(msg.method || 'GET'),
        headers: msg.headers && typeof msg.headers === 'object' ? msg.headers : {},
        body: String(msg.body || ''),
      }));
      sendToNative({ type: 'call_tool_result', id: msg.id, result });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }

  } else if (msg.type === 'exploration_action_capture_start') {
    try {
      const tabId = Number(msg.tabId);
      const siteKey = String(msg.siteKey || '').trim();
      const actionName = String(msg.actionName || '').trim();
      if (!Number.isInteger(tabId) || tabId < 0) throw new Error('A valid tabId is required');
      if (!siteKey) throw new Error('siteKey required');
      if (!actionName) throw new Error('actionName required');
      if (cdpActionCaptureSessions.has(tabId)) throw new Error('当前标签页已有进行中的动作捕获');
      if (actionCaptureAnalysisRetries.size) throw new Error('已有动作分析正在进行，请稍后开始新的捕获');

      const mode = ['observe', 'intercept'].includes(msg.mode) ? msg.mode : 'intercept';
      const timeoutSeconds = Math.max(5, Math.min(Number(msg.timeoutSeconds || 60), 300));
      const pattern = String(msg.pattern || '').trim();
      await chrome.storage.local.set({
        actionCaptureLastResult: {
          type: 'action_capture_loading',
          tabId,
          siteKey,
          actionName,
          mode,
          timeoutSeconds,
          pattern,
          startedAtMs: Date.now(),
          timestamp: Date.now(),
        },
      });
      let resolveCaptureReady;
      let rejectCaptureReady;
      const captureReady = new Promise((resolve, reject) => {
        resolveCaptureReady = resolve;
        rejectCaptureReady = reject;
      });

      void (async () => {
        try {
          const captureResult = await runActionCaptureWorkflow({
            tabId,
            site: siteKey,
            actionName,
            mode,
            timeoutSeconds,
            pattern,
            captureReadRequests: true,
            onReady: resolveCaptureReady,
          });
          await chrome.storage.local.set({
            actionCaptureLastResult: {
              type: 'action_capture_ai_loading',
              tabId,
              siteKey,
              actionName,
              startedAtMs: Date.parse(captureResult.startedAt || '') || Date.now(),
              result: captureResult,
              timestamp: Date.now(),
            },
          });
          const result = await finalizeActionCaptureResult(captureResult, {
            timeoutMs: 120000,
            analysisContextId: msg.analysisContextId,
          });
          await chrome.storage.local.set({
            actionCaptureLastResult: {
              type: 'action_capture',
              tabId,
              siteKey,
              actionName,
              startedAtMs: Date.parse(result.startedAt || '') || Date.now(),
              result,
              timestamp: Date.now(),
            },
          });
        } catch (err) {
          rejectCaptureReady(err);
          await chrome.storage.local.set({
            actionCaptureLastResult: {
              type: 'action_capture_error',
              tabId,
              siteKey,
              actionName,
              startedAtMs: Date.now(),
              error: err?.message || String(err),
              timestamp: Date.now(),
            },
          });
        }
      })();

      await Promise.race([
        captureReady,
        delay(7000).then(() => { throw new Error('操作捕获初始化超时，请重新录制'); }),
      ]);
      sendToNative({
        type: 'call_tool_result',
        id: msg.id,
        result: { ok: true, started: true, type: 'action_capture_loading', tabId, siteKey, actionName },
      });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }

  } else if (msg.type === 'exploration_action_capture_stop') {
    try {
      const tabId = Number(msg.tabId);
      const session = Number.isFinite(tabId) ? cdpActionCaptureSessions.get(tabId) : null;
      if (!session || typeof session.requestStop !== 'function') throw new Error('当前没有进行中的动作捕获');
      if (!session.requestStop('manual_stop')) throw new Error('动作捕获已经在结束中');
      const stored = await chrome.storage.local.get('actionCaptureLastResult');
      const state = stored.actionCaptureLastResult || {};
      await chrome.storage.local.set({
        actionCaptureLastResult: {
          ...state,
          type: 'action_capture_stopping',
          tabId,
          siteKey: String(msg.siteKey || session.site || state.siteKey || '').trim(),
          actionName: String(msg.actionName || session.actionName || state.actionName || '').trim(),
          stopRequestedAt: session.stopRequestedAt,
          timestamp: Date.now(),
        },
      });
      sendToNative({ type: 'call_tool_result', id: msg.id, result: { ok: true, stopping: true, type: 'action_capture_stopping', tabId } });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }

  } else if (msg.type === 'exploration_action_capture_analyze') {
    try {
      const state = await retryStoredActionCaptureAnalysis(msg);
      sendToNative({ type: 'call_tool_result', id: msg.id, result: state });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }

  } else if (msg.type === 'exploration_action_capture_get') {
    try {
      const stored = await chrome.storage.local.get('actionCaptureLastResult');
      let state = stored.actionCaptureLastResult || null;
      const requestedTabId = Number(msg.tabId);
      const requestedSiteKey = String(msg.siteKey || '').trim();
      if (state && ['action_capture_loading', 'action_capture_stopping', 'action_capture_ai_loading'].includes(state.type)) {
        const stateTabId = Number(state.tabId);
        const ageMs = Math.max(0, Date.now() - Number(state.timestamp || state.startedAtMs || Date.now()));
        let targetMissing = false;
        if (Number.isInteger(stateTabId)) {
          try {
            await chrome.tabs.get(stateTabId);
          } catch {
            targetMissing = true;
          }
        }
        const sessionMissing = Number.isInteger(stateTabId) && !cdpActionCaptureSessions.has(stateTabId);
        const abandoned = targetMissing
          || (state.type === 'action_capture_loading' && sessionMissing && ageMs > 5000)
          || (state.type === 'action_capture_stopping' && sessionMissing && ageMs > 10000)
          || (state.type === 'action_capture_ai_loading' && ageMs > 150000);
        if (abandoned) {
          state = {
            ...state,
            type: 'action_capture_error',
            code: targetMissing ? 'TARGET_TAB_NOT_FOUND' : 'ACTION_CAPTURE_SESSION_LOST',
            error: targetMissing ? '目标页面已经关闭，请重新选择页面并录制。' : '操作捕获会话已丢失，请重新录制。',
            recoverable: true,
            timestamp: Date.now(),
          };
          if (state.result && Array.isArray(state.result.capturedActions)) {
            state.type = 'action_capture';
            state.result = actionCaptureAnalysisFailure(state.result, '分析会话已中断，可重试已有证据的 AI 分析，无需重新操作网站', 'ACTION_ANALYSIS_INTERRUPTED');
          }
          await chrome.storage.local.set({ actionCaptureLastResult: state });
        }
      }
      if (state && Number.isInteger(requestedTabId) && Number(state.tabId) !== requestedTabId) {
        sendToNative({ type: 'call_tool_result', id: msg.id, result: null });
      } else if (state && requestedSiteKey && state.siteKey && String(state.siteKey) !== requestedSiteKey) {
        sendToNative({ type: 'call_tool_result', id: msg.id, result: null });
      } else {
        sendToNative({ type: 'call_tool_result', id: msg.id, result: state });
      }
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }

  } else if (msg.type === 'exploration_action_capture_select') {
    try {
      if (actionCaptureAnalysisRetries.size) throw new Error('动作分析仍在进行中，暂时不能修改主接口');
      const state = await selectStoredActionCapturePrimaryCandidate({
        siteKey: String(msg.siteKey || '').trim(),
        candidateIndex: msg.candidateIndex,
      });
      sendToNative({ type: 'call_tool_result', id: msg.id, result: state });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }

  } else if (msg.type === 'exploration_action_capture_clear') {
    try {
      const stored = await chrome.storage.local.get('actionCaptureLastResult');
      const state = stored.actionCaptureLastResult || null;
      if (actionCaptureAnalysisRetries.size) throw new Error('动作分析仍在进行中，暂时不能清空');
      const requestedTabId = Number(msg.tabId);
      const requestedSiteKey = String(msg.siteKey || '').trim();
      const matchesTab = !state || !Number.isInteger(requestedTabId) || Number(state.tabId) === requestedTabId;
      const matchesSite = !state || !requestedSiteKey || !state.siteKey || String(state.siteKey) === requestedSiteKey;
      if (matchesTab && matchesSite) await chrome.storage.local.remove('actionCaptureLastResult');
      sendToNative({
        type: 'call_tool_result',
        id: msg.id,
        result: { ok: true, cleared: Boolean(state && matchesTab && matchesSite) },
      });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }

  } else if (msg.type === "get_active_tab") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    sendToNative({ type: "get_active_tab_result", id: msg.id, tabId: tab?.id ?? null, url: tab?.url ?? null, title: tab?.title ?? null });

  } else if (msg.type === "get_trace_logs") {
    const swLogs = getTraceLogs(msg.traceID);
    let csLogs = [];
    if (msg.traceID) {
      const allTabs = await chrome.tabs.query({});
      for (const tab of allTabs) {
        try {
          const resp = await chrome.tabs.sendMessage(tab.id, { type: "get_trace_logs", traceID: msg.traceID });
          if (resp?.logs?.length) csLogs.push(...resp.logs);
        } catch { /* tab 可能没有 content script */ }
      }
    }
    sendToNative({ type: "get_trace_logs_result", id: msg.id, traceID: msg.traceID, logs: [...swLogs, ...csLogs].sort() });

  } else if (msg.type === "open_tab") {
    try {
      const tab = await createBrowserTab({ url: msg.url, active: true });
      sendToNative({ type: "call_tool_result", id: msg.id, result: { tabId: tab.id, url: tab.url } });
    } catch (err) {
      sendToNative({ type: "call_tool_error", id: msg.id, error: err.message });
    }
  } else if (msg.type === "screenshot_target") {
    // WeWorker 浏览器: the Bridge captures through its own CDP pipe (no "being debugged"
    // bar, no chrome.debugger); the extension only picks and selects the tab.
    const traceID = msg.traceID || null;
    try {
      const { tab, reason } = await prepareScreenshotTab(msg.tabId, traceID);
      const targetId = await debuggerTargetId({ api: chrome, tabId: tab.id });
      traceLog(traceID, `[ServiceWorker] screenshot_target: tab=${tab.id} target=${targetId || 'none'}`);
      sendToNative({
        type: "call_tool_result", id: msg.id, traceID,
        result: { tabId: tab.id, url: displayPageUrl(tab.url), reason, targetId },
      });
    } catch (err) {
      traceLog(traceID, `[ServiceWorker] screenshot_target 失败: ${err.message}`);
      sendToNative({ type: "call_tool_error", id: msg.id, error: err.message, traceID });
    }
  } else if (msg.type === "capture_screenshot") {
    const traceID = msg.traceID || null;
    const log = (line) => traceLog(traceID, `[ServiceWorker] capture_screenshot: ${line}`);
    // captureVisibleTab 在 MV3 下需要 <all_urls> 或带用户手势的 activeTab，
    // 仅按域名授予的 host 权限不满足（会抛 "Either the '<all_urls>' or 'activeTab' permission is required."）。
    // 项目安全策略禁止 <all_urls>，故权限不足时回退到已授权的 chrome.debugger（CDP Page.captureScreenshot）。
    async function captureVisible(tab, { format = "jpeg", quality = 80 } = {}) {
      try {
        return await chrome.tabs.captureVisibleTab(tab.windowId, { format, quality });
      } catch (err) {
        const m = err?.message || "";
        if (m.includes("'<all_urls>'") || m.includes("activeTab") || m.includes("permission")) {
          log('captureVisibleTab not permitted; using chrome.debugger');
          // A session another feature holds on this tab is borrowed, never detached.
          return await captureTabViaDebugger({ api: chrome, tabId: tab.id, borrowed: cdpAttachedTabs.has(tab.id), format, quality, log });
        }
        throw err;
      }
    }
    try {
      const { tab } = await prepareScreenshotTab(msg.tabId, traceID);
      const shotTab = { tabId: tab.id, url: displayPageUrl(tab.url) };

      // 使用chrome.tabs.captureVisibleTab截图（使用JPEG格式以获得更好的压缩）
      // 若权限不足，captureVisible 会自动回退到 chrome.debugger (CDP) 截图
      const dataUrl = await captureVisible(tab, {
        format: "jpeg",
        quality: 80  // 初始质量设为80
      });

      // 如果需要全页截图，需要通过content script滚动并拼接
      if (msg.fullPage) {
        // 发送消息给content script获取页面尺寸
        const pageInfo = await chrome.tabs.sendMessage(tab.id, { type: "get_page_dimensions" });

        if (pageInfo && pageInfo.scrollHeight > pageInfo.viewportHeight) {
          // 需要滚动截图并拼接
          const screenshots = [];
          const viewportHeight = pageInfo.viewportHeight;
          const totalHeight = pageInfo.scrollHeight;
          let currentScroll = 0;

          while (currentScroll < totalHeight) {
            // 滚动到指定位置
            await chrome.tabs.sendMessage(tab.id, {
              type: "scroll_to",
              y: currentScroll
            });

            // 等待滚动完成
            await new Promise(resolve => setTimeout(resolve, 300));

            // 截图
            const screenshot = await captureVisible(tab, {
              format: "jpeg",
              quality: 80
            });
            screenshots.push(screenshot);

            currentScroll += viewportHeight;
          }

          // 恢复滚动位置
          await chrome.tabs.sendMessage(tab.id, { type: "scroll_to", y: 0 });

          // 裁剪第一张截图（中心区域）
          const cropped = await cropImage(dataUrl);

          sendToNative({
            type: "call_tool_result",
            id: msg.id,
            traceID,
            result: {
              ...shotTab,
              data: cropped.data,
              width: cropped.width,
              height: cropped.height,
              fullPage: true,
              crop: {
                cropped: cropped.cropped,
                originalSize: cropped.originalSize,
                croppedSize: cropped.croppedSize,
                cropArea: cropped.cropArea
              },
              note: "全页截图功能需要进一步优化拼接逻辑"
            }
          });
        } else {
          // 页面高度小于视口，裁剪后返回
          const cropped = await cropImage(dataUrl);

          sendToNative({
            type: "call_tool_result",
            id: msg.id,
            traceID,
            result: {
              ...shotTab,
              data: cropped.data,
              width: cropped.width,
              height: cropped.height,
              fullPage: false,
              crop: {
                cropped: cropped.cropped,
                originalSize: cropped.originalSize,
                croppedSize: cropped.croppedSize,
                cropArea: cropped.cropArea
              }
            }
          });
        }
      } else {
        // 只截取可见区域，裁剪后返回
        const cropped = await cropImage(dataUrl);

        sendToNative({
          type: "call_tool_result",
          id: msg.id,
          traceID,
          result: {
            ...shotTab,
            data: cropped.data,
            width: cropped.width,
            height: cropped.height,
            fullPage: false,
            crop: {
              cropped: cropped.cropped,
              originalSize: cropped.originalSize,
              croppedSize: cropped.croppedSize,
              cropArea: cropped.cropArea
            }
          }
        });
      }
      log('done');
    } catch (err) {
      log(`失败: ${err.message}`);
      sendToNative({ type: "call_tool_error", id: msg.id, error: err.message, traceID });
    }
  } else if (msg.type === "reload_extension") {
    console.log("[WebMCP] Reloading extension by request from native host...");
    Promise.resolve()
      .then(() => chrome.offscreen?.closeDocument?.())
      .catch(() => {})
      .finally(() => chrome.runtime.reload());
  } else if (msg.type === "refresh_registry") {
    doRefreshRegistry()
      .then(r => console.log(`[WebMCP] Registry refreshed via CLI: ${r.count} adapters`))
      .catch(err => console.error(`[WebMCP] Registry refresh failed: ${err.message}`));
  } else if (msg.type === "refresh_adapter_tabs") {
    try {
      const result = await refreshAdapterTabs(String(msg.siteKey || '').trim());
      sendToNative({ type: "call_tool_result", id: msg.id, result });
    } catch (err) {
      sendToNative({ type: "call_tool_error", id: msg.id, error: err.message });
    }
  } else if (msg.type === 'browser_execute') {
    const operation = () => executeBrowserCommand(msg, { chrome, ensureCdpAttached, cdpEvaluate, getCdpNetworkSnapshot, onBrowserDetach: clearBrowserDebuggerState });
    // Read-only download observers must not block the click they are observing.
    const observer = ['dialog', 'downloads', 'events'].includes(msg.command) || (msg.command === 'wait' && msg.args?.kind === 'download');
    const result = Number.isInteger(msg.tabId) && !observer
      ? await getHostAdapterRuntime().exclusive(msg.tabId, operation) : await operation();
    sendToNative({ type: 'call_tool_result', id: msg.id, result });
  } else if (msg.type === 'browser_state') {
    try {
      const tabId = await getExplorationTabId(msg.tabId);
      if (!tabId) throw new Error('未找到可用于探索的标签页');
      const result = await sendExplorationMessage(tabId, { type: 'browser_state' });
      sendToNative({ type: 'call_tool_result', id: msg.id, result: { tabId, ...result } });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }
  } else if (msg.type === 'browser_network') {
    try {
      const tabId = await getExplorationTabId(msg.tabId);
      if (!tabId) throw new Error('未找到可用于探索的标签页');

      let result;
      try {
        result = await getCdpNetworkSnapshot(tabId, { businessOnly: true, includeTelemetry: msg.includeTelemetry === true, limit: 60 });
      } catch (cdpErr) {
        const fallback = await sendExplorationMessage(tabId, { type: 'browser_network' });
        result = {
          tabId,
          ...fallback,
          source: fallback?.source || 'performance',
          fallbackReason: cdpErr?.message || String(cdpErr),
        };
      }

      sendToNative({ type: 'call_tool_result', id: msg.id, result: { tabId, ...result } });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }
  } else if (msg.type === 'browser_eval') {
    try {
      const tabId = await getExplorationTabId(msg.tabId);
      if (!tabId) throw new Error('未找到可用于探索的标签页');
      const result = await sendExplorationMessage(tabId, { type: 'browser_eval', expression: msg.expression });
      sendToNative({ type: 'call_tool_result', id: msg.id, result: { tabId, value: result } });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }
  } else if (msg.type === 'browser_analyze') {
    try {
      const tabId = await getExplorationTabId(msg.tabId);
      if (!tabId) throw new Error('未找到可用于探索的标签页');
      const pageState = await sendExplorationMessage(tabId, { type: 'browser_state' });
      let network;
      try {
        network = await getCdpNetworkSnapshot(tabId, { businessOnly: true, limit: 60 });
      } catch {
        network = await sendExplorationMessage(tabId, { type: 'browser_network' });
      }
      const heuristicVerdict = classifySitePattern(pageState, network?.entries || []);
      const result = await enhanceExplorationResultWithAI({
        tabId,
        pageState,
        network,
        verdict: heuristicVerdict,
      });
      sendToNative({
        type: 'call_tool_result',
        id: msg.id,
        result,
      });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }
  } else if (msg.type === 'browser_explore_workflow') {
    try {
      const workflowResult = await runExploreWorkflow({ tabId: msg.tabId ?? null, url: msg.url ?? null });
      const result = await enhanceExplorationResultWithAI(workflowResult, { siteKey: workflowResult?.site || '' });
      sendToNative({ type: 'call_tool_result', id: msg.id, result });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }
  } else if (msg.type === 'browser_action_capture_workflow') {
    try {
      const captureResult = await runActionCaptureWorkflow({
        tabId: msg.tabId ?? null,
        url: msg.url ?? null,
        site: msg.site ?? '',
        actionName: msg.actionName ?? 'unknown_action',
        mode: msg.mode ?? 'intercept',
        timeoutSeconds: msg.timeoutSeconds ?? 90,
        pattern: msg.pattern ?? '',
      });
      const result = await finalizeActionCaptureResult(captureResult, { timeoutMs: 120000 });
      sendToNative({ type: 'call_tool_result', id: msg.id, result });
    } catch (err) {
      sendToNative({ type: 'call_tool_error', id: msg.id, error: err.message });
    }
  }
}

function sendToNative(msg, sensitive = false) {
  logCallToolTiming(msg);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("[WebMCP] Cannot send to native: not connected");
    return false;
  }
  console.log("[WebMCP] -> native:", sensitive ? { type: msg.type, id: msg.id } : msg);
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch (err) {
    console.warn("[WebMCP] Failed to send to native:", err.message);
    resetNativeSocket(err.message);
    return false;
  }
}

/**
 * ③ 扩展内部耗时观测：从收到 call_tool 到把结果/错误交回 bridge。
 * 写成既有 trace 的一部分（`webcli trace <traceID>` 可看到 ①②③ 三段），
 * 不记录参数与用户数据，也不改变控制流。
 */
const callToolTimings = new Map();

function noteCallToolStart(msg) {
  if (msg?.type !== 'call_tool' || !msg.id) return;
  callToolTimings.set(msg.id, { startedAt: Date.now(), traceID: msg.traceID || null, toolName: String(msg.toolName || '') });
  // 防御性上限：结果消息丢失时不会无限增长。
  if (callToolTimings.size > 64) callToolTimings.delete(callToolTimings.keys().next().value);
}

function logCallToolTiming(msg) {
  if (msg?.type !== 'call_tool_result' && msg?.type !== 'call_tool_error') return;
  const timing = callToolTimings.get(msg.id);
  if (!timing) return;
  callToolTimings.delete(msg.id);
  const internalMs = Date.now() - timing.startedAt;
  traceLog(timing.traceID || msg.traceID, `[ServiceWorker] call_tool 内部耗时 ${internalMs}ms (${timing.toolName || 'unknown'})`);
}

// ─── Trace 日志存储（按需拉取，不主动推送） ──────────────────────────────────

const traceLogs = new Map(); // traceID -> string[]
// Tab of the last Adapter command; capture_screenshot captures it (see screenshot.js).
const screenshotToolTabs = createToolTabTracker(typeof chrome !== 'undefined' ? chrome : undefined);

/** The tab capture_screenshot shows, selected in its window so that it paints. */
async function prepareScreenshotTab(tabId, traceID) {
  const toolTabId = await screenshotToolTabs.get();
  const picked = await pickScreenshotTab({ api: chrome, tabId: Number.isInteger(tabId) ? tabId : null, toolTabId });
  traceLog(traceID, `[ServiceWorker] 截图目标: tab=${picked.tab.id} (${picked.reason}) ${displayPageUrl(picked.tab.url)}${picked.tab.active ? '' : '，在窗口内选中'}`);
  const tab = await selectTabForScreenshot({ api: chrome, tab: picked.tab });
  return { tab, reason: picked.reason };
}

function traceLog(traceID, message) {
  if (!traceID) return;
  if (!traceLogs.has(traceID)) traceLogs.set(traceID, []);
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  traceLogs.get(traceID).push(`[${ts}] [${traceID}] ${message}`);
  // 限制每个 traceID 最多 100 条，防止内存泄漏
  if (traceLogs.get(traceID).length > 100) {
    traceLogs.get(traceID).shift();
  }
}

function getTraceLogs(traceID) {
  return traceLogs.get(traceID) || [];
}

function requestBridge(msg, timeoutMs, timeoutError) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ ok: false, error: lastBridgeDisconnectReason || 'Bridge 未连接' });
  }

  return new Promise((resolve) => {
    const reqId = `${msg.type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      if (pendingWriteRequests.has(reqId)) {
        pendingWriteRequests.delete(reqId);
        resolve({ ok: false, error: timeoutError || 'Bridge 未响应' });
      }
    }, timeoutMs);
    pendingWriteRequests.set(reqId, { resolve, reject: resolve, timer });
    sendToNative({ ...msg, id: reqId });
  });
}

async function enhanceExplorationResultWithAI(result, options = {}) {
  const heuristicVerdict = result?.verdict || null;
  const siteKey = String(
    options.siteKey
      || result?.site
      || result?.pageStateAfter?.url
      || result?.pageState?.url
      || ""
  ).trim();

  const withHeuristicFallback = (errorMessage = "") => ({
    ...result,
    verdict: {
      ...(heuristicVerdict || {
        pattern: 'dom_driven',
        recommendedStrategy: 'UI',
        reason: '未获取到有效探索结论，已回退到默认 UI 策略。',
      }),
      analysisSource: 'heuristic',
      aiError: errorMessage || '',
    },
    heuristicVerdict: heuristicVerdict || null,
  });

  if (!heuristicVerdict) {
    return withHeuristicFallback('missing_heuristic_verdict');
  }

  const response = await requestBridge(
    {
      type: 'analyze_exploration_result',
      siteKey,
      explorationResult: result,
      heuristicVerdict,
    },
    Math.max(1000, Number(options.timeoutMs || 120000)),
    '探索结果 AI 分析超时，已回退到规则分析',
  );

  if (!response?.ok || !response.analysis) {
    return withHeuristicFallback(response?.error || '探索结果 AI 分析失败');
  }

  return {
    ...result,
    heuristicVerdict,
    aiAnalysis: response.analysis,
    verdict: {
      pattern: response.analysis.pattern,
      recommendedStrategy: response.analysis.recommendedStrategy,
      reason: response.analysis.reason,
      observedSummary: response.analysis.observedSummary || '',
      confidence: response.analysis.confidence,
      analysisSource: response.analysis.analysisSource || 'ai',
      model: response.analysis.model || '',
      provider: response.analysis.provider || '',
      topApiCandidates: Array.isArray(response.analysis.topApiCandidates) ? response.analysis.topApiCandidates : [],
      nextSteps: Array.isArray(response.analysis.nextSteps) ? response.analysis.nextSteps : [],
    },
  };
}

const REQUEST_TRUNCATION_MARKER_RE = /(?:\.{0,3}\[truncated\]|…\s*\[truncated\])\s*$/i;

function capturedValueShape(value, depth = 0) {
  if (depth >= 8) return { type: 'unknown' };
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', items: value.length > 0 ? capturedValueShape(value[0], depth + 1) : { type: 'unknown' } };
  if (value && typeof value === 'object') {
    return { type: 'object', properties: Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, capturedValueShape(nested, depth + 1)])) };
  }
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'string') return { type: 'string' };
  return { type: 'unknown' };
}

function capturedBodyKeys(shape) {
  return shape?.type === 'object' && shape.properties && typeof shape.properties === 'object'
    ? Object.keys(shape.properties).sort()
    : [];
}

function buildSafeRequestEvidence(entry = {}) {
  if (entry.requestEvidence && typeof entry.requestEvidence === 'object') return entry.requestEvidence;
  const text = String(entry.requestBodyPreview || '').trim();
  if (!text) return { version: 'request-evidence-v1', bodyKind: 'none', bodyShape: null, bodyKeys: [], bodyFullSize: 0, bodyTruncated: false, bodyOmitted: false };
  const bodyFullSize = Number(entry.requestBodyFullSize) || text.length;
  const bodyTruncated = Boolean(entry.requestBodyTruncated) || REQUEST_TRUNCATION_MARKER_RE.test(text) || bodyFullSize > text.length;
  if (bodyTruncated) return { version: 'request-evidence-v1', bodyKind: 'opaque', bodyShape: null, bodyKeys: [], bodyFullSize, bodyTruncated: true, bodyOmitted: true };
  try {
    const bodyShape = capturedValueShape(JSON.parse(text));
    return { version: 'request-evidence-v1', bodyKind: 'json', bodyShape, bodyKeys: capturedBodyKeys(bodyShape), bodyFullSize, bodyTruncated: false, bodyOmitted: false };
  } catch {
    if (text.startsWith('{') || text.startsWith('[')) return { version: 'request-evidence-v1', bodyKind: 'opaque', bodyShape: null, bodyKeys: [], bodyFullSize, bodyTruncated: false, bodyOmitted: true };
  }
  if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(text)) {
    const bodyShape = capturedValueShape(Object.fromEntries(new URLSearchParams(text)));
    return { version: 'request-evidence-v1', bodyKind: 'form', bodyShape, bodyKeys: capturedBodyKeys(bodyShape), bodyFullSize, bodyTruncated: false, bodyOmitted: false };
  }
  return { version: 'request-evidence-v1', bodyKind: 'opaque', bodyShape: null, bodyKeys: [], bodyFullSize, bodyTruncated: false, bodyOmitted: true };
}

function structuralCapturedUrl(input) {
  try {
    const url = new URL(String(input || ''));
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, ':value');
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return String(input || '').split('#', 1)[0];
  }
}

function structuralizeStoredTextUrls(value) {
  return safeStoredText(value).replace(/https?:\/\/[^\s，。；）)]+/g, (url) => structuralCapturedUrl(url));
}

function sanitizeActionCaptureResult(result = {}) {
  return {
    ...result,
    capturedActions: (Array.isArray(result.capturedActions) ? result.capturedActions : []).map((candidate) => {
      const { requestBodyPreview, requestBody, requestHeaders, ...safeCandidate } = candidate || {};
      return {
        ...safeCandidate,
        url: structuralCapturedUrl(candidate?.url),
        requestEvidence: buildSafeRequestEvidence(candidate),
      };
    }),
  };
}

function actionCaptureAnalysisFailure(result, errorMessage = '', code = 'ACTION_ANALYSIS_FAILED', details = {}) {
  const safeResult = sanitizeActionCaptureResult(result);
  const heuristicRecommendation = safeResult?.recommendation || {};
  return {
    ...safeResult,
    actionAnalysis: {
      analysisSource: 'heuristic',
      summary: safeResult?.capturedActions?.length > 0
        ? 'AI 分析失败，已保留当前动作捕获与规则结论。'
        : '本次没有捕获到足够的动作候选，已保留规则结论。',
      recommendedToolName: heuristicRecommendation.toolName || '',
      recommendedNextStep: heuristicRecommendation.nextStep || '',
      actionKind: 'unknown',
      confidence: null,
      candidateAnalyses: [],
      aiError: errorMessage || '',
      errorCode: code,
      ...(Number.isSafeInteger(details?.outputLimit) ? { outputLimit: details.outputLimit } : {}),
    },
  };
}

// Only re-analyze retained evidence: no debugger, page interaction or request replay.
const actionCaptureAnalysisRetries = new Set();
async function retryStoredActionCaptureAnalysis(msg) {
  const tabId = Number(msg.tabId);
  if (actionCaptureAnalysisRetries.size) throw new Error('动作分析仍在进行中');
  actionCaptureAnalysisRetries.add(tabId);
  let handedOff = false;
  try {
    const stored = await chrome.storage.local.get('actionCaptureLastResult');
    const state = stored.actionCaptureLastResult;
    if (!state?.result || !Array.isArray(state.result.capturedActions)) throw new Error('没有保留的捕获证据可供分析，请勿重复执行写操作');
    if (Number(state.tabId) !== tabId || state.result.site !== msg.siteKey || state.result.actionName !== msg.actionName) throw new Error('捕获证据与当前任务不匹配');
    if (['action_capture_loading', 'action_capture_stopping', 'action_capture_ai_loading'].includes(state.type) || cdpActionCaptureSessions.has(tabId)) throw new Error('动作捕获或分析仍在进行中');
    const loading = { ...state, type: 'action_capture_ai_loading', analysisAttemptId: msg.id, timestamp: Date.now() };
    await chrome.storage.local.set({ actionCaptureLastResult: loading });
    void (async () => {
      try {
        let result;
        try {
          result = await finalizeActionCaptureResult(state.result, { analysisContextId: msg.analysisContextId, timeoutMs: 120000 });
        } catch (err) {
          result = actionCaptureAnalysisFailure(state.result, err?.message || '动作分析失败');
        }
        const current = (await chrome.storage.local.get('actionCaptureLastResult')).actionCaptureLastResult;
        if (current?.analysisAttemptId === msg.id) {
          const { analysisAttemptId, ...settled } = loading;
          await chrome.storage.local.set({ actionCaptureLastResult: { ...settled, type: 'action_capture', result, timestamp: Date.now() } });
        }
      } finally {
        actionCaptureAnalysisRetries.delete(tabId);
      }
    })().catch(() => {}); // A storage failure is reconciled by the normal state polling path.
    handedOff = true;
    return loading;
  } finally {
    if (!handedOff) actionCaptureAnalysisRetries.delete(tabId);
  }
}

async function enhanceActionCaptureResultWithAI(result, options = {}) {
  const safeResult = sanitizeActionCaptureResult(result);
  const heuristicRecommendation = safeResult?.recommendation || {};

  let response;
  try {
    response = await requestBridge(
      {
        type: 'analyze_action_capture_result',
        captureResult: safeResult,
        ...(options.analysisContextId !== undefined ? { analysisContextId: options.analysisContextId } : {}),
      },
      Math.max(1000, Number(options.timeoutMs || 120000)),
      '动作捕获 AI 分析超时，已保留证据，可重试分析，无需重新操作网站',
    );
  } catch (err) {
    return actionCaptureAnalysisFailure(safeResult, err?.message || '动作分析连接中断', err?.code || 'ACTION_ANALYSIS_UNAVAILABLE');
  }

  if (!response?.ok || !response.analysis) {
    return actionCaptureAnalysisFailure(safeResult, response?.error || '动作捕获 AI 分析失败', response?.code, response?.details);
  }

  const analysis = response.analysis;
  const analysisByKey = new Map(
    (Array.isArray(analysis.candidateAnalyses) ? analysis.candidateAnalyses : []).map((item) => [
      `${String(item.method || 'GET').toUpperCase()} ${String(item.url || '')}`,
      item,
    ]),
  );

  const enhancedCandidates = Array.isArray(safeResult?.capturedActions)
    ? safeResult.capturedActions.map((candidate) => {
      const key = `${String(candidate?.method || 'GET').toUpperCase()} ${String(candidate?.url || '')}`;
      const match = analysisByKey.get(key);
      if (!match) return candidate;
      return {
        ...candidate,
        aiPurpose: match.purpose || '',
        aiWhy: match.why || '',
        aiIsPrimary: Boolean(match.isPrimary),
        aiToolNameSuggestion: match.toolNameSuggestion || '',
        aiParameterHints: Array.isArray(match.parameterHints) ? match.parameterHints : [],
        aiRisk: match.risk || '',
      };
    })
    : [];

  return {
    ...safeResult,
    capturedActions: enhancedCandidates,
    recommendation: {
      ...heuristicRecommendation,
      toolName: analysis.recommendedToolName || heuristicRecommendation.toolName || '',
      nextStep: analysis.recommendedNextStep || heuristicRecommendation.nextStep || '',
    },
    actionAnalysis: {
      ...analysis,
      analysisSource: analysis.analysisSource || 'ai',
    },
  };
}

async function finalizeActionCaptureResult(result, options = {}) {
  const enhanced = await enhanceActionCaptureResultWithAI(result, options);
  try {
    enhanced.siteMemoryUpdate = await persistActionCaptureToSiteMemory(enhanced);
  } catch (err) {
    enhanced.siteMemoryUpdate = {
      ok: false,
      error: err?.message || String(err),
    };
  }
  return enhanced;
}

// ─── 工具注册表管理 ─────────────────────────────────────────────────────────

/**
 * 比较两个工具列表是否相同（深度比较）
 * @param {Array} tools1
 * @param {Array} tools2
 * @returns {boolean}
 */
function toolsAreEqual(tools1, tools2) {
  if (tools1.length !== tools2.length) return false;

  // 按名称排序后比较（避免顺序不同导致误判）
  const sorted1 = [...tools1].sort((a, b) => a.name.localeCompare(b.name));
  const sorted2 = [...tools2].sort((a, b) => a.name.localeCompare(b.name));

  for (let i = 0; i < sorted1.length; i++) {
    const t1 = sorted1[i];
    const t2 = sorted2[i];

    // 比较关键字段
    if (t1.name !== t2.name ||
      t1.publicName !== t2.publicName ||
      t1.handlerName !== t2.handlerName ||
      t1.adapterId !== t2.adapterId ||
      t1.routeDomain !== t2.routeDomain ||
      t1.tabDomain !== t2.tabDomain ||
      t1.excludeTabDomain !== t2.excludeTabDomain ||
      t1.directCapable !== t2.directCapable ||
      t1.preferDirect !== t2.preferDirect ||
      t1.executionMode !== t2.executionMode ||
      t1.description !== t2.description ||
      JSON.stringify(t1.parameters) !== JSON.stringify(t2.parameters)) {
      return false;
    }
  }

  return true;
}

function gatherAllTools() {
  const all = [];
  const liveNames = new Set();
  for (const [domain, domainData] of toolRegistry.entries()) {
    for (const tool of domainData.tools) {
      liveNames.add(tool.publicName || tool.name);
      all.push({ ...tool, domain, tabCount: domainData.tabIds.size });
    }
  }
  for (const tool of gatherStaticTools()) {
    if (liveNames.has(tool.publicName || tool.name)) continue;
    all.push(tool);
  }
  return all;
}

function gatherStaticTools() {
  const tools = [];
  const seen = new Set();
  for (const definition of staticToolDefinitionIndex.values()) {
    const publicName = definition.publicName || definition.name;
    if (!publicName || publicName !== definition.name) continue;
    if (seen.has(publicName)) continue;
    seen.add(publicName);
    tools.push({
      ...definition,
      name: publicName,
      publicName,
      domain: definition.routeDomain || definition.adapterId,
      tabCount: 0,
      direct: isDirectCapableRoute(definition),
    });
  }
  return tools;
}

/**
 * 从工具名中提取域名
 * 工具名格式：<domain>.<action>
 * 例如：mail.163.com.search_emails -> mail.163.com
 */
function extractDomainFromToolName(toolName) {
  // 找到最后一个点的位置，之前的部分是域名
  const lastDotIndex = toolName.lastIndexOf('.');
  if (lastDotIndex === -1) return null;
  return toolName.substring(0, lastDotIndex);
}

function normalizeRouteField(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeRouteHosts(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(values
    .map(item => String(item || "").trim().replace(/^\.+/, "").toLowerCase())
    .filter(Boolean))];
}

function normalizeExecutionMode(value) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return mode === "direct" || mode === "page" || mode === "tab" ? mode : undefined;
}

function isGeneratedCommandDirectCapable(command = {}) {
  const executionMode = normalizeExecutionMode(command.executionMode);
  if (executionMode === "page" || executionMode === "tab") return false;
  if (command.directCapable === true || command.preferDirect === true) return true;
  if (executionMode === "direct") return true;
  return command.browser === true && command.navigateBefore === false;
}

function isDirectCapableRoute(route = {}) {
  const executionMode = normalizeExecutionMode(route.executionMode);
  if (executionMode === "page" || executionMode === "tab") return false;
  return route.directCapable === true
    || route.preferDirect === true
    || executionMode === "direct";
}

function normalizeToolRoute(tool, fallbackAdapterId) {
  const publicName = normalizeRouteField(tool.publicName) ?? normalizeRouteField(tool.name);
  const handlerName = normalizeRouteField(tool.handlerName) ?? normalizeRouteField(tool.name);
  const adapterId = normalizeRouteField(tool.adapterId) ?? fallbackAdapterId;
  const routeDomain = normalizeRouteField(tool.routeDomain) ?? adapterId ?? extractDomainFromToolName(handlerName);
  const allowedHosts = normalizeRouteHosts(tool.allowedHosts);

  if (!publicName || !handlerName || !adapterId || !routeDomain) {
    throw new Error(`Invalid ToolRoute metadata for "${publicName ?? tool.name ?? "unknown"}"`);
  }

  return {
    publicName,
    handlerName,
    adapterId,
    routeDomain,
    ...(normalizeRouteField(tool.tabDomain) ? { tabDomain: normalizeRouteField(tool.tabDomain) } : {}),
    ...(normalizeRouteField(tool.excludeTabDomain) ? { excludeTabDomain: normalizeRouteField(tool.excludeTabDomain) } : {}),
    ...(allowedHosts.length ? { allowedHosts } : {}),
    ...(typeof tool.directCapable === "boolean" ? { directCapable: tool.directCapable } : {}),
    ...(tool.preferDirect === true ? { preferDirect: true } : {}),
    ...(normalizeExecutionMode(tool.executionMode) ? { executionMode: normalizeExecutionMode(tool.executionMode) } : {}),
  };
}

function mergeToolRoute(primary, fallback) {
  if (!primary) return fallback;
  if (!fallback) return primary;
  const allowedHosts = normalizeRouteHosts(primary.allowedHosts).length
    ? normalizeRouteHosts(primary.allowedHosts)
    : normalizeRouteHosts(fallback.allowedHosts);
  return {
    ...fallback,
    ...primary,
    ...(allowedHosts.length ? { allowedHosts } : {}),
    excludeTabDomain: primary.excludeTabDomain ?? fallback.excludeTabDomain,
    tabDomain: primary.tabDomain ?? fallback.tabDomain,
    directCapable: primary.directCapable ?? fallback.directCapable,
    preferDirect: primary.preferDirect ?? fallback.preferDirect,
    executionMode: primary.executionMode ?? fallback.executionMode,
  };
}

function routeHostsEqual(left = [], right = []) {
  const l = normalizeRouteHosts(left);
  const r = normalizeRouteHosts(right);
  return l.length === r.length && l.every((item, index) => item === r[index]);
}

function toolRoutesEqual(left, right) {
  return left.publicName === right.publicName
    && left.handlerName === right.handlerName
    && left.adapterId === right.adapterId
    && left.routeDomain === right.routeDomain
    && left.tabDomain === right.tabDomain
    && left.excludeTabDomain === right.excludeTabDomain
    && left.directCapable === right.directCapable
    && left.preferDirect === right.preferDirect
    && left.executionMode === right.executionMode
    && routeHostsEqual(left.allowedHosts, right.allowedHosts);
}

function formatToolRoute(route) {
  return [
    `adapterId=${route.adapterId}`,
    `publicName=${route.publicName}`,
    `handlerName=${route.handlerName}`,
    `routeDomain=${route.routeDomain}`,
    `tabDomain=${route.tabDomain ?? ""}`,
    `excludeTabDomain=${route.excludeTabDomain ?? ""}`,
    `allowedHosts=${(route.allowedHosts || []).join("|")}`,
    `directCapable=${route.directCapable === true}`,
    `preferDirect=${route.preferDirect === true}`,
    `executionMode=${route.executionMode ?? ""}`,
  ].join(",");
}

function setToolRouteIndexEntry(nextIndex, key, route, keyKind) {
  if (!key) return;
  const existing = nextIndex.get(key);
  if (existing && !toolRoutesEqual(existing, route)) {
    throw new Error(
      `Duplicate ${keyKind} tool name "${key}": `
      + `existing={${formatToolRoute(existing)}} incoming={${formatToolRoute(route)}}`
    );
  }
  nextIndex.set(key, route);
}

function addToolRouteIndexEntries(nextIndex, route) {
  setToolRouteIndexEntry(nextIndex, route.publicName, route, "public");
}

function isLegacyWecliHandlerName(toolName) {
  return typeof toolName === "string" && /\.wecli_/.test(toolName);
}

function buildToolRouteIndex(replacementDomain, replacementTools) {
  const nextIndex = new Map();
  const existingRoutes = [];
  const incomingRoutes = [];

  for (const [domain, domainData] of toolRegistry) {
    if (domain === replacementDomain) continue;
    for (const tool of domainData.tools) {
      existingRoutes.push(normalizeToolRoute(tool, domain));
    }
  }
  for (const tool of replacementTools ?? []) {
    incomingRoutes.push(normalizeToolRoute(tool, replacementDomain));
  }

  const compareRoutes = (left, right) =>
    left.publicName.localeCompare(right.publicName)
    || formatToolRoute(left).localeCompare(formatToolRoute(right))
  ;
  existingRoutes.sort(compareRoutes);
  incomingRoutes.sort(compareRoutes);

  for (const route of existingRoutes) addToolRouteIndexEntries(nextIndex, route);

  for (const route of incomingRoutes) addToolRouteIndexEntries(nextIndex, route);

  return nextIndex;
}

function replaceToolRouteIndex(nextIndex) {
  toolRouteIndex.clear();
  for (const [key, route] of nextIndex) {
    toolRouteIndex.set(key, route);
  }
}

function rebuildToolRouteIndex() {
  replaceToolRouteIndex(buildToolRouteIndex(null, []));
}

/**
 * 查找工具的元数据（tabDomain / excludeTabDomain）
 * @param {string} toolName
 * @returns {{ tabDomain?: string, excludeTabDomain?: string } | null}
 */
function getToolMeta(toolName) {
  for (const [, domainData] of toolRegistry) {
    const tool = domainData.tools.find(t => t.name === toolName);
    if (tool) return { tabDomain: tool.tabDomain, excludeTabDomain: tool.excludeTabDomain };
  }
  return null;
}

function getRegisteredToolDefinition(publicName, handlerName) {
  for (const [, domainData] of toolRegistry) {
    const tool = domainData.tools.find(t =>
      t.name === publicName
      || t.publicName === publicName
      || (handlerName && t.handlerName === handlerName)
    );
    if (tool) return tool;
  }
  return staticToolDefinitionIndex.get(publicName)
    ?? (handlerName ? staticToolDefinitionIndex.get(handlerName) : null)
    ?? null;
}

function isMissingToolArg(value) {
  return value === undefined || value === null || value === "";
}

function normalizeToolArgsForSchema(args = {}, schema = {}) {
  if (!schema || schema.type !== "object") return args || {};
  const result = { ...(args || {}) };
  const properties = schema.properties || {};
  for (const [name, definition] of Object.entries(properties)) {
    const value = result[name];
    if (definition?.type === "integer" && typeof value === "string" && value.trim() !== "") {
      const numberValue = Number(value.trim());
      if (Number.isInteger(numberValue)) result[name] = numberValue;
    }
    if (definition?.type === "number" && typeof value === "string" && value.trim() !== "") {
      const numberValue = Number(value.trim());
      if (Number.isFinite(numberValue)) result[name] = numberValue;
    }
    if (definition?.type === "array" && definition?.items?.type === "integer" && typeof value === "string") {
      const parts = value.split(",").map(part => part.trim()).filter(Boolean);
      const numberValues = parts.map(part => Number(part));
      if (parts.length > 0 && numberValues.every(Number.isInteger)) result[name] = numberValues;
    }
  }
  return result;
}

function validateToolValueType(name, value, definition = {}) {
  const type = definition.type;
  const ok = type === "array" ? Array.isArray(value)
    : type === "integer" ? Number.isInteger(value)
    : type === "number" ? typeof value === "number" && Number.isFinite(value)
    : type === "boolean" ? typeof value === "boolean"
    : type === "object" ? typeof value === "object" && value !== null && !Array.isArray(value)
    : type === "string" ? typeof value === "string"
    : true;
  if (!ok) {
    throw new Error(`Invalid type for argument ${name}: expected ${type}`);
  }
  if (Array.isArray(definition.enum) && !definition.enum.includes(value)) {
    throw new Error(`Invalid value for argument ${name}: expected one of ${definition.enum.join(", ")}`);
  }
}

function validateToolCallArgs(args = {}, schema = {}) {
  if (!schema || schema.type !== "object") return args || {};
  let result = { ...(args || {}) };
  const properties = schema.properties || {};
  const required = schema.required || [];
  const controlArgs = new Set(["__confirmed", "dry-run"]);

  for (const [name, definition] of Object.entries(properties)) {
    if (!(name in result) && Object.prototype.hasOwnProperty.call(definition, "default")) {
      result[name] = definition.default;
    }
  }
  result = normalizeToolArgsForSchema(result, schema);

  for (const name of required) {
    if (isMissingToolArg(result[name])) {
      throw new Error(`Missing required argument: ${name}`);
    }
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const matched = schema.anyOf.some(option =>
      (option.required || []).every(name => !isMissingToolArg(result[name]))
    );
    if (!matched) {
      const choices = schema.anyOf
        .map(option => (option.required || []).join(" and "))
        .filter(Boolean)
        .join(" or ");
      if (choices) throw new Error(`Missing required argument: ${choices}`);
    }
  }

  if (schema.additionalProperties === false) {
    for (const name of Object.keys(result)) {
      if (!(name in properties) && !controlArgs.has(name)) {
        throw new Error(`Unknown argument: ${name}`);
      }
    }
  }

  for (const [name, definition] of Object.entries(properties)) {
    if (isMissingToolArg(result[name])) continue;
    validateToolValueType(name, result[name], definition);
  }

  return result;
}

function getToolErrorResultMessage(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  if (result.ok === true || result.success === true) return "";
  if (typeof result.error !== "string" || !result.error.trim()) return "";
  const message = typeof result.message === "string" && result.message.trim() && result.message !== result.error
    ? `${result.error}: ${result.message}`
    : result.error;
  return message;
}

function registerDirectAdapter(adapter) {
  if (!adapter || !Array.isArray(adapter.tools)) return;

  let registered = 0;
  for (const tool of adapter.tools) {
    if (typeof tool?.handler !== "function") continue;
    const publicName = tool.publicName ?? tool.name;
    const handlerName = tool.handlerName ?? tool.name;
    if (!handlerName) continue;
    directToolRegistry.set(handlerName, {
      ...tool,
      publicName,
      handlerName,
      adapterId: tool.adapterId ?? adapter.adapterId,
      routeDomain: tool.routeDomain ?? adapter.routeDomain,
      tabDomain: tool.tabDomain ?? adapter.tabDomain,
      excludeTabDomain: tool.excludeTabDomain ?? adapter.excludeTabDomain,
      allowedHosts: normalizeRouteHosts(tool.allowedHosts ?? adapter.allowedHosts),
    });
    registered += 1;
  }

  console.log(`[WebMCP] Direct adapter "${adapter.adapterId || "unknown"}" registered ${registered} handlers`);
}

function createDirectWecliRuntime() {
  const CONTROL_ARGS = new Set(["__confirmed", "dry-run"]);

  function createRuntimeError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  function validateArgs(args = {}, schema = {}) {
    if (!schema || schema.type !== "object") return args || {};
    let result = { ...(args || {}) };
    const properties = schema.properties || {};
    const required = schema.required || [];

    for (const [name, definition] of Object.entries(properties)) {
      if (!(name in result) && Object.prototype.hasOwnProperty.call(definition, "default")) {
        result[name] = definition.default;
      }
    }
    result = normalizeToolArgsForSchema(result, schema);

    for (const name of required) {
      if (isMissingToolArg(result[name])) {
        throw createRuntimeError("INVALID_ARGS", `Missing required argument: ${name}`, { argument: name });
      }
    }

    if (schema.additionalProperties === false) {
      for (const name of Object.keys(result)) {
        if (!(name in properties) && !CONTROL_ARGS.has(name)) {
          throw createRuntimeError("INVALID_ARGS", `Unknown argument: ${name}`, { argument: name });
        }
      }
    }

    for (const [name, definition] of Object.entries(properties)) {
      if (isMissingToolArg(result[name])) continue;
      validateToolValueType(name, result[name], definition);
    }

    return result;
  }

  function requireConfirmation(args = {}, toolName = "this command") {
    if (args.__confirmed === true || args.yes === true) {
      return true;
    }
    throw createRuntimeError("CONFIRMATION_REQUIRED", `${toolName} requires explicit user confirmation`, { toolName });
  }

  async function fetchJson(input, init = {}) {
    const traceID = directRuntimeContext?.traceID || null;
    traceLog(traceID, `[DirectRuntime] fetchJson request ${JSON.stringify({
      method: String(init.method || "GET").toUpperCase(),
      url: String(input),
    })}`);
    const response = await handleDirectRuntimeRequest("backend_fetch", {
      url: String(input),
      options: {
        method: init.method || "GET",
        headers: {
          Accept: "application/json",
          ...(init.headers || {}),
        },
        body: init.body,
      },
    });
    const contentType = response?.headers?.["content-type"] || response?.headers?.["Content-Type"] || "";
    const text = response?.body ?? "";
    let body = text;
    if (String(contentType).includes("json") || (typeof text === "string" && /^[\[{]/.test(text.trim()))) {
      try {
        body = JSON.parse(text);
      } catch { }
    }
    traceLog(traceID, `[DirectRuntime] fetchJson response ${JSON.stringify({
      status: response?.status,
      ok: response?.ok,
      contentType,
      body: summarizeDirectTraceData(body, 800),
    })}`);
    if (!response?.ok) {
      throw createRuntimeError("HTTP_ERROR", `HTTP ${response?.status}`, { status: response?.status, body });
    }
    return body;
  }

  async function requestPrivileged(action, payload = {}) {
    const traceID = directRuntimeContext?.traceID || null;
    traceLog(traceID, `[DirectRuntime] ${action} request ${JSON.stringify(summarizeDirectPrivilegedPayload(action, payload))}`);
    try {
      const result = await handleDirectRuntimeRequest(action, payload);
      traceLog(traceID, `[DirectRuntime] ${action} response ${JSON.stringify(summarizeDirectPrivilegedResult(action, result))}`);
      return result;
    } catch (err) {
      traceLog(traceID, `[DirectRuntime] ${action} error ${JSON.stringify(sanitizeDirectTraceValue({
        code: err?.code,
        message: err?.message,
        details: err?.details,
      }))}`);
      throw createRuntimeError(err?.code || "RUNTIME_HELPER_ERROR", err?.message || String(err), err?.details || {});
    }
  }

  function setFileInput(selector, files) {
    return requestPrivileged("set_file_input", { selector, files });
  }

  return {
    createRuntimeError,
    validateArgs,
    requireConfirmation,
    fetchJson,
    requestPrivileged,
    getContext: () => directRuntimeContext ? { ...directRuntimeContext } : null,
    setFileInput,
  };
}

function sanitizeDirectTraceValue(value, key = "") {
  if (value == null) return value;
  if (/cookie|authorization|token|ticket|session|password|passwd|secret|csrf|credential|signature/i.test(String(key))) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text ? `[redacted length=${text.length}]` : "";
  }
  if (typeof value === "string") return value.length > 3000 ? `${value.slice(0, 3000)}...[truncated ${value.length - 3000} chars]` : value;
  if (Array.isArray(value)) return value.map((item) => sanitizeDirectTraceValue(item, key));
  if (typeof value === "object") {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = sanitizeDirectTraceValue(childValue, childKey);
    }
    return result;
  }
  return value;
}

function summarizeDirectTraceBody(body, limit = 3000) {
  if (body == null) return undefined;
  const text = String(body);
  try {
    return summarizeDirectTraceData(JSON.parse(text), limit);
  } catch {
    return text.length > limit ? `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]` : text;
  }
}

function summarizeDirectTraceData(value, limit = 3000) {
  if (value == null) return value;
  const text = typeof value === "string" ? value : JSON.stringify(sanitizeDirectTraceValue(value));
  return text.length > limit ? `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]` : text;
}

function summarizeDirectPrivilegedPayload(action, payload = {}) {
  if (action === "backend_fetch" || action === "browser_fetch") {
    const options = payload && typeof payload.options === "object" && !Array.isArray(payload.options) ? payload.options : payload;
    return {
      url: payload.url,
      method: String(options?.method || "GET").toUpperCase(),
      headers: sanitizeDirectTraceValue(options?.headers || {}),
      body: summarizeDirectTraceBody(options?.body),
    };
  }
  if (action === "backend_file_read" || action === "backend_xlsx_read" || action === "backend_file_write") {
    return sanitizeDirectTraceValue({ ...payload, content: payload?.content ? `[content length=${String(payload.content).length}]` : undefined });
  }
  return sanitizeDirectTraceValue(payload);
}

function summarizeDirectPrivilegedResult(action, result) {
  if (action === "backend_fetch" || action === "browser_fetch") {
    return {
      status: result?.status,
      ok: result?.ok,
      headers: sanitizeDirectTraceValue(result?.headers || {}),
      body: summarizeDirectTraceBody(result?.body, 800),
    };
  }
  if (action === "cookies_get") {
    const cookies = Array.isArray(result?.cookies) ? result.cookies : [];
    return {
      count: cookies.length,
      cookies: cookies.map(cookie => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
      })),
    };
  }
  return sanitizeDirectTraceValue(result);
}

function createDirectContextTab() {
  const routeDomain = directRuntimeContext?.routeDomain || directRuntimeContext?.adapterId;
  if (!routeDomain) {
    throw createRuntimeHelperError("NO_ROUTE_DOMAIN", "Direct runtime requires routeDomain");
  }
  return {
    id: null,
    url: `${directRuntimeContext?.scheme || "http"}://${routeDomain}/`,
  };
}

function createPageContextRequiredError(action) {
  return createRuntimeHelperError(
    "PAGE_CONTEXT_REQUIRED",
    `Runtime helper "${action}" requires a page context and cannot run without a matching tab`,
    { action }
  );
}

async function findDirectRuntimeContextTab() {
  const routeDomain = directRuntimeContext?.routeDomain || directRuntimeContext?.adapterId;
  const requiredTabDomain = directRuntimeContext?.tabDomain || routeDomain;
  const excludeTabDomain = directRuntimeContext?.excludeTabDomain;
  if (!requiredTabDomain) return null;

  const tabs = await chrome.tabs.query({});
  let activeTabs = [];
  try {
    activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    activeTabs = [];
  }
  const activeTabIds = new Set(activeTabs.map(tab => tab.id));
  const sortedTabs = [
    ...activeTabs,
    ...tabs
      .filter(tab => !activeTabIds.has(tab.id))
      .sort((left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0) || right.id - left.id),
  ];

  for (const tab of sortedTabs) {
    if (!Number.isInteger(tab?.id) || !tab.url) continue;
    let hostname = "";
    try {
      hostname = new URL(tab.url).hostname;
    } catch {
      continue;
    }
    if (!hostnameMatchesDomain(hostname, requiredTabDomain)) continue;
    if (excludeTabDomain && hostnameMatchesDomain(hostname, excludeTabDomain)) continue;
    return tab;
  }
  return null;
}

async function createDirectBrowserFetchTab(traceID = null) {
  const created = await createBrowserTab({ url: "about:blank", active: false });
  if (!Number.isInteger(created?.id)) {
    throw createRuntimeHelperError("BROWSER_FETCH_ERROR", "Failed to create direct browser fetch tab");
  }
  traceLog(traceID, `[ServiceWorkerRuntime] direct browser_fetch background tab created tab=${created.id}`);
  return created;
}

async function ensureDirectBrowserFetchTabAtOrigin(tab, targetUrl, traceID = null) {
  const target = new URL(targetUrl);
  let currentOrigin = "";
  try {
    currentOrigin = tab?.url ? new URL(tab.url).origin : "";
  } catch {
    currentOrigin = "";
  }
  if (currentOrigin !== target.origin) {
    traceLog(traceID, `[ServiceWorkerRuntime] direct browser_fetch background tab navigate tab=${tab.id} ${target.origin}/`);
    await chrome.tabs.update(tab.id, { url: `${target.origin}/`, active: false });
    await waitForTabLoad(tab.id, 20000);
  }

  const loadedTab = await chrome.tabs.get(tab.id);
  let loadedOrigin = "";
  try {
    loadedOrigin = loadedTab?.url ? new URL(loadedTab.url).origin : "";
  } catch {
    loadedOrigin = "";
  }
  if (loadedOrigin !== target.origin) {
    throw createRuntimeHelperError(
      "PAGE_CONTEXT_REQUIRED",
      `Browser authentication is required for ${target.origin}`,
      { action: "browser_fetch", url: targetUrl, finalUrl: loadedTab?.url || "" },
    );
  }
  return loadedTab;
}

async function closeDirectBrowserFetchTab(tabId, traceID = null) {
  try {
    await chrome.tabs.remove(tabId);
    traceLog(traceID, `[ServiceWorkerRuntime] direct browser_fetch background tab closed tab=${tabId}`);
  } catch (error) {
    traceLog(traceID, `[ServiceWorkerRuntime] direct browser_fetch background tab close failed tab=${tabId}: ${error?.message || error}`);
  }
}

function parseDirectResponseBody(body) {
  if (body == null || typeof body === "object") return body;
  const text = String(body).trim();
  if (!text) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isDirectAuthenticationResponse(response = {}) {
  const status = Number(response?.status || 0);
  if (status === 401 || status === 403) return true;

  const finalUrl = String(response?.url || "");
  if (/\/cas\/login|\/login(?:[/?#]|$)|\/signin(?:[/?#]|$)|\/sso(?:[/?#]|$)/i.test(finalUrl)) return true;

  const payload = parseDirectResponseBody(response?.body);
  const code = Number(payload?.retCode ?? payload?.code ?? payload?.statusCode);
  const message = String(payload?.retDetail || payload?.msg || payload?.message || "");
  if (code === 3001 || code === 401 || code === 403) return true;

  const bodyText = typeof payload === "string" ? payload.slice(0, 8000) : "";
  return /登录超时|请重新登录|统一单点登[录陆]|统一认证|\/cas\/login|\/signin|\/sso/i
    .test(`${message} ${bodyText}`);
}

async function runDirectBrowserFetch(payload = {}, traceID = null) {
  let tab = await findDirectRuntimeContextTab();
  let managedBackgroundTab = false;
  if (!tab) {
    tab = await createDirectBrowserFetchTab(traceID);
    managedBackgroundTab = true;
    try {
      tab = await ensureDirectBrowserFetchTabAtOrigin(tab, String(payload.url || ""), traceID);
    } catch (error) {
      await closeDirectBrowserFetchTab(tab.id, traceID);
      throw error;
    }
  }
  traceLog(traceID, `[ServiceWorkerRuntime] direct browser_fetch tab=${tab.id} background=${managedBackgroundTab} ${String(payload.url || "")}`);
  try {
    return await runRuntimeBrowserFetch(tab, payload);
  } finally {
    if (managedBackgroundTab) await closeDirectBrowserFetchTab(tab.id, traceID);
  }
}

async function runDirectBackendFetch(payload = {}, traceID = null) {
  const response = await runRuntimeBridgeRequest("wecli_backend_fetch", payload, traceID);
  if (payload.browserFallback === false || !isDirectAuthenticationResponse(response)) return response;
  traceLog(traceID, `[ServiceWorkerRuntime] backend_fetch authentication response, retrying in browser context ${String(payload.url || "")}`);
  return runDirectBrowserFetch(payload, traceID);
}

async function getDirectRuntimeCookiesViaDebugger(payload = {}, traceID = null) {
  const url = String(payload.url || '');
  if (!url) return null;
  assertRuntimeUrlAllowed(createDirectContextTab(), url);

  let activeTab = null;
  try {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    activeTab = null;
  }
  if (!Number.isInteger(activeTab?.id) || !shouldHandleTabUrl(activeTab?.url || '')) return null;

  const wasAttached = cdpAttachedTabs.has(activeTab.id);
  try {
    await ensureCdpAttached(activeTab.id);
    const result = await chrome.debugger.sendCommand({ tabId: activeTab.id }, 'Network.getCookies', { urls: [url] });
    const cookies = Array.isArray(result?.cookies) ? result.cookies : [];
    traceLog(traceID, `[ServiceWorkerRuntime] direct cookies_get browser-debugger tab=${activeTab.id} count=${cookies.length}`);
    return cookies.length > 0 ? { cookies, source: 'browser-debugger', tabId: activeTab.id } : null;
  } catch (error) {
    traceLog(traceID, `[ServiceWorkerRuntime] direct cookies_get browser-debugger failed: ${error?.message || error}`);
    return null;
  } finally {
    if (!wasAttached && cdpAttachedTabs.has(activeTab.id)) {
      try {
        await chrome.debugger.detach({ tabId: activeTab.id });
      } catch { }
      clearBrowserDebuggerState(activeTab.id, 'Temporary cookie attachment released.');
    }
  }
}

function createStorageContextRequiredError(host, area, key, details = {}) {
  const storageScope = details.storageScope || host;
  return createRuntimeHelperError(
    "PAGE_CONTEXT_REQUIRED",
    `Runtime storage "${area}.${key}" is not cached for ${storageScope || "current site"}`,
    { action: "storage_get", host, storageScope, area, key, ...details }
  );
}

async function handleDirectRuntimeRequest(action, payload = {}) {
  const traceID = directRuntimeContext?.traceID || null;
  switch (String(action || "")) {
    case "cookies_get":
      traceLog(traceID, `[ServiceWorkerRuntime] direct cookies_get ${String(payload.domain || payload.domains || payload.url || directRuntimeContext?.routeDomain || "")}`);
      {
        const debuggerResult = payload.browserDebugger === false ? null : await getDirectRuntimeCookiesViaDebugger(payload, traceID);
        const result = debuggerResult || await getRuntimeCookies(createDirectContextTab(), payload);
        const cookies = Array.isArray(result?.cookies) ? result.cookies : [];
        traceLog(traceID, `[ServiceWorkerRuntime] direct cookies_get result ${JSON.stringify({
          count: cookies.length,
          source: result?.source || 'chrome.cookies',
          cookies: cookies.map((cookie) => ({
            name: cookie.name,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
          })),
        })}`);
        return result;
      }
    case "download":
      traceLog(traceID, `[ServiceWorkerRuntime] direct download ${String(payload.url || payload.filename || "")}`);
      return runRuntimeDownload(createDirectContextTab(), payload);
    case "backend_fetch":
      return runDirectBackendFetch(payload, traceID);
    case "browser_fetch":
      return runDirectBrowserFetch(payload, traceID);
    case "backend_file_read":
      return runRuntimeBridgeRequest("wecli_backend_file_read", payload, traceID);
    case "backend_xlsx_read":
      return runRuntimeBridgeRequest("wecli_backend_xlsx_read", payload, traceID);
    case "backend_file_write":
      return runRuntimeBridgeRequest("wecli_backend_file_write", payload, traceID);
    case "main_world_eval": {
      const tabId = await findTabByDomain(
        directRuntimeContext?.routeDomain || directRuntimeContext?.adapterId,
        directRuntimeContext?.excludeTabDomain,
        directRuntimeContext?.tabDomain,
      );
      if (!tabId) throw createPageContextRequiredError(action);
      return runRuntimeMainWorldEval(await chrome.tabs.get(tabId), payload);
    }
    case "storage_get":
      traceLog(traceID, `[ServiceWorkerRuntime] direct storage_get ${String(payload.key || "")}`);
      return getDirectRuntimeStorageValue(payload);
    case "navigate":
    case "set_file_input":
      throw createPageContextRequiredError(action);
    default:
      throw createRuntimeHelperError("UNKNOWN_HELPER", `Unknown runtime helper: ${action}`, { action });
  }
}

async function ensureDirectAdapterLoaded(adapterId, traceID = null) {
  if (!adapterId || !SAFE_ADAPTER_ID_RE.test(adapterId)) {
    throw new Error(`Invalid adapter id for direct execution: ${adapterId}`);
  }
  if (!directAdapterLoadPromises.has(adapterId)) {
    const loadPromise = (async () => {
      const adapterManifest = await loadAdapterManifest(adapterId);
      const supportFiles = normalizeAdapterSupportFiles(adapterId, adapterManifest?.supportFiles ?? adapterManifest?.support_files);
      for (const supportFile of supportFiles) {
        traceLog(traceID, `[ServiceWorkerDirect] import support ${supportFile}`);
        await import(withDirectImportCacheBuster(chrome.runtime.getURL(supportFile)));
      }
      traceLog(traceID, `[ServiceWorkerDirect] import adapter adapters/${adapterId}/index.js`);
      await import(withDirectImportCacheBuster(chrome.runtime.getURL(`adapters/${adapterId}/index.js`)));
    })().catch((err) => {
      directAdapterLoadPromises.delete(adapterId);
      throw err;
    });
    directAdapterLoadPromises.set(adapterId, loadPromise);
  }
  await directAdapterLoadPromises.get(adapterId);
}

function withDirectImportCacheBuster(url) {
  const separator = String(url).includes("?") ? "&" : "?";
  return `${url}${separator}webcli_direct_import=${Date.now()}`;
}

function runDirectToolExclusive(task) {
  const run = directToolExecutionQueue.then(task, task);
  directToolExecutionQueue = run.catch(() => undefined);
  return run;
}

async function handleDirectRuntimeMessage(msg) {
  const route = msg.route || {};
  const previousContext = directRuntimeContext;
  directRuntimeContext = {
    traceID: msg.traceID || null,
    adapterId: route.adapterId,
    routeDomain: route.routeDomain,
    tabDomain: route.tabDomain,
    excludeTabDomain: route.excludeTabDomain,
    allowedHosts: normalizeRouteHosts(route.allowedHosts),
  };
  try {
    return await handleDirectRuntimeRequest(msg.action, msg.payload || {});
  } finally {
    directRuntimeContext = previousContext;
  }
}

async function hasOffscreenDirectRunner() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DIRECT_RUNNER_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDirectRunner() {
  if (!chrome.offscreen?.createDocument) {
    throw new Error("chrome.offscreen is unavailable; cannot run adapter without a target tab");
  }
  if (await hasOffscreenDirectRunner()) return;
  if (!offscreenCreatePromise) {
    offscreenCreatePromise = chrome.offscreen.createDocument({
      url: OFFSCREEN_DIRECT_RUNNER_PATH,
      reasons: ["IFRAME_SCRIPTING"],
      justification: "Run installed WebCLI adapters without requiring a target site tab.",
    }).catch((err) => {
      if (!/Only a single offscreen document may be created/i.test(err?.message || "")) {
        throw err;
      }
    }).finally(() => {
      offscreenCreatePromise = null;
    });
  }
  await offscreenCreatePromise;
}

function requestOffscreenDirectTool(route, handlerName, args, traceID = null) {
  return new Promise((resolve, reject) => {
    const id = `offscreen_call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    chrome.runtime.sendMessage({
      type: "wecli_offscreen_call_tool",
      id,
      route,
      handlerName,
      args,
      traceID,
    }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response?.ok) {
        const error = response?.error || {};
        const err = new Error(error.message || error || "Offscreen adapter execution failed");
        if (error.code) err.code = error.code;
        if (error.details) err.details = error.details;
        reject(err);
        return;
      }
      resolve(response.result);
    });
  });
}

async function callToolDirect(route, handlerName, args, traceID = null) {
  if (!route?.adapterId || !SAFE_ADAPTER_ID_RE.test(route.adapterId)) {
    throw new Error(`Invalid adapter id for direct execution: ${route?.adapterId}`);
  }
  return runDirectToolExclusive(async () => {
    await ensureOffscreenDirectRunner();
    traceLog(traceID, `[ServiceWorkerDirect] handler args ${JSON.stringify(sanitizeDirectTraceValue(args || {}))}`);
    return requestOffscreenDirectTool(route, handlerName, args, traceID);
  });
}

function hostnameMatchesDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * 根据域名查找匹配的tab（按时间倒序，最新的优先）
 * 找到后会激活该tab，让用户能看到操作过程
 * @param {string} domain
 * @param {string} [excludeTabDomain] - 排除该域名的tab
 * @param {string} [requiredTabDomain] - 要求实际 tab hostname 属于该域名
 * @returns {Promise<number|null>} tabId or null
 */
async function findTabByDomain(domain, excludeTabDomain, requiredTabDomain) {
  const domainData = toolRegistry.get(domain);
  if (!domainData || domainData.tabIds.size === 0) {
    return null;
  }

  const tabs = await chrome.tabs.query({});
  let activeTabs = [];
  try {
    activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    activeTabs = [];
  }
  const activeTabIds = new Set(activeTabs.map(tab => tab.id));
  const sortedTabs = [
    ...activeTabs,
    ...tabs
      .filter(tab => !activeTabIds.has(tab.id))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0) || b.id - a.id),
  ];

  // 找到第一个匹配域名的tab，并验证该 tab 的 URL 确实属于该 domain
  for (const tab of sortedTabs) {
    if (!domainData.tabIds.has(tab.id)) continue;

    // 验证 tab URL 与 domain 一致，防止 tabId 被错误归入其他 domain
    // （同 adapter 匹配多个 host 时，以注册时记录的来源主机 hostAliases 为准）
    let tabHostname;
    try {
      tabHostname = new URL(tab.url).hostname;
      const aliasOk = domainData.hostAliases?.has(tabHostname) === true;
      if (!hostnameMatchesDomain(tabHostname, domain) && !aliasOk) {
        console.warn(`[WebMCP] Tab ${tab.id} hostname "${tabHostname}" does not match domain "${domain}", skipping`);
        domainData.tabIds.delete(tab.id);
        continue;
      }
    } catch {
      continue;
    }

    // 排除指定子域名的tab（如 pay_now 以外的工具排除结算页）
    if (excludeTabDomain && hostnameMatchesDomain(tabHostname, excludeTabDomain)) {
      console.log(`[WebMCP] Tab ${tab.id} excluded by excludeTabDomain "${excludeTabDomain}", skipping`);
      continue;
    }

    if (requiredTabDomain && !hostnameMatchesDomain(tabHostname, requiredTabDomain)) {
      console.log(`[WebMCP] Tab ${tab.id} does not match tabDomain "${requiredTabDomain}", skipping`);
      continue;
    }

    // 激活该tab，让用户能看到操作过程
    try {
      await chrome.tabs.update(tab.id, { active: true });
      // 激活该tab所在的窗口
      await focusBrowserWindow(tab.windowId);
    } catch {
      // Tab may have been closed between query and update — skip it
      domainData.tabIds.delete(tab.id);
      continue;
    }

    console.log(`[WebMCP] Activated tab ${tab.id} (${domain}) in window ${tab.windowId}`);
    return tab.id;
  }

  return null;
}

function isStorageContextRequiredError(err) {
  return err?.code === "PAGE_CONTEXT_REQUIRED" && err?.details?.action === "storage_get";
}

/**
 * 根据域名查找该 adapter 的 homepage URL。
 * 优先用 manifest.homepage_url；找不到时回退到 http(s)://<domain>/。
 * @param {string} domain
 * @returns {Promise<string|null>}
 */
async function getHomepageUrlForDomain(domain) {
  try {
    const manifests = await loadLocalAdapterManifests();
    for (const manifest of manifests) {
      const match = manifest?.match || [];
      const hit = match.some((p) => hostnameMatchesDomain(domain, String(p).replace(/^https?:\/\//, "")));
      if (hit) {
        if (typeof manifest.homepage_url === "string" && manifest.homepage_url.trim()) {
          return manifest.homepage_url.trim();
        }
        // 无 homepage_url 时用 match 里的第一个作为 fallback 站点地址
        return `http://${String(match[0]).replace(/^https?:\/\//, "")}/`;
      }
    }
  } catch { }
  return null;
}

/**
 * 轮询等待某 domain 的 adapter 工具注册完成（注入完成标志）。
 * @param {string} domain
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForToolRegistry(domain, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const domainData = toolRegistry.get(domain);
    if (domainData && domainData.tabIds.size > 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 自动打开指定域名的 homepage tab，并等待 adapter 注入完成。
 * @param {string} domain
 * @returns {Promise<number|null>} 打开的 tabId 或 null
 */
async function autoOpenHomepageTab(domain) {
  const homepageUrl = await getHomepageUrlForDomain(domain) || `http://${domain}/`;
  try {
    const tab = await createBrowserTab({ url: homepageUrl, active: true });
    const ready = await waitForToolRegistry(domain, 10000);
    if (ready) return tab.id;
    // 即使未确认注入完成，也返回 tabId 让后续重试 findTabByDomain 判定
    return tab.id;
  } catch (err) {
    console.warn(`[WebMCP] 自动打开站点失败 ${homepageUrl}: ${err.message}`);
    return null;
  }
}

async function findStorageContextTabs(routeDomain, excludeTabDomain, requiredTabDomain, requiredStorageScope = "") {
  const tabs = await chrome.tabs.query({});
  let activeTabs = [];
  try {
    activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    activeTabs = [];
  }

  const activeTabIds = new Set(activeTabs.map(tab => tab.id));
  const sortedTabs = [
    ...activeTabs,
    ...tabs
      .filter(tab => !activeTabIds.has(tab.id))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0) || b.id - a.id),
  ];

  const targetDomain = normalizeRuntimeStorageHost(requiredTabDomain || routeDomain);
  const targetStorageScope = normalizeRuntimeStorageScope(requiredStorageScope);
  const matchedTabs = [];
  for (const tab of sortedTabs) {
    if (!tab?.id || !tab.url || !/^https?:\/\//i.test(tab.url)) continue;
    let hostname;
    try {
      hostname = normalizeRuntimeStorageHost(new URL(tab.url).hostname);
    } catch {
      continue;
    }
    if (targetStorageScope) {
      if (!storageScopeMatchesTab(tab, targetStorageScope)) continue;
    } else if (targetDomain && !hostnameMatchesDomain(hostname, targetDomain)) {
      continue;
    }
    if (excludeTabDomain && hostnameMatchesDomain(hostname, excludeTabDomain)) continue;
    matchedTabs.push(tab);
  }
  return matchedTabs;
}

async function findStorageContextTab(routeDomain, excludeTabDomain, requiredTabDomain, requiredStorageScope = "") {
  const tabs = await findStorageContextTabs(routeDomain, excludeTabDomain, requiredTabDomain, requiredStorageScope);
  return tabs[0] || null;
}

async function refreshDirectStorageContext({ routeDomain, tabDomain, excludeTabDomain, details = {}, traceID = null }) {
  const key = String(details.key || "");
  const area = details.area === "session" ? "session" : "local";
  if (!key) return false;

  const storageScope = getRuntimeStorageScopeFromDetails(details, tabDomain || routeDomain);
  const tabs = await findStorageContextTabs(routeDomain, excludeTabDomain, tabDomain || getRuntimeStorageHostFromScope(storageScope), storageScope);
  if (!tabs.length) {
    traceLog(traceID, `[ServiceWorker] 未找到可刷新 storage 登录态的标签页: scope=${storageScope || tabDomain || details.host || routeDomain} key=${key}`);
    return false;
  }

  for (const tab of tabs) {
    try {
      const result = await getRuntimeStorageValue(tab, { area, key });
      if (result?.value === undefined || result.value === null || result.value === "") {
        traceLog(traceID, `[ServiceWorker] 标签页 storage 未返回有效值: tab=${tab.id} area=${area} key=${key}`);
        continue;
      }
      await cacheRuntimeStorageValueForScope(storageScope || tabDomain || routeDomain, area, key, result.value);
      traceLog(traceID, `[ServiceWorker] 已从标签页刷新 storage 登录态: tab=${tab.id} area=${area} key=${key}`);
      return true;
    } catch (err) {
      traceLog(traceID, `[ServiceWorker] 刷新 storage 登录态失败: tab=${tab.id} ${err?.message || err}`);
    }
  }

  return false;
}

/**
 * 向标签页发送工具调用消息，内置 bfcache 恢复重试
 *
 * Chrome 的 bfcache（后退/前进缓存）会冻结页面并关闭扩展消息通道。
 * 当 sendMessage 因 bfcache 失败时，我们主动激活标签页将其从 bfcache 中唤醒，
 * 等待页面恢复后重试。
 */
async function callToolInTab(tabId, toolName, args, traceID = null, allowTransportRetry = true, timeoutMs = null, continuation = null) {
  const tracePrefix = traceID ? `[${traceID}] ` : '';
  traceLog(traceID, `[ServiceWorker] 发送到 Content Script: tab=${tabId} tool=${toolName}`);
  // capture_screenshot shows this page, not whatever tab the window has selected.
  screenshotToolTabs.note(tabId);

  const message = { type: "call_tool", toolName, args, ...(continuation ? { continuation } : {}) };
  if (traceID) message.traceID = traceID;

  const createAdapterError = (message) => {
    const error = new Error(message);
    error.isWebMcpAdapterError = true;
    return error;
  };

  let lastError;
  const maxRetries = allowTransportRetry ? 2 : 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      traceLog(traceID, `[ServiceWorker] bfcache 重试 ${attempt}/${maxRetries}: tab=${tabId}`);
      console.log(`${tracePrefix}[WebMCP] Retrying call_tool after bfcache recovery, attempt ${attempt}/${maxRetries}`);
    }

    try {
      let timer;
      const response = await Promise.race([
        chrome.tabs.sendMessage(tabId, message),
        ...(Number.isFinite(timeoutMs) ? [new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Adapter command timed out; execution was not replayed.')), timeoutMs); })] : []),
      ]).finally(() => clearTimeout(timer));
      // 成功 —— 继续处理响应
      if (response?.error) {
        const adapterError = createAdapterError(response.error);
        // Codes such as AUTH_REQUIRED drive host behaviour (login flow); keep them.
        if (typeof response.code === 'string' && response.code) adapterError.code = response.code;
        if (response.details && typeof response.details === 'object') adapterError.details = response.details;
        throw adapterError;
      }

      const result = response?.result;

      // Check if the adapter returned a CDP action (e.g. file upload via DOM.setFileInputFiles)
      if (result && typeof result === 'object' && result.__cdp_action) {
        const cdpResult = await handleCdpAction(tabId, result);

        // If the adapter specified an __after callback, execute it in the tab after CDP action completes
        if (result.__after) {
          const { toolName: afterTool, delay } = result.__after;
          if (delay) await new Promise(r => setTimeout(r, delay));
          console.log(`[WebMCP] Executing __after callback: ${afterTool}, tabId: ${tabId}`);
          try {
            const afterResponse = await chrome.tabs.sendMessage(tabId, {
              type: "call_tool",
              toolName: afterTool,
              args: {},
            });
            console.log(`[WebMCP] __after callback response:`, JSON.stringify(afterResponse)?.substring(0, 200));
            if (afterResponse?.error) throw new Error(afterResponse.error);
            return afterResponse?.result ?? cdpResult;
          } catch (afterErr) {
            console.error(`[WebMCP] __after callback failed:`, afterErr.message);
            return { ...cdpResult, __after_error: afterErr.message };
          }
        }

        return cdpResult;
      }

      return result;
    } catch (err) {
      if (err?.isWebMcpAdapterError) throw err;

      lastError = err;
      const errMsg = err.message || String(err);

      // Managed Adapter calls recover at the host boundary, where the pinned
      // read/write policy, package snapshot, page URL and total deadline can
      // all be enforced together. Generic channel errors are not BFCache.
      if (!allowTransportRetry && /back\/forward cache|bfcache/i.test(errMsg)) {
        const error = new Error('Adapter page entered back/forward cache; its message channel closed.');
        error.code = 'ADAPTER_BFCACHE_DISCONNECTED';
        throw error;
      }

      // 检测 bfcache 或页面跳转导致的断连
      if (
        attempt < maxRetries &&
        (errMsg.includes('back/forward cache') || errMsg.includes('bfcache') || errMsg.includes('channel closed'))
      ) {
        // 如果是页面跳转导致的断连（channel closed before response），
        // 尝试获取当前 tab URL，确认页面是否已跳转
        let tabUrlChanged = false;
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.url) {
            tabUrlChanged = true;
          }
          if (tab.windowId) {
            await focusBrowserWindow(tab.windowId);
          }
          await chrome.tabs.update(tabId, { active: true });
        } catch {
          // Tab may no longer exist
          break;
        }

        // 如果页面已跳转，等待 content script 在新页面加载完成
        if (tabUrlChanged) {
          await new Promise(r => setTimeout(r, 1500 + attempt * 500));
        } else {
          // bfcache 恢复：等待 pageshow 触发、JS 解冻
          await new Promise(r => setTimeout(r, 500 + attempt * 500));
        }
        continue;
      }

      // 非 bfcache 错误，或重试次数用尽
      break;
    }
  }

  const lastMsg = lastError?.message || 'Unknown error';
  // 工具未注册时 content script 返回 "Tool ... not found in this page"，此时 tab 其实还在，
  // 不要套用 "Tab no longer available" 外壳，原样透出真实原因便于排查。
  if (lastMsg.includes('not found in this page')) {
    throw new Error(lastMsg);
  }
  throw new Error(`Tab ${tabId} is no longer available: ${lastMsg}`);
}

// ─── CDP Action Handler ─────────────────────────────────────────────────────

/**
 * Handle CDP actions returned by adapter handlers.
 * Currently supports:
 *   - set_file_input: Use DOM.setFileInputFiles to set files on an <input type="file">
 *
 * @param {number} tabId
 * @param {{ __cdp_action: string, selector: string, files: string[] }} action
 * @returns {Promise<object>}
 */
async function handleCdpAction(tabId, action) {
  const { __cdp_action, selector, files } = action;

  if (__cdp_action !== 'set_file_input') {
    throw new Error(`Unknown CDP action: ${__cdp_action}`);
  }

  if (!selector || !files || !files.length) {
    throw new Error('CDP set_file_input requires selector and files');
  }

  let attached = false;
  try {
    // Attach debugger to the tab
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;

    // Get the document root
    const docResult = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', {});
    const rootNodeId = docResult.root.nodeId;

    // Find the file input element
    const queryResult = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
      nodeId: rootNodeId,
      selector: selector,
    });

    if (!queryResult.nodeId) {
      throw new Error(`未找到文件上传元素: ${selector}`);
    }

    // Set files on the input element (this is the key CDP command)
    await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
      nodeId: queryResult.nodeId,
      files: files,
    });

    console.log(`[WebMCP] CDP set_file_input: ${files.length} file(s) set on "${selector}"`);
    return { success: true, message: `已通过 CDP 设置 ${files.length} 个文件`, files };
  } catch (err) {
    console.error('[WebMCP] CDP action failed:', err.message);
    throw new Error(`CDP 文件上传失败: ${err.message}`);
  } finally {
    // Always detach debugger to minimize the blue bar duration
    if (attached) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Already detached or tab closed
      }
    }
  }
}

function safeStoredText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeStoredUrl(value) {
  return safeStoredText(value);
}

function parseStoredUrl(value) {
  const text = safeStoredUrl(value);
  if (!text) return null;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function findWorkflowAction(actions, step) {
  return Array.isArray(actions) ? actions.find((item) => item?.step === step) || null : null;
}

function isLikelyStoredListApiEntry(entry) {
  const probe = `${entry?.url || ''} ${entry?.requestBodyPreview || ''}`.toLowerCase();
  if (!probe || isTelemetryLikeEntry(entry)) return false;
  if (/getrequestdetail|getstatuslistbyrequestid|requestdetail|eventdetail|changedetail|problemdetail/.test(probe)) return false;
  if (/getcilist|getcigroup/.test(probe)) return true;
  return /(list|search|query|get[a-z0-9]*list|getrooms|rooms|currentpage|pagesize|totalcount|keyword|history=|rows|records|availability)/.test(probe);
}

function mergeStoredListCandidateEvidence(candidate, entry) {
  candidate.requestEvidence = pickStoredRicherRequestEvidence(buildSafeRequestEvidence(candidate), buildSafeRequestEvidence(entry));
  delete candidate.requestBodyPreview;
  candidate.responseContentType = candidate.responseContentType
    || safeStoredText(entry?.responseContentType || entry?.contentType);
  candidate.responseHints = mergeStoredActionResponseHints(
    candidate.responseHints,
    extractStoredActionResponseHints(entry?.responsePreview),
  );
  if (candidate.status == null && Number.isFinite(Number(entry?.status))) candidate.status = Number(entry.status);
  return candidate;
}

function createStoredListCandidate(entry, url, method, step) {
  return mergeStoredListCandidateEvidence({
    url: structuralCapturedUrl(url),
    method,
    requestEvidence: buildSafeRequestEvidence(entry),
    responseContentType: safeStoredText(entry?.responseContentType || entry?.contentType),
    responseHints: extractStoredActionResponseHints(entry?.responsePreview),
    status: Number.isFinite(Number(entry?.status)) ? Number(entry.status) : undefined,
    sourceSteps: [step],
  }, entry);
}

function extractStoredListApiCandidates(workflowResult) {
  const byKey = new Map();
  const actions = Array.isArray(workflowResult?.actions) ? workflowResult.actions : [];
  const rankedSteps = ['search', 'refine_search', 'pagination'];

  for (const step of rankedSteps) {
    const action = findWorkflowAction(actions, step);
    const entries = Array.isArray(action?.networkDelta?.entries) ? action.networkDelta.entries : [];
    for (const entry of entries) {
      if (!isLikelyStoredListApiEntry(entry)) continue;
      const url = safeStoredUrl(entry.url);
      if (!url) continue;
      const method = safeStoredText(entry.method) || 'GET';
      const key = `${method.toUpperCase()} ${url}`;
      if (byKey.has(key)) {
        const existing = byKey.get(key);
        if (!existing.sourceSteps.includes(step)) existing.sourceSteps.push(step);
        mergeStoredListCandidateEvidence(existing, entry);
        continue;
      }
      byKey.set(key, createStoredListCandidate(entry, url, method, step));
    }
  }

  const passiveSources = [
    { step: 'initial_load', entries: workflowResult?.initialNetwork?.entries },
    { step: 'passive_capture', entries: workflowResult?.network?.entries },
  ];
  for (const source of passiveSources) {
    const entries = Array.isArray(source.entries) ? source.entries : [];
    for (const entry of entries) {
      if (!isLikelyStoredListApiEntry(entry)) continue;
      const url = safeStoredUrl(entry.url);
      if (!url) continue;
      const method = safeStoredText(entry.method) || 'GET';
      const key = `${method.toUpperCase()} ${url}`;
      if (byKey.has(key)) {
        const existing = byKey.get(key);
        if (!existing.sourceSteps.includes(source.step)) existing.sourceSteps.push(source.step);
        mergeStoredListCandidateEvidence(existing, entry);
        continue;
      }
      byKey.set(key, createStoredListCandidate(entry, url, method, source.step));
    }
  }

  return [...byKey.values()].slice(0, 8);
}

function extractLegacyApiCandidates(workflowResult) {
  const entries = Array.isArray(workflowResult?.network?.entries) ? workflowResult.network.entries : [];
  return entries
    .filter((entry) => {
      const contentType = safeStoredText(entry?.responseContentType || entry?.contentType).toLowerCase();
      return Boolean(entry?.url) && (contentType.includes('json') || contentType.includes('javascript'));
    })
    .map((entry) => ({
      url: structuralCapturedUrl(entry.url),
      method: entry.method || 'GET',
      status: entry.status,
      contentType: entry.responseContentType || entry.contentType,
      requestEvidence: buildSafeRequestEvidence(entry),
      responseHints: extractStoredActionResponseHints(entry.responsePreview),
    }));
}

function buildStoredSiteMemory(siteKey, workflowResult, existing = {}) {
  const now = new Date().toISOString();
  const pageStateBeforeUrl = structuralCapturedUrl(workflowResult?.pageStateBefore?.url);
  const resultPageUrl = structuralCapturedUrl(workflowResult?.resultPageState?.url);
  const finalPageUrl = structuralCapturedUrl(workflowResult?.pageStateAfter?.url);
  const openedUrl = structuralCapturedUrl(workflowResult?.opened?.url);
  const sourceUrl = openedUrl || resultPageUrl || finalPageUrl || pageStateBeforeUrl;
  const parsedSource = parseStoredUrl(sourceUrl);
  const resolvedSiteKey = safeStoredText(siteKey) || parsedSource?.hostname || safeStoredText(existing.siteKey);
  const siteHost = parsedSource?.hostname || safeStoredText(existing.siteHost) || resolvedSiteKey;
  const siteOrigin = parsedSource?.origin || safeStoredText(existing.siteOrigin) || (siteHost ? `https://${siteHost}` : '');
  const verdict = workflowResult?.verdict || {};
  const actions = Array.isArray(workflowResult?.actions) ? workflowResult.actions : [];
  const searchAction = findWorkflowAction(actions, 'search');
  const paginationAction = findWorkflowAction(actions, 'pagination');
  const detailAction = findWorkflowAction(actions, 'detail');
  const listApiCandidates = extractStoredListApiCandidates(workflowResult);
  const legacyApiCandidates = extractLegacyApiCandidates(workflowResult);
  const workflowVersion = safeStoredText(workflowResult?.workflow?.version);
  const workflowVersionsSeen = Array.isArray(existing.workflowVersionsSeen)
    ? existing.workflowVersionsSeen.filter((item) => typeof item === 'string' && item.trim())
    : [];
  if (workflowVersion && !workflowVersionsSeen.includes(workflowVersion)) {
    workflowVersionsSeen.push(workflowVersion);
  }

  return {
    ...existing,
    siteKey: resolvedSiteKey,
    siteHost,
    siteOrigin,
    updatedAt: now,
    firstCapturedAt: safeStoredText(existing.firstCapturedAt) || now,
    captureCount: Number(existing.captureCount || 0) + 1,
    workflowVersion: workflowVersion || safeStoredText(existing.workflowVersion),
    workflowVersionsSeen,
    lastSourceUrl: sourceUrl || safeStoredText(existing.lastSourceUrl),
    canonicalEntryUrl: pageStateBeforeUrl || safeStoredText(existing.canonicalEntryUrl),
    canonicalResultUrl: resultPageUrl || finalPageUrl || safeStoredText(existing.canonicalResultUrl),
    verdictPattern: safeStoredText(verdict.pattern) || safeStoredText(existing.verdictPattern),
    recommendedStrategy: safeStoredText(verdict.recommendedStrategy) || safeStoredText(existing.recommendedStrategy),
    verdictReason: structuralizeStoredTextUrls(verdict.reason) || structuralizeStoredTextUrls(existing.verdictReason),
    search: {
      executed: Boolean(searchAction?.result?.executed),
      action: safeStoredText(searchAction?.result?.action),
      keywordSeed: '',
    },
    resultSignals: {
      listCandidates: Number(workflowResult?.resultPageState?.listCandidates || 0),
      paginationCandidates: Number(workflowResult?.resultPageState?.paginationCandidates || 0),
    },
    listApiCandidates,
    actionApiCandidates: Array.isArray(existing.actionApiCandidates) ? existing.actionApiCandidates.map(sanitizeStoredActionCandidate) : [],
    actionCaptureHistory: Array.isArray(existing.actionCaptureHistory) ? existing.actionCaptureHistory.map(sanitizeStoredActionCandidate) : [],
    actionEvidenceSummary: existing.actionEvidenceSummary,
    detailHints: {
      mode: safeStoredText(detailAction?.result?.mode),
      bestCandidateHref: structuralCapturedUrl(detailAction?.result?.bestCandidate?.href),
      bestCandidateText: '',
      networkDetailCandidates: Array.isArray(detailAction?.result?.networkDetailCandidates)
        ? detailAction.result.networkDetailCandidates.map(structuralCapturedUrl).filter(Boolean)
        : [],
    },
    pagination: {
      attempted: Boolean(paginationAction?.result?.executed),
      verified: Boolean(paginationAction?.result?.verified),
      mode: safeStoredText(paginationAction?.result?.mode),
      targetPage: Number.isFinite(Number(paginationAction?.result?.targetPage)) ? Number(paginationAction.result.targetPage) : null,
      activePageBefore: Number.isFinite(Number(paginationAction?.result?.activePageBefore)) ? Number(paginationAction.result.activePageBefore) : null,
      activePageAfter: Number.isFinite(Number(paginationAction?.result?.activePageAfter)) ? Number(paginationAction.result.activePageAfter) : null,
      reason: safeStoredText(paginationAction?.result?.reason),
    },
    rawSummary: {
      tabId: Number.isFinite(Number(workflowResult?.tabId)) ? Number(workflowResult.tabId) : null,
      resultPageUrl,
      finalPageUrl,
    },
    apiCandidates: legacyApiCandidates,
    pattern: safeStoredText(verdict.pattern),
    reason: structuralizeStoredTextUrls(verdict.reason),
  };
}

async function persistActionCaptureToSiteMemory(captureResult, options = {}) {
  const siteKey = resolveStoredCaptureSiteKey(captureResult);
  if (!siteKey) {
    return { ok: false, reason: 'missing_site_key' };
  }

  const stored = await chrome.storage.local.get('siteMemories');
  const memories = stored.siteMemories || {};
  const existing = memories[siteKey] || {};
  const merged = buildStoredActionCaptureMemory(siteKey, captureResult, existing, options);

  if (!merged) {
    return { ok: false, siteKey, reason: 'no_usable_capture' };
  }

  memories[siteKey] = merged;
  await chrome.storage.local.set({ siteMemories: memories });
  const selectedToolName = safeStoredText(captureResult?.recommendation?.toolName);
  const selectedCandidate = (Array.isArray(merged.actionApiCandidates)
    ? merged.actionApiCandidates.find((candidate) => !selectedToolName || candidate?.toolName === selectedToolName)
    : null) || merged.actionApiCandidates?.[0] || null;

  return {
    ok: true,
    siteKey,
    captureCount: merged.captureCount,
    actionApiCandidateCount: Array.isArray(merged.actionApiCandidates) ? merged.actionApiCandidates.length : 0,
    actionCaptureHistoryCount: Array.isArray(merged.actionCaptureHistory) ? merged.actionCaptureHistory.length : 0,
    selectedToolName: selectedCandidate?.toolName || '',
    selectedUrl: selectedCandidate?.url || '',
    selectedMethod: selectedCandidate?.method || '',
    primarySelection: selectedCandidate?.primarySelection || '',
  };
}

async function selectStoredActionCapturePrimaryCandidate({ siteKey, candidateIndex }) {
  const stored = await chrome.storage.local.get('actionCaptureLastResult');
  const state = stored.actionCaptureLastResult || null;
  const normalizedSiteKey = normalizeStoredSiteLookup(siteKey);
  if (!state?.result || (normalizedSiteKey && state.siteKey && normalizeStoredSiteLookup(state.siteKey) !== normalizedSiteKey)) {
    throw new Error('未找到当前网站的录制结果');
  }

  const capturedActions = Array.isArray(state.result.capturedActions) ? state.result.capturedActions : [];
  const index = Number(candidateIndex);
  if (!Number.isInteger(index) || index < 0 || index >= capturedActions.length) {
    throw new Error('主接口候选不存在，请重新录制');
  }

  const nextCapturedActions = capturedActions.map((candidate, itemIndex) => ({
    ...candidate,
    userSelectedPrimary: itemIndex === index,
  }));
  const nextResult = {
    ...state.result,
    capturedActions: nextCapturedActions,
  };
  nextResult.siteMemoryUpdate = await persistActionCaptureToSiteMemory(nextResult, { incrementCaptureCount: false });

  const nextState = {
    ...state,
    result: nextResult,
    selectedCandidateIndex: index,
    timestamp: Date.now(),
  };
  await chrome.storage.local.set({ actionCaptureLastResult: nextState });
  return nextState;
}

function resolveStoredCaptureSiteKey(captureResult) {
  const explicit = normalizeStoredSiteLookup(captureResult?.site);
  if (explicit) return explicit;

  const finalUrl = safeStoredUrl(captureResult?.finalTab?.url);
  const beforeUrl = safeStoredUrl(captureResult?.beforeTab?.url);
  return normalizeStoredSiteLookup(finalUrl || beforeUrl);
}

function normalizeStoredSiteLookup(siteOrUrl) {
  const text = safeStoredText(siteOrUrl);
  if (!text) return '';
  const parsed = parseStoredUrl(text);
  return parsed?.hostname || text;
}

function buildStoredActionCaptureMemory(siteKey, captureResult, existing = {}, options = {}) {
  const now = new Date().toISOString();
  const actionName = safeStoredText(captureResult?.actionName) || 'captured_action';
  const mode = safeStoredText(captureResult?.mode) || 'intercept';
  const workflowVersion = safeStoredText(captureResult?.workflow?.version);
  const toolName = safeStoredText(captureResult?.recommendation?.toolName) || `${siteKey}.${actionName}_draft`;
  const capturedEntries = Array.isArray(captureResult?.capturedActions) ? captureResult.capturedActions : [];
  const candidate = selectBestStoredActionCaptureEntry(capturedEntries, actionName);

  if (!candidate) {
    return existing && Object.keys(existing).length > 0 ? existing : null;
  }

  const finalUrl = structuralCapturedUrl(captureResult?.finalTab?.url);
  const beforeUrl = structuralCapturedUrl(captureResult?.beforeTab?.url);
  const openedUrl = structuralCapturedUrl(captureResult?.opened?.url);
  const sourceUrl = finalUrl || beforeUrl || openedUrl || safeStoredText(existing.lastSourceUrl);
  const parsedSource = parseStoredUrl(sourceUrl);

  const nextActionCandidate = {
    actionName,
    mode,
    toolName,
    url: structuralCapturedUrl(candidate.url),
    method: safeStoredText(candidate.method) || 'GET',
    requestEvidence: buildSafeRequestEvidence(candidate),
    responseContentType: safeStoredText(candidate.responseContentType),
    responseHints: extractStoredActionResponseHints(candidate.responsePreview),
    intercepted: Boolean(candidate.intercepted),
    blockedReason: safeStoredText(candidate.blockedReason),
    aiIsPrimary: Boolean(candidate.aiIsPrimary),
    aiPurpose: safeStoredText(candidate.aiPurpose),
    aiWhy: safeStoredText(candidate.aiWhy),
    primarySelection: candidate.userSelectedPrimary ? 'user' : (candidate.aiIsPrimary ? 'ai' : 'heuristic'),
    capturedAt: now,
    sourceWorkflowVersion: workflowVersion,
  };

  const base = {
    siteKey,
    siteHost: parsedSource?.hostname || safeStoredText(existing.siteHost) || siteKey,
    siteOrigin: parsedSource?.origin || safeStoredText(existing.siteOrigin) || (siteKey ? `https://${siteKey}` : ''),
    updatedAt: now,
    firstCapturedAt: safeStoredText(existing.firstCapturedAt) || now,
    captureCount: Number(existing.captureCount || 0),
    workflowVersion: workflowVersion || safeStoredText(existing.workflowVersion),
    workflowVersionsSeen: Array.isArray(existing.workflowVersionsSeen) ? existing.workflowVersionsSeen.filter((item) => typeof item === 'string' && item.trim()) : [],
    lastSourceUrl: structuralCapturedUrl(sourceUrl),
    canonicalEntryUrl: structuralCapturedUrl(existing.canonicalEntryUrl) || beforeUrl || sourceUrl,
    canonicalResultUrl: structuralCapturedUrl(existing.canonicalResultUrl) || finalUrl || sourceUrl,
    verdictPattern: safeStoredText(existing.verdictPattern),
    recommendedStrategy: safeStoredText(existing.recommendedStrategy),
    verdictReason: structuralizeStoredTextUrls(existing.verdictReason),
    search: existing.search ? { ...existing.search, keywordSeed: '' } : { executed: false, action: '', keywordSeed: '' },
    resultSignals: existing.resultSignals || { listCandidates: 0, paginationCandidates: 0 },
    listApiCandidates: Array.isArray(existing.listApiCandidates) ? existing.listApiCandidates.map((candidate) => {
      const { requestBodyPreview, requestBody, responsePreview, responseBodyPreview, responseBody, ...safeCandidate } = candidate || {};
      return {
        ...safeCandidate,
        url: structuralCapturedUrl(candidate?.url),
        requestEvidence: buildSafeRequestEvidence(candidate),
        responseHints: mergeStoredActionResponseHints(candidate?.responseHints, extractStoredActionResponseHints(candidate?.responsePreview)),
      };
    }) : [],
    actionApiCandidates: Array.isArray(existing.actionApiCandidates) ? existing.actionApiCandidates.map(sanitizeStoredActionCandidate) : [],
    actionCaptureHistory: Array.isArray(existing.actionCaptureHistory) ? existing.actionCaptureHistory.map(sanitizeStoredActionCandidate) : [],
    actionEvidenceSummary: existing.actionEvidenceSummary,
    detailHints: existing.detailHints ? {
      ...existing.detailHints,
      bestCandidateHref: structuralCapturedUrl(existing.detailHints.bestCandidateHref),
      bestCandidateText: '',
      networkDetailCandidates: Array.isArray(existing.detailHints.networkDetailCandidates)
        ? existing.detailHints.networkDetailCandidates.map(structuralCapturedUrl).filter(Boolean)
        : [],
    } : { mode: '', bestCandidateHref: '', bestCandidateText: '', networkDetailCandidates: [] },
    pagination: existing.pagination || { attempted: false, verified: false, mode: '', targetPage: null, activePageBefore: null, activePageAfter: null, reason: '' },
    rawSummary: existing.rawSummary || { tabId: null, resultPageUrl: '', finalPageUrl: '' },
    apiCandidates: Array.isArray(existing.apiCandidates) ? existing.apiCandidates.map((item) => ({
      url: structuralCapturedUrl(item?.url),
      method: safeStoredText(item?.method) || 'GET',
      status: item?.status,
      contentType: safeStoredText(item?.contentType),
      requestEvidence: buildSafeRequestEvidence(item),
      responseHints: mergeStoredActionResponseHints(item?.responseHints, extractStoredActionResponseHints(item?.responsePreview)),
    })) : [],
    pattern: safeStoredText(existing.pattern),
    reason: structuralizeStoredTextUrls(existing.reason),
  };

  const workflowVersionsSeen = new Set(base.workflowVersionsSeen || []);
  if (workflowVersion) workflowVersionsSeen.add(workflowVersion);

  const existingHistory = Array.isArray(base.actionCaptureHistory) && base.actionCaptureHistory.length > 0
    ? base.actionCaptureHistory
    : (Array.isArray(base.actionApiCandidates) ? base.actionApiCandidates : []);
  const mergedExact = existingHistory.find((item) => isSameStoredActionCandidate(item, nextActionCandidate));
  const canonicalNextCandidate = mergedExact ? mergeStoredActionCandidate(mergedExact, nextActionCandidate) : nextActionCandidate;
  const dedupedHistory = existingHistory.filter((item) => !isSameStoredActionCandidate(item, nextActionCandidate));
  const nextHistory = sortStoredActionCaptureHistory([canonicalNextCandidate, ...dedupedHistory]).slice(0, 60);
  const derivedCandidates = deriveBestStoredActionCandidates(nextHistory, base.actionApiCandidates);
  const actionEvidenceSummary = buildStoredActionEvidenceSummary(nextHistory, derivedCandidates);

  return {
    ...base,
    updatedAt: now,
    captureCount: Number(base.captureCount || 0) + (options.incrementCaptureCount === false ? 0 : 1),
    workflowVersion: workflowVersion || base.workflowVersion,
    workflowVersionsSeen: [...workflowVersionsSeen],
    siteHost: parsedSource?.hostname || base.siteHost || siteKey,
    siteOrigin: parsedSource?.origin || base.siteOrigin || (siteKey ? `https://${siteKey}` : ''),
    lastSourceUrl: sourceUrl || base.lastSourceUrl,
    canonicalEntryUrl: base.canonicalEntryUrl || sourceUrl,
    canonicalResultUrl: finalUrl || base.canonicalResultUrl || sourceUrl,
    actionCaptureHistory: nextHistory,
    actionApiCandidates: derivedCandidates,
    actionEvidenceSummary,
    rawSummary: {
      tabId: Number.isFinite(Number(captureResult?.tabId)) ? Number(captureResult.tabId) : base.rawSummary?.tabId ?? null,
      resultPageUrl: base.rawSummary?.resultPageUrl || '',
      finalPageUrl: finalUrl || base.rawSummary?.finalPageUrl || '',
    },
  };
}

function selectBestStoredActionCaptureEntry(entries, actionName) {
  const usable = (Array.isArray(entries) ? entries : []).filter((entry) => safeStoredUrl(entry?.url));
  if (usable.length === 0) return null;

  const userSelected = usable.find((entry) => Boolean(entry?.userSelectedPrimary));
  if (userSelected) return userSelected;

  const aiPrimary = usable.filter((entry) => Boolean(entry?.aiIsPrimary));
  if (aiPrimary.length === 1) return aiPrimary[0];

  const tokens = normalizeStoredActionTokens(actionName);
  return [...usable].sort((left, right) => scoreStoredActionCaptureEntry(right, tokens) - scoreStoredActionCaptureEntry(left, tokens))[0] || null;
}

function scoreStoredActionCaptureEntry(entry, tokens) {
  const url = safeStoredUrl(entry?.url).toLowerCase();
  const method = safeStoredText(entry?.method).toUpperCase() || 'GET';
  const requestBody = safeStoredText(entry?.requestBodyPreview).toLowerCase();
  const responsePreview = safeStoredText(entry?.responsePreview).toLowerCase();

  let score = 0;
  if (Boolean(entry?.userSelectedPrimary)) score += 100;
  if (Boolean(entry?.aiIsPrimary)) score += 30;
  if (Boolean(entry?.intercepted)) score += 6;
  if (method !== 'GET') score += 4;
  if (requestBody || entry?.requestEvidence?.bodyKind && entry.requestEvidence.bodyKind !== 'none') score += 3;
  if (responsePreview) score += 2;
  if (storedHasQueryParams(url)) score += 2;
  if (url.includes('/api/') || url.includes('/meeting/') || url.includes('/list') || url.includes('/query') || url.includes('/search') || url.includes('/get')) score += 2;
  if (url.endsWith('/') || /https?:\/\/[^/]+\/?$/.test(url)) score -= 5;
  if (/staff|orgstaff|avatar|static|favicon|login|logout/.test(url)) score -= 3;
  if (hasStoredWriteActionIntent(tokens) && isStoredReadLikeActionUrl(url)) score -= 12;
  if (/approve|agree|reject|audit|submit|commit|complete|deal|process|handle/.test(url)) score += 10;

  for (const token of tokens) {
    if (token.length < 2) continue;
    if (url.includes(token)) score += 3;
    if (requestBody.includes(token)) score += 1;
    if (responsePreview.includes(token)) score += 1;
  }

  return score;
}

function normalizeStoredActionTokens(actionName) {
  const actionText = safeStoredText(actionName);
  const raw = actionText
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const expanded = new Set();
  for (const token of raw) {
    expanded.add(token);
    if (token.endsWith('s') && token.length > 3) expanded.add(token.slice(0, -1));
  }
  const semanticAliases = [
    [/批阅|审批|审核|同意|通过/, ['approve', 'agree', 'audit', 'myapprove']],
    [/驳回|拒绝|退回/, ['reject', 'return']],
    [/提交|确认/, ['submit', 'commit', 'confirm']],
    [/保存/, ['save']],
    [/取消|撤销/, ['cancel', 'revoke']],
    [/转交|转发/, ['transfer', 'forward']],
    [/完成|办结/, ['complete', 'finish']],
  ];
  for (const [pattern, aliases] of semanticAliases) {
    if (!pattern.test(actionText)) continue;
    for (const alias of aliases) expanded.add(alias);
  }
  return [...expanded];
}

function hasStoredWriteActionIntent(tokens) {
  return (Array.isArray(tokens) ? tokens : []).some((token) => /approve|agree|audit|reject|return|submit|commit|confirm|save|cancel|revoke|transfer|forward|complete|finish|create|update|delete|book|reserve/.test(token));
}

function isStoredReadLikeActionUrl(input) {
  const url = safeStoredUrl(input).toLowerCase();
  if (!url) return false;
  return /(?:^|[\/_-])(info|detail|summary|list|query|search|get|history|count)(?:[\/_?&=-]|$)/.test(url);
}

function storedHasQueryParams(input) {
  const text = safeStoredText(input);
  if (!text) return false;
  try {
    const parsed = new URL(text);
    return [...parsed.searchParams.keys()].length > 0;
  } catch {
    return false;
  }
}

function isSameStoredActionCandidate(left, right) {
  return left?.actionName === right?.actionName
    && left?.url === right?.url
    && left?.method === right?.method;
}

function sortStoredActionCaptureHistory(candidates) {
  return [...(Array.isArray(candidates) ? candidates : [])].sort((left, right) => compareStoredIsoTimestamps(right?.capturedAt || '', left?.capturedAt || ''));
}

function sortStoredActionCandidates(candidates) {
  return [...(Array.isArray(candidates) ? candidates : [])].sort((left, right) => {
    const leftScore = scoreStoredDerivedActionCandidate(left);
    const rightScore = scoreStoredDerivedActionCandidate(right);
    if (leftScore !== rightScore) return rightScore - leftScore;
    return compareStoredIsoTimestamps(right?.capturedAt || '', left?.capturedAt || '');
  });
}

function deriveBestStoredActionCandidates(history, legacyBestView = []) {
  const seeded = [...(Array.isArray(history) ? history : [])];
  for (const candidate of Array.isArray(legacyBestView) ? legacyBestView : []) {
    if (!seeded.some((item) => isSameStoredActionCandidate(item, candidate))) {
      seeded.push(candidate);
    }
  }

  const bestByToolName = new Map();
  for (const candidate of sortStoredActionCandidates(seeded)) {
    const key = getStoredActionToolKey(candidate);
    const current = bestByToolName.get(key);
    if (!current) {
      bestByToolName.set(key, candidate);
      continue;
    }
    bestByToolName.set(key, mergeStoredActionCandidate(current, candidate));
  }

  return sortStoredActionCandidates([...bestByToolName.values()]).slice(0, 20);
}

function scoreStoredDerivedActionCandidate(candidate) {
  return describeStoredActionCandidateQuality(candidate).score;
}

function describeStoredActionCandidateQuality(candidate) {
  let score = 0;
  const signals = [];

  if (candidate?.primarySelection === 'user') {
    score += 100;
    signals.push('user_selected_primary');
  } else if (candidate?.primarySelection === 'ai' || candidate?.aiIsPrimary) {
    score += 30;
    signals.push('ai_selected_primary');
  }
  if ((safeStoredText(candidate?.method) || 'GET').toUpperCase() !== 'GET') {
    score += 4;
    signals.push('write_method');
  }
  const requestEvidence = buildSafeRequestEvidence(candidate);
  if (requestEvidence.bodyKind !== 'none') {
    score += 1;
    signals.push('has_request_body');
  }
  if (candidate?.responseHints || candidate?.apiEvidence?.responseShape) {
    score += 1;
    signals.push('has_response_shape');
  }
  if (safeStoredText(candidate?.responseContentType).toLowerCase().includes('json')) {
    score += 1;
    signals.push('json_response');
  }
  if (storedHasQueryParams(candidate?.url)) {
    score += 2;
    signals.push('has_query_params');
  }

  const requestFieldCount = Array.isArray(requestEvidence.bodyKeys) ? requestEvidence.bodyKeys.length : 0;
  if (requestFieldCount > 0) {
    const contribution = Math.min(requestFieldCount, 8);
    score += contribution;
    signals.push(`request_fields:${requestFieldCount}`);
  }

  const hintScore = scoreStoredResponseHints(candidate?.responseHints);
  if (hintScore > 0) {
    score += hintScore;
    signals.push(`response_hints:${hintScore}`);
  }

  if (/staff|orgstaff|avatar|static|favicon|login|logout/i.test(safeStoredText(candidate?.url))) {
    score -= 4;
    signals.push('noise_penalty');
  }
  if (safeStoredText(candidate?.url).endsWith('/') || /https?:\/\/[^/]+\/?$/i.test(safeStoredText(candidate?.url))) {
    score -= 5;
    signals.push('root_url_penalty');
  }

  return { score, signals };
}

function scoreStoredResponseHints(hints) {
  if (!hints) return 0;
  let score = 0;
  if (hints.listPath) score += 2;
  if (Array.isArray(hints.itemKeys) && hints.itemKeys.length > 0) score += Math.min(hints.itemKeys.length, 6);
  if (Array.isArray(hints.idLikeKeys) && hints.idLikeKeys.length > 0) score += 1;
  if (Array.isArray(hints.displayLikeKeys) && hints.displayLikeKeys.length > 0) score += 1;
  if (Array.isArray(hints.availabilityLikeKeys) && hints.availabilityLikeKeys.length > 0) score += 2;
  if (hints.preferredIdKey) score += 1;
  if (hints.preferredDisplayKey) score += 1;
  if (hints.preferredAvailabilityKey) score += 2;
  return score;
}

function countStoredPreviewFields(preview) {
  const normalized = safeStoredUrl(preview);
  if (!normalized) return 0;
  if (normalized.startsWith('{') || normalized.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalized);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.keys(parsed).length;
      }
    } catch {
      return 0;
    }
  }
  return [...new Set([...normalized.matchAll(/([A-Za-z0-9_]+)=/g)].map((match) => match[1]).filter(Boolean))].length;
}

function compareStoredIsoTimestamps(left, right) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  return String(left || '').localeCompare(String(right || ''));
}

function mergeStoredActionCandidate(primary, secondary) {
  const primaryEnriched = {
    ...primary,
    responseHints: enrichStoredActionResponseHints(primary?.responseHints, primary?.responsePreview),
  };
  const secondaryEnriched = {
    ...secondary,
    responseHints: enrichStoredActionResponseHints(secondary?.responseHints, secondary?.responsePreview),
  };
  const primaryScore = scoreStoredDerivedActionCandidate(primaryEnriched);
  const secondaryScore = scoreStoredDerivedActionCandidate(secondaryEnriched);
  const winner = secondaryScore > primaryScore ? secondaryEnriched : primaryEnriched;
  const loser = winner === secondaryEnriched ? primaryEnriched : secondaryEnriched;
  const preserveExplicitSelection = ['user', 'ai'].includes(winner.primarySelection) && winner.url !== loser.url;

  return {
    ...winner,
    mode: winner.mode || loser.mode,
    toolName: winner.toolName || loser.toolName,
    requestEvidence: pickStoredRicherRequestEvidence(buildSafeRequestEvidence(winner), buildSafeRequestEvidence(loser)),
    responsePreview: undefined,
    responseContentType: winner.responseContentType || loser.responseContentType,
    responseHints: preserveExplicitSelection ? winner.responseHints : mergeStoredActionResponseHints(winner.responseHints, loser.responseHints),
    intercepted: Boolean(winner.intercepted || loser.intercepted),
    blockedReason: winner.blockedReason || loser.blockedReason,
    aiIsPrimary: Boolean(winner.aiIsPrimary || loser.aiIsPrimary),
    aiPurpose: winner.aiPurpose || loser.aiPurpose,
    aiWhy: winner.aiWhy || loser.aiWhy,
    primarySelection: winner.primarySelection || loser.primarySelection,
    capturedAt: compareStoredIsoTimestamps(winner.capturedAt, loser.capturedAt) >= 0 ? winner.capturedAt : loser.capturedAt,
    sourceWorkflowVersion: winner.sourceWorkflowVersion || loser.sourceWorkflowVersion,
  };
}

function sanitizeStoredActionCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const {
    requestBodyPreview,
    requestBody,
    requestHeaders,
    responsePreview,
    responseBodyPreview,
    responseBody,
    ...safeCandidate
  } = candidate;
  return {
    ...safeCandidate,
    url: structuralCapturedUrl(candidate.url),
    requestEvidence: buildSafeRequestEvidence(candidate),
    responseHints: mergeStoredActionResponseHints(candidate.responseHints, extractStoredActionResponseHints(candidate.responsePreview)),
  };
}

function pickStoredRicherRequestEvidence(primary, secondary) {
  if (primary.bodyOmitted !== secondary.bodyOmitted) return primary.bodyOmitted ? secondary : primary;
  if ((primary.bodyKeys?.length || 0) !== (secondary.bodyKeys?.length || 0)) {
    return (primary.bodyKeys?.length || 0) > (secondary.bodyKeys?.length || 0) ? primary : secondary;
  }
  return Number(primary.bodyFullSize || 0) >= Number(secondary.bodyFullSize || 0) ? primary : secondary;
}

function buildStoredActionEvidenceSummary(history, bestView) {
  const selectedByToolName = new Map();
  for (const candidate of Array.isArray(bestView) ? bestView : []) {
    const key = getStoredActionToolKey(candidate);
    if (!selectedByToolName.has(key)) selectedByToolName.set(key, candidate);
  }

  const grouped = new Map();
  for (const candidate of Array.isArray(history) ? history : []) {
    const key = getStoredActionToolKey(candidate);
    grouped.set(key, [...(grouped.get(key) || []), candidate]);
  }

  const toolSummaries = [...grouped.entries()].map(([toolName, candidates]) => {
    const selected = selectedByToolName.get(toolName) || sortStoredActionCandidates(candidates)[0];
    const selectedQuality = describeStoredActionCandidateQuality(selected);
    return {
      toolName,
      actionName: selected?.actionName || '',
      historyCount: candidates.length,
      selectedUrl: selected?.url || '',
      selectedMethod: selected?.method || '',
      selectedScore: selectedQuality.score,
      selectedSignals: selectedQuality.signals,
      candidates: sortStoredActionCandidates(candidates).map((candidate) => {
        const quality = describeStoredActionCandidateQuality(candidate);
        return {
          url: candidate.url,
          method: candidate.method,
          capturedAt: candidate.capturedAt,
          score: quality.score,
          signals: quality.signals,
          selected: isSameStoredActionCandidate(candidate, selected),
        };
      }),
    };
  }).sort((left, right) => right.selectedScore - left.selectedScore);

  return {
    historyCount: Array.isArray(history) ? history.length : 0,
    bestViewCount: Array.isArray(bestView) ? bestView.length : 0,
    toolSummaries,
  };
}

function getStoredActionToolKey(candidate) {
  return safeStoredText(candidate?.toolName) || `${safeStoredText(candidate?.actionName)} ${(safeStoredText(candidate?.method) || 'GET').toUpperCase()}`;
}

function pickStoredRicherPreview(primary, secondary) {
  const left = safeStoredUrl(primary);
  const right = safeStoredUrl(secondary);
  if (!left) return right || undefined;
  if (!right) return left;
  const leftScore = left.length + countStoredPreviewFields(left) * 20;
  const rightScore = right.length + countStoredPreviewFields(right) * 20;
  return leftScore >= rightScore ? left : right;
}

function mergeStoredActionResponseHints(primary, secondary) {
  if (!primary) return secondary;
  if (!secondary) return primary;

  const idLikeKeys = hasNonEmptyStoredArray(primary.idLikeKeys) ? primary.idLikeKeys : secondary.idLikeKeys;
  const displayLikeKeys = hasNonEmptyStoredArray(primary.displayLikeKeys) ? primary.displayLikeKeys : secondary.displayLikeKeys;
  const availabilityLikeKeys = hasNonEmptyStoredArray(primary.availabilityLikeKeys) ? primary.availabilityLikeKeys : secondary.availabilityLikeKeys;
  const merged = {
    topLevelKeys: hasNonEmptyStoredArray(primary.topLevelKeys) ? primary.topLevelKeys : secondary.topLevelKeys,
    listPath: primary.listPath || secondary.listPath,
    itemKeys: hasNonEmptyStoredArray(primary.itemKeys) ? primary.itemKeys : secondary.itemKeys,
    idLikeKeys,
    displayLikeKeys,
    availabilityLikeKeys,
    preferredIdKey: primary.preferredIdKey || secondary.preferredIdKey || pickStoredPreferredIdKey(idLikeKeys),
    preferredDisplayKey: primary.preferredDisplayKey || secondary.preferredDisplayKey || pickStoredPreferredDisplayKey(displayLikeKeys),
    preferredAvailabilityKey: primary.preferredAvailabilityKey || secondary.preferredAvailabilityKey || pickStoredPreferredAvailabilityKey(availabilityLikeKeys),
  };

  if (JSON.stringify(primary) === JSON.stringify(merged)) return primary;
  return merged;
}

function enrichStoredActionResponseHints(hints, responsePreview) {
  const fallback = extractStoredActionResponseHints(responsePreview);
  if (!hints) return fallback;

  const idLikeKeys = hasNonEmptyStoredArray(hints.idLikeKeys) ? hints.idLikeKeys : (fallback?.idLikeKeys || []);
  const displayLikeKeys = hasNonEmptyStoredArray(hints.displayLikeKeys) ? hints.displayLikeKeys : (fallback?.displayLikeKeys || []);
  const availabilityLikeKeys = hasNonEmptyStoredArray(hints.availabilityLikeKeys) ? hints.availabilityLikeKeys : (fallback?.availabilityLikeKeys || []);
  const preferredIdKey = hints.preferredIdKey || fallback?.preferredIdKey || pickStoredPreferredIdKey(idLikeKeys);
  const preferredDisplayKey = hints.preferredDisplayKey || fallback?.preferredDisplayKey || pickStoredPreferredDisplayKey(displayLikeKeys);
  const preferredAvailabilityKey = hints.preferredAvailabilityKey || fallback?.preferredAvailabilityKey || pickStoredPreferredAvailabilityKey(availabilityLikeKeys);

  if (
    hints.preferredIdKey === preferredIdKey
    && hints.preferredDisplayKey === preferredDisplayKey
    && hints.preferredAvailabilityKey === preferredAvailabilityKey
    && hints.listPath
  ) {
    return hints;
  }

  return {
    topLevelKeys: hasNonEmptyStoredArray(hints.topLevelKeys) ? hints.topLevelKeys : (fallback?.topLevelKeys || []),
    listPath: hints.listPath || fallback?.listPath || '',
    itemKeys: hasNonEmptyStoredArray(hints.itemKeys) ? hints.itemKeys : (fallback?.itemKeys || []),
    idLikeKeys,
    displayLikeKeys,
    availabilityLikeKeys,
    preferredIdKey,
    preferredDisplayKey,
    preferredAvailabilityKey,
  };
}

function hasNonEmptyStoredArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function extractStoredActionResponseHints(responsePreview) {
  const text = safeStoredUrl(responsePreview);
  if (!text) return undefined;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const sanitized = sanitizeStoredPreviewForJsonParse(text);
    if (!sanitized) return extractStoredActionResponseHintsByPattern(text);
    try {
      parsed = JSON.parse(sanitized);
    } catch {
      return extractStoredActionResponseHintsByPattern(text);
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const topLevelKeys = Object.keys(parsed);
  const listHit = findFirstStoredObjectList(parsed, '');
  const itemKeys = listHit?.item && typeof listHit.item === 'object' && !Array.isArray(listHit.item)
    ? Object.keys(listHit.item)
    : [];
  const patternFallback = (!listHit || itemKeys.length === 0) ? extractStoredActionResponseHintsByPattern(text) : undefined;

  const idLikeKeys = itemKeys.filter((key) => /(^id$|id$|code$|key$|uuid$)/i.test(key));
  const displayLikeKeys = itemKeys.filter((key) => /(name|title|label|code|display|desc|room)/i.test(key));
  const availabilityLikeKeys = itemKeys.filter((key) => /(availability|schedule|calendar|slot|time|map)/i.test(key));
  const mergedIdLikeKeys = idLikeKeys.length > 0 ? idLikeKeys : (patternFallback?.idLikeKeys || []);
  const mergedDisplayLikeKeys = displayLikeKeys.length > 0 ? displayLikeKeys : (patternFallback?.displayLikeKeys || []);
  const mergedAvailabilityLikeKeys = availabilityLikeKeys.length > 0 ? availabilityLikeKeys : (patternFallback?.availabilityLikeKeys || []);

  return {
    topLevelKeys: topLevelKeys.length > 0 ? topLevelKeys : (patternFallback?.topLevelKeys || []),
    listPath: listHit?.path || patternFallback?.listPath || '',
    itemKeys: itemKeys.length > 0 ? itemKeys : (patternFallback?.itemKeys || []),
    idLikeKeys: mergedIdLikeKeys,
    displayLikeKeys: mergedDisplayLikeKeys,
    availabilityLikeKeys: mergedAvailabilityLikeKeys,
    preferredIdKey: pickStoredPreferredIdKey(mergedIdLikeKeys),
    preferredDisplayKey: pickStoredPreferredDisplayKey(mergedDisplayLikeKeys),
    preferredAvailabilityKey: pickStoredPreferredAvailabilityKey(mergedAvailabilityLikeKeys),
  };
}

function sanitizeStoredPreviewForJsonParse(text) {
  const normalized = safeStoredText(text);
  if (!normalized) return '';
  return normalized
    .replace(/\[\s*\.\.\.\s*\]/g, '[]')
    .replace(/\{\s*\.\.\.\s*\}/g, '{}')
    .replace(/:\s*\.\.\.(?=[,\]}])/g, ': null');
}

function extractStoredActionResponseHintsByPattern(text) {
  const normalized = safeStoredText(text);
  if (!normalized) return undefined;

  const topLevelKeys = collectStoredObjectKeys(normalized);
  const listPath = inferStoredListPathFromPreview(normalized);
  const itemKeys = collectStoredLikelyItemKeys(normalized);
  if (topLevelKeys.length === 0 && !listPath && itemKeys.length === 0) return undefined;

  const idLikeKeys = itemKeys.filter((key) => /(^id$|id$|code$|key$|uuid$)/i.test(key));
  const displayLikeKeys = itemKeys.filter((key) => /(name|title|label|code|display|desc|room)/i.test(key));
  const availabilityLikeKeys = itemKeys.filter((key) => /(availability|schedule|calendar|slot|time|map)/i.test(key));

  return {
    topLevelKeys,
    listPath,
    itemKeys,
    idLikeKeys,
    displayLikeKeys,
    availabilityLikeKeys,
    preferredIdKey: pickStoredPreferredIdKey(idLikeKeys),
    preferredDisplayKey: pickStoredPreferredDisplayKey(displayLikeKeys),
    preferredAvailabilityKey: pickStoredPreferredAvailabilityKey(availabilityLikeKeys),
  };
}

function collectStoredObjectKeys(text) {
  const matches = [...text.matchAll(/"([A-Za-z0-9_]+)"\s*:/g)].map((match) => match[1]).filter(Boolean);
  return [...new Set(matches)].slice(0, 30);
}

function inferStoredListPathFromPreview(text) {
  if (/"data"\s*:\s*\{[\s\S]*?"list"\s*:/i.test(text)) return 'data.list';
  if (/"data"\s*:\s*\{[\s\S]*?"rows"\s*:/i.test(text)) return 'data.rows';
  if (/"list"\s*:/i.test(text)) return 'list';
  if (/"rows"\s*:/i.test(text)) return 'rows';
  if (/"records"\s*:/i.test(text)) return 'records';
  if (/"items"\s*:/i.test(text)) return 'items';
  return '';
}

function collectStoredLikelyItemKeys(text) {
  const preferred = ['id', 'roomId', 'roomcode', 'roomCode', 'name', 'title', 'meetingType', 'equipment', 'capacity', 'meetingInfoMaps'];
  const found = preferred.filter((key) => new RegExp(`"${key}"\\s*:`, 'i').test(text));
  return [...new Set(found)];
}

function pickStoredPreferredIdKey(keys) {
  const ordered = ['id', 'roomId', 'roomcode', 'roomCode', 'code'];
  return ordered.find((key) => keys.includes(key)) || keys[0] || '';
}

function pickStoredPreferredDisplayKey(keys) {
  const ordered = ['roomcode', 'roomCode', 'name', 'title', 'label', 'code'];
  return ordered.find((key) => keys.includes(key)) || keys[0] || '';
}

function pickStoredPreferredAvailabilityKey(keys) {
  const ordered = ['meetingInfoMaps', 'availability', 'schedule', 'calendar', 'slotMap'];
  return ordered.find((key) => keys.includes(key)) || keys[0] || '';
}

function findFirstStoredObjectList(value, path) {
  if (Array.isArray(value)) {
    const firstObject = value.find((item) => item && typeof item === 'object' && !Array.isArray(item));
    if (firstObject) {
      return { path, item: firstObject };
    }
    return null;
  }

  if (!value || typeof value !== 'object') return null;

  const record = value;
  const preferredKeys = ['list', 'rows', 'records', 'items', 'data'];
  for (const key of preferredKeys) {
    if (!(key in record)) continue;
    const hit = findFirstStoredObjectList(record[key], path ? `${path}.${key}` : key);
    if (hit) return hit;
  }

  for (const [key, nested] of Object.entries(record)) {
    if (preferredKeys.includes(key)) continue;
    const hit = findFirstStoredObjectList(nested, path ? `${path}.${key}` : key);
    if (hit) return hit;
  }

  return null;
}

function normalizeExploreStateSiteKey(siteKey) {
  return String(siteKey || '').trim().toLowerCase();
}

function buildExploreStateStorageKey(siteKey, tabId) {
  const normalizedSiteKey = normalizeExploreStateSiteKey(siteKey);
  if (normalizedSiteKey) return `site:${normalizedSiteKey}`;
  return Number.isInteger(Number(tabId)) ? `tab:${Number(tabId)}` : '';
}

async function resolveExploreStateContext(tabId, explicitSiteKey = '') {
  let siteKey = normalizeExploreStateSiteKey(explicitSiteKey);
  const normalizedTabId = Number.isInteger(Number(tabId)) ? Number(tabId) : null;
  if (!siteKey && normalizedTabId) {
    try {
      const tab = await chrome.tabs.get(normalizedTabId);
      siteKey = normalizeExploreStateSiteKey(new URL(tab.url || '').hostname);
    } catch { }
  }
  return { siteKey, tabId: normalizedTabId };
}

async function saveExploreState(state, context = {}) {
  const resolved = await resolveExploreStateContext(context.tabId, context.siteKey);
  const enrichedState = {
    ...state,
    siteKey: resolved.siteKey || undefined,
    tabId: resolved.tabId ?? undefined,
    timestamp: Number(state?.timestamp || Date.now()),
  };
  const storageKey = buildExploreStateStorageKey(resolved.siteKey, resolved.tabId);
  const stored = await chrome.storage.local.get('exploreLastResults');
  const results = stored.exploreLastResults && typeof stored.exploreLastResults === 'object'
    ? { ...stored.exploreLastResults }
    : {};
  if (storageKey) results[storageKey] = enrichedState;

  const recentEntries = Object.entries(results)
    .sort((left, right) => Number(right[1]?.timestamp || 0) - Number(left[1]?.timestamp || 0))
    .slice(0, 30);

  await chrome.storage.local.set({
    exploreLastResult: enrichedState,
    exploreLastResults: Object.fromEntries(recentEntries),
  });
  return enrichedState;
}

async function loadExploreState(context = {}) {
  const resolved = await resolveExploreStateContext(context.tabId, context.siteKey);
  const stored = await chrome.storage.local.get(['exploreLastResult', 'exploreLastResults']);
  const storageKey = buildExploreStateStorageKey(resolved.siteKey, resolved.tabId);
  if (storageKey && stored.exploreLastResults?.[storageKey]) {
    return stored.exploreLastResults[storageKey];
  }

  const legacy = stored.exploreLastResult || null;
  if (!legacy) return null;
  if (resolved.siteKey && normalizeExploreStateSiteKey(legacy.siteKey) !== resolved.siteKey) return null;
  if (!resolved.siteKey && resolved.tabId && Number(legacy.tabId) !== resolved.tabId) return null;
  return legacy;
}

// ─── 来自 Content Script / 测试页面的消息 ──────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'managed_adapter_runtime_request') {
    getManagedBackgroundRuntime().handleMessage(msg, sender)
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: toStructuredRuntimeError(err) }));
    return true;
  }
  // The managed document may use only its call-bound helper channel.
  if (sender?.url?.split('?')[0] === chrome.runtime.getURL(MANAGED_RUNNER_PATH)) {
    sendResponse({ ok: false, error: { code: 'RUNTIME_CHANNEL_DENIED', message: 'Use the current Adapter runtime context.' } });
    return;
  }
  if (msg.type === "wecli_direct_runtime_request") {
    handleDirectRuntimeMessage(msg)
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: toStructuredRuntimeError(err) }));
    return true;
  }

  if (msg.type === "wecli_runtime_request") {
    handleWecliRuntimeRequest(msg, sender)
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: toStructuredRuntimeError(err) }));
    return true;
  }

  if (msg.type === "test_call_tool") {
    callToolInTab(msg.tabId, msg.toolName, msg.args)
      .then(result => sendResponse({ result }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  // QQ邮箱适配器调用诺诺网适配器 - 全自动流程
  if (msg.type === "auto_download_nuonuo_invoice") {
    (async () => {
      try {
        const { url, downloadPath } = msg;

        // 1. 创建新的诺诺网标签页（扩展创建，不会被拦截）
        const nuonuoTab = await createBrowserTab({
          url: url,
          active: false // 在后台打开
        });

        // 2. 等待页面加载完成
        await new Promise(resolve => setTimeout(resolve, 5000));

        // 3. 在诺诺网页面执行自动下载
        let downloadResult = null;
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount < maxRetries && !downloadResult) {
          try {
            // 注入并执行诺诺网适配器的下载功能
            const result = await chrome.scripting.executeScript({
              target: { tabId: nuonuoTab.id },
              func: async (path) => {
                // 等待页面加载
                await new Promise(r => setTimeout(r, 2000));

                // 查找下载按钮
                const btnSelectors = [
                  ".logo-btn-area",
                  ".download-area",
                  ".btn-area",
                  "[class*='download']"
                ];

                let btnArea = null;
                for (const sel of btnSelectors) {
                  btnArea = document.querySelector(sel);
                  if (btnArea) break;
                }

                if (!btnArea) btnArea = document.body;

                const links = btnArea.querySelectorAll("a, button");
                for (const link of links) {
                  const text = link.textContent?.trim() ?? "";
                  if (text.includes("下载PDF") || text.includes("PDF文件") || text === "下载") {
                    // 使用 Chrome API 下载
                    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.downloads) {
                      const href = link.href || link.getAttribute('href');
                      if (href) {
                        const filename = `发票_${new Date().toISOString().slice(0, 10)}.pdf`;
                        const cleanPath = path ? path.replace(/^[\/\\]+/, '').replace(/[<>:"|?*]/g, '_') : '';
                        const fullPath = cleanPath ? `${cleanPath}/${filename}` : filename;

                        await new Promise((resolve, reject) => {
                          chrome.downloads.download({
                            url: href,
                            filename: fullPath,
                            saveAs: false
                          }, (downloadId) => {
                            if (chrome.runtime.lastError) {
                              reject(chrome.runtime.lastError);
                            } else {
                              resolve(downloadId);
                            }
                          });
                        });
                        return { success: true, filename: fullPath };
                      }
                    }
                    // 回退：直接点击
                    link.click();
                    return { success: true, method: "click" };
                  }
                }
                return { success: false, error: "Download button not found" };
              },
              args: [downloadPath]
            });

            downloadResult = result[0]?.result;
            if (downloadResult?.success) break;
          } catch (err) {
            console.log(`[Background] Retry ${retryCount + 1} failed:`, err);
            retryCount++;
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        // 4. 关闭诺诺网标签页
        await chrome.tabs.remove(nuonuoTab.id);

        if (downloadResult?.success) {
          sendResponse({
            status: "completed",
            filename: downloadResult.filename,
            message: "诺诺网发票下载完成"
          });
        } else {
          sendResponse({
            status: "failed",
            error: downloadResult?.error || "Download failed after retries"
          });
        }
      } catch (err) {
        console.error("[Background] Nuonuo download error:", err);
        sendResponse({ status: "error", error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "popup_bridge_status") {
    sendResponse({
      ok: true,
      isConnected: Boolean(ws && ws.readyState === WebSocket.OPEN),
      disconnectReason: lastBridgeDisconnectReason,
    });
    return true;
  }

  // Popup 查询当前 tab 的状态（active / none）
  if (msg.type === "get_tab_info") {
    (async () => {
      const { url } = msg;
      const isConnected = ws && ws.readyState === WebSocket.OPEN;

      // 从URL提取域名
      let domain;
      try {
        domain = new URL(url).hostname;
      } catch {
        sendResponse({ state: "none", isConnected, bridgeDisconnectReason: lastBridgeDisconnectReason });
        return;
      }

      const resolved = await resolveAdapterForHostname(domain);
      if (Number.isInteger(msg.tabId)) await injectAdapters(msg.tabId, url, resolved);
      if (resolved.adapterId) {
        const originalDomain = domain;
        domain = resolved.adapterId;
        if (domain !== originalDomain) {
          console.log(`[WebMCP] get_tab_info: Normalized domain ${originalDomain} -> ${domain}`);
        }
      }

      // 检查该域名是否有工具
      let domainData = toolRegistry.get(domain);
      console.log(`[WebMCP] get_tab_info: Looking for tools under domain "${domain}", found: ${domainData?.tools?.length ?? 0} tools`);

      if ((!domainData || domainData.tools.length === 0) && resolved.adapterId && Number.isInteger(msg.tabId)) {
        await injectAdapters(msg.tabId, url);
        domainData = await waitForDomainTools(domain);
        console.log(`[WebMCP] get_tab_info: Rechecked domain "${domain}" after injection, found: ${domainData?.tools?.length ?? 0} tools`);
      }

      if (domainData && domainData.tools.length > 0) {
        sendResponse({
          state: "active",
          tools: domainData.tools,
          isConnected,
          domain,
          bridgeDisconnectReason: lastBridgeDisconnectReason,
        });
        return;
      }

      sendResponse({
        state: resolved.adapterId ? "installed" : "none",
        isConnected,
        domain,
        bridgeDisconnectReason: lastBridgeDisconnectReason,
        adapterId: resolved.adapterId || undefined,
        injectionError: resolved.adapterId ? getAdapterInjectionError(resolved.adapterId) : '',
      });
    })();
    return true;
  }

  if (msg.type === "popup_explore_analyze") {
    (async () => {
      try {
        const tabId = msg.tabId;
        if (!tabId) throw new Error('未找到可用于探索的标签页');
        const context = await resolveExploreStateContext(tabId, msg.siteKey);
        const pageState = await sendExplorationMessage(tabId, { type: 'browser_state' });
        let network;
        try {
          network = await getCdpNetworkSnapshot(tabId, { businessOnly: true, limit: 60 });
        } catch {
          network = await sendExplorationMessage(tabId, { type: 'browser_network' });
        }
        const heuristicVerdict = classifySitePattern(pageState, network?.entries || []);
        const result = await enhanceExplorationResultWithAI({ tabId, pageState, network, verdict: heuristicVerdict });
        await saveExploreState({ type: 'analyze', result, timestamp: Date.now() }, context);
        sendResponse({ result });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "popup_explore_workflow") {
    (async () => {
      const context = await resolveExploreStateContext(msg.tabId, msg.siteKey);
      try {
        // Store in-progress state so popup can recover if closed
        await saveExploreState({ type: 'workflow_loading', timestamp: Date.now() }, context);
        sendResponse({ ok: true, started: true });

        (async () => {
          try {
            const workflowResult = await runExploreWorkflow({ tabId: msg.tabId });
            await saveExploreState({
              type: 'workflow_ai_loading',
              result: workflowResult,
              timestamp: Date.now(),
            }, context);
            const result = await enhanceExplorationResultWithAI(
              workflowResult,
              {
                siteKey: workflowResult?.site || '',
                timeoutMs: 120000,
              },
            );
            await saveExploreState({ type: 'workflow', result, timestamp: Date.now() }, context);
          } catch (err) {
            await saveExploreState({ type: 'workflow_error', error: err.message, timestamp: Date.now() }, context);
          }
        })();
      } catch (err) {
        await saveExploreState({ type: 'workflow_error', error: err.message, timestamp: Date.now() }, context);
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "popup_explore_get_state") {
    (async () => {
      sendResponse(await loadExploreState({ siteKey: msg.siteKey, tabId: msg.tabId }));
    })();
    return true;
  }

  if (msg.type === "sidepanel_action_capture_get_state") {
    (async () => {
      const stored = await chrome.storage.local.get('actionCaptureLastResult');
      const state = stored.actionCaptureLastResult || null;
      if (!state) {
        sendResponse(null);
        return;
      }
      if (msg.siteKey && state.siteKey && msg.siteKey !== state.siteKey) {
        sendResponse(null);
        return;
      }
      sendResponse(state);
    })();
    return true;
  }

  if (msg.type === "sidepanel_action_capture_select_candidate") {
    (async () => {
      try {
        const state = await selectStoredActionCapturePrimaryCandidate({
          siteKey: msg.siteKey,
          candidateIndex: msg.candidateIndex,
        });
        sendResponse({ ok: true, state });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "sidepanel_action_capture_clear_state") {
    (async () => {
      const stored = await chrome.storage.local.get('actionCaptureLastResult');
      const state = stored.actionCaptureLastResult || null;
      if (!state) {
        sendResponse({ ok: true, cleared: false });
        return;
      }
      if (msg.siteKey && state.siteKey && msg.siteKey !== state.siteKey) {
        sendResponse({ ok: true, cleared: false });
        return;
      }
      await chrome.storage.local.remove('actionCaptureLastResult');
      sendResponse({ ok: true, cleared: true });
    })();
    return true;
  }

  if (msg.type === "sidepanel_action_capture_stop") {
    (async () => {
      const tabId = Number(msg.tabId);
      const session = Number.isFinite(tabId) ? cdpActionCaptureSessions.get(tabId) : null;
      if (!session || typeof session.requestStop !== 'function') {
        sendResponse({ ok: false, error: '当前没有进行中的动作捕获' });
        return;
      }

      const accepted = session.requestStop('manual_stop');
      if (!accepted) {
        sendResponse({ ok: false, error: '动作捕获已经在结束中' });
        return;
      }

      const stored = await chrome.storage.local.get('actionCaptureLastResult');
      const state = stored.actionCaptureLastResult || {};
      await chrome.storage.local.set({
        actionCaptureLastResult: {
          ...state,
          type: 'action_capture_stopping',
          tabId,
          siteKey: String(msg.siteKey || session.site || state.siteKey || '').trim(),
          actionName: String(msg.actionName || session.actionName || state.actionName || '').trim(),
          mode: String(state.mode || session.mode || 'intercept'),
          pattern: String(state.pattern || '').trim(),
          timeoutSeconds: Number(state.timeoutSeconds || 60),
          startedAtMs: Number(state.startedAtMs || state.timestamp || Date.now()),
          stopRequestedAt: session.stopRequestedAt,
          timestamp: Date.now(),
        },
      });

      sendResponse({ ok: true, stopping: true, stopRequestedAt: session.stopRequestedAt });
    })();
    return true;
  }

  if (msg.type === "sidepanel_action_capture_start") {
    (async () => {
      const { tabId, siteKey, actionName, mode, timeoutSeconds, pattern } = msg;
      try {
        if (!tabId) throw new Error('未找到可用于动作捕获的标签页');
        if (!siteKey) throw new Error('siteKey required');
        if (!actionName?.trim()) throw new Error('actionName required');
        if (cdpActionCaptureSessions.has(tabId)) throw new Error('当前标签页已有进行中的动作捕获');

        await chrome.storage.local.set({
          actionCaptureLastResult: {
            type: 'action_capture_loading',
            tabId,
            siteKey,
            actionName: String(actionName || '').trim(),
            mode: String(mode || 'intercept'),
            timeoutSeconds: Number(timeoutSeconds || 60),
            pattern: String(pattern || '').trim(),
            startedAtMs: Date.now(),
            timestamp: Date.now(),
          },
        });

        sendResponse({ ok: true, started: true });

        (async () => {
          try {
            const captureResult = await runActionCaptureWorkflow({
              tabId,
              site: siteKey,
              actionName,
              mode,
              timeoutSeconds,
              pattern,
            });

            await chrome.storage.local.set({
              actionCaptureLastResult: {
                type: 'action_capture_ai_loading',
                tabId,
                siteKey,
                actionName: String(actionName || '').trim(),
                startedAtMs: Date.parse(captureResult.startedAt || '') || Date.now(),
                result: captureResult,
                timestamp: Date.now(),
              },
            });

            const result = await finalizeActionCaptureResult(captureResult, { timeoutMs: 120000 });

            await chrome.storage.local.set({
              actionCaptureLastResult: {
                type: 'action_capture',
                tabId,
                siteKey,
                actionName: String(actionName || '').trim(),
                startedAtMs: Date.parse(result.startedAt || '') || Date.now(),
                result,
                timestamp: Date.now(),
              },
            });
          } catch (err) {
            await chrome.storage.local.set({
              actionCaptureLastResult: {
                type: 'action_capture_error',
                tabId,
                siteKey: String(siteKey || '').trim(),
                actionName: String(actionName || '').trim(),
                startedAtMs: Date.now(),
                error: err.message,
                timestamp: Date.now(),
              },
            });
          }
        })();
      } catch (err) {
        await chrome.storage.local.set({
          actionCaptureLastResult: {
            type: 'action_capture_error',
            tabId,
            siteKey: String(siteKey || '').trim(),
            actionName: String(actionName || '').trim(),
            startedAtMs: Date.now(),
            error: err.message,
            timestamp: Date.now(),
          },
        });
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "popup_explore_save_memory") {
    (async () => {
      try {
        const { siteKey, workflowResult } = msg;
        if (!siteKey) throw new Error('siteKey required');
        const stored = await chrome.storage.local.get('siteMemories');
        const memories = stored.siteMemories || {};
        const existing = memories[siteKey] || {};
        memories[siteKey] = buildStoredSiteMemory(siteKey, workflowResult, existing);

        await chrome.storage.local.set({ siteMemories: memories });
        sendResponse({ ok: true, siteKey, captureCount: memories[siteKey].captureCount });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "popup_save_adapter_file") {
    (async () => {
      try {
        const { siteKey, filename, content } = msg;
        if (!siteKey || !filename || typeof content !== 'string') throw new Error('siteKey, filename, content required');
        const result = await requestBridge(
          { type: 'write_adapter_file', siteKey, filename, content },
          10000,
          'Bridge 未响应',
        );

        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'popup_explore_start_generation' || msg.type === 'popup_explore_generate_scaffold') {
    (async () => {
      try {
        const { siteKey } = msg;
        if (!siteKey) throw new Error('siteKey required');
        const stored = await chrome.storage.local.get('siteMemories');
        const memory = stored.siteMemories?.[siteKey];
        if (!memory) throw new Error(`未找到 ${siteKey} 的探索记录，请先保存探索结果`);
        const result = await requestBridge(
          {
            type: 'start_generation_run',
            mode: msg.type === 'popup_explore_generate_scaffold' || msg.mode === 'quick' ? 'quick' : 'agent',
            siteKey,
            memory,
            tabId: Number.isInteger(msg.tabId) ? msg.tabId : null,
            goal: `为 ${siteKey} 生成并验证 API Adapter`,
          },
          30000,
          '智能生成任务启动超时，请检查 Bridge 是否已更新并重启',
        );
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'popup_explore_get_generation') {
    (async () => {
      const result = await requestBridge(
        { type: 'get_generation_run', runId: msg.runId, includeTrace: Boolean(msg.includeTrace) },
        10000,
        '读取智能生成状态超时',
      );
      sendResponse(result);
    })();
    return true;
  }

  if (msg.type === 'popup_explore_resume_generation') {
    requestBridge({ type: 'resume_generation_run', runId: msg.runId, answer: String(msg.answer || '') }, 30000, '继续验证超时')
      .then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (msg.type === 'popup_explore_cancel_generation') {
    (async () => {
      const result = await requestBridge(
        { type: 'cancel_generation_run', runId: msg.runId, reason: 'cancelled from sidepanel' },
        10000,
        '取消智能生成任务超时',
      );
      sendResponse(result);
    })();
    return true;
  }

  if (msg.type === 'popup_explore_publish_generation') {
    (async () => {
      try {
        const result = await requestBridge(
          { type: 'publish_generation_run', runId: msg.runId, approval: msg.approval },
          60000,
          '安装生成结果超时',
        );
        if (!result.ok) {
          sendResponse(result);
          return;
        }
        if (result.run?.status !== 'completed') { sendResponse(result); return; }
        const refreshResult = await refreshAdapterTabs(result.run?.siteKey || msg.siteKey || '');
        sendResponse({
          ...result,
          refreshedTabs: refreshResult.refreshedTabs,
          refreshedToolCount: refreshResult.toolCount,
        });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "popup_ai_config_get") {
    (async () => {
      try {
        const result = await requestBridge(
          { type: 'get_ai_config' },
          10000,
          '读取 AI 配置超时，请检查 webcli bridge 状态',
        );
        if (!result.ok) {
          throw new Error(result.error || '读取 AI 配置失败');
        }
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "popup_ai_config_save") {
    (async () => {
      try {
        const config = msg.config || {};
        const result = await requestBridge(
          { type: 'save_ai_config', config },
          10000,
          '保存 AI 配置超时，请检查 webcli bridge 状态',
        );
        if (!result.ok) {
          throw new Error(result.error || '保存 AI 配置失败');
        }
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "popup_ai_config_test") {
    (async () => {
      try {
        const config = msg.config || {};
        const result = await requestBridge(
          { type: 'test_ai_config', config },
          45000,
          '测试 AI 配置超时。若 bridge 早于本次代码变更启动，请先重启 bridge；否则再检查模型首包是否超过 45 秒',
        );
        if (!result.ok) {
          throw new Error(result.error || '测试 AI 配置失败');
        }
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (!sender.tab) return;

  if (msg.type === "register_tools") {
    const newTools = msg.tools;
    const tabId = sender.tab.id;
    const tabUrl = sender.tab.url;

    // 空列表表示该 tab 已清除工具。
    if (!newTools || newTools.length === 0) {
      clearTabDomainRegistration(tabId);
      rebuildToolRouteIndex();
      console.log(`[WebMCP] Tab ${tabId} cleared its tools`);
      sendResponse({ ok: true });
      return true;
    }

    // 从URL提取域名
    let hostname;
    try {
      hostname = new URL(tabUrl).hostname;
    } catch {
      console.warn(`[WebMCP] Invalid tab URL: ${tabUrl}`);
      sendResponse({ ok: false, error: "Invalid tab URL" });
      return true;
    }

    // 规范化域名：从工具名前缀提取 canonical domain（如 "jd.com.search_products" -> "jd.com"）
    // 这样无论 tab 在哪个子域名（www.jd.com / order.jd.com），都归入同一个 domain key
    (async () => {
      let domain = hostname;
      if (newTools.length > 0) {
        const toolDomain = normalizeRouteField(newTools[0].adapterId)
          ?? normalizeRouteField(newTools[0].routeDomain)
          ?? extractDomainFromToolName(newTools[0].name);
        if (toolDomain) {
          domain = toolDomain;
          if (domain !== hostname) {
            console.log(`[WebMCP] Normalized domain: ${hostname} -> ${domain} (from tool name)`);
          }
        }
      }

      let nextRouteIndex;
      try {
        nextRouteIndex = buildToolRouteIndex(domain, newTools);
      } catch (err) {
        console.error(`[WebMCP] Tool registration rejected: ${err.message}`);
        sendResponse({ ok: false, error: err.message });
        return;
      }

      // 获取该域名的现有数据
      const domainData = toolRegistry.get(domain);
      const oldTools = domainData?.tools ?? [];

      // 检查工具列表是否真的变化了
      const hasChanged = !domainData ||
        oldTools.length !== newTools.length ||
        !toolsAreEqual(oldTools, newTools);

      if (hasChanged) {
        const previousDomain = tabDomainMap.get(tabId);
        if (previousDomain && previousDomain !== domain) {
          clearTabDomainRegistration(tabId);
        }

        // 更新或创建域名数据
        if (!domainData) {
          toolRegistry.set(domain, { tools: newTools, tabIds: new Set([tabId]), hostAliases: new Set([hostname]) });
        } else {
          domainData.tools = newTools;
          domainData.tabIds.add(tabId);
          // 记录实际注册来源主机（同一 adapter 可能匹配多个 host，如 passport / uat.sso）
          if (!domainData.hostAliases) domainData.hostAliases = new Set();
          domainData.hostAliases.add(hostname);
        }

        // 记录tab到域名的映射
        tabDomainMap.set(tabId, domain);

        console.log(`[WebMCP] Domain ${domain} registered ${newTools.length} tools (changed), tab count: ${toolRegistry.get(domain).tabIds.size}`);
      } else {
        // 工具未变化，但仍需记录tab
        if (domainData) {
          const previousDomain = tabDomainMap.get(tabId);
          if (previousDomain && previousDomain !== domain) {
            clearTabDomainRegistration(tabId);
          }
          domainData.tabIds.add(tabId);
          if (!domainData.hostAliases) domainData.hostAliases = new Set();
          domainData.hostAliases.add(hostname);
          tabDomainMap.set(tabId, domain);
        }
        console.log(`[WebMCP] Domain ${domain} tools unchanged, skipping notification, tab count: ${domainData.tabIds.size}`);
      }

      replaceToolRouteIndex(nextRouteIndex);
      setBadgeActive(tabId, newTools.length);
      sendResponse({ ok: true });
    })();

    return true;
  }

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearBrowserEvents(tabId);
  clearBrowserObservations(tabId);
  clearBrowserDownloads(tabId);
  clearBrowserFrames(tabId);
  chrome.storage.session.remove(`webcli-browser-tab-${tabId}`).catch(() => {});
  const actionCaptureSession = cdpActionCaptureSessions.get(tabId);
  if (actionCaptureSession && typeof actionCaptureSession.requestStop === 'function') {
    actionCaptureSession.errors.push('TARGET_TAB_NOT_FOUND');
    actionCaptureSession.requestStop('target_tab_closed');
  }
  adapterNetworkCaptureSessions.delete(tabId);
  clearTabInjectedAdapters(tabId);
  const domain = tabDomainMap.get(tabId);
  if (domain) {
    const domainData = toolRegistry.get(domain);
    if (domainData) {
      domainData.tabIds.delete(tabId);

      // 如果该域名没有任何tab了，清除工具
      if (domainData.tabIds.size === 0) {
        toolRegistry.delete(domain);
        rebuildToolRouteIndex();
        console.log(`[WebMCP] Domain ${domain} has no tabs, clearing tools`);
      } else {
        console.log(`[WebMCP] Tab ${tabId} removed, domain ${domain} still has ${domainData.tabIds.size} tabs`);
      }
    }
    tabDomainMap.delete(tabId);
  }
  clearBadge(tabId);
});

// ─── Local Registry 管理 ───────────────────────────────────────────────────

/**
 * 获取本地已安装 adapter 的 registry（仅本地 manifest）
 * @returns {Promise<object|null>}
 */
async function getCachedRegistry() {
  const localAdapters = await loadLocalAdapterManifests();
  if (localAdapters.length === 0) return null;
  return { adapters: localAdapters };
}

let hostAdapterClient;
function getHostAdapterClient() {
  return hostAdapterClient ||= createHostAdapterClient((message, timeout) => bridgeCapabilities.includes('adapter_catalog_v1')
    ? requestBridge(message, timeout) : Promise.resolve(null));
}

let hostAdapterRuntime;
let managedBackgroundRuntime;
function getManagedBackgroundRuntime() {
  return managedBackgroundRuntime ||= createManagedBackgroundRuntime({
    bundle: manifest => getHostAdapterClient().bundle(manifest),
    exclusive: (task, context) => runDirectToolExclusive(async () => {
      const previous = directRuntimeContext;
      directRuntimeContext = context;
      try { return await task(); } finally { directRuntimeContext = previous; }
    }),
    request: async (action, payload, context) => {
      if (context.previewNoPage) {
        if (Date.now() >= context.previewDeadline || ++context.previewRequests > 50) throw new Error('Background preview read budget exceeded.');
        payload = backgroundPreviewRequest(action, payload);
      }
      assertManagedRuntimeRequest(action, payload, context);
      return handleDirectRuntimeRequest(action, payload);
    },
  });
}

function assertManagedRuntimeRequest(action, payload, context) {
  const allowed = ['cookies_get', 'download', 'backend_fetch', 'browser_fetch', 'backend_file_read',
    'backend_xlsx_read', 'backend_file_write', 'main_world_eval', 'storage_get', 'navigate', 'set_file_input'];
  if (!allowed.includes(action)) throw new Error('Unsupported Adapter runtime helper.');
  for (const value of [payload.url, payload.host, payload.hostname, payload.domain, payload.storageScope, ...(Array.isArray(payload.domains) ? payload.domains : [])]) {
    if (!value) continue;
    let host = String(value).replace(/^\.+/, '').toLowerCase();
    if (host.includes('://')) {
      const url = new URL(host);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported Adapter helper URL.');
      host = url.hostname;
    }
    if (!context.declaredHosts.some((pattern) => hostMatchesPattern(host, pattern))) {
      throw new Error('Adapter helper host is not declared in the current package.');
    }
  }
}

async function callManagedBackgroundTool(manifest, command, args, traceID) {
  const routeDomain = adapterPrimaryHost(manifest);
  const declaredHosts = adapterHelperPatterns(manifest);
  const context = { adapterId: manifest.name, routeDomain, tabDomain: routeDomain, traceID,
    declaredHosts,
    allowedHosts: declaredHosts.map(host => host.replace(/^\*\./, '')) };
  // The runtime owns the shared queue. Set global legacy helper context only
  // while its queued task runs, including settlement of in-flight helpers.
  const runtime = getManagedBackgroundRuntime();
  return runtime.execute(manifest, command, args, context);
}

/** Where the site redirected a requested host inside the package scope (see host-scope.js). */
const managedRouteRedirects = createRouteRedirects();

/** A read step that lands on a login page (redirect or SSO) has not run Adapter code yet. */
function assertNotOnLoginPage(manifest, url) {
  if (isLoginPageUrl(manifest, url)) {
    throw authRequiredError({ site: manifest.name, pageUrl: authDisplayUrl(url), phase: 'navigation' });
  }
}

async function waitForManagedPageReady(tabId, manifest, resume, timeoutMs, traceID = null) {
  const deadline = Date.now() + timeoutMs;
  // Fail fast: while the page is still loading, the URL may already prove that
  // the final host is not declared (e.g. jd.com → www.jd.com), in which case
  // there is no point in waiting for `complete`. A redirect that later lands on
  // a declared host keeps changing tab.url and resets the guard's settle timer,
  // so a still-redirecting tab is never rejected.
  const guard = createNavigationGuard(manifest, resume);
  let stableUrl = null;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) throw new Error('Adapter tab was closed.');
    if (tab.status === 'complete' && stableUrl === tab.url) {
      if (resume) assertNotOnLoginPage(manifest, tab.url);
      return assertAdapterNavigationUrl(manifest, tab.url, resume);
    }
    stableUrl = tab.status === 'complete' ? tab.url : null;
    if (guard.observe(tab.url, Date.now()) === 'reject') {
      if (resume) assertNotOnLoginPage(manifest, tab.url);
      traceLog(traceID, `[ServiceWorker] 页面目标 host 不在白名单，提前结束等待: ${tab.url}`);
      return assertAdapterNavigationUrl(manifest, tab.url, resume);
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Adapter page navigation timed out.');
}

function getHostAdapterRuntime() {
  return hostAdapterRuntime ||= createHostAdapterRuntime({
    bundle: (manifest) => getHostAdapterClient().bundle(manifest),
    prepare: (tabId) => chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: ['content/injector.js'] }),
    clear: async (tabId, name) => {
      await chrome.tabs.sendMessage(tabId, { type: 'clear_tools', siteKey: name });
      clearTabDomainRegistration(tabId);
      tabInjectedAdapters.delete(tabId);
    },
    inject: injectV2AdapterWithCode,
    ready: (tabId, manifest, timeoutMs, traceID) => waitForManagedPageReady(tabId, manifest, true, timeoutMs, traceID),
    recover: (tabId, manifest, url, timeoutMs) => waitForAdapterPageRecovery(chrome, tabId, manifest, url, timeoutMs),
    query: (tabId, payload, manifest, command) => {
      assertAdapterNavigationUrl(manifest, assertPageQueryRoute(payload, command));
      return executePageQuery({ chrome, ensureCdpAttached, tabId, payload: { ...payload, metadataOnly: false } });
    },
    navigate: async (tabId, url, manifest, resume, timeoutMs) => {
      try {
        const landed = await navigateAdapterTab(chrome, tabId, url, manifest, resume, timeoutMs);
        managedRouteRedirects.note(manifest, url, landed);
        return landed;
      } catch (error) {
        // A read continuation redirected to an undeclared login host (SSO).
        if (resume) {
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (tab?.url) assertNotOnLoginPage(manifest, tab.url);
        }
        throw error;
      }
    },
  });
}

// ─── Website login (driven by the Bridge's login flow) ───────────────────────

/** Login tabs opened per site; reused while the user signs in. */
const siteLoginTabs = new Map();

function isDeclaredHostUrl(manifest, value) {
  let url;
  try { url = new URL(String(value)); } catch { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return authDeclaredHosts(manifest).some((pattern) => hostMatchesPattern(url.hostname, pattern));
}

async function managedSiteManifest(site) {
  if (typeof site !== 'string' || !SAFE_ADAPTER_ID_RE.test(site)) throw new Error('Invalid site.');
  const { managed, manifest } = await getHostAdapterClient().manifest(site);
  if (!managed || !manifest) throw new Error(`Adapter "${site}" is not available.`);
  return manifest;
}

function loginTabUrl(manifest, tab) {
  const candidates = [tab?.pendingUrl, tab?.url].filter((value) => typeof value === 'string' && value);
  return candidates.find((value) => isLoginPageUrl(manifest, value, { root: true }))
    || candidates[0]
    || '';
}

async function findSiteLoginTab(manifest) {
  // A tab may still expose its old business URL while pendingUrl already points to SSO.
  // Check both so the auth flow reuses the redirecting tab instead of opening a second login page.
  siteLoginTabs.delete(manifest.name);
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => tab?.id && isLoginPageUrl(manifest, loginTabUrl(manifest, tab), { root: true })) || null;
}

/** Open (or reuse) the login page. Only declared hosts or recognised login pages are opened. */
async function openSiteLoginTab(msg) {
  const manifest = await managedSiteManifest(msg.site);
  let tab = await findSiteLoginTab(manifest);
  if (!tab) {
    // Only declared hosts are opened from a request; an undeclared SSO page is used only
    // when the site itself redirected a tab there (found above).
    const requested = typeof msg.url === 'string' && isDeclaredHostUrl(manifest, msg.url) ? msg.url : null;
    const url = requested || loginStartUrl(manifest);
    if (!url) throw new Error('This Adapter declares no login page.');
    tab = await createBrowserTab({ url, active: true });
  } else if (!tab.active) {
    const updated = await chrome.tabs.update(tab.id, { active: true });
    tab = updated ? { ...tab, ...updated } : tab;
  }
  siteLoginTabs.set(manifest.name, tab.id);
  // The user's own Chrome: bring the login tab forward (WeWorker 浏览器 is shown by the Bridge).
  if (msg.focus === true && Number.isInteger(tab.windowId)) await focusBrowserWindow(tab.windowId).catch(() => {});
  return { tabId: tab.id, url: loginTabUrl(manifest, tab) };
}

/** Where the login tab is, and the declared cookie check. Commands are checked by the Bridge. */
async function checkSiteLogin(msg) {
  const manifest = await managedSiteManifest(msg.site);
  const auth = siteAuth(manifest);
  let loginTab = { open: false, url: '', onLoginPage: false };
  const known = siteLoginTabs.get(manifest.name);
  if (Number.isInteger(known)) {
    const tab = await chrome.tabs.get(known).catch(() => null);
    if (tab?.id) {
      const url = loginTabUrl(manifest, tab);
      // A page that is still loading (for example right after submitting the form) counts as the login page.
      loginTab = { open: true, url, onLoginPage: tab.status !== 'complete' || isLoginPageUrl(manifest, url, { root: true }) };
    } else {
      siteLoginTabs.delete(manifest.name);
    }
  }
  let cookies = null;
  let fingerprint = null;
  const spec = auth?.check?.cookies;
  if (spec && chrome.cookies?.getAll) {
    if (!isDeclaredHostUrl(manifest, spec.url)) throw new Error('Login cookie check host is not declared.');
    const jar = await chrome.cookies.getAll({ url: new URL(String(spec.url)).href });
    cookies = evaluateCookieCheck(spec, jar);
    fingerprint = cookieFingerprint(spec, jar);
  }
  return { loginTab, cookies, ...(fingerprint ? { fingerprint } : {}) };
}

// ─── 用户 adapter 目录访问（经 bridge 代理）─────────────────────────────────

/**
 * 列出用户安装的 adapter id（~/.weworker/adapters 或 ~/.webcli/adapters）。
 * @returns {Promise<string[]>}
 */
async function loadUserAdapterIds() {
  const resp = await requestBridge({ type: "list_user_adapters" }, 5000);
  if (!resp?.ok || !Array.isArray(resp.adapters)) return [];
  return resp.adapters
    .filter((a) => a?.id && typeof a.id === "string" && a.hasManifest)
    .map((a) => a.id);
}

/**
 * 读取用户 adapter 目录内的文件内容。
 * @param {string} adapterId
 * @param {string} relPath
 * @returns {Promise<string|null>} 文件内容或 null
 */
async function readUserAdapterFile(adapterId, relPath) {
  const resp = await requestBridge({ type: "read_user_adapter", payload: { adapterId, relPath } }, 5000);
  if (!resp?.ok || typeof resp?.result?.content !== "string") return null;
  return resp.result.content;
}

/**
 * 判断用户目录中是否存在某 adapter 的 manifest.json。
 * @param {string} adapterId
 * @returns {Promise<boolean>}
 */
async function isUserAdapterInstalled(adapterId) {
  const manifestContent = await readUserAdapterFile(adapterId, "manifest.json");
  return manifestContent !== null;
}

/**
 * 判断 adapter 是否已安装（内置文件探测 + 用户目录探测）。
 * @param {string} adapterId
 * @returns {Promise<boolean>}
 */
async function isAnyAdapterInstalled(adapterId) {
  const selected = await getHostAdapterClient().manifest(adapterId);
  if (selected.managed) return Boolean(selected.manifest);
  if (await isAdapterFileInstalled(adapterId)) return true;
  return isUserAdapterInstalled(adapterId);
}

/**
 * 读取 adapter 的 manifest.json（内置 fetch + 用户目录 bridge 双路径）。
 * @param {string} adapterId
 * @returns {Promise<object|null>}
 */
async function loadAdapterManifestAnywhere(adapterId) {
  const selected = await getHostAdapterClient().manifest(adapterId);
  if (selected.managed) return selected.manifest;
  const builtin = await loadAdapterManifest(adapterId);
  if (builtin) return builtin;
  const content = await readUserAdapterFile(adapterId, "manifest.json");
  if (content === null) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * 从 chrome.storage.local 中读取已安装 adapter ID 列表，
 * 然后逐个加载 adapters/<id>/manifest.json。
 * 如果 storage 为空（首次加载），回退到 adapters/index.json。
 */
async function loadLocalAdapterManifests() {
  let { installedAdapterIds } = await chrome.storage.local.get("installedAdapterIds");
  let ids = Array.isArray(installedAdapterIds) ? installedAdapterIds.filter((id) => typeof id === "string") : [];

  try {
    const url = chrome.runtime.getURL("adapters/index.json");
    const resp = await fetch(url);
    if (resp.ok) {
      const parsed = await resp.json();
      if (Array.isArray(parsed)) {
        ids = Array.from(new Set([...ids, ...parsed.filter((id) => typeof id === "string")])).sort();
      }
    }
  } catch { }

  if (JSON.stringify(ids) !== JSON.stringify(installedAdapterIds ?? [])) {
    await chrome.storage.local.set({ installedAdapterIds: ids });
  }

  const manifests = [];
  for (const id of ids) {
    try {
      const url = chrome.runtime.getURL(`adapters/${id}/manifest.json`);
      const resp = await fetch(url);
      if (resp.ok) {
        const manifest = await resp.json();
        manifests.push(manifest);
      }
    } catch { }
  }

  // 合并用户 adapter manifest（从用户目录经 bridge 读取）
  const userIds = await loadUserAdapterIds();
  for (const userId of userIds) {
    if (ids.includes(userId)) continue; // 已存在跳过
    const content = await readUserAdapterFile(userId, "manifest.json");
    if (content === null) continue;
    try {
      const manifest = JSON.parse(content);
      if (manifest && typeof manifest === "object") {
        // v2：name 即安装身份，归一化出 id 供 hostname 路由使用
        manifests.push(manifest.schema_version === 2 ? { ...manifest, id: manifest.name } : manifest);
      }
    } catch { }
  }

  return getHostAdapterClient().merge(manifests);
}

/**
 * 初始化已安装 adapter ID 列表。
 * 从本地 adapters/index.json 读取（打包时生成），然后逐个验证文件存在。
 */
async function doRefreshRegistry() {
  await initInstalledAdapterIds();
  await loadStaticToolRoutes();
  const [stored, hostCatalog] = await Promise.all([
    chrome.storage.local.get("installedAdapterIds"),
    getHostAdapterClient().catalog().catch(() => null),
  ]);
  const managedNames = Array.isArray(hostCatalog?.managedNames) ? hostCatalog.managedNames : [];
  const legacyIds = Array.isArray(stored.installedAdapterIds) ? stored.installedAdapterIds : [];
  const adapters = [...new Set([...managedNames, ...legacyIds])].sort();
  return { count: adapters.length, adapters };
}
async function initInstalledAdapterIds() {
  // 始终重新扫描（不依赖缓存，确保刷新后能发现新 adapter）
  const knownIds = [];
  try {
    const url = chrome.runtime.getURL("adapters/index.json");
    const resp = await fetch(url);
    if (resp.ok) {
      const ids = await resp.json();
      if (Array.isArray(ids)) knownIds.push(...ids);
    }
  } catch { }

  if (knownIds.length === 0) {
    console.warn("[WebMCP] adapters/index.json not found or empty");
    return;
  }

  const installed = [];
  for (const id of knownIds) {
    if (await isAdapterFileInstalled(id)) {
      installed.push(id);
    }
  }

  // 合并用户目录 adapter id（~/.weworker/adapters）
  const userIds = await loadUserAdapterIds();
  for (const userId of userIds) {
    if (!installed.includes(userId)) installed.push(userId);
  }

  await chrome.storage.local.set({ installedAdapterIds: installed });
  console.log(`[WebMCP] Initialized installed adapter IDs (${installed.length}): ${installed.join(", ")}`);
}

// ─── Adapter 文件检测 ────────────────────────────────────────────────────────

/**
 * 检查 adapter JS 文件是否已安装到扩展包的 adapters/ 目录
 * （通过 fetch 扩展内部资源来探测文件是否存在）
 * @param {string} adapterId
 * @returns {Promise<boolean>}
 */
async function isAdapterFileInstalled(adapterId) {
  try {
    const url = chrome.runtime.getURL(`adapters/${adapterId}/index.js`);
    const resp = await fetch(url);
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * 预加载所有已安装 adapter 的 wecli.generated.json，构建静态路由表。
 * 当 toolRouteIndex 中没有活动条目（即没有 tab 打开）时，用此表查 routeDomain，
 * 避免 fallback 到 extractDomainFromToolName 返回的短主机名（如 "wcs"）。
 */
async function loadStaticToolRoutes() {
  const ids = await loadInstalledAdapterIds();
  const next = new Map();
  const nextDefinitions = new Map();
  for (const id of ids) {
    try {
      const url = chrome.runtime.getURL(`adapters/${id}/wecli.generated.json`);
      const resp = await fetch(url);
      let data = null;
      if (resp.ok) {
        data = await resp.json();
      } else {
        // 用户 adapter：从用户目录经 bridge 读取
        const content = await readUserAdapterFile(id, "wecli.generated.json");
        if (content !== null) {
          data = JSON.parse(content);
        }
      }
      if (!data) continue;
      const commands = Array.isArray(data?.registeredCommands) ? data.registeredCommands : [];
      for (const cmd of commands) {
        const publicName = typeof cmd?.publicName === "string" ? cmd.publicName : null;
        const handlerName = typeof cmd?.handlerName === "string" ? cmd.handlerName : publicName;
        const routeDomain = typeof cmd?.routeDomain === "string" ? cmd.routeDomain : null;
        if (!publicName || !routeDomain) continue;
        const allowedHosts = normalizeRouteHosts(cmd?.allowedHosts);
        const directCapable = isGeneratedCommandDirectCapable(cmd);
        const executionMode = normalizeExecutionMode(cmd?.executionMode) || (directCapable ? "direct" : undefined);
        const route = {
          publicName,
          handlerName,
          adapterId: typeof cmd?.adapterId === "string" ? cmd.adapterId : id,
          routeDomain,
          tabDomain: typeof cmd?.tabDomain === "string" ? cmd.tabDomain : routeDomain,
          ...(allowedHosts.length ? { allowedHosts } : {}),
          ...(directCapable ? { directCapable: true } : {}),
          ...(cmd?.preferDirect === true ? { preferDirect: true } : {}),
          ...(executionMode ? { executionMode } : {}),
        };
        addToolRouteIndexEntries(next, route);
        const definition = {
          name: publicName,
          publicName,
          handlerName,
          adapterId: route.adapterId,
          routeDomain,
          tabDomain: typeof cmd?.tabDomain === "string" ? cmd.tabDomain : routeDomain,
          excludeTabDomain: typeof cmd?.excludeTabDomain === "string" ? cmd.excludeTabDomain : undefined,
          ...(allowedHosts.length ? { allowedHosts } : {}),
          ...(directCapable ? { directCapable: true } : {}),
          ...(cmd?.preferDirect === true ? { preferDirect: true } : {}),
          ...(executionMode ? { executionMode } : {}),
          description: typeof cmd?.description === "string" ? cmd.description : "",
          parameters: cmd?.parameters && typeof cmd.parameters === "object" ? cmd.parameters : {},
        };
        nextDefinitions.set(publicName, definition);
      }
    } catch {
      // 单个 adapter 失败不应阻塞其余加载
    }

    try {
      const adapterManifest = await loadAdapterManifest(id);
      addGeneratedSupportToolRoutes(id, adapterManifest, next, nextDefinitions);
    } catch {
      // generated support route discovery is best effort
    }
  }
  staticToolRouteIndex.clear();
  for (const [k, v] of next) staticToolRouteIndex.set(k, v);
  staticToolDefinitionIndex.clear();
  for (const [k, v] of nextDefinitions) staticToolDefinitionIndex.set(k, v);
  console.log(`[WebMCP] Loaded ${staticToolRouteIndex.size} static tool routes and ${staticToolDefinitionIndex.size} tool definitions from ${ids.length} adapters`);
}

function addGeneratedSupportToolRoutes(adapterId, adapterManifest, nextRoutes, nextDefinitions) {
  const toolExecution = adapterManifest?.tool_execution && typeof adapterManifest.tool_execution === "object"
    ? adapterManifest.tool_execution
    : {};
  for (const [publicName, execution] of Object.entries(toolExecution)) {
    if (execution?.type !== "api" || execution?.runtime !== "background") continue;
    if (nextRoutes.has(publicName)) continue;
    const route = {
      publicName,
      handlerName: publicName,
      adapterId,
      routeDomain: adapterId,
      tabDomain: adapterId,
      directCapable: true,
      executionMode: "direct",
    };
    addToolRouteIndexEntries(nextRoutes, route);
    if (!nextDefinitions.has(publicName)) {
      nextDefinitions.set(publicName, {
        name: publicName,
        publicName,
        handlerName: publicName,
        adapterId,
        routeDomain: adapterId,
        tabDomain: adapterId,
        directCapable: true,
        executionMode: "direct",
        description: '',
        parameters: {},
      });
    }
  }
}

/**
 * 读取已安装 adapter ID 列表（合并 chrome.storage.local、adapters/index.json 与用户目录）。
 * 与 initInstalledAdapterIds 的差异：本函数仅返回 ID 列表，不写入 storage，可被复用。
 */
async function loadInstalledAdapterIds() {
  let ids = [];
  try {
    const stored = await chrome.storage.local.get("installedAdapterIds");
    if (Array.isArray(stored?.installedAdapterIds)) {
      ids.push(...stored.installedAdapterIds.filter((id) => typeof id === "string"));
    }
  } catch { }
  try {
    const url = chrome.runtime.getURL("adapters/index.json");
    const resp = await fetch(url);
    if (resp.ok) {
      const parsed = await resp.json();
      if (Array.isArray(parsed)) {
        ids = Array.from(new Set([...ids, ...parsed.filter((id) => typeof id === "string")])).sort();
      }
    }
  } catch { }
  // 合并用户目录 adapter id（~/.weworker/adapters）
  const userIds = await loadUserAdapterIds();
  for (const userId of userIds) {
    if (!ids.includes(userId)) ids.push(userId);
  }
  return ids;
}

// ─── Badge 管理 ─────────────────────────────────────────────────────────────

/**
 * 绿色 badge，显示工具数量，表示 adapter 已激活
 * @param {number} tabId
 * @param {number} toolCount
 */
function setBadgeActive(tabId, toolCount) {
  chrome.action.setBadgeText({ text: String(toolCount), tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#22c55e", tabId }); // green-500
  chrome.action.setTitle({ title: `WebMCP：${toolCount} 个工具已就绪`, tabId });
}

/**
 * 清除 badge
 * @param {number} tabId
 */
function clearBadge(tabId) {
  chrome.action.setBadgeText({ text: "", tabId });
  chrome.action.setTitle({ title: "WeWorker Browser Adapter", tabId });
}

// ─── Adapter 注入 ───────────────────────────────────────────────────────────

/** Safe adapter id: starts with alphanumeric, then alphanumeric/dot/hyphen/underscore only. */
const SAFE_ADAPTER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SAFE_ADAPTER_SUPPORT_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

function normalizeAdapterSupportFiles(adapterId, supportFiles) {
  if (!Array.isArray(supportFiles)) return [];

  return supportFiles
    .filter((value) => typeof value === "string")
    .map((value) => value.trim().replace(/^\/+/, ""))
    .filter((value) => value && !value.includes("..") && !value.startsWith("adapters/") && SAFE_ADAPTER_SUPPORT_FILE_RE.test(value))
    .map((value) => `adapters/${adapterId}/${value}`);
}

function normalizeGenerationPreviewBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return null;
  const manifest = bundle.manifest && typeof bundle.manifest === 'object' ? bundle.manifest : null;
  const scripts = Array.isArray(bundle.scripts) ? bundle.scripts : [];
  if (!manifest || scripts.length === 0 || scripts.length > 50) {
    throw new Error('invalid inline generation preview bundle');
  }
  let totalChars = 0;
  const normalizedScripts = scripts.map((script) => {
    const scriptPath = String(script?.path || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
    const source = String(script?.source || '');
    if (!SAFE_ADAPTER_SUPPORT_FILE_RE.test(scriptPath) || !scriptPath.endsWith('.js') || scriptPath.includes('..') || !source) {
      throw new Error(`invalid inline preview script: ${scriptPath || 'unknown'}`);
    }
    totalChars += source.length;
    if (totalChars > 1_000_000) throw new Error('inline generation preview bundle is too large');
    return { path: scriptPath, source };
  });
  const packageDigest = bundle.packageDigest || null;
  if (packageDigest !== null && !/^[a-f0-9]{64}$/.test(packageDigest)) throw new Error('Invalid preview package digest');
  return { manifest, scripts: normalizedScripts, packageDigest };
}

async function loadAdapterManifest(adapterId) {
  try {
    const url = chrome.runtime.getURL(`adapters/${adapterId}/manifest.json`);
    const resp = await fetch(url);
    if (resp.ok) {
      return await resp.json();
    }
  } catch { }
  return null;
}

function adapterMatchesHostname(adapterMeta, hostname) {
  const matches = (domain) => {
    const normalized = String(domain).toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
    const host = String(hostname).toLowerCase().replace(/\.$/, '');
    return host === normalized || host.endsWith('.' + normalized);
  };
  // Registry entries treat `match` as a domain suffix; v2 `domains` are site domains.
  const scope = [...(Array.isArray(adapterMeta?.match) ? adapterMeta.match : []),
    ...(Array.isArray(adapterMeta?.domains) ? adapterMeta.domains : [])];
  return scope.some(matches)
    && !(adapterMeta.except ?? []).some(matches);
}

async function findAdapterIdByFileProbe(hostname) {
  if (await isAnyAdapterInstalled(hostname)) return hostname;

  const parts = hostname.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const candidateId = parts.slice(i).join('.');
    if (await isAnyAdapterInstalled(candidateId)) {
      return candidateId;
    }
  }

  return null;
}

async function resolveAdapterForHostname(hostname) {
  const registry = await getCachedRegistry();
  const adapters = registry?.adapters ?? [];
  const adapterMeta = adapters.find((entry) => adapterMatchesHostname(entry, hostname)) || null;

  let adapterId = adapterMeta?.id || null;
  if (!adapterId) {
    adapterId = await findAdapterIdByFileProbe(hostname);
  }

  if (!adapterId) {
    return {
      registry,
      adapterId: null,
      adapterMeta: null,
      adapterManifest: null,
    };
  }

  const adapterManifest = adapterMeta?.id === adapterId ? adapterMeta : await loadAdapterManifestAnywhere(adapterId);
  if (adapterManifest?._hostSnapshot && !adapterMatchesHostname(adapterManifest, hostname)) {
    return { registry, adapterId: null, adapterMeta: null, adapterManifest: null };
  }

  return {
    registry,
    adapterId,
    adapterMeta,
    adapterManifest,
  };
}

function clearTabDomainRegistration(tabId) {
  const previousDomain = tabDomainMap.get(tabId);
  if (!previousDomain) return;

  const previousDomainData = toolRegistry.get(previousDomain);
  if (previousDomainData) {
    previousDomainData.tabIds.delete(tabId);
    if (previousDomainData.tabIds.size === 0) {
      toolRegistry.delete(previousDomain);
      rebuildToolRouteIndex();
      console.log(`[WebMCP] Cleared domain ${previousDomain} after tab ${tabId} moved away`);
    }
  }

  tabDomainMap.delete(tabId);
}

function setAdapterInjectionStatus(adapterId, status) {
  if (!adapterId) return;
  adapterInjectionStatus.set(adapterId, {
    ok: Boolean(status?.ok),
    error: status?.error ? String(status.error) : '',
    tabId: Number.isInteger(status?.tabId) ? status.tabId : undefined,
    updatedAt: Date.now(),
  });
}

function getAdapterInjectionError(adapterId, maxAgeMs = 120000) {
  const status = adapterInjectionStatus.get(adapterId);
  if (!status || status.ok || !status.error) return '';
  if (Date.now() - Number(status.updatedAt || 0) > maxAgeMs) return '';
  return status.error;
}

async function waitForDomainTools(domain, timeoutMs = 800) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const domainData = toolRegistry.get(domain);
    if (domainData?.tools?.length) return domainData;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return toolRegistry.get(domain) || null;
}

async function waitForPreviewTools(domain, tabId, expectedToolNames, timeoutMs = 3000) {
  const expected = new Set((expectedToolNames || []).map(String).filter(Boolean));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const domainData = toolRegistry.get(domain);
    const names = new Set((domainData?.tools || []).map((tool) => tool.publicName || tool.name));
    const tabRegistered = domainData?.tabIds?.has(tabId);
    const allExpectedRegistered = [...expected].every((name) => names.has(name));
    if (tabRegistered && allExpectedRegistered) return domainData;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return toolRegistry.get(domain) || null;
}

async function findGenerationPreviewTab(siteKey, preferredTabId) {
  const matchesSite = (tab) => {
    if (!Number.isInteger(tab?.id) || !shouldHandleTabUrl(tab?.url)) return false;
    try {
      return hostnameMatchesDomain(new URL(tab.url).hostname, siteKey);
    } catch {
      return false;
    }
  };
  if (Number.isInteger(preferredTabId)) {
    try {
      const preferred = await chrome.tabs.get(preferredTabId);
      if (matchesSite(preferred)) return preferred;
    } catch {}
  }
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const active = activeTabs.find(matchesSite);
  if (active) return active;
  const tabs = await chrome.tabs.query({});
  return tabs.filter(matchesSite).sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0] || null;
}

function findSensitiveOutputPath(value, pathPrefix = '$', depth = 0) {
  if (depth > 8 || value == null) return '';
  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 20); index++) {
      const found = findSensitiveOutputPath(value[index], `${pathPrefix}[${index}]`, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const [key, child] of Object.entries(value)) {
    if (/api[_-]?key|authorization|cookie|credential|password|passwd|secret|session|ticket|token|csrf/i.test(key)) {
      return `${pathPrefix}.${key}`;
    }
    const found = findSensitiveOutputPath(child, `${pathPrefix}.${key}`, depth + 1);
    if (found) return found;
  }
  return '';
}

function validateGenerationPreviewOutput(output, contract = {}) {
  return validateGenerationPreviewOutputV2(output, contract);
}

const CAPTURE_BOUND_SENSITIVE_PARAM_RE = /api[_-]?key|authorization|cookie|credential|password|passwd|secret|session|ticket|token|csrf|xsrf/i;

function normalizeEndpointPathForCaptureBound(pathname) {
  return String(pathname || '')
    .split('/')
    .map((segment) => (
      /^\d{3,}$/.test(segment)
      || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)
      || /^[A-Za-z]+-\d{2,}$/.test(segment)
        ? ':id'
        : segment
    ))
    .join('/');
}

function capturedEndpointFamily(entry) {
  try {
    const url = new URL(String(entry?.url || ''));
    const method = String(entry?.method || 'GET').toUpperCase();
    const queryKeys = [...new Set([...url.searchParams.keys()])].sort();
    return `${method} ${normalizeEndpointPathForCaptureBound(url.pathname)}${queryKeys.length ? `?${queryKeys.join(',')}` : ''}`;
  } catch {
    return '';
  }
}

function findCaptureBoundEntry(tabId, endpointFamily, contract = {}) {
  const candidates = ensureCdpState(tabId).entries.filter((entry) => {
    if (capturedEndpointFamily(entry) !== String(endpointFamily || '')) return false;
    const method = String(entry?.method || 'GET').toUpperCase();
    const probe = `${capturedEndpointFamily(entry)} ${String(entry?.requestBodyPreview || '')}`;
    if (/(?:^|[^a-z0-9])(approve|book|buy|cancel|commit|create|delete|edit|finish|mutation|pay|publish|reject|reserve|save|submit|update|upload)(?:$|[^a-z0-9])/i.test(probe)) return false;
    return ['GET', 'HEAD'].includes(method)
      || (method === 'POST' && /(?:^|[^a-z0-9])(detail|filter|get|list|page|query|read|search|sort|status)(?:$|[^a-z0-9])/i.test(probe));
  });
  return selectCompatibleCaptureBoundEntry(candidates, contract);
}

function coerceCaptureBoundValue(value, propertySchema = {}) {
  if (value === undefined || value === null) return undefined;
  if (propertySchema.type === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  if (propertySchema.type === 'boolean') {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  }
  return String(value);
}

function buildCaptureBoundArguments(entry, tool, testCase) {
  const properties = tool?.parameters?.properties && typeof tool.parameters.properties === 'object'
    ? tool.parameters.properties
    : {};
  const keys = [...new Set([
    ...Object.keys(properties),
    ...Object.keys(testCase?.arguments || {}),
    ...(testCase?.capturedRequestKeys || []),
  ])].filter((key) => key && !CAPTURE_BOUND_SENSITIVE_PARAM_RE.test(key));
  const url = new URL(String(entry?.url || ''));
  let body = {};
  try {
    const parsed = JSON.parse(String(entry?.requestBodyPreview || '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
  } catch {}
  const args = { ...(testCase?.arguments || {}) };
  for (const key of keys) {
    const raw = url.searchParams.has(key)
      ? url.searchParams.get(key)
      : body[key];
    const coerced = coerceCaptureBoundValue(raw, properties[key] || {});
    if (coerced !== undefined) args[key] = coerced;
  }
  return args;
}

function describeGenerationOutputShape(value) {
  const kindOf = (current) => current === null ? 'null' : Array.isArray(current) ? 'array' : typeof current;
  const kinds = new Set();
  const visit = (current, depth = 0) => {
    const kind = kindOf(current);
    kinds.add(kind);
    if (depth >= 6 || current == null) return;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 3)) visit(item, depth + 1);
    } else if (typeof current === 'object') {
      for (const child of Object.values(current).slice(0, 30)) visit(child, depth + 1);
    }
  };
  visit(value);
  return {
    rootKind: kindOf(value),
    containsKinds: [...kinds].sort(),
    rootKeys: value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).slice(0, 30).sort()
      : [],
  };
}

async function callGenerationPreviewTool(tabId, token, toolName, args, timeoutMs = 30000, continuation = null) {
  const response = await Promise.race([
    chrome.tabs.sendMessage(tabId, { type: 'call_generation_preview', token, toolName, args, ...(continuation ? { continuation } : {}) }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`tool timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);
  if (response?.error) throw new Error(response.error);
  const result = response?.result;
  if (result && typeof result === 'object' && (result.__cdp_action || result.__after)) {
    const error = new Error('preview tool returned a side-effect action');
    error.code = 'UNEXPECTED_SIDE_EFFECT_ACTION';
    throw error;
  }
  return result;
}

const generationPreviewGrants = new Map();

async function validateGenerationPreview({ previewAdapterId, previewBundle = null, siteKey, tabId, expectedToolNames = [], testCases = [], operationId, executionMode } = {}) {
  if (!SAFE_ADAPTER_ID_RE.test(String(previewAdapterId || '')) || !String(previewAdapterId).startsWith('generation_preview_')) {
    throw new Error('invalid generation preview adapter id');
  }
  if (!SAFE_ADAPTER_ID_RE.test(String(siteKey || ''))) throw new Error('invalid generation preview siteKey');
  if (executionMode === 'background') {
    const normalized = normalizeGenerationPreviewBundle(previewBundle);
    if (!normalized) throw new Error('Background preview requires an inline package.');
    const bundle = { manifest: normalized.manifest, files: Object.fromEntries(normalized.scripts.map(script => [script.path, script.source])) };
    return validateBackgroundPreview({ bundle, expectedToolNames, testCases, execute: (manifest, command, args, selected) => {
      const routeDomain = manifest.match[0].replace(/^\*\./, '');
      const declaredHosts = [...manifest.match, ...(manifest.runtime_allowed_hosts || [])];
      return getManagedBackgroundRuntime().execute(manifest, command, args, { adapterId: manifest.name, routeDomain, tabDomain: routeDomain,
        declaredHosts, allowedHosts: declaredHosts.map(host => host.replace(/^\*\./, '')), previewNoPage: true,
        previewDeadline: Date.now() + 30000, previewRequests: 0 }, selected);
    } });
  }
  const routeCommands = previewBundle?.manifest?.commands || [];
  const explicitOrigins = routeCommands.some(command => usesWorkflowOrigins(command.pageRoute?.navigation) || usesWorkflowOrigins(command.pageRoute?.workflow));
  let targetTab;
  if (explicitOrigins) {
    // A cross-origin preview is bound to the task tab. Never find a substitute
    // by host if this tab navigated outside its explicitly declared routes.
    if (Number.isInteger(tabId)) {
      try { const selected = await chrome.tabs.get(tabId);
        if (routeCommands.some(command => command.pageRoute && pageRouteTargets(command.pageRoute).some(target => matchesOriginTarget(new URL(selected.url), target)))) targetTab = selected;
      } catch {}
    }
  } else targetTab = await findGenerationPreviewTab(siteKey, tabId);
  if (!targetTab) {
    return {
      passed: false,
      phase: testCases.length > 0 ? 'execution' : 'registration',
      errors: [{
        code: 'TARGET_TAB_NOT_FOUND',
        message: `未找到已打开的 ${siteKey} 页面，无法执行真实页面验证`,
      }],
      tools: [],
    };
  }

  return getHostAdapterRuntime().exclusive(targetTab.id, async () => validateGenerationPreviewOnTab({
    previewAdapterId, previewBundle, siteKey, expectedToolNames, testCases, operationId,
  }, await chrome.tabs.get(targetTab.id)));
}

async function validateGenerationPreviewOnTab({ previewAdapterId, previewBundle, siteKey, expectedToolNames, testCases, operationId }, targetTab) {
  const inlinePreview = normalizeGenerationPreviewBundle(previewBundle);
  const manifest = inlinePreview?.manifest || await loadAdapterManifest(previewAdapterId);
  if (!manifest) throw new Error(`preview manifest not found: ${previewAdapterId}`);
  const supportFiles = normalizeAdapterSupportFiles(previewAdapterId, manifest.support_files);
  const explicitOrigins = manifest.commands?.some(command => usesWorkflowOrigins(command.pageRoute?.navigation) || usesWorkflowOrigins(command.pageRoute?.workflow));
  const previewSite = url => {
    if (!explicitOrigins) return siteKey;
    const current = new URL(url);
    if (!manifest.commands.some(command => command.pageRoute && pageRouteTargets(command.pageRoute).some(target => matchesOriginTarget(current, target)))) throw new Error('Preview left the declared page routes.');
    assertAdapterNavigationUrl(manifest, current.href);
    return current.hostname;
  };
  const expected = [...new Set((expectedToolNames || []).map(String).filter(Boolean))];

  const token = crypto.randomUUID();
  let began = false;
  try {
    await chrome.scripting.executeScript({ target: { tabId: targetTab.id }, world: 'ISOLATED', files: ['content/preview-registry.js'] });
    const opened = await chrome.tabs.sendMessage(targetTab.id, { type: 'begin_generation_preview', token, siteKey: previewSite((await chrome.tabs.get(targetTab.id)).url), previewAdapterId, packageDigest: inlinePreview?.packageDigest || null, allowQueryChanges: manifest.commands?.some(command => command.pageStrategy === 'INTERCEPT') === true });
    if (!opened?.ok) throw new Error(opened?.error || 'Unable to begin preview');
    began = true;
    generationPreviewGrants.set(token, { tabId: targetTab.id, url: targetTab.url, allowedHosts: normalizeRouteHosts(manifest.runtime_allowed_hosts), expiresAt: Date.now() + 300000 });
    const scripts = inlinePreview?.scripts || await Promise.all([...supportFiles, `adapters/${previewAdapterId}/index.js`].map(async file => {
      const response = await fetch(chrome.runtime.getURL(file));
      if (!response.ok) throw new Error('Missing preview script');
      return { path: file, source: await response.text() };
    }));
    await injectGenerationPreviewSourcesWithCdp(targetTab.id, scopedGenerationPreviewScripts(scripts, token));
    const domainData = await chrome.tabs.sendMessage(targetTab.id, { type: 'get_generation_preview', token });
    const registeredTools = (domainData?.tools || []).map((tool) => ({
      name: tool.publicName || tool.name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
      generationSource: tool.generationSource || null,
    }));
    const registeredNames = new Set(registeredTools.map((tool) => tool.name));
    const missingTools = expected.filter((name) => !registeredNames.has(name));
    const tabRegistered = domainData?.ok === true;
    const errors = [];
    if (!tabRegistered) errors.push({ code: 'PREVIEW_NOT_REGISTERED_ON_TAB', message: 'Preview Adapter 未在目标页面完成注册' });
    for (const toolName of missingTools) {
      errors.push({ code: 'TOOL_NOT_REGISTERED', toolName, message: `预期工具未注册: ${toolName}` });
    }
    const toolResults = [];
    if (errors.length === 0 && Array.isArray(testCases)) {
      for (const testCase of testCases.slice(0, 5)) {
        assertPageWorkflowActive(targetTab.id, operationId);
        const toolName = String(testCase?.toolName || '');
        const risk = testCase?.risk || {};
        const tool = registeredTools.find((item) => String(item?.name || '') === toolName) || null;
        const preflightErrors = Array.isArray(testCase?.validationErrors) ? testCase.validationErrors : [];
        if (preflightErrors.length > 0) {
          toolResults.push({
            toolName,
            ...(testCase.caseId ? { caseId: testCase.caseId } : {}),
            attempted: false,
            passed: false,
            skipReason: testCase?.skipReason || 'preflight_contract_mismatch',
            errors: preflightErrors,
          });
          continue;
        }
        if (!testCase?.execute || risk.level !== 'read' || Number(risk.confidence || 0) < 0.75) {
          toolResults.push({
            toolName,
            ...(testCase.caseId ? { caseId: testCase.caseId } : {}),
            attempted: false,
            passed: true,
            skipReason: testCase?.skipReason || 'tool_is_not_high_confidence_read_only',
          });
          continue;
        }
        const startedAt = Date.now();
        try {
          let runtimeArguments = testCase.arguments || {};
          if (testCase?.captureBound) {
            const capturedEntry = findCaptureBoundEntry(
              targetTab.id,
              testCase.captureBoundEndpointFamily,
              testCase.contract || {},
            );
            if (!capturedEntry) {
              throw Object.assign(new Error('未找到可用于本次 Preview 的 capture-bound 只读请求'), {
                code: 'CAPTURE_BOUND_ARGUMENTS_NOT_FOUND',
              });
            }
            runtimeArguments = buildCaptureBoundArguments(capturedEntry, tool, testCase);
          }
          let output = await callGenerationPreviewTool(targetTab.id, token, toolName, runtimeArguments);
          if (output?.__webcli_page_query) {
            const command = manifest.commands?.find(entry => `${manifest.name}.${entry.id}` === toolName);
            const payload = output.__webcli_page_query;
            assertAdapterNavigationUrl(manifest, assertPageQueryRoute(payload, command));
            const result = await executePageQuery({ chrome, ensureCdpAttached, tabId: targetTab.id, payload: { ...payload, operationId, metadataOnly: false } });
            if (!result.ok) output = result;
            else {
              await sendTabMessage(targetTab.id, { type: 'end_generation_preview', token });
              await chrome.scripting.executeScript({ target: { tabId: targetTab.id }, world: 'ISOLATED', files: ['content/preview-registry.js'] });
              const restored = await chrome.tabs.sendMessage(targetTab.id, { type: 'begin_generation_preview', token, siteKey: previewSite((await chrome.tabs.get(targetTab.id)).url), previewAdapterId, packageDigest: inlinePreview?.packageDigest || null, allowQueryChanges: manifest.commands?.some(command => command.pageStrategy === 'INTERCEPT') === true });
              if (!restored?.ok) throw new Error('Unable to resume preview after query.');
              generationPreviewGrants.get(token).url = (await chrome.tabs.get(targetTab.id)).url;
              await injectGenerationPreviewSourcesWithCdp(targetTab.id, scopedGenerationPreviewScripts(scripts, token));
              output = await callGenerationPreviewTool(targetTab.id, token, toolName, runtimeArguments, 30000, { kind: 'page_query_result', result });
              if (output?.__webcli_page_query || output?.__webcli_navigation) throw new Error('Preview query must return a final result after resuming.');
            }
          }
          const contractResult = validateGenerationPreviewOutput(output, testCase.contract || {});
          toolResults.push({
            toolName,
            ...(testCase.caseId ? { caseId: testCase.caseId } : {}),
            attempted: true,
            durationMs: Date.now() - startedAt,
            passed: contractResult.passed,
            arguments: testCase.arguments || {},
            argumentSources: testCase.argumentSources || {},
            contract: testCase.contract || {},
            ...contractResult,
          });
        } catch (error) {
          toolResults.push({
            toolName,
            ...(testCase.caseId ? { caseId: testCase.caseId } : {}),
            attempted: true,
            durationMs: Date.now() - startedAt,
            passed: false,
            errors: [{
              code: error?.code || (/timed out/i.test(error?.message || '') ? 'TOOL_TIMEOUT' : 'RUNTIME_EXCEPTION'),
              message: error?.message || String(error),
            }],
          });
        }
      }
    }
    const failedToolResults = toolResults.filter((item) => item.passed === false);
    const attemptedCount = toolResults.filter((item) => item.attempted).length;
    const warnings = [
      ...(attemptedCount === 0 && failedToolResults.length === 0 && testCases.length > 0
        ? [{ code: 'NO_SAFE_RUNTIME_CASES', message: '没有具备安全参数的高置信度只读工具，已仅完成注册验证' }]
        : []),
      ...toolResults.flatMap((item) => (item.warnings || []).map((warning) => ({ ...warning, toolName: item.toolName }))),
    ];
    for (const failure of failedToolResults) {
      for (const error of failure.errors || []) errors.push({ ...error, toolName: failure.toolName, ...(failure.caseId ? { caseId: failure.caseId } : {}) });
    }
    return {
      passed: errors.length === 0,
      phase: testCases.length > 0 ? 'execution' : 'registration',
      tabId: targetTab.id,
      tabUrl: targetTab.url || '',
      previewAdapterId,
      registeredToolCount: registeredTools.length,
      expectedToolCount: expected.length,
      tools: registeredTools,
      toolResults,
      warnings,
      executionSummary: {
        attempted: attemptedCount,
        passed: toolResults.filter((item) => item.attempted && item.passed).length,
        skipped: toolResults.filter((item) => !item.attempted && item.passed !== false).length,
        failed: failedToolResults.length,
      },
      errors,
    };
  } finally {
    generationPreviewGrants.delete(token);
    if (began) await sendTabMessage(targetTab.id, { type: 'end_generation_preview', token });
  }
}

function shouldHandleTabUrl(url) {
  return typeof url === "string"
    && !url.startsWith("chrome://")
    && !url.startsWith("chrome-extension://");
}

function sendTabMessage(tabId, message, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: `tab message timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          finish({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        finish(response || { ok: true });
      });
    } catch (error) {
      finish({ ok: false, error: error?.message || String(error) });
    }
  });
}

async function refreshAdapterTabs(adapterId) {
  return refreshAdapterTabBatch([adapterId]);
}

let adapterStateRefreshChain = Promise.resolve();
let lastRefreshedCatalog = null;
let refreshedCatalogAdapters = new Set();
function refreshAdapterState(msg) {
  const next = adapterStateRefreshChain.catch(() => {}).then(async () => {
    const registry = await doRefreshRegistry();
    const catalog = await getHostAdapterClient().catalog();
    const fingerprint = catalog?.available !== false && Array.isArray(catalog?.adapters) && Array.isArray(catalog?.managedNames)
      ? JSON.stringify({ profile: catalog.profile, revision: catalog.revision, names: [...catalog.managedNames].sort(),
        packages: catalog.adapters.map(item => [item.name, item._hostSnapshot]).sort((a, b) => a[0].localeCompare(b[0])) }) : null;
    // Reconnect snapshots and delayed duplicate change notifications may refer
    // to an already refreshed catalog. Manual refresh uses the separate tab API.
    const adapters = Array.isArray(msg.adapters) ? msg.adapters.filter(name => typeof name === 'string' && SAFE_ADAPTER_ID_RE.test(name)) : [];
    const adapterIds = adapters.length ? adapters : registry.adapters.filter(name => typeof name === 'string' && SAFE_ADAPTER_ID_RE.test(name));
    if (fingerprint && fingerprint === lastRefreshedCatalog && adapterIds.every(id => refreshedCatalogAdapters.has(id))) return { registry, refreshedTabs: 0 };
    const result = await refreshAdapterTabBatch(adapterIds);
    if (!fingerprint || fingerprint !== lastRefreshedCatalog) refreshedCatalogAdapters = new Set();
    for (const id of adapterIds) refreshedCatalogAdapters.add(id);
    lastRefreshedCatalog = fingerprint;
    return { registry, refreshedTabs: result.refreshedTabs };
  });
  adapterStateRefreshChain = next;
  return next;
}

async function refreshAdapterTabBatch(adapterIds) {
  const ids = [...new Set(adapterIds)];
  // One snapshot for the whole catalog notification. Re-querying for each
  // package can reload newly opened pages, or reload one page repeatedly when
  // several packages match the same host, after an earlier refresh released it.
  const tabs = await chrome.tabs.query({});
  const matchedTabs = [];
  const manifests = await Promise.all(ids.map(id => loadAdapterManifestAnywhere(id)));

  await runDirectToolExclusive(async () => {
    directAdapterLoadPromises.clear();
    try {
      await chrome.offscreen?.closeDocument?.();
    } catch {
      // No offscreen document exists yet.
    }
  });

  for (const tab of tabs) {
    if (!Number.isInteger(tab?.id) || !shouldHandleTabUrl(tab?.url)) continue;

    let hostname;
    try {
      hostname = new URL(tab.url).hostname;
    } catch {
      continue;
    }

    const matchingIds = ids.filter((id, index) => manifests[index]
      ? adapterMatchesHostname(manifests[index], hostname)
      : hostname === id || hostname.endsWith(`.${id}`));
    if (matchingIds.length) matchedTabs.push({ ...tab, matchingIds });
  }

  if (matchedTabs.length === 0) {
    return {
      refreshedTabs: 0,
      toolCount: ids.reduce((count, id) => count + (toolRegistry.get(id)?.tools?.length || 0), 0),
    };
  }

  // Reserve every affected tab before awaiting the first reload. Otherwise a
  // long reconnect refresh lets a later tab start a new exploration, then
  // reloads it between that task's independent before/write/after requests.
  let previousRefresh = Promise.resolve();
  let refreshedTabs = 0;
  const refreshes = matchedTabs.map(tab => {
    const preceding = previousRefresh;
    const refresh = getHostAdapterRuntime().exclusive(tab.id, async () => {
      await preceding; // Preserve serial reloads without leaving later tabs free.
      const currentTab = await chrome.tabs.get(tab.id);
      // The snapshot grants refresh only for the page we originally matched.
      // A queued operation may have navigated this tab in the meantime.
      if (currentTab.url !== tab.url) return;
      // A tab opened after installation may already contain the latest bundle
      // before the delayed state notification arrives. Do not erase that page.
      if (tab.matchingIds.every(id => {
        const manifest = manifests[ids.indexOf(id)];
        return manifest?._hostSnapshot && getHostAdapterRuntime().hasSnapshot?.(tab.id, manifest, currentTab.url);
      })) return;
      clearTabDomainRegistration(tab.id);
      clearTabInjectedAdapters(tab.id);
      clearBadge(tab.id);
      for (const id of tab.matchingIds) await sendTabMessage(tab.id, { type: "clear_tools", siteKey: id });
      // Managed v2 bundles already use the runtime's clear/reinject protocol
      // when a command selects a newer digest. Refresh that same way; a page
      // reload would interrupt independent effect reads and erase user inputs.
      // Legacy scripts still require a new realm for top-level declarations.
      // A missing manifest can mean catalog loss/removal, never proof of a
      // legacy script. Reload only positively identified legacy packages.
      if (tab.matchingIds.some(id => {
        const manifest = manifests[ids.indexOf(id)];
        return manifest && manifest.schema_version !== 2 && !manifest._hostSnapshot;
      })) {
        await chrome.tabs.reload(tab.id);
        await waitForTabLoad(tab.id, 15000);
      }
      refreshedTabs++;
    });
    previousRefresh = refresh;
    return refresh;
  });
  const refreshed = await Promise.allSettled(refreshes);
  const failed = refreshed.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;

  for (const tab of matchedTabs) {
    const refreshedTab = await chrome.tabs.get(tab.id);
    await injectAdapters(tab.id, refreshedTab.url || tab.url);
  }

  const domainData = await Promise.all(ids.map(id => waitForDomainTools(id, 2500)));
  return {
    refreshedTabs,
    toolCount: domainData.reduce((count, item) => count + (item?.tools?.length || 0), 0),
  };
}

// ─── 注入去重：同一 tab 同一文档加载周期内，同一 adapter 只注入一次 ──────────
// onUpdated(complete)、启动 scan、resync 等多触发点会对同一 tab 反复调 injectAdapters；
// 而 chrome.scripting.executeScript 对同 file 重复执行不去重。adapter 的 index.js 顶层
// 带 const，重复执行会触发 "Identifier has already been declared" 解析期 SyntaxError，
// 导致整个 adapter 加载失败、handler 不注册。此处按 tabId 记录已注入集合，重复即跳过。
// 导航(loading)或 tab 关闭时清除，确保新 document 能重新注入。
const tabInjectedAdapters = new Map(); // tabId -> Set<adapterId>
function markTabInjected(tabId, adapterId) {
  let s = tabInjectedAdapters.get(tabId);
  if (!s) { s = new Set(); tabInjectedAdapters.set(tabId, s); }
  s.add(adapterId);
}
function hasTabInjectedAdapter(tabId, adapterId) {
  return tabInjectedAdapters.get(tabId)?.has(adapterId) ?? false;
}
function clearTabInjectedAdapters(tabId) {
  tabInjectedAdapters.delete(tabId);
  hostAdapterRuntime?.invalidate(tabId);
}

/**
 * 检查给定 URL 的 Tab，注入已安装的 adapter（本地文件存在则注入）。
 */
async function injectAdapters(tabId, url, selection = null) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return; }

  console.log(`[WebMCP] injectAdapters called for tab ${tabId}, hostname: ${hostname}`);

  const { adapterId, adapterMeta, adapterManifest } = selection || await resolveAdapterForHostname(hostname);
  console.log(`[WebMCP] Found adapter meta:`, adapterMeta || adapterManifest);

  if (!adapterId) {
    clearTabDomainRegistration(tabId);
    clearTabInjectedAdapters(tabId);
    chrome.tabs.sendMessage(tabId, { type: 'clear_tools' }, () => void chrome.runtime.lastError);
    console.log(`[WebMCP] No adapter found for hostname: ${hostname}`);
    clearBadge(tabId);
    return;
  }

  // Guard against path traversal or unexpected characters in the adapter id
  if (!adapterManifest?._hostSnapshot && !SAFE_ADAPTER_ID_RE.test(adapterId)) {
    console.warn(`[WebMCP] Unsafe adapter id "${adapterId}", skipping`);
    return;
  }

  if (adapterManifest?._hostSnapshot) {
    try {
      await getHostAdapterRuntime().execute(tabId, adapterManifest, url);
      setAdapterInjectionStatus(adapterId, { ok: true, tabId });
    } catch (error) {
      setAdapterInjectionStatus(adapterId, { ok: false, tabId, error: error?.message || 'Adapter injection failed.' });
    }
    return;
  }

  // 检查本地文件是否存在（内置 + 用户目录）
  const isBuiltin = await isAdapterFileInstalled(adapterId);
  const isUser = !isBuiltin && await isUserAdapterInstalled(adapterId);
  const isInstalled = isBuiltin || isUser;

  console.log(`[WebMCP] Adapter "${adapterId}" installed: ${isInstalled} (builtin:${isBuiltin}, user:${isUser})`);

  if (isInstalled) {
    // 去重：同一 tab 同一文档加载周期内已注入过该 adapter，则整体跳过
    // （避免重复 executeScript injector/index.js 触发顶层 const 重复声明的 SyntaxError）
    if (hasTabInjectedAdapter(tabId, adapterId)) {
      console.log(`[WebMCP] adapter "${adapterId}" already injected in tab ${tabId} this load, skipping`);
      setAdapterInjectionStatus(adapterId, { ok: true, tabId });
      return;
    }

    const supportFiles = normalizeAdapterSupportFiles(adapterId, adapterManifest?.support_files);

    // 已安装：先确保 injector 已注入，再注入 adapter
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        files: ["content/injector.js"],
      });
    } catch {
      // injector may already be loaded via content_scripts manifest — ignore
    }

    try {
      if (isUser) {
        // 用户 adapter：文件在 ~/.weworker/adapters，无法用 {files} 注入，改为从 bridge 读内容后 {code} 注入
        await injectUserAdapterWithCode(tabId, adapterId, supportFiles, url);
      } else {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          files: [...supportFiles, `adapters/${adapterId}/index.js`],
        });
      }
      setAdapterInjectionStatus(adapterId, { ok: true, tabId });
      markTabInjected(tabId, adapterId);
      console.log(`[WebMCP] Injected adapter "${adapterId}" into tab ${tabId}`, { supportFiles, isUser });
    } catch (err) {
      const errorMessage = err?.message || String(err);
      setAdapterInjectionStatus(adapterId, { ok: false, tabId, error: errorMessage });
      console.warn(`[WebMCP] Failed to inject adapter "${adapterId}":`, errorMessage);
    }
  } else {
    // 未安装：清除该 tab 残留的工具注册
    clearTabDomainRegistration(tabId);
    chrome.tabs.sendMessage(tabId, { type: "clear_tools" }, () => void chrome.runtime.lastError);
    clearBadge(tabId);
  }
}

/**
 * 用 code 方式注入用户 adapter（文件在 ~/.weworker/adapters，无法 {files} 注入）。
 * 先注入 support files，再注入 index.js。
 * @param {number} tabId
 * @param {string} adapterId
 * @param {string[]} supportFiles 已归一化为 adapters/<id>/... 的包内路径（仅用于内置；用户 adapter 需转回相对路径）
 */
// Built-in page scripts shipped with this Extension (see packaged-adapter-loader.js).
const packagedAdapterFiles = createPackagedAdapterMatcher({
  read: async (path) => {
    const response = await fetch(chrome.runtime.getURL(path));
    return response.ok ? response.text() : null;
  },
});

async function injectV2AdapterWithCode(tabId, manifest, expectedUrl, suppliedBundle = null) {
  const bundle = suppliedBundle || await getHostAdapterClient().bundle(manifest);
  const { internal, commands } = v2InjectionFiles(bundle.manifest, Object.keys(bundle.files));
  // Identical built-in copy: inject without attaching chrome.debugger to the page.
  const packaged = await packagedAdapterFiles(bundle, [...internal, ...commands]).catch(() => null);
  if (packaged) {
    const modules = Object.fromEntries((bundle.manifest.commands || []).map((command) => [command.id, command.module]));
    return injectPackagedAdapter({ tabId, expectedUrl, defs: v2CommandDefs(bundle.manifest), files: packaged, modules });
  }
  const scripts = [{ path: 'bootstrap.js', source: buildV2Bootstrap(bundle.manifest) }];
  for (const relPath of [...internal, ...commands]) {
    const source = bundle.files[relPath];
    if (typeof source !== 'string') throw new Error(`Adapter source unavailable: ${relPath}`);
    scripts.push({ path: relPath, source });
  }
  return injectAdapterSources({
    tabId, scripts, expectedUrl,
    borrowedSession: cdpAttachedTabs.has(tabId),
    existingContexts: () => [...getCdpExecutionContextMap(tabId).values()],
  });
}
async function injectUserAdapterWithCode(tabId, adapterId, supportFiles, expectedUrl) {
  const relPaths = [...supportFiles.map((p) => p.replace(`adapters/${adapterId}/`, '')), 'index.js'];
  const scripts = [];
  for (const relPath of relPaths) {
    const source = await readUserAdapterFile(adapterId, relPath);
    if (source === null) throw new Error(`Adapter source unavailable: ${relPath}`);
    scripts.push({ path: relPath, source });
  }
  return injectAdapterSources({
    tabId, scripts, expectedUrl,
    borrowedSession: cdpAttachedTabs.has(tabId),
    existingContexts: () => [...getCdpExecutionContextMap(tabId).values()],
  });
}

async function handleWecliRuntimeRequest(msg, sender) {
  const tab = sender?.tab;
  if (!tab?.id || !tab.url) {
    throw createRuntimeHelperError('NO_TAB', 'WeCLI runtime helper requires a sender tab');
  }
  const action = String(msg.action || '');
  const payload = msg.payload || {};
  const traceID = msg.traceID || null;
  const allowedHosts = action === 'intercept_read' && msg.previewToken
    ? previewRuntimeAllowedHosts(msg.previewToken, sender)
    : await loadRuntimeAllowedHostsForTab(tab);

  switch (action) {
    case 'intercept_read':
      assertRuntimeUrlAllowed(tab, payload.source?.endpoint, allowedHosts);
      return executeInterceptRead({ chrome, ensureCdpAttached, tabId: tab.id, payload: { ...payload, metadataOnly: false } });
    case 'page_read':
      return executePageSource(chrome, tab.id, { ...payload, metadataOnly: false });
    case 'cookies_get':
      traceLog(traceID, `[ServiceWorkerRuntime] cookies_get ${String(payload.domain || payload.domains || payload.url || tab.url)}`);
      return getRuntimeCookies(tab, payload, allowedHosts);
    case 'storage_get':
      traceLog(traceID, `[ServiceWorkerRuntime] storage_get ${String(payload.key || '')}`);
      return getRuntimeStorageValue(tab, payload);
    case 'navigate':
      traceLog(traceID, `[ServiceWorkerRuntime] navigate ${String(payload.url || '')}`);
      return navigateRuntimeTab(tab, payload, allowedHosts);
    case 'main_world_eval':
      traceLog(traceID, `[ServiceWorkerRuntime] main_world_eval`);
      return runRuntimeMainWorldEval(tab, payload);
    case 'network_capture_start':
      traceLog(traceID, `[ServiceWorkerRuntime] network_capture_start pattern=${String(payload.pattern || '')}`);
      return startAdapterNetworkCapture(tab, payload, allowedHosts);
    case 'network_capture_read':
      traceLog(traceID, '[ServiceWorkerRuntime] network_capture_read');
      return readAdapterNetworkCapture(tab, payload);
    case 'download':
      traceLog(traceID, `[ServiceWorkerRuntime] download ${String(payload.url || payload.filename || '')}`);
      return runRuntimeDownload(tab, payload, allowedHosts);
    case 'set_file_input':
      return handleCdpAction(tab.id, {
        __cdp_action: 'set_file_input',
        selector: payload.selector,
        files: payload.files,
      });
    case 'native_input':
      return runRuntimeNativeInput(tab.id, payload);
    case 'backend_fetch':
      return runRuntimeBridgeRequest('wecli_backend_fetch', payload, traceID);
    case 'browser_fetch':
      traceLog(traceID, `[ServiceWorkerRuntime] browser_fetch tab=${tab.id} ${String(payload.url || '')}`);
      return runRuntimeBrowserFetch(tab, payload, allowedHosts);
    case 'backend_file_read':
      return runRuntimeBridgeRequest('wecli_backend_file_read', payload, traceID);
    case 'backend_xlsx_read':
      return runRuntimeBridgeRequest('wecli_backend_xlsx_read', payload, traceID);
    case 'backend_file_write':
      return runRuntimeBridgeRequest('wecli_backend_file_write', payload, traceID);
    default:
      throw createRuntimeHelperError('UNKNOWN_HELPER', `Unknown runtime helper: ${action}`, { action });
  }
}

function formatRuntimeBridgeType(type) {
  switch (type) {
    case 'wecli_backend_fetch':
      return 'backend_fetch';
    case 'wecli_backend_file_read':
      return 'backend_file_read';
    case 'wecli_backend_xlsx_read':
      return 'backend_xlsx_read';
    case 'wecli_backend_file_write':
      return 'backend_file_write';
    default:
      return String(type || 'backend_helper').replace(/^wecli_/, '');
  }
}

async function runRuntimeBridgeRequest(type, payload, traceID = null) {
  const label = formatRuntimeBridgeType(type);
  traceLog(traceID, `[ServiceWorkerRuntime] ${label} -> bridge`);
  const result = await requestBridge({ type, payload, traceID }, 60000, `${type} helper timed out`);
  if (!result?.ok) {
    traceLog(traceID, `[ServiceWorkerRuntime] ${label} error: ${result?.error || `${label} helper failed`}`);
    throw createRuntimeHelperError('BACKEND_HELPER_ERROR', result?.error || `${type} helper failed`, { type });
  }
  if (type === 'wecli_backend_fetch') {
    traceLog(traceID, `[ServiceWorkerRuntime] ${label} <- bridge ${JSON.stringify({
      status: result?.result?.status,
      ok: result?.result?.ok,
      url: result?.result?.url,
      replay: result?.result?.replay,
      body: payload?.redactBodyInTrace === true ? '[redacted]' : summarizeDirectTraceBody(result?.result?.body, 800),
    })}`);
  } else {
    traceLog(traceID, `[ServiceWorkerRuntime] ${label} <- bridge ok`);
  }
  return result.result;
}

async function getRuntimeCookies(tab, payload, allowedHosts = directRuntimeContext?.allowedHosts) {
  if (!chrome.cookies?.getAll) {
    throw createRuntimeHelperError('MISSING_PERMISSION', 'chrome.cookies is unavailable');
  }
  let cookies;
  const domains = normalizeRuntimeCookieDomains(payload);
  if (domains.length) {
    cookies = [];
    for (const domain of domains) {
      assertRuntimeCookieDomainAllowed(tab, domain, allowedHosts);
      cookies.push(...await chrome.cookies.getAll({ domain }));
    }
  } else {
    const url = String(payload.url || tab.url);
    assertRuntimeUrlAllowed(tab, url, allowedHosts);
    cookies = await chrome.cookies.getAll({ url });
  }
  const names = Array.isArray(payload.names) ? new Set(payload.names.map(String)) : null;
  const seen = new Set();
  return {
    cookies: cookies
      .filter(cookie => !names || names.has(cookie.name))
      .filter(cookie => {
        const key = `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        sameSite: cookie.sameSite,
      })),
  };
}

function normalizeRuntimeCookieDomains(payload) {
  const values = Array.isArray(payload.domains)
    ? payload.domains
    : payload.domain
      ? [payload.domain]
      : [];
  return [...new Set(values
    .map(value => String(value || '').trim().replace(/^\.+/, '').toLowerCase())
    .filter(Boolean))];
}

async function getRuntimeStorageValue(tab, payload) {
  const area = payload.area === 'session' ? 'session' : 'local';
  const key = String(payload.key || '');
  if (!key) throw createRuntimeHelperError('INVALID_ARGS', 'storage_get requires key');
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [area, key],
    func: (storageArea, storageKey) => {
      const storage = storageArea === 'session' ? window.sessionStorage : window.localStorage;
      return storage.getItem(storageKey);
    },
  });
  const value = result ?? null;
  await cacheRuntimeStorageValue(tab, area, key, value);
  return { value };
}

function normalizeRuntimeStorageHost(hostname) {
  return String(hostname || '').trim().replace(/^\.+/, '').toLowerCase();
}

function normalizeRuntimeStorageScope(scope) {
  return String(scope || '').trim().replace(/\/+$/, '').toLowerCase();
}

function getRuntimeStorageHostFromTab(tab) {
  try {
    return normalizeRuntimeStorageHost(new URL(tab.url).hostname);
  } catch {
    return '';
  }
}

function getRuntimeStorageScopeFromTab(tab) {
  try {
    const url = new URL(tab.url);
    if (!/^https?:$/i.test(url.protocol)) return '';
    return normalizeRuntimeStorageScope(url.origin);
  } catch {
    return '';
  }
}

function getRuntimeStorageHostFromPayload(payload = {}) {
  if (payload.url) {
    try {
      const host = normalizeRuntimeStorageHost(new URL(String(payload.url)).hostname);
      if (host) return host;
    } catch {}
  }
  return normalizeRuntimeStorageHost(payload.host || payload.hostname || payload.domain);
}

function getRuntimeStorageScopeFromPayload(payload = {}) {
  if (payload.url) {
    try {
      const url = new URL(String(payload.url));
      if (/^https?:$/i.test(url.protocol)) return normalizeRuntimeStorageScope(url.origin);
    } catch {}
  }
  return normalizeRuntimeStorageHost(payload.host || payload.hostname || payload.domain);
}

function getRuntimeStorageScopeFromDetails(details = {}, fallback = "") {
  return normalizeRuntimeStorageScope(
    details.storageScope
    || getRuntimeStorageScopeFromPayload(details)
    || fallback
  );
}

function getRuntimeStorageHostFromScope(scope) {
  const normalized = normalizeRuntimeStorageScope(scope);
  if (!normalized) return '';
  if (/^https?:\/\//i.test(normalized)) {
    try {
      return normalizeRuntimeStorageHost(new URL(normalized).hostname);
    } catch {
      return '';
    }
  }
  return normalizeRuntimeStorageHost(normalized);
}

function storageScopeMatchesTab(tab, targetScope) {
  const normalizedTarget = normalizeRuntimeStorageScope(targetScope);
  if (!normalizedTarget) return true;
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return false;
  }
  if (/^https?:\/\//i.test(normalizedTarget)) {
    return normalizeRuntimeStorageScope(url.origin) === normalizedTarget;
  }
  return hostnameMatchesDomain(normalizeRuntimeStorageHost(url.hostname), normalizeRuntimeStorageHost(normalizedTarget));
}

function getDirectRuntimeStorageHost(payload = {}) {
  return normalizeRuntimeStorageHost(
    getRuntimeStorageHostFromPayload(payload)
    || directRuntimeContext?.tabDomain
    || directRuntimeContext?.routeDomain
    || directRuntimeContext?.adapterId
  );
}

function getDirectRuntimeStorageScope(payload = {}) {
  return normalizeRuntimeStorageScope(
    getRuntimeStorageScopeFromPayload(payload)
    || directRuntimeContext?.tabDomain
    || directRuntimeContext?.routeDomain
    || directRuntimeContext?.adapterId
  );
}

function getRuntimeStorageCacheEntryKey(scope, area, key) {
  return `${normalizeRuntimeStorageScope(scope)}\u0000${area}\u0000${String(key || '')}`;
}

async function readRuntimeStorageCache() {
  if (!chrome.storage?.local) return {};
  const data = await chrome.storage.local.get(RUNTIME_STORAGE_CACHE_KEY);
  const cache = data?.[RUNTIME_STORAGE_CACHE_KEY];
  return cache && typeof cache === 'object' && !Array.isArray(cache) ? cache : {};
}

async function cacheRuntimeStorageValueForHost(host, area, key, value) {
  return cacheRuntimeStorageValueForScope(host, area, key, value);
}

async function cacheRuntimeStorageValueForScope(scope, area, key, value) {
  if (value === undefined || value === null || value === '' || !chrome.storage?.local) return;
  scope = normalizeRuntimeStorageScope(scope);
  if (!scope || !key) return;
  const cache = await readRuntimeStorageCache();
  cache[getRuntimeStorageCacheEntryKey(scope, area, key)] = {
    host: scope,
    storageScope: scope,
    area,
    key,
    value,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ [RUNTIME_STORAGE_CACHE_KEY]: cache });
}

async function cacheRuntimeStorageValue(tab, area, key, value) {
  await cacheRuntimeStorageValueForScope(getRuntimeStorageScopeFromTab(tab) || getRuntimeStorageHostFromTab(tab), area, key, value);
}

async function refreshDirectRuntimeStorageInBackgroundTab(payload, area, key, storageScope) {
  const url = String(payload.url || '');
  if (!url) return null;

  const traceID = directRuntimeContext?.traceID || null;
  let tab = await createDirectBrowserFetchTab(traceID);
  try {
    tab = await ensureDirectBrowserFetchTabAtOrigin(tab, url, traceID);
    const result = await getRuntimeStorageValue(tab, { ...payload, area, key });
    if (result?.value !== undefined && result.value !== null && result.value !== '') {
      await cacheRuntimeStorageValueForScope(storageScope, area, key, result.value);
      traceLog(traceID, `[ServiceWorkerRuntime] direct storage_get refreshed from background tab=${tab.id} scope=${storageScope} key=${key}`);
      return result;
    }
    traceLog(traceID, `[ServiceWorkerRuntime] direct storage_get empty from background tab=${tab.id} scope=${storageScope} key=${key}`);
    return null;
  } finally {
    await closeDirectBrowserFetchTab(tab.id, traceID);
  }
}

async function getDirectRuntimeStorageValue(payload) {
  const area = payload.area === 'session' ? 'session' : 'local';
  const key = String(payload.key || '');
  if (!key) throw createRuntimeHelperError('INVALID_ARGS', 'storage_get requires key');
  const storageScope = getDirectRuntimeStorageScope(payload);
  const host = getRuntimeStorageHostFromScope(storageScope) || getDirectRuntimeStorageHost(payload);
  if (!storageScope) throw createStorageContextRequiredError(storageScope, area, key);

  if (!payload.forceRefresh) {
    const cache = await readRuntimeStorageCache();
    const entry = cache[getRuntimeStorageCacheEntryKey(storageScope, area, key)];
    if (entry && entry.value !== undefined && entry.value !== null && entry.value !== '') {
      return { value: entry.value };
    }
  }

  // Preview may prove a cached credential works without opening or consulting
  // a website tab. Cache initialization belongs to explicit login preparation.
  if (payload.cacheOnly === true) throw createStorageContextRequiredError(storageScope, area, key);

  const tabs = await findStorageContextTabs(
    directRuntimeContext?.routeDomain || host,
    directRuntimeContext?.excludeTabDomain,
    directRuntimeContext?.tabDomain || host,
    storageScope
  );
  for (const tab of tabs) {
    try {
      const result = await getRuntimeStorageValue(tab, { ...payload, area, key });
      if (result?.value !== undefined && result.value !== null && result.value !== '') {
        await cacheRuntimeStorageValueForScope(storageScope, area, key, result.value);
        traceLog(directRuntimeContext?.traceID || null, `[ServiceWorkerRuntime] direct storage_get refreshed from tab=${tab.id} scope=${storageScope} key=${key}`);
        return result;
      }
      traceLog(directRuntimeContext?.traceID || null, `[ServiceWorkerRuntime] direct storage_get empty from tab=${tab.id} scope=${storageScope} key=${key}`);
    } catch (err) {
      traceLog(directRuntimeContext?.traceID || null, `[ServiceWorkerRuntime] direct storage_get tab failed tab=${tab.id} scope=${storageScope} key=${key}: ${err?.message || err}`);
    }
  }

  if (tabs.length === 0 && payload.url) {
    const result = await refreshDirectRuntimeStorageInBackgroundTab(payload, area, key, storageScope);
    if (result) return result;
  }

  throw createStorageContextRequiredError(storageScope, area, key, { storageScope, host, url: payload.url });
}

async function navigateRuntimeTab(tab, payload, allowedHosts = directRuntimeContext?.allowedHosts) {
  const url = String(payload.url || '');
  if (!url) throw createRuntimeHelperError('INVALID_ARGS', 'navigate requires url');
  assertRuntimeUrlAllowed(tab, url, allowedHosts);
  const updated = await chrome.tabs.update(tab.id, { url, active: payload.active !== false });
  return { tabId: updated.id, url: updated.url || url };
}

async function runRuntimeMainWorldEval(tab, payload) {
  const expression = String(payload.expression || '');
  if (!expression) throw createRuntimeHelperError('INVALID_ARGS', 'main_world_eval requires expression');
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [expression],
    func: (source) => {
      // eslint-disable-next-line no-new-func
      return Function(`"use strict"; return (${source});`)();
    },
  });
  return { value: result };
}

// Fixed input operations for editors that require trusted browser events.
// This does not expose an arbitrary CDP method or caller-selected tab.
async function runRuntimeNativeInput(tabId, payload = {}) {
  const keys = { Enter: 13, PageDown: 34, Escape: 27, Backspace: 8, Tab: 9 };
  if (payload.type === 'text') {
    if (typeof payload.text !== 'string' || payload.text.length > 20000) throw createRuntimeHelperError('INVALID_ARGS', 'native_input text must be a string of at most 20000 characters');
  } else if (payload.type === 'key') {
    if (!Object.hasOwn(keys, payload.key)) throw createRuntimeHelperError('INVALID_ARGS', 'Unsupported native_input key');
  } else throw createRuntimeHelperError('INVALID_ARGS', 'native_input supports text and key only');
  const borrowed = cdpAttachedTabs.has(tabId);
  let owned = false;
  try {
    const target = { tabId };
    if (!borrowed) {
      await chrome.debugger.attach(target, '1.3');
      cdpAttachedTabs.add(tabId);
      owned = true;
    }
    if (payload.type === 'text') await chrome.debugger.sendCommand(target, 'Input.insertText', { text: payload.text });
    else {
      const fields = { key: payload.key, code: payload.key, windowsVirtualKeyCode: keys[payload.key], nativeVirtualKeyCode: keys[payload.key] };
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', ...fields, ...(payload.key === 'Enter' ? { text: '\r' } : {}) });
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...fields });
    }
    return { success: true };
  } finally {
    if (owned) {
      try { await chrome.debugger.detach({ tabId }); } catch { }
      clearBrowserDebuggerState(tabId, 'Temporary input attachment released.');
    }
  }
}

function normalizeRuntimeBrowserFetchHeaders(headers = {}) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lowerName = String(name || '').toLowerCase();
    if (!name
      || lowerName === 'cookie'
      || lowerName === 'host'
      || lowerName === 'content-length'
      || lowerName === 'origin'
      || lowerName === 'referer'
      || lowerName.startsWith('sec-')) {
      continue;
    }
    result[name] = value;
  }
  return result;
}

async function runRuntimeBrowserFetch(tab, payload = {}, allowedHosts = directRuntimeContext?.allowedHosts) {
  const url = String(payload.url || '');
  if (!url) throw createRuntimeHelperError('INVALID_ARGS', 'browser_fetch requires url');
  assertRuntimeUrlAllowed(tab, url, allowedHosts);

  const options = payload && typeof payload.options === 'object' && !Array.isArray(payload.options)
    ? payload.options
    : payload;
  const method = String(options.method || 'GET').toUpperCase();
  const request = {
    url,
    method,
    headers: normalizeRuntimeBrowserFetchHeaders(options.headers || {}),
    body: options.body,
    redirect: options.redirect || 'follow',
  };
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [request],
    func: async (input) => {
      try {
        const init = {
          method: input.method,
          credentials: 'include',
          headers: input.headers || {},
          redirect: input.redirect || 'follow',
        };
        if (!['GET', 'HEAD'].includes(String(input.method).toUpperCase()) && input.body !== undefined) {
          init.body = input.body;
        }
        const response = await fetch(input.url, init);
        const headers = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return {
          status: response.status,
          ok: response.ok,
          url: response.url || input.url,
          redirected: response.redirected,
          headers,
          body: await response.text(),
        };
      } catch (error) {
        return { error: error?.message || String(error) };
      }
    },
  });

  if (result?.error) {
    throw createRuntimeHelperError('BROWSER_FETCH_ERROR', result.error, { url, tabId: tab.id });
  }
  if (result?.redirected) assertRuntimeUrlAllowed(tab, result.url, allowedHosts);
  return {
    status: Number(result?.status || 0),
    ok: Boolean(result?.ok),
    url: result?.url || url,
    redirected: Boolean(result?.redirected),
    headers: result?.headers || {},
    body: result?.body ?? '',
    replay: { transport: 'browser-page', tabId: tab.id },
  };
}

async function runRuntimeDownload(tab, payload, allowedHosts = directRuntimeContext?.allowedHosts) {
  if (!chrome.downloads?.download) {
    throw createRuntimeHelperError('MISSING_PERMISSION', 'chrome.downloads is unavailable');
  }
  const url = String(payload.url || '');
  if (!url) throw createRuntimeHelperError('INVALID_ARGS', 'download requires url');
  assertRuntimeUrlAllowed(tab, url, allowedHosts);
  const filename = payload.filename ? sanitizeDownloadFilename(String(payload.filename)) : undefined;
  const downloadId = await chrome.downloads.download({
    url,
    ...(filename ? { filename } : {}),
    saveAs: Boolean(payload.saveAs),
  });
  return { downloadId, ...(filename ? { filename } : {}) };
}

function previewRuntimeAllowedHosts(token, sender) {
  const grant = generationPreviewGrants.get(token);
  const current = new URL(sender.tab.url);
  const original = grant && new URL(grant.url);
  if (!grant || grant.tabId !== sender.tab.id || (sender.frameId ?? 0) !== 0 || grant.expiresAt <= Date.now()
    || current.origin !== original.origin || current.pathname !== original.pathname) {
    throw createRuntimeHelperError('PREVIEW_SESSION_EXPIRED', 'This preview query grant is unavailable or belongs to another page.');
  }
  return grant.allowedHosts;
}

async function loadRuntimeAllowedHostsForTab(tab) {
  let tabHost;
  try { tabHost = new URL(tab.url).hostname; } catch { return []; }
  // Resolve a unique managed package by its declared page hosts, including
  // subdomains. Never merge grants from unrelated or ambiguous packages.
  const client = getHostAdapterClient();
  const catalog = await client.catalog();
  if (catalog?.available === false) return [];
  const matches = (catalog?.adapters || []).filter(manifest => (manifest.match || []).some(host =>
    host === tabHost || (host.startsWith('*.') && tabHost.endsWith(host.slice(1)))));
  if (matches.length) return matches.length === 1 ? normalizeRouteHosts(matches[0].runtime_allowed_hosts) : [];
  const selected = await client.manifest(tabHost);
  const manifest = selected.managed ? selected.manifest : await loadAdapterManifest(tabHost);
  return normalizeRouteHosts(manifest?.runtime_allowed_hosts);
}

function assertRuntimeUrlAllowed(tab, targetUrl, allowedHosts = directRuntimeContext?.allowedHosts) {
  let tabHost;
  let targetHost;
  try {
    tabHost = new URL(tab.url).hostname;
    targetHost = new URL(targetUrl).hostname;
  } catch {
    throw createRuntimeHelperError('INVALID_URL', `Invalid helper URL: ${targetUrl}`);
  }
  if (!isRuntimeHelperHostAllowed(tabHost, targetHost, allowedHosts)) {
    throw createRuntimeHelperError('HOST_NOT_ALLOWED', `Runtime helper URL host "${targetHost}" is not allowed for tab host "${tabHost}"`, { tabHost, targetHost });
  }
}

function assertRuntimeCookieDomainAllowed(tab, domain, allowedHosts = directRuntimeContext?.allowedHosts) {
  let tabHost;
  try {
    tabHost = new URL(tab.url).hostname;
  } catch {
    throw createRuntimeHelperError('INVALID_URL', `Invalid tab URL: ${tab.url}`);
  }
  const targetHost = String(domain || '').replace(/^\.+/, '').toLowerCase();
  if (!targetHost || !isRuntimeHelperHostAllowed(tabHost, targetHost, allowedHosts)) {
    throw createRuntimeHelperError('HOST_NOT_ALLOWED', `Runtime helper cookie domain "${targetHost}" is not allowed for tab host "${tabHost}"`, { tabHost, targetHost });
  }
}

function isRuntimeHelperHostAllowed(tabHost, targetHost, allowedHosts = []) {
  if (tabHost === targetHost || tabHost.endsWith(`.${targetHost}`) || targetHost.endsWith(`.${tabHost}`)) return true;
  for (const host of normalizeRouteHosts(allowedHosts)) {
    if (targetHost === host || targetHost.endsWith(`.${host}`) || host.endsWith(`.${targetHost}`)) return true;
  }
  return false;
}

function sanitizeDownloadFilename(filename) {
  return filename
    .replace(/^[\\/]+/, '')
    .split(/[\\/]+/)
    .map(part => part.replace(/[<>:"|?*\x00-\x1F]/g, '_'))
    .filter(Boolean)
    .join('/');
}

function createRuntimeHelperError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function toStructuredRuntimeError(err) {
  return {
    code: err?.code || 'RUNTIME_HELPER_ERROR',
    message: err?.message || String(err),
    ...(err?.details ? { details: err.details } : {}),
  };
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 导航到新文档：清除注入去重记录（新 isolated world 需重新注入 adapter）
  if (changeInfo.status === "loading") {
    clearTabInjectedAdapters(tabId);
  }
  if (changeInfo.status === "complete" && tab.url) {
    injectAdapters(tabId, tab.url);
  }
});

// ─── 启动 ──────────────────────────────────────────────────────────────────

chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      console.log("[WebMCP] keepAlive: reconnecting...");
      connectToNativeHost();
    } else if (ws.readyState === WebSocket.OPEN) {
      sendNativeHeartbeat();
    }
  }
});

// 启动时初始化已安装 adapter 列表
initInstalledAdapterIds();
// 预加载静态工具路由（fallback 用，避免短主机名路由错误）
loadStaticToolRoutes();
connectToNativeHost();
// The desktop may write the WeWorker 浏览器 marker while this worker is already connected:
// repeat the hello so the bridge can switch to this browser.
watchBrowserInstance(() => {
  if (ws && ws.readyState === WebSocket.OPEN) sendToNative(buildExtensionHello());
});
// Clicking WeWorker 浏览器 in the taskbar must show the window, not an invisible off-screen one.
revealWindowOnUserFocus();

// Side panel: 点击扩展图标打开侧边栏
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
