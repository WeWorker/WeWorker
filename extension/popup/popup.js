const GITHUB_REPO = "https://github.com/WeWorker/WeWorker";
const GITHUB_NEW_ISSUE = `${GITHUB_REPO}/issues/new?template=adapter-request.md`;
const GITHUB_CONTRIBUTING = `${GITHUB_REPO}/blob/main/hub/CONTRIBUTING.md`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function openTab(url) {
  chrome.tabs.create({ url });
}

function showOnly(id) {
  for (const el of document.querySelectorAll("[id^='state']")) {
    el.hidden = el.id !== id;
  }
}

function setHeaderBadge(type, text) {
  const badge = document.getElementById("headerBadge");
  badge.className = `header-badge badge-${type}`;
  document.getElementById("headerBadgeText").textContent = text;
}

function setWsStatus(connected) {
  const dot = document.getElementById("wsDot");
  const label = document.getElementById("wsLabel");
  if (connected) {
    dot.className = "ws-dot ws-dot-on";
    label.textContent = "已连接 WebCLI 服务";
  } else {
    dot.className = "ws-dot ws-dot-off";
    label.textContent = "未连接 WebCLI 服务";
  }
}

function formatToolDisplayName(toolName) {
  const name = String(toolName || "");
  return name.split(".").pop() || name;
}

function collectUniqueGeneratedFileLines(files = {}) {
  const seen = new Set();
  const result = [];
  for (const value of Object.values(files || {})) {
    if (typeof value !== "string" || !value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

// ── Render helpers ────────────────────────────────────────────────────────────

function renderActive(tools) {
  setHeaderBadge("active", `${tools.length} 个工具已就绪`);

  document.getElementById("toolCountLabel").textContent =
    `已加载 ${tools.length} 个工具`;

  const list = document.getElementById("toolList");
  list.innerHTML = "";
  for (const tool of tools) {
    const item = document.createElement("div");
    item.className = "tool-item";
    item.title = tool.name;
    item.innerHTML = `
      <div class="tool-name">${escHtml(formatToolDisplayName(tool.name))}</div>
      <div class="tool-desc">${escHtml(tool.description || "")}</div>
    `;

    // 点击工具打开测试模态框
    item.addEventListener("click", () => {
      openToolTestModal(tool);
    });

    list.appendChild(item);
  }

  showOnly("stateActive");
}

function renderNone(options = {}) {
  setHeaderBadge("none", options.adapterInstalled ? "适配器已发现" : "无适配器");
  const titleEl = document.querySelector("#stateNone .none-title");
  const descEl = document.querySelector("#stateNone .none-desc");
  if (options.adapterInstalled) {
    titleEl.textContent = "已发现适配器，正在同步工具";
    descEl.innerHTML = "扩展已识别到当前网站的适配器。<br />如果仍未显示工具，可刷新当前页面或重载扩展。";
  } else {
    titleEl.textContent = "此网站暂无适配器";
    descEl.innerHTML = "WebMCP 目前还不支持此网站。<br />你可以提交 Issue 或贡献一个新适配器。";
  }
  showOnly("stateNone");
}

function renderError(msg) {
  setHeaderBadge("none", "—");
  document.getElementById("errorMsg").textContent = msg;
  showOnly("stateError");
}

function escHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatSchemaType(schema = {}) {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return "enum";
  return schema.type || "string";
}

function formatSchemaDefault(schema = {}) {
  if (!Object.prototype.hasOwnProperty.call(schema, "default")) return "";
  const value = schema.default;
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getSchemaUiHint(schema = {}) {
  const hint = schema["x-ui"];
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) return null;
  return hint;
}

function resolveSchemaWidget(schema = {}) {
  const type = formatSchemaType(schema);
  const uiHint = getSchemaUiHint(schema);
  const hintedWidget = String(uiHint?.widget || "").trim().toLowerCase();

  if (Array.isArray(schema.enum) && schema.enum.length > 0) return "select";
  if (type === "boolean") return "boolean";
  if (type === "number") return hintedWidget === "number" ? "number" : "number";
  if (type === "object" || type === "array") return "json";
  if (["textarea", "date", "time", "datetime", "text"].includes(hintedWidget)) return hintedWidget;
  return "text";
}

function toDatetimeLocalInputValue(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?$/);
  if (match) {
    return `${match[1]}T${match[2]}`;
  }
  return raw;
}

function toDatetimeSubmitValue(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/);
  if (match) {
    return `${match[1]} ${match[2]}:${match[3] || "00"}`;
  }
  return raw;
}

function buildToolFieldMarkup(key, schema = {}, isRequired = false) {
  const type = formatSchemaType(schema);
  const widget = resolveSchemaWidget(schema);
  const uiHint = getSchemaUiHint(schema);
  const description = schema.description || "";
  const label = uiHint?.label || key;
  const rawDefaultText = formatSchemaDefault(schema);
  const defaultText = widget === "datetime" ? toDatetimeLocalInputValue(rawDefaultText) : rawDefaultText;
  const placeholder = uiHint?.placeholder || description || "";
  const example = uiHint?.example || "";
  const metaChips = [
    `<span class="form-chip">类型: ${escHtml(type)}</span>`,
    widget !== type && widget !== "select" && widget !== "json" ? `<span class="form-chip">控件: ${escHtml(widget)}</span>` : "",
    widget === "json" ? '<span class="form-chip">控件: json</span>' : "",
    isRequired ? '<span class="form-chip">必填</span>' : '<span class="form-chip">选填</span>',
    Object.prototype.hasOwnProperty.call(schema, "default") ? '<span class="form-chip">已带默认值</span>' : "",
  ].filter(Boolean).join("");

  let inputHtml = "";
  if (schema.enum) {
    inputHtml = `<select class="form-input" data-param="${key}" data-schema-type="${escHtml(type)}" data-schema-widget="select" ${isRequired ? 'required' : ''}>`;
    if (!isRequired) {
      inputHtml += '<option value="">-- 请选择 --</option>';
    }
    for (const val of schema.enum) {
      const selected = schema.default === val ? 'selected' : '';
      inputHtml += `<option value="${escHtml(String(val))}" ${selected}>${escHtml(String(val))}</option>`;
    }
    inputHtml += '</select>';
  } else if (widget === "number") {
    inputHtml = `<input type="number" class="form-input" data-param="${key}" data-schema-type="number" data-schema-widget="number" value="${escHtml(defaultText)}" ${isRequired ? 'required' : ''} placeholder="${escHtml(placeholder)}" />`;
  } else if (widget === "boolean") {
    const checked = schema.default === true ? "checked" : "";
    inputHtml = `<input type="checkbox" data-param="${key}" data-schema-type="boolean" data-schema-widget="boolean" ${checked} />`;
  } else if (widget === "json") {
    inputHtml = `<textarea class="form-input form-textarea" data-param="${key}" data-schema-type="${escHtml(type)}" data-schema-widget="json" placeholder="${escHtml(placeholder || `请输入合法 JSON ${type === "array" ? "数组" : "对象"}`)}">${escHtml(defaultText)}</textarea>`;
  } else if (widget === "textarea") {
    inputHtml = `<textarea class="form-input form-textarea" data-param="${key}" data-schema-type="string" data-schema-widget="textarea" placeholder="${escHtml(placeholder)}">${escHtml(defaultText)}</textarea>`;
  } else if (widget === "date") {
    inputHtml = `<input type="date" class="form-input" data-param="${key}" data-schema-type="string" data-schema-widget="date" value="${escHtml(defaultText)}" ${isRequired ? 'required' : ''} />`;
  } else if (widget === "time") {
    inputHtml = `<input type="time" class="form-input" data-param="${key}" data-schema-type="string" data-schema-widget="time" value="${escHtml(defaultText)}" ${isRequired ? 'required' : ''} />`;
  } else if (widget === "datetime") {
    inputHtml = `<input type="datetime-local" class="form-input" data-param="${key}" data-schema-type="string" data-schema-widget="datetime" value="${escHtml(defaultText)}" ${isRequired ? 'required' : ''} />`;
  } else {
    inputHtml = `<input type="text" class="form-input" data-param="${key}" data-schema-type="string" data-schema-widget="text" value="${escHtml(defaultText)}" ${isRequired ? 'required' : ''} placeholder="${escHtml(placeholder)}" />`;
  }

  return `
    <div class="form-group">
      <label class="form-label">${escHtml(label)}${isRequired ? ' *' : ''}</label>
      <div class="form-meta">${metaChips}</div>
      ${inputHtml}
      ${description ? `<div class="form-hint">${escHtml(description)}</div>` : ''}
      ${example ? `<div class="form-hint">示例：${escHtml(example)}</div>` : ''}
    </div>
  `;
}

function parseToolFieldValue(input) {
  const type = input.dataset.schemaType || "string";
  const widget = input.dataset.schemaWidget || "";
  if (type === "boolean") {
    return input.checked;
  }

  const rawValue = typeof input.value === "string" ? input.value.trim() : "";
  if (!rawValue) return undefined;

  if (type === "number") {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      throw new Error(`参数 ${input.dataset.param} 需要是数字`);
    }
    return parsed;
  }

  if (type === "object" || type === "array") {
    try {
      const parsed = JSON.parse(rawValue);
      if (type === "object" && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
        throw new Error("expected object");
      }
      if (type === "array" && !Array.isArray(parsed)) {
        throw new Error("expected array");
      }
      return parsed;
    } catch {
      throw new Error(`参数 ${input.dataset.param} 需要是合法 JSON ${type === "array" ? "数组" : "对象"}`);
    }
  }

  if (widget === "datetime") {
    return toDatetimeSubmitValue(rawValue);
  }

  return rawValue;
}

function toolRequiresConfirmation(tool) {
  return Boolean(tool?.parameters?.["x-webcli-requires-confirmation"]);
}

function confirmToolExecution(tool, args) {
  if (!toolRequiresConfirmation(tool)) return true;
  const message = tool.parameters?.["x-webcli-confirmation-message"] || "该工具会触发真实业务动作，请确认参数无误后继续。";
  const payload = Object.keys(args || {}).length ? JSON.stringify(args, null, 2) : "无参数";
  return window.confirm(`${message}\n\n将提交的参数：\n${payload}`);
}

// ── Tool Test Modal ───────────────────────────────────────────────────────────

let currentTool = null;
let currentTabId = null;

// ── Explore State ────────────────────────────────────────────────────────────

let exploreState = 'idle';
let lastWorkflowResult = null;

function openToolTestModal(tool) {
  currentTool = tool;

  const modal = document.getElementById("toolModal");
  const modalToolName = document.getElementById("modalToolName");
  const modalToolDesc = document.getElementById("modalToolDesc");
  const modalForm = document.getElementById("modalForm");
  const modalResult = document.getElementById("modalResult");
  const btnExecute = document.getElementById("btnModalExecute");

  modalToolName.textContent = formatToolDisplayName(tool.name);
  modalToolDesc.textContent = tool.description || "";
  modalToolDesc.hidden = !(tool.description || "").trim();
  modalResult.hidden = true;
  modalResult.textContent = "";
  btnExecute.disabled = false;
  btnExecute.textContent = "执行";

  // 生成参数表单
  const params = tool.parameters?.properties || {};
  const required = tool.parameters?.required || [];

  if (Object.keys(params).length === 0) {
    modalForm.innerHTML = '<div style="color: #6b7280; font-size: 12px;">此工具无需参数</div>';
  } else {
    modalForm.innerHTML = Object.entries(params)
      .map(([key, schema]) => buildToolFieldMarkup(key, schema, required.includes(key)))
      .join("");
  }

  modal.hidden = false;
}

function closeToolTestModal() {
  document.getElementById("toolModal").hidden = true;
  document.getElementById("modalForm").innerHTML = "";
  const modalResult = document.getElementById("modalResult");
  modalResult.hidden = true;
  modalResult.textContent = "";
  modalResult.className = "";
  const btnExecute = document.getElementById("btnModalExecute");
  btnExecute.disabled = false;
  btnExecute.textContent = "执行";
  currentTool = null;
}

async function executeCurrentTool() {
  if (!currentTool || !currentTabId) return;

  const modalForm = document.getElementById("modalForm");
  const modalResult = document.getElementById("modalResult");
  const btnExecute = document.getElementById("btnModalExecute");

  try {
    const args = {};
    const inputs = modalForm.querySelectorAll("[data-param]");
    for (const input of inputs) {
      const key = input.dataset.param;
      let value = parseToolFieldValue(input);
      if (value !== undefined && value !== '') {
        args[key] = value;
      }
    }
    if (!currentTool.parameters?.['x-webcli-host-confirmation']) {
      if (!confirmToolExecution(currentTool, args)) return;
      if (toolRequiresConfirmation(currentTool)) args.__confirmed = true;
    }

    btnExecute.disabled = true;
    btnExecute.textContent = "等待宿主处理 / 确认...";
    modalResult.hidden = true;

    // 调用工具
    const response = await chrome.runtime.sendMessage({
      type: "test_call_tool",
      tabId: currentTabId,
      toolName: currentTool.name,
      args: args
    });

    // 显示结果
    modalResult.hidden = false;
    if (response.error) {
      modalResult.className = "result-box result-error";
      const states = { cancelled: '已取消', not_submitted: '尚未提交', unknown: '结果未知', failed: '执行失败' };
      modalResult.textContent = `${states[response.execution?.state] || '执行失败'}：${response.error}`;
    } else {
      modalResult.className = response.execution?.state === 'failed' ? 'result-box result-error' : 'result-box result-success';
      modalResult.textContent = `${response.execution?.state === 'failed' ? '执行失败' : response.execution?.state === 'succeeded' ? '执行成功' : '调用完成'}\n${JSON.stringify(response.result, null, 2)}`;
    }
  } catch (error) {
    modalResult.hidden = false;
    modalResult.className = "result-box result-error";
    modalResult.textContent = `执行失败：${error.message}`;
  } finally {
    btnExecute.disabled = false;
    btnExecute.textContent = "执行";
  }
}

// ── Explore ──────────────────────────────────────────────────────────────────

function showExploreState(state) {
  exploreState = state;
  document.getElementById('exploreIdle').hidden = state !== 'idle';
  document.getElementById('exploreLoading').hidden = (state !== 'loading' && state !== 'workflow_loading');
  document.getElementById('exploreResults').hidden = state !== 'results';
  document.getElementById('exploreWorkflowResults').hidden = state !== 'workflow_results';
  document.getElementById('exploreError').hidden = state !== 'error';

  const loadingText = document.getElementById('exploreLoadingText');
  if (state === 'workflow_loading') {
    loadingText.textContent = '正在刷新页面并探测接口…';
  } else if (state === 'loading') {
    loadingText.textContent = '正在分析页面…';
  }
}

function renderPatternBadge(el, pattern) {
  const map = {
    api_driven: { label: 'API', cls: 'explore-badge-api' },
    dom_driven: { label: 'UI/DOM', cls: 'explore-badge-ui' },
    state_or_ssr: { label: 'HYBRID', cls: 'explore-badge-hybrid' },
  };
  const m = map[pattern] || { label: pattern || '?', cls: 'explore-badge-ui' };
  el.textContent = m.label;
  el.className = `explore-badge ${m.cls}`;
}

function renderAnalyzeResults(result) {
  const { verdict, pageState, network } = result;

  renderPatternBadge(document.getElementById('exploreBadge'), verdict.pattern);
  document.getElementById('exploreStrategy').textContent = `推荐策略: ${verdict.recommendedStrategy}`;
  document.getElementById('exploreReason').textContent = verdict.reason;

  const apiCount = (network?.entries || []).length;
  const stats = [`API 请求: ${apiCount} 条`];
  if (pageState?.interactiveElements) stats.push(`交互元素: ${pageState.interactiveElements}`);
  if (pageState?.listCandidates) stats.push(`列表区域: ${pageState.listCandidates}`);
  document.getElementById('exploreStats').textContent = stats.join(' · ');

  showExploreState('results');
}

function renderWorkflowResults(result) {
  const verdict = result.verdict || result.classification || {};

  renderPatternBadge(document.getElementById('exploreWfBadge'), verdict.pattern);
  document.getElementById('exploreWfStrategy').textContent = `推荐策略: ${verdict.recommendedStrategy || '—'}`;
  document.getElementById('exploreWfReason').textContent = verdict.reason || '接口探测完成';

  // Build detailed stats
  const stats = [];
  const allEntries = result.network?.entries || [];
  if (allEntries.length) stats.push(`网络请求: ${allEntries.length} 条`);
  if (result.workflow?.mode === 'passive_network_capture') stats.push('模式: 被动捕获');

  const statsEl = document.getElementById('exploreWfStats');
  statsEl.textContent = stats.join(' · ') || '已完成';

  // Show API candidates list
  const apiListEl = document.getElementById('exploreWfApiList');
  const apiEntries = (allEntries || []).filter(e => {
    if (!e?.url) return false;
    const ct = (e.responseContentType || e.contentType || '').toLowerCase();
    return ct.includes('json') || ct.includes('javascript');
  }).slice(0, 8);

  if (apiEntries.length > 0) {
    let html = '<div class="explore-api-title">API 候选:</div>';
    for (const entry of apiEntries) {
      const url = entry.url.split('?')[0];
      const shortUrl = url.length > 50 ? '...' + url.slice(-47) : url;
      const method = (entry.method || 'GET').toUpperCase();
      const status = entry.status || '';
      html += `<div class="explore-api-item">
        <span class="explore-api-method">${escHtml(method)}</span>
        <span class="explore-api-url" title="${escHtml(entry.url)}">${escHtml(shortUrl)}</span>
        ${status ? `<span class="explore-api-status">${status}</span>` : ''}
      </div>`;
    }
    apiListEl.innerHTML = html;
    apiListEl.hidden = false;
  } else {
    apiListEl.hidden = true;
  }

  showExploreState('workflow_results');
}

function showExploreError(msg) {
  document.getElementById('exploreErrorText').textContent = msg;
  showExploreState('error');
}

async function pollWorkflowState() {
  const check = async () => {
    try {
      const state = await chrome.runtime.sendMessage({ type: 'popup_explore_get_state' });
      if (!state) return;
      if (state.type === 'workflow' && state.result) {
        lastWorkflowResult = state.result;
        renderWorkflowResults(state.result);
      } else if (state.type === 'workflow_error') {
        showExploreError(state.error);
      } else if (state.type === 'workflow_loading') {
        setTimeout(check, 2000);
      }
    } catch {}
  };
  setTimeout(check, 2000);
}

async function triggerAnalyze() {
  if (!currentTabId) {
    showExploreError('无法获取当前标签页');
    return;
  }
  showExploreState('loading');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'popup_explore_analyze',
      tabId: currentTabId,
    });
    if (response.error) {
      showExploreError(response.error);
    } else {
      renderAnalyzeResults(response.result);
    }
  } catch (err) {
    showExploreError(`分析失败: ${err.message}`);
  }
}

async function triggerWorkflow() {
  if (!currentTabId) {
    showExploreError('无法获取当前标签页');
    return;
  }
  showExploreState('workflow_loading');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'popup_explore_workflow',
      tabId: currentTabId,
    });
    if (response.error) {
      showExploreError(response.error);
    } else {
      lastWorkflowResult = response.result;
      renderWorkflowResults(response.result);
    }
  } catch (err) {
    showExploreError(`接口探索失败: ${err.message}`);
  }
}

async function triggerSaveMemory() {
  if (!lastWorkflowResult) return;

  const tab = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab[0]?.url;
  let siteKey;
  try { siteKey = new URL(url).hostname; } catch { return; }

  const btn = document.getElementById('btnExploreSave');
  btn.disabled = true;
  btn.textContent = '保存中…';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'popup_explore_save_memory',
      siteKey,
      workflowResult: lastWorkflowResult,
    });

    const statusEl = document.getElementById('exploreSaveStatus');
    if (response.error) {
      statusEl.className = 'explore-save-status save-error';
      statusEl.textContent = response.error;
    } else {
      statusEl.className = 'explore-save-status';
      statusEl.textContent = `已保存 ${siteKey} 的探索结果（第 ${response.captureCount} 次）`;
      document.getElementById('btnExploreGenerate').hidden = false;
    }
    statusEl.hidden = false;
  } catch (err) {
    const statusEl = document.getElementById('exploreSaveStatus');
    statusEl.className = 'explore-save-status save-error';
    statusEl.textContent = err.message;
    statusEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '保存探索结果';
  }
}

async function triggerGenerate() {
  const tab = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab[0]?.url;
  let siteKey;
  try { siteKey = new URL(url).hostname; } catch { return; }

  const btn = document.getElementById('btnExploreGenerate');
  btn.disabled = true;
  btn.textContent = '网站工具生成中…';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'popup_explore_generate_scaffold',
      siteKey,
    });

    const resultEl = document.getElementById('exploreGenerateResult');
    if (response.error) {
      resultEl.innerHTML = `<div style="color:#991b1b">${escHtml(response.error)}</div>`;
    } else {
      if (!response.ok || !response.run?.id) throw new Error('无法启动生成任务');
      const stored = await chrome.storage.local.get('generationRunsBySite');
      await chrome.storage.local.set({ generationRunsBySite: { ...(stored.generationRunsBySite || {}), [siteKey]: response.run.id } });
      resultEl.innerHTML = '<div>已创建快速生成任务。请在侧栏开发页查看验证结果并确认安装。</div><button id="openGenerationReview" type="button">查看生成任务</button>';
      document.getElementById('openGenerationReview').onclick = () => chrome.sidePanel.open({ tabId: tab[0].id });
    }
    resultEl.hidden = false;
  } catch (err) {
    const resultEl = document.getElementById('exploreGenerateResult');
    resultEl.innerHTML = `<div style="color:#991b1b">${escHtml(err.message)}</div>`;
    resultEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '生成网站工具';
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function init() {
  // Modal 事件绑定
  document.getElementById("btnModalClose").addEventListener("click", closeToolTestModal);
  document.getElementById("btnModalCancel").addEventListener("click", closeToolTestModal);
  document.getElementById("btnModalExecute").addEventListener("click", executeCurrentTool);

  // Footer links
  document.getElementById("linkGitHub").onclick = () => openTab(GITHUB_REPO);
  document.getElementById("linkDocs").onclick = () =>
    openTab(`${GITHUB_REPO}#readme`);
  document.getElementById("btnNewIssue").onclick = () => openTab(GITHUB_NEW_ISSUE);
  document.getElementById("btnContribute").onclick = () => openTab(GITHUB_CONTRIBUTING);

  // Explore button events
  document.getElementById('btnExplore').addEventListener('click', triggerAnalyze);
  document.getElementById('btnExploreWorkflow').addEventListener('click', triggerWorkflow);
  document.getElementById('btnExploreReset').addEventListener('click', () => showExploreState('idle'));
  document.getElementById('btnExploreWfReset').addEventListener('click', () => {
    lastWorkflowResult = null;
    showExploreState('idle');
  });
  document.getElementById('btnExploreRetry').addEventListener('click', triggerAnalyze);
  document.getElementById('btnExploreSave').addEventListener('click', triggerSaveMemory);
  document.getElementById('btnExploreGenerate').addEventListener('click', triggerGenerate);

  // Show extension version
  const manifest = chrome.runtime.getManifest();
  document.getElementById("extVersion").textContent = `v${manifest.version}`;

  showOnly("stateLoading");

  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab?.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
    renderError("此页面不支持 WebMCP");
    setWsStatus(false);
    return;
  }

  // 保存当前 tabId 供工具测试使用
  currentTabId = tab.id;

  // Show explore section for valid tabs
  document.getElementById('exploreSection').hidden = false;

  // Restore explore state if popup was closed during workflow
  try {
    const savedState = await chrome.runtime.sendMessage({ type: 'popup_explore_get_state' });
    if (savedState && Date.now() - savedState.timestamp < 300000) {
      if (savedState.type === 'workflow' && savedState.result) {
        lastWorkflowResult = savedState.result;
        renderWorkflowResults(savedState.result);
      } else if (savedState.type === 'workflow_loading') {
        showExploreState('workflow_loading');
        pollWorkflowState();
      } else if (savedState.type === 'workflow_error') {
        showExploreError(savedState.error);
      } else if (savedState.type === 'analyze' && savedState.result) {
        renderAnalyzeResults(savedState.result);
      }
    }
  } catch {}

  // Ask background for this tab's state
  let info;
  try {
    info = await chrome.runtime.sendMessage({
      type: "get_tab_info",
      tabId: tab.id,
      url: tab.url,
    });
  } catch (e) {
    renderError("无法连接到扩展后台，请重新加载扩展");
    setWsStatus(false);
    return;
  }

  setWsStatus(info.isConnected ?? false);

  if (info.state === "active") {
    renderActive(info.tools);
    document.getElementById('exploreSection').classList.add('explore-subtle');
  } else {
    renderNone({ adapterInstalled: info.state === "installed" });
  }
}

init();
