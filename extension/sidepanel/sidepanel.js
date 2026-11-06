const GITHUB_REPO = "https://github.com/WeWorker/WeWorker";
const AI_CONFIG_PATH_HINT = "~/.webcli/config.json";
const AI_PROVIDER_PRESETS = {
  anthropic: {
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-opus-4-7",
  },
  openai: {
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.5",
  },
  deepseek: {
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
  },
  zhipu: {
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.1",
  },
  qwen: {
    protocol: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3-max",
  },
  custom: {
    protocol: "openai",
    baseUrl: "",
    model: "",
  },
};

let currentTabId = null;
let currentSiteKey = null;
let currentTools = [];
let lastWorkflowResult = null;
let lastActionCaptureState = null;
let currentTool = null;
let refreshSequence = 0;
let tabListenersBound = false;
let actionCapturePollTimer = null;
let actionCaptureRenderToken = 0;
let explorePollTimer = null;
let generationPollTimer = null;
let activeGenerationRunId = null;
let devWorkflowStep = 'explore';
let devAdvancedCodeVisible = false;
let isBridgeConnected = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function collectUniqueGeneratedFileLines(files = {}) {
  const seen = new Set();
  const result = [];
  for (const value of Object.values(files || {})) {
    if (typeof value !== 'string' || !value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function formatSchemaType(schema = {}) {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return 'enum';
  return schema.type || 'string';
}

function formatSchemaDefault(schema = {}) {
  if (!Object.prototype.hasOwnProperty.call(schema, 'default')) return '';
  const value = schema.default;
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getSchemaUiHint(schema = {}) {
  const hint = schema['x-ui'];
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return null;
  return hint;
}

function resolveSchemaWidget(schema = {}) {
  const type = formatSchemaType(schema);
  const uiHint = getSchemaUiHint(schema);
  const hintedWidget = String(uiHint?.widget || '').trim().toLowerCase();

  if (Array.isArray(schema.enum) && schema.enum.length > 0) return 'select';
  if (type === 'boolean') return 'boolean';
  if (type === 'number') return 'number';
  if (type === 'object' || type === 'array') return 'json';
  if (['textarea', 'date', 'time', 'datetime', 'text'].includes(hintedWidget)) return hintedWidget;
  return 'text';
}

function toDatetimeLocalInputValue(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?$/);
  if (match) {
    return `${match[1]}T${match[2]}`;
  }
  return raw;
}

function toDatetimeSubmitValue(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/);
  if (match) {
    return `${match[1]} ${match[2]}:${match[3] || '00'}`;
  }
  return raw;
}

function buildToolFieldMarkup(key, schema = {}, required = false) {
  const type = formatSchemaType(schema);
  const widget = resolveSchemaWidget(schema);
  const uiHint = getSchemaUiHint(schema);
  const desc = schema.description || '';
  const label = uiHint?.label || key;
  const rawDefaultText = formatSchemaDefault(schema);
  const defaultText = widget === 'datetime' ? toDatetimeLocalInputValue(rawDefaultText) : rawDefaultText;
  const placeholder = uiHint?.placeholder || desc || '';
  const example = uiHint?.example || '';
  const metaChips = [
    `<span class="form-chip">类型: ${escHtml(type)}</span>`,
    widget !== type && widget !== 'select' && widget !== 'json' ? `<span class="form-chip">控件: ${escHtml(widget)}</span>` : '',
    widget === 'json' ? '<span class="form-chip">控件: json</span>' : '',
    required ? '<span class="form-chip">必填</span>' : '<span class="form-chip">选填</span>',
    Object.prototype.hasOwnProperty.call(schema, 'default') ? '<span class="form-chip">已带默认值</span>' : '',
  ].filter(Boolean).join('');

  let input = '';
  if (schema.enum) {
    input = `<select class="form-input" data-param="${key}" data-schema-type="${escHtml(type)}" data-schema-widget="select">${!required ? '<option value="">-- 请选择 --</option>' : ''}${schema.enum.map(v => `<option value="${escHtml(String(v))}" ${schema.default === v ? 'selected' : ''}>${escHtml(String(v))}</option>`).join('')}</select>`;
  } else if (widget === 'number') {
    input = `<input type="number" class="form-input" data-param="${key}" data-schema-type="number" data-schema-widget="number" value="${escHtml(defaultText)}" placeholder="${escHtml(placeholder)}" />`;
  } else if (widget === 'boolean') {
    input = `<input type="checkbox" data-param="${key}" data-schema-type="boolean" data-schema-widget="boolean" ${schema.default ? 'checked' : ''} />`;
  } else if (widget === 'json') {
    input = `<textarea class="form-input form-textarea" data-param="${key}" data-schema-type="${escHtml(type)}" data-schema-widget="json" placeholder="${escHtml(placeholder || `请输入合法 JSON ${type === 'array' ? '数组' : '对象'}`)}">${escHtml(defaultText)}</textarea>`;
  } else if (widget === 'textarea') {
    input = `<textarea class="form-input form-textarea" data-param="${key}" data-schema-type="string" data-schema-widget="textarea" placeholder="${escHtml(placeholder)}">${escHtml(defaultText)}</textarea>`;
  } else if (widget === 'date') {
    input = `<input type="date" class="form-input" data-param="${key}" data-schema-type="string" data-schema-widget="date" value="${escHtml(defaultText)}" />`;
  } else if (widget === 'time') {
    input = `<input type="time" class="form-input" data-param="${key}" data-schema-type="string" data-schema-widget="time" value="${escHtml(defaultText)}" />`;
  } else if (widget === 'datetime') {
    input = `<input type="datetime-local" class="form-input" data-param="${key}" data-schema-type="string" data-schema-widget="datetime" value="${escHtml(defaultText)}" />`;
  } else {
    input = `<input type="text" class="form-input" data-param="${key}" data-schema-type="string" data-schema-widget="text" value="${escHtml(defaultText)}" placeholder="${escHtml(placeholder)}" />`;
  }

  return `<div class="form-group"><label class="form-label">${escHtml(label)}${required ? ' *' : ''}</label><div class="form-meta">${metaChips}</div>${input}${desc ? `<div class="form-hint">${escHtml(desc)}</div>` : ''}${example ? `<div class="form-hint">示例：${escHtml(example)}</div>` : ''}</div>`;
}

function parseToolFieldValue(input) {
  const type = input.dataset.schemaType || 'string';
  const widget = input.dataset.schemaWidget || '';
  if (type === 'boolean') {
    return input.checked;
  }

  const raw = typeof input.value === 'string' ? input.value.trim() : '';
  if (!raw) return undefined;

  if (type === 'number') {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`参数 ${input.dataset.param} 需要是数字`);
    }
    return parsed;
  }

  if (type === 'object' || type === 'array') {
    try {
      const parsed = JSON.parse(raw);
      if (type === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
        throw new Error('expected object');
      }
      if (type === 'array' && !Array.isArray(parsed)) {
        throw new Error('expected array');
      }
      return parsed;
    } catch {
      throw new Error(`参数 ${input.dataset.param} 需要是合法 JSON ${type === 'array' ? '数组' : '对象'}`);
    }
  }

  if (widget === 'datetime') {
    return toDatetimeSubmitValue(raw);
  }

  return raw;
}

function toolRequiresConfirmation(tool) {
  return Boolean(tool?.parameters?.['x-webcli-requires-confirmation']);
}

function confirmToolExecution(tool, args) {
  if (!toolRequiresConfirmation(tool)) return true;
  const message = tool.parameters?.['x-webcli-confirmation-message'] || '该工具会触发真实业务动作，请确认参数无误后继续。';
  const payload = Object.keys(args || {}).length ? JSON.stringify(args, null, 2) : '无参数';
  return window.confirm(`${message}\n\n将提交的参数：\n${payload}`);
}

function formatToolDisplayName(toolName) {
  const name = String(toolName || '');
  if (currentSiteKey && name.startsWith(`${currentSiteKey}.`)) {
    return name.slice(currentSiteKey.length + 1);
  }
  return name.split('.').pop() || name;
}

function setHeaderBadge(type, text) {
  const badge = document.getElementById("headerBadge");
  badge.className = `header-badge badge-${type}`;
  document.getElementById("headerBadgeText").textContent = text;
}

function setWsStatus(connected, disconnectReason = '') {
  isBridgeConnected = Boolean(connected);
  const badge = document.getElementById("wsBadge");
  const label = document.getElementById("wsLabel");
  badge.className = isBridgeConnected ? "header-badge badge-active" : "header-badge badge-none";
  label.textContent = isBridgeConnected ? "Bridge 已连接" : "Bridge 未连接";
  badge.title = isBridgeConnected ? '' : String(disconnectReason || '');
}

async function refreshBridgeStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'popup_bridge_status' });
    setWsStatus(Boolean(response?.isConnected), response?.disconnectReason || '');
  } catch {
    setWsStatus(false);
  }
  return isBridgeConnected;
}

async function ensureBridgeConnected(message) {
  if (await refreshBridgeStatus()) return true;
  if (message) showToast(message, 3000);
  return false;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      const panelId = tab.dataset.panel;
      document.getElementById(panelId).classList.add('active');
    });
  });
}

// ── Dev Mode ──────────────────────────────────────────────────────────────────
// Click version number 5 times within 1 second to toggle developer mode.

let devModeClickCount = 0;
let devModeClickTimer = null;
let devModeEnabled = false;

function applyDevMode(enabled) {
  document.querySelectorAll('[data-dev-only]').forEach(el => {
    el.hidden = !enabled;
  });
  // If dev mode is off and current tab is a dev-only tab, switch to "使用"
  if (!enabled) {
    const activeTab = document.querySelector('.tab.active');
    if (activeTab && activeTab.hasAttribute('data-dev-only')) {
      const useTab = document.querySelector('.tab[data-panel="panelUse"]');
      if (useTab) useTab.click();
    }
  }
}

function showToast(message, duration = 1500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

function initDevMode() {
  // Release builds should start with dev-only tabs hidden even if an older
  // version persisted devMode=true in chrome.storage.local.
  devModeEnabled = false;
  applyDevMode(false);
  chrome.storage.local.remove('devMode');

  // Listen for clicks on version number
  const versionEl = document.getElementById('extVersionRight');
  if (!versionEl) return;

  versionEl.addEventListener('click', () => {
    devModeClickCount++;
    if (devModeClickTimer) clearTimeout(devModeClickTimer);
    devModeClickTimer = setTimeout(() => { devModeClickCount = 0; }, 1000);

    if (devModeClickCount >= 5) {
      devModeClickCount = 0;
      clearTimeout(devModeClickTimer);
      devModeEnabled = !devModeEnabled;
      applyDevMode(devModeEnabled);
      showToast(devModeEnabled ? '已开启开发者模式' : '已关闭开发者模式');
    }
  });
}

// ── Use Tab ──────────────────────────────────────────────────────────────────

function renderUseTab(tools, options = {}) {
  document.getElementById('useLoading').hidden = true;
  if (tools.length === 0) {
    const titleEl = document.querySelector('#useNone .none-title');
    const descEl = document.querySelector('#useNone .none-desc');
    if (options.injectionError) {
      titleEl.textContent = '适配器加载失败';
      descEl.textContent = `已发现适配器，但注入当前页面失败：${options.injectionError}`;
    } else if (options.adapterInstalled) {
      titleEl.textContent = '已发现适配器，正在同步工具';
      descEl.textContent = '如果稍后仍未显示工具，可刷新当前页面或重载扩展。';
    } else {
      titleEl.textContent = '此网站暂无适配器';
      descEl.textContent = '此网站暂未支持，可通过 WebCLI 探索并生成适配器。';
    }
    document.getElementById('useActive').hidden = true;
    document.getElementById('useNone').hidden = false;
    return;
  }
  document.getElementById('useNone').hidden = true;
  document.getElementById('useActive').hidden = false;
  document.getElementById('useToolCount').textContent = `已加载 ${tools.length} 个工具`;

  const list = document.getElementById('useToolList');
  list.innerHTML = '';
  for (const tool of tools) {
    const item = document.createElement('div');
    item.className = 'tool-item';
    item.title = tool.name;
    item.innerHTML = `<div class="tool-name">${escHtml(formatToolDisplayName(tool.name))}</div><div class="tool-desc">${escHtml(tool.description || '')}</div>`;
    item.addEventListener('click', () => openToolTestModal(tool));
    list.appendChild(item);
  }
}

function resetExploreStateForSiteChange() {
  clearExplorePolling();
  clearGenerationPolling();
  activeGenerationRunId = null;
  lastWorkflowResult = null;
  lastActionCaptureState = null;
  setDevAdvancedCodeVisible(false);
  setDevViewMode('auto');
  setDevWorkflowStep('explore');
  showExploreState('idle');
  document.getElementById('exploreSaveStatus').hidden = true;
  document.getElementById('exploreGenerateResult').hidden = true;
  resetActionCaptureForm();
  resetActionCaptureUi();
}

// ── Dev Tab ──────────────────────────────────────────────────────────────────

let activeDevFile = 'code';
let codeEditor = null;
let manifestEditor = null;
let monacoReady = false;
let devViewMode = 'auto';
let devCodeModels = new Map();
let devManifestText = '{}';
let devAuxiliaryFiles = [];
let currentToolSourceFile = '';
let currentToolDisplayName = '';
let currentManifestObject = null;
let devLoadedSiteKey = '';
const DEV_AUXILIARY_FILE_DEFS = [
  { key: 'skill', filename: 'SKILL.md', tabId: 'devSkillFileTab', label: 'SKILL.md' },
  { key: 'generatedSkill', filename: 'SKILL.generated.md', tabId: 'devGeneratedSkillFileTab', label: '生成Skill' },
  { key: 'knowledgeMarkdown', filename: 'WEBCLI_KNOWLEDGE.md', tabId: 'devKnowledgeMdFileTab', label: '知识.md' },
  { key: 'knowledgeJson', filename: 'WEBCLI_KNOWLEDGE.json', tabId: 'devKnowledgeJsonFileTab', label: '知识.json' },
];

function setDevViewMode(mode) {
  devViewMode = mode;
}

function setDevWorkflowStep(step) {
  devWorkflowStep = ['explore', 'capture', 'generate'].includes(step) ? step : 'explore';
  const order = ['explore', 'capture', 'generate'];
  const activeIndex = order.indexOf(devWorkflowStep);

  for (const item of order) {
    const index = order.indexOf(item);
    const suffix = `${item[0].toUpperCase()}${item.slice(1)}`;
    const stepEl = document.getElementById(`devStep${suffix}`);
    const panelEl = document.getElementById(`devStepPanel${suffix}`);
    if (stepEl) {
      stepEl.classList.toggle('active', item === devWorkflowStep);
      stepEl.classList.toggle('done', index < activeIndex);
      if (item === devWorkflowStep) stepEl.setAttribute('aria-current', 'step');
      else stepEl.removeAttribute('aria-current');
    }
    if (panelEl) panelEl.classList.toggle('active', item === devWorkflowStep);
  }

  if (devWorkflowStep === 'generate') {
    syncGenerateButtonFromSiteMemory().catch(() => {});
  }
}

function setDevAdvancedCodeVisible(visible) {
  devAdvancedCodeVisible = Boolean(visible);
  const button = document.getElementById('btnDevShowCode');
  if (button) button.textContent = devAdvancedCodeVisible ? '返回生成向导' : '高级：查看代码';
}

function applyDevView(hasAdapter) {
  const showEditor = Boolean(hasAdapter && devAdvancedCodeVisible && devViewMode === 'editor');
  document.getElementById('devIdeLayout').hidden = !showEditor;
  document.getElementById('devExploreSection').style.display = showEditor ? 'none' : '';
  const codeButton = document.getElementById('btnDevShowCode');
  if (codeButton) codeButton.hidden = !hasAdapter;
  setDevWorkflowStep(devWorkflowStep);
}

function initMonaco() {
  return new Promise((resolve) => {
    if (monacoReady) { resolve(); return; }
    // Monaco is loaded globally via monaco.bundle.js
    if (!window.monaco) { throw new Error('Monaco Editor not loaded'); }
    monaco.editor.defineTheme('webmcp-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#11111b',
        'editor.foreground': '#cdd6f4',
        'editorLineNumber.foreground': '#45475a',
        'editorLineNumber.activeForeground': '#89b4fa',
        'editor.selectionBackground': '#89b4fa44',
        'editor.lineHighlightBackground': '#181825',
      }
    });
    monacoReady = true;
    resolve();
  });
}

function createEditor(container, language) {
  return monaco.editor.create(container, {
    language,
    theme: 'webmcp-dark',
    fontSize: 12,
    lineNumbers: 'on',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    automaticLayout: true,
    tabSize: 2,
    renderWhitespace: 'none',
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
  });
}

function getDevToolFileTab() {
  return document.getElementById('devToolFileTab');
}

function getDevAuxFileTab(tabId) {
  return document.getElementById(tabId);
}

function resetDevCodeModels() {
  for (const model of devCodeModels.values()) {
    try { model.dispose(); } catch { }
  }
  devCodeModels = new Map();
}

function getAdapterFileUrl(siteKey, filename) {
  return chrome.runtime.getURL(`adapters/${siteKey}/${filename}`);
}

function getLanguageForFilename(filename) {
  const value = String(filename || '').toLowerCase();
  if (value.endsWith('.json')) return 'json';
  if (value.endsWith('.md') || value.endsWith('.markdown')) return 'markdown';
  return 'javascript';
}

function getOrCreateCodeModel(filename, content = '') {
  const existing = devCodeModels.get(filename);
  if (existing) return existing;
  const model = monaco.editor.createModel(content, getLanguageForFilename(filename));
  devCodeModels.set(filename, model);
  return model;
}

async function loadAdapterFileText(filename) {
  const url = getAdapterFileUrl(currentSiteKey, filename);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`读取文件失败: ${filename}`);
  }
  return response.text();
}

function getDevAuxFileDefByKey(fileKey) {
  return DEV_AUXILIARY_FILE_DEFS.find((item) => item.key === fileKey) || null;
}

function buildGeneratedToolRelPath(siteKey, toolName) {
  const prefix = `${siteKey}.`;
  const localName = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
  const safeFileToken = localName.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return `webcli-generated/tools/${safeFileToken}.generated.js`;
}

function resolveGeneratedToolSourceFile(toolName, manifest) {
  const supportFiles = Array.isArray(manifest?.support_files) ? manifest.support_files.filter((item) => typeof item === 'string') : [];
  const relPath = buildGeneratedToolRelPath(currentSiteKey, toolName);
  return supportFiles.includes(relPath) ? relPath : '';
}

function setDevEditorActiveTab(fileKey) {
  document.querySelectorAll('.dev-editor-tab').forEach(t => t.classList.toggle('active', t.dataset.file === fileKey));
}

function showDevEditorFile(fileKey) {
  activeDevFile = fileKey;
  const toolTab = getDevToolFileTab();
  document.getElementById('codeEditorContainer').hidden = fileKey === 'manifest';
  document.getElementById('manifestEditorContainer').hidden = fileKey !== 'manifest';
  toolTab.hidden = !currentToolSourceFile;
  if (fileKey === 'tool' && currentToolDisplayName) {
    toolTab.textContent = currentToolDisplayName;
  } else if (toolTab && !toolTab.hidden) {
    toolTab.textContent = currentToolDisplayName || 'tool';
  }
  for (const def of DEV_AUXILIARY_FILE_DEFS) {
    const tab = getDevAuxFileTab(def.tabId);
    if (!tab) continue;
    const visible = devAuxiliaryFiles.some((item) => item.key === def.key);
    tab.hidden = !visible;
    tab.textContent = def.label;
  }
  setDevEditorActiveTab(fileKey);
  if (fileKey === 'manifest' && manifestEditor) manifestEditor.layout();
  if (fileKey !== 'manifest' && codeEditor) codeEditor.layout();
}

function openIndexSourceInEditor() {
  const model = devCodeModels.get('index.js');
  if (!model || !codeEditor) return;
  codeEditor.setModel(model);
  showDevEditorFile('code');
}

async function openToolSourceInEditor(tool) {
  const sourceFile = tool?.sourceFile || '';
  if (!sourceFile || !codeEditor) {
    openIndexSourceInEditor();
    return false;
  }
  const existingModel = devCodeModels.get(sourceFile);
  if (existingModel) {
    codeEditor.setModel(existingModel);
    currentToolSourceFile = sourceFile;
    currentToolDisplayName = sourceFile.split('/').pop() || sourceFile;
    showDevEditorFile('tool');
    return true;
  }

  const content = await loadAdapterFileText(sourceFile);
  const model = getOrCreateCodeModel(sourceFile, content);
  codeEditor.setModel(model);
  currentToolSourceFile = sourceFile;
  currentToolDisplayName = sourceFile.split('/').pop() || sourceFile;
  showDevEditorFile('tool');
  return true;
}

async function openAuxiliarySourceInEditor(fileKey) {
  const def = getDevAuxFileDefByKey(fileKey);
  if (!def || !codeEditor) {
    openIndexSourceInEditor();
    return false;
  }
  const existingModel = devCodeModels.get(def.filename);
  if (existingModel) {
    codeEditor.setModel(existingModel);
    showDevEditorFile(def.key);
    return true;
  }

  const content = await loadAdapterFileText(def.filename);
  const model = getOrCreateCodeModel(def.filename, content);
  codeEditor.setModel(model);
  showDevEditorFile(def.key);
  return true;
}

async function openDevEditorAtFile(fileKey = 'code') {
  setDevAdvancedCodeVisible(true);
  setDevViewMode('editor');
  applyDevView(Boolean(currentSiteKey));
  await renderDevTab();
  const auxDef = getDevAuxFileDefByKey(fileKey);
  if (auxDef) {
    await openAuxiliarySourceInEditor(auxDef.key);
    return;
  }
  openIndexSourceInEditor();
}

function initDevEditorTabs() {
  document.querySelectorAll('.dev-editor-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.file;
      if (target === 'manifest') {
        showDevEditorFile('manifest');
        return;
      }
      if (target === 'tool' && currentToolSourceFile) {
        void openToolSourceInEditor({ sourceFile: currentToolSourceFile });
        return;
      }
      const auxDef = getDevAuxFileDefByKey(target);
      if (auxDef) {
        void openAuxiliarySourceInEditor(auxDef.key);
        return;
      }
      openIndexSourceInEditor();
    });
  });
}

async function renderDevTab() {
  if (!currentSiteKey) {
    devLoadedSiteKey = '';
    resetDevCodeModels();
    setDevAdvancedCodeVisible(false);
    setDevViewMode('auto');
    applyDevView(false);
    return;
  }

  try {
    const codeUrl = chrome.runtime.getURL(`adapters/${currentSiteKey}/index.js`);
    const codeResp = await fetch(codeUrl);
    if (codeResp.ok) {
      const code = await codeResp.text();
      const manifestUrl = chrome.runtime.getURL(`adapters/${currentSiteKey}/manifest.json`);
      const manifestResp = await fetch(manifestUrl);
      const manifestText = manifestResp.ok ? await manifestResp.text() : '{}';

      applyDevView(true);

      // Initialize Monaco editors
      await initMonaco();
      if (devLoadedSiteKey !== currentSiteKey) {
        resetDevCodeModels();
        devLoadedSiteKey = currentSiteKey;
      }

      if (!codeEditor) {
        codeEditor = createEditor(document.getElementById('codeEditorContainer'), 'javascript');
      }
      const indexModel = getOrCreateCodeModel('index.js', code);
      indexModel.setValue(code);
      codeEditor.setModel(indexModel);

      if (!manifestEditor) {
        manifestEditor = createEditor(document.getElementById('manifestEditorContainer'), 'json');
      }
      manifestEditor.setValue(manifestText);
      devManifestText = manifestText;
      try {
        currentManifestObject = JSON.parse(manifestText);
      } catch {
        currentManifestObject = null;
      }
      devAuxiliaryFiles = [];
      for (const def of DEV_AUXILIARY_FILE_DEFS) {
        try {
          const content = await loadAdapterFileText(def.filename);
          const model = getOrCreateCodeModel(def.filename, content);
          model.setValue(content);
          devAuxiliaryFiles.push({ ...def, hidden: false });
        } catch {
          const existing = devCodeModels.get(def.filename);
          if (existing) {
            try { existing.dispose(); } catch { }
            devCodeModels.delete(def.filename);
          }
        }
      }
      currentToolSourceFile = '';
      currentToolDisplayName = '';
      getDevToolFileTab().hidden = true;
      showDevEditorFile('code');

      // Render tool list in sidebar
      const devList = document.getElementById('devToolList');
      devList.innerHTML = '';
      if (currentTools.length > 0) {
        const toolSection = document.createElement('div');
        toolSection.className = 'dev-sidebar-section';
        toolSection.textContent = '工具';
        devList.appendChild(toolSection);
      }
      for (const tool of currentTools) {
        const item = document.createElement('div');
        item.className = 'dev-sidebar-item';
        const shortName = tool.name.replace(`${currentSiteKey}.`, '');
        item.textContent = shortName;
        item.title = tool.description || tool.name;
        const sourceFile = resolveGeneratedToolSourceFile(tool.name, currentManifestObject);
        if (sourceFile) {
          item.dataset.sourceFile = sourceFile;
          item.title = `${tool.description || tool.name}\n${sourceFile}`;
        }
        item.addEventListener('click', async () => {
          devList.querySelectorAll('.dev-sidebar-item').forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          if (sourceFile) {
            try {
              await openToolSourceInEditor({ sourceFile });
              codeEditor.focus();
              return;
            } catch (err) {
              console.warn('[WebMCP] Failed to open generated tool file, fallback to index.js:', err.message);
            }
          }

          openIndexSourceInEditor();
          const model = codeEditor.getModel();
          const matches = model.findMatches(tool.name, false, false, true, null, false);
          if (matches.length > 0) {
            codeEditor.revealLineInCenter(matches[0].range.startLineNumber);
            codeEditor.setSelection(matches[0].range);
          }
          codeEditor.focus();
        });
        devList.appendChild(item);
      }
      if (devAuxiliaryFiles.length > 0) {
        const contextSection = document.createElement('div');
        contextSection.className = 'dev-sidebar-section';
        contextSection.textContent = '优化上下文';
        devList.appendChild(contextSection);
        for (const def of devAuxiliaryFiles) {
          const item = document.createElement('div');
          item.className = 'dev-sidebar-item';
          item.textContent = def.label;
          item.title = def.filename;
          item.addEventListener('click', async () => {
            devList.querySelectorAll('.dev-sidebar-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            await openAuxiliarySourceInEditor(def.key);
            codeEditor.focus();
          });
          devList.appendChild(item);
        }
      }
      return;
    }
  } catch {}

  // No adapter
  setDevAdvancedCodeVisible(false);
  setDevViewMode('auto');
  applyDevView(false);
}

async function saveCurrentFile() {
  const auxDef = getDevAuxFileDefByKey(activeDevFile);
  const filename = activeDevFile === 'manifest'
    ? 'manifest.json'
    : activeDevFile === 'tool' && currentToolSourceFile
      ? currentToolSourceFile
      : auxDef
        ? auxDef.filename
        : 'index.js';
  const content = activeDevFile === 'manifest'
    ? manifestEditor.getValue()
    : codeEditor.getValue();

  const statusEl = document.getElementById('devSaveStatus');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'popup_save_adapter_file', siteKey: currentSiteKey, filename, content
    });
    if (response.ok) {
      if (filename === 'manifest.json') {
        try {
          currentManifestObject = JSON.parse(content);
        } catch {
          currentManifestObject = null;
        }
      }
      statusEl.className = 'save-status success';
      statusEl.textContent = `${filename} 已保存`;
    } else {
      statusEl.className = 'save-status error';
      statusEl.textContent = response.error || '保存失败';
    }
  } catch (err) {
    statusEl.className = 'save-status error';
    statusEl.textContent = err.message;
  }
  setTimeout(() => { statusEl.textContent = ''; }, 4000);
}

// ── Explore ──────────────────────────────────────────────────────────────────

function clearExplorePolling() {
  if (explorePollTimer) {
    clearTimeout(explorePollTimer);
    explorePollTimer = null;
  }
}

function showExploreState(state) {
  document.getElementById('exploreIdle').hidden = state !== 'idle';
  document.getElementById('exploreLoading').hidden = (state !== 'loading' && state !== 'workflow_loading' && state !== 'workflow_ai_loading');
  document.getElementById('exploreResults').hidden = state !== 'results';
  document.getElementById('exploreWorkflowResults').hidden = state !== 'workflow_results';
  document.getElementById('exploreError').hidden = state !== 'error';
  const loadingText = document.getElementById('exploreLoadingText');
  if (state === 'workflow_loading') loadingText.textContent = '正在刷新页面并探测接口…';
  else if (state === 'workflow_ai_loading') loadingText.textContent = '接口探测完成，AI 分析中…';
  else if (state === 'loading') loadingText.textContent = '正在分析页面…';
}

function renderPatternBadge(el, pattern) {
  const map = { api_driven: { label: 'API', cls: 'explore-badge-api' }, dom_driven: { label: 'UI/DOM', cls: 'explore-badge-ui' }, state_or_ssr: { label: 'HYBRID', cls: 'explore-badge-hybrid' } };
  const m = map[pattern] || { label: pattern || '?', cls: 'explore-badge-ui' };
  el.textContent = m.label;
  el.className = `explore-badge ${m.cls}`;
}

function formatVerdictSource(verdict = {}) {
  if (verdict.analysisSource === 'ai') {
    const provider = verdict.provider ? String(verdict.provider) : 'ai';
    const model = verdict.model ? String(verdict.model) : '';
    return model ? `AI分析 · ${provider} / ${model}` : `AI分析 · ${provider}`;
  }
  return '规则兜底';
}

function renderVerdictApiList(container, verdict, fallbackEntries = []) {
  const aiCandidates = Array.isArray(verdict?.topApiCandidates) ? verdict.topApiCandidates : [];
  const entries = aiCandidates.length > 0
    ? aiCandidates.slice(0, 5).map((item) => ({
      method: item.method || 'GET',
      url: item.url || '',
      why: item.why || item.purpose || item.description || item.summary || item.reason || '',
    }))
    : fallbackEntries;

  if (!entries.length) {
    container.hidden = true;
    return;
  }

  const title = aiCandidates.length > 0 ? 'AI 识别候选:' : 'API 候选:';
  let html = `<div class="explore-api-title">${escHtml(title)}</div>`;
  for (const entry of entries) {
    const url = String(entry.url || '').split('?')[0];
    const short = url.length > 55 ? '...' + url.slice(-52) : url;
    const why = String(entry.why || '').trim();
    const titleText = why ? `${entry.url}\n${why}` : (entry.url || '');
    html += `
      <div class="explore-api-item">
        <div class="explore-api-main">
          <span class="explore-api-method">${escHtml((entry.method || 'GET').toUpperCase())}</span>
          <div class="explore-api-content">
            <span class="explore-api-url" title="${escHtml(titleText)}">${escHtml(short)}</span>
            ${why ? `<span class="explore-api-why">${escHtml(why)}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }
  container.innerHTML = html;
  container.hidden = false;
}

function renderAnalyzeResults(result) {
  const { verdict, network } = result;
  renderPatternBadge(document.getElementById('exploreBadge'), verdict.pattern);
  document.getElementById('exploreStrategy').textContent = `推荐策略: ${verdict.recommendedStrategy} · ${formatVerdictSource(verdict)}`;
  document.getElementById('exploreReason').textContent = verdict.reason;
  const stats = [`API 请求: ${(network?.entries || []).length} 条`];
  if (typeof verdict?.confidence === 'number') stats.push(`置信度: ${Math.round(verdict.confidence * 100)}%`);
  document.getElementById('exploreStats').textContent = stats.join(' · ');
  showExploreState('results');
}

function renderWorkflowResults(result) {
  lastWorkflowResult = result || null;
  const verdict = result.verdict || {};
  renderPatternBadge(document.getElementById('exploreWfBadge'), verdict.pattern);
  document.getElementById('exploreWfStrategy').textContent = `推荐策略: ${verdict.recommendedStrategy || '—'} · ${formatVerdictSource(verdict)}`;
  const reasonParts = [verdict.reason || '接口探测完成', verdict.observedSummary || ''].filter(Boolean);
  document.getElementById('exploreWfReason').textContent = reasonParts.join(' ');
  const allEntries = result.network?.entries || [];
  const stats = [];
  if (allEntries.length) stats.push(`网络请求: ${allEntries.length} 条`);
  if (result.workflow?.mode === 'passive_network_capture') stats.push('模式: 被动捕获');
  if (typeof verdict?.confidence === 'number') stats.push(`置信度: ${Math.round(verdict.confidence * 100)}%`);
  document.getElementById('exploreWfStats').textContent = stats.join(' · ');

  const apiListEl = document.getElementById('exploreWfApiList');
  const apiEntries = allEntries.filter(e => e?.url && ((e.responseContentType || e.contentType || '').toLowerCase().includes('json'))).slice(0, 10);
  renderVerdictApiList(apiListEl, verdict, apiEntries);
  showExploreState('workflow_results');
  setDevWorkflowStep('explore');
}

function showExploreError(msg) { document.getElementById('exploreErrorText').textContent = msg; showExploreState('error'); }

async function triggerAnalyze() {
  if (!currentTabId) { showExploreError('无法获取当前标签页'); return; }
  setDevAdvancedCodeVisible(false);
  setDevViewMode('auto');
  setDevWorkflowStep('explore');
  clearExplorePolling();
  showExploreState('loading');
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'popup_explore_analyze',
      tabId: currentTabId,
      siteKey: currentSiteKey,
    });
    if (r.error) showExploreError(r.error); else renderAnalyzeResults(r.result);
  } catch (e) { showExploreError(e.message); }
}

async function triggerWorkflow() {
  if (!currentTabId) { showExploreError('无法获取当前标签页'); return; }
  setDevAdvancedCodeVisible(false);
  setDevViewMode('auto');
  setDevWorkflowStep('explore');
  applyDevView(Boolean(currentSiteKey));
  clearExplorePolling();
  showExploreState('workflow_loading');
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'popup_explore_workflow',
      tabId: currentTabId,
      siteKey: currentSiteKey,
    });
    if (r.error) {
      showExploreError(r.error);
    } else {
      scheduleExplorePoll();
    }
  } catch (e) { showExploreError(e.message); }
}

function applySavedExploreState(saved) {
  if (!saved) return false;
  if (saved.siteKey && currentSiteKey && saved.siteKey !== String(currentSiteKey).toLowerCase()) return false;
  if (saved.type === 'workflow' && saved.result) {
    clearExplorePolling();
    lastWorkflowResult = saved.result;
    renderWorkflowResults(saved.result);
    return true;
  }
  if (saved.type === 'workflow_loading') {
    showExploreState('workflow_loading');
    scheduleExplorePoll();
    return true;
  }
  if (saved.type === 'workflow_ai_loading') {
    showExploreState('workflow_ai_loading');
    scheduleExplorePoll();
    return true;
  }
  if (saved.type === 'workflow_error') {
    clearExplorePolling();
    showExploreError(saved.error || '接口探索失败');
    return true;
  }
  if (saved.type === 'analyze' && saved.result) {
    clearExplorePolling();
    renderAnalyzeResults(saved.result);
    return true;
  }
  return false;
}

async function restoreExploreStateForCurrentSite(maxAgeMs = 900000) {
  const expectedTabId = currentTabId;
  const expectedSiteKey = currentSiteKey;
  if (!expectedTabId || !expectedSiteKey) return false;

  try {
    const saved = await chrome.runtime.sendMessage({
      type: 'popup_explore_get_state',
      tabId: expectedTabId,
      siteKey: expectedSiteKey,
    });
    if (currentTabId !== expectedTabId || currentSiteKey !== expectedSiteKey) return false;
    if (!saved?.timestamp || Date.now() - saved.timestamp > maxAgeMs) return false;
    if (saved.type !== 'workflow_loading' && saved.type !== 'workflow_ai_loading') return false;
    return applySavedExploreState(saved);
  } catch {
    return false;
  }
}

function scheduleExplorePoll() {
  clearExplorePolling();
  explorePollTimer = setTimeout(async () => {
    try {
      const saved = await chrome.runtime.sendMessage({
        type: 'popup_explore_get_state',
        tabId: currentTabId,
        siteKey: currentSiteKey,
      });
      if (!saved) return;
      if (saved.type === 'workflow_loading' || saved.type === 'workflow_ai_loading') {
        applySavedExploreState(saved);
        return;
      }
      applySavedExploreState(saved);
    } catch {
      scheduleExplorePoll();
    }
  }, 1000);
}

async function triggerSaveMemory() {
  const el = document.getElementById('exploreSaveStatus');
  if (!lastWorkflowResult || !currentSiteKey) {
    el.className = 'save-status error';
    el.textContent = !currentSiteKey
      ? '无法识别当前网站，请刷新页面后重试'
      : '没有可保存的探索结果，请先完成一次网站探索';
    el.hidden = false;
    return;
  }
  const btn = document.getElementById('btnExploreSave');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const r = await saveCurrentWorkflowMemory();
    if (r.error) { el.className = 'save-status error'; el.textContent = r.error; }
    else { el.className = 'save-status success'; el.textContent = `已保存（第 ${r.captureCount} 次）`; document.getElementById('btnExploreGenerate').hidden = false; }
    el.hidden = false;
  } finally { btn.disabled = false; btn.textContent = '仅保存探索结果'; }
}

async function saveCurrentWorkflowMemory() {
  if (!lastWorkflowResult || !currentSiteKey) {
    return { error: !currentSiteKey ? '无法识别当前网站，请刷新页面后重试' : '没有可保存的探索结果，请先完成一次网站探索' };
  }
  return chrome.runtime.sendMessage({
    type: 'popup_explore_save_memory',
    siteKey: currentSiteKey,
    workflowResult: lastWorkflowResult,
  });
}

async function ensureMemoryBeforeGenerate() {
  if (!lastWorkflowResult || !currentSiteKey) return { ok: true, skipped: true };
  const el = document.getElementById('exploreSaveStatus');
  el.className = 'save-status';
  el.textContent = '正在自动保存探索结果…';
  el.hidden = false;

  const r = await saveCurrentWorkflowMemory();
  if (r.error) {
    el.className = 'save-status error';
    el.textContent = `自动保存探索结果失败：${r.error}`;
    return { ok: false, error: r.error };
  }

  el.className = 'save-status success';
  el.textContent = `已自动保存探索结果（第 ${r.captureCount} 次）`;
  return { ok: true, result: r };
}

async function triggerQuickGenerate() {
  return triggerGenerate({ quick: true });
}

const GENERATION_STATUS_LABELS = {
  created: '任务已创建',
  context_ready: '上下文已就绪',
  planning: '正在制定生成计划',
  drafting: '正在生成隔离草稿',
  static_validating: '正在执行静态验证',
  revising: '正在修正草稿',
  runtime_validating: '正在执行真实调用验证',
  awaiting_approval: '草稿验证通过，等待安装',
  publishing: '正在安装 Adapter',
  completed: 'Adapter 已安装',
  failed: '智能生成失败',
  cancelled: '智能生成已取消',
  needs_user_input: '需要补充操作信息',
  budget_exceeded: '智能生成已达到预算上限',
};

const ACTIVE_GENERATION_STATUSES = new Set([
  'created',
  'context_ready',
  'planning',
  'drafting',
  'static_validating',
  'revising',
  'runtime_validating',
  'publishing',
]);

function clearGenerationPolling() {
  if (generationPollTimer) {
    clearTimeout(generationPollTimer);
    generationPollTimer = null;
  }
}

async function persistGenerationRunId(siteKey, runId) {
  if (!siteKey || !runId) return;
  const stored = await chrome.storage.local.get('generationRunsBySite');
  const mapping = stored.generationRunsBySite || {};
  mapping[siteKey] = runId;
  await chrome.storage.local.set({ generationRunsBySite: mapping });
}

async function removeGenerationRunId(siteKey, runId = '') {
  if (!siteKey) return;
  const stored = await chrome.storage.local.get('generationRunsBySite');
  const mapping = stored.generationRunsBySite || {};
  if (!mapping[siteKey] || (runId && mapping[siteKey] !== runId)) return;
  delete mapping[siteKey];
  await chrome.storage.local.set({ generationRunsBySite: mapping });
}

async function restoreGenerationRunForSite(siteKey = currentSiteKey) {
  if (!siteKey) return false;
  try {
    const stored = await chrome.storage.local.get('generationRunsBySite');
    const runId = stored.generationRunsBySite?.[siteKey];
    if (!runId) return false;
    const response = await chrome.runtime.sendMessage({
      type: 'popup_explore_get_generation',
      runId,
    });
    if (!response?.ok || !response.run) {
      await removeGenerationRunId(siteKey, runId);
      return false;
    }
    if (!ACTIVE_GENERATION_STATUSES.has(response.run.status) && !['awaiting_approval', 'needs_user_input'].includes(response.run.status)) {
      await removeGenerationRunId(siteKey, runId);
      return false;
    }
    activeGenerationRunId = runId;
    renderGenerationRun(response.run);
    if (ACTIVE_GENERATION_STATUSES.has(response.run.status)) {
      generationPollTimer = setTimeout(() => pollGenerationRun(runId), 1000);
    }
    return true;
  } catch {
    return false;
  }
}

let activeInstallationReview = null;
function renderGenerationRun(run, extra = {}) {
  if (!run) return;
  activeGenerationRunId = run.id || activeGenerationRunId;
  activeInstallationReview = run.artifacts?.installationReview || null;
  const resultEl = document.getElementById('exploreGenerateResult');
  const status = String(run.status || 'created');
  const statusLabel = GENERATION_STATUS_LABELS[status] || status;
  const planTools = Array.isArray(run.artifacts?.plan?.tools) ? run.artifacts.plan.tools : [];
  const generatedTools = Array.isArray(run.artifacts?.draft?.toolNames) ? run.artifacts.draft.toolNames : [];
  const validation = run.artifacts?.staticValidation;
  const validationErrors = Array.isArray(validation?.errors) ? validation.errors : [];
  const validationWarnings = Array.isArray(validation?.warnings) ? validation.warnings : [];
  const runtimeValidation = run.artifacts?.runtimeValidation;
  const provenance = run.artifacts?.provenance;
  const runtimeToolResults = Array.isArray(runtimeValidation?.toolResults) ? runtimeValidation.toolResults : [];
  const runtimeErrors = Array.isArray(runtimeValidation?.errors) ? runtimeValidation.errors : [];
  const runtimeSkipLabels = {
    login_status_utility_not_runtime_tested: '登录状态工具无需运行验证',
    tool_is_not_high_confidence_read_only: '写操作或非高置信只读工具，为避免副作用已跳过',
    missing_safe_test_arguments: '缺少可从捕获请求安全复用的必填参数',
    captured_parameter_type_mismatch: '工具参数类型与捕获请求不一致',
    missing_captured_response_sample: '缺少可用于结果对比的原始响应样本',
  };
  const isRunning = ACTIVE_GENERATION_STATUSES.has(status);
  const canPublish = status === 'awaiting_approval';
  const isCompleted = status === 'completed';
  const isFailure = ['failed', 'cancelled', 'budget_exceeded', 'needs_user_input'].includes(status);
  const color = isCompleted || canPublish ? '#a6e3a1' : isFailure ? '#f38ba8' : '#89b4fa';
  const planItems = planTools.map((tool) => `
    <div>• ${escHtml(String(tool.name || ''))} · ${escHtml(String(tool.risk || ''))} · ${escHtml(String(tool.purpose || ''))}</div>
  `).join('');
  const toolItems = generatedTools.map((toolName) => `<div>• ${escHtml(String(toolName))}</div>`).join('');
  const errorItems = validationErrors.map((error) => `<div style="color:#f38ba8">• ${escHtml(String(error.code || 'VALIDATION_ERROR'))}: ${escHtml(String(error.message || ''))}</div>`).join('');
  const warningItems = validationWarnings.map((warning) => `<div style="color:#fab387">• ${escHtml(String(warning.code || 'WARNING'))}: ${escHtml(String(warning.message || ''))}</div>`).join('');
  const runtimeItems = runtimeToolResults.map((item) => {
    const icon = item.passed === false ? '✗' : !item.attempted ? '○' : '✓';
    const itemColor = item.passed === false ? '#f38ba8' : !item.attempted ? '#fab387' : '#a6e3a1';
    const detail = item.passed === false
      ? (item.errors || []).map((error) => error.message || error.code).join('; ')
      : !item.attempted
        ? runtimeSkipLabels[item.skipReason] || item.skipReason || '未执行'
        : item.passed
        ? `真实调用通过 · ${Number(item.durationMs || 0)}ms`
        : (item.errors || []).map((error) => error.message || error.code).join('; ');
    return `<div style="color:${itemColor}">${icon} ${escHtml(String(item.toolName || ''))} · ${escHtml(String(detail || ''))}</div>`;
  }).join('');
  const renderedToolErrors = new Set(runtimeToolResults.flatMap((item) =>
    (item.errors || []).map((error) => `${item.toolName || ''}\u0000${error.code || ''}\u0000${error.message || ''}`)));
  const runtimeErrorItems = runtimeErrors.filter((error) => !renderedToolErrors.has(
    `${error.toolName || ''}\u0000${error.code || ''}\u0000${error.message || ''}`,
  )).map((error) => `
    <div style="color:#f38ba8">• ${escHtml(String(error.code || 'RUNTIME_VALIDATION_ERROR'))}${error.toolName ? ` · ${escHtml(String(error.toolName))}` : ''}: ${escHtml(String(error.message || ''))}</div>
  `).join('');
  const lastError = run.lastError?.message
    ? `<div style="color:#f38ba8;margin-top:8px">${escHtml(String(run.lastError.message))}</div>`
    : '';
  const refreshSummary = isCompleted && Number.isFinite(Number(extra.refreshedTabs))
    ? `<div style="margin-top:8px">页面刷新：${Number(extra.refreshedTabs)} 个 Tab，注册工具 ${Number(extra.refreshedToolCount || 0)} 个</div>`
    : '';
  const smartButton = document.getElementById('btnExploreGenerate');
  const quickButton = document.getElementById('btnExploreQuickGenerate');
  if (smartButton) smartButton.disabled = isRunning;
  if (quickButton) quickButton.disabled = isRunning;

  resultEl.innerHTML = `
    <div style="color:${color};font-weight:600;margin-bottom:8px">${escHtml(statusLabel)}</div>
    ${provenance ? `<div style="color:#cba6f7;margin-bottom:8px">Harness: ${escHtml(String(provenance.version || 'unknown'))} · run ${escHtml(String(provenance.run_id || run.id || ''))}</div>` : ''}
    <div style="color:#a6adc8;margin-bottom:8px">动作步数 ${Number(run.stepCount || 0)} · 模型调用 ${Number(run.modelCallCount || 0)} · 修正 ${Number(run.revisionCount || 0)}</div>
    ${planItems ? `<div style="margin-bottom:8px"><div style="color:#6c7086">生成计划</div>${planItems}</div>` : ''}
    ${toolItems ? `<div style="margin-bottom:8px"><div style="color:#6c7086">草稿工具</div>${toolItems}</div>` : ''}
    ${validation ? `<div style="margin-bottom:8px"><div style="color:#6c7086">静态验证：${validation.passed ? '通过' : '未通过'}，检查文件 ${Number(validation.checkedFiles || 0)} 个</div>${errorItems}${warningItems}</div>` : ''}
    ${runtimeValidation ? `<div style="margin-bottom:8px"><div style="color:#6c7086">运行验证：${runtimeValidation.passed ? '通过' : '未通过'} · 调用 ${Number(runtimeValidation.executionSummary?.attempted || 0)} · 跳过 ${Number(runtimeValidation.executionSummary?.skipped || 0)}</div>${runtimeItems}${runtimeErrorItems}</div>` : ''}
    ${activeInstallationReview ? `<div style="margin-bottom:8px"><div>本机安装评审</div><div>版本：${escHtml(activeInstallationReview.currentVersion || '未安装')} → ${escHtml(activeInstallationReview.version)}</div><div>来源：${escHtml(activeInstallationReview.currentSource || '无')} → 本机生成</div><div>申请权限：${escHtml(activeInstallationReview.permissions.join('、') || '无')}</div><div>新增权限：${escHtml(activeInstallationReview.addedPermissions.join('、') || '无')}</div>${activeInstallationReview.sourceChange ? '<div>将切换更新来源。</div>' : ''}${activeInstallationReview.downgrade ? '<div>将降级当前版本。</div>' : ''}</div>` : ''}
    ${lastError}
    ${run.artifacts?.pendingQuestion?.question ? `<div>${escHtml(run.artifacts.pendingQuestion.question)}</div>` : ''}
    ${status === 'needs_user_input' ? '<input id="generationResumeAnswer" aria-label="补充信息" placeholder="请填写补充信息或确认已登录" />' : ''}
    ${refreshSummary}
    <div class="explore-actions" style="margin-top:10px">
      ${canPublish ? '<button class="btn-sm primary" type="button" data-generate-action="publish-run">安装并启用</button>' : ''}
      ${status === 'needs_user_input' ? '<button class="btn-sm primary" type="button" data-generate-action="resume-run">继续验证</button>' : ''}
      ${isRunning ? '<button class="btn-sm secondary" type="button" data-generate-action="cancel-run">取消任务</button>' : ''}
      ${isFailure ? '<button class="btn-sm secondary" type="button" data-generate-action="retry-smart">重新智能生成</button>' : ''}
      ${canPublish || isFailure ? '<button class="btn-sm secondary" type="button" data-generate-action="quick-generate">改用快速生成</button>' : ''}
    </div>
    <pre style="margin-top:8px">runId: ${escHtml(String(run.id || ''))}\ndraft: ${escHtml(String(run.artifacts?.draft?.adapterDir || ''))}</pre>
  `;
  resultEl.hidden = false;
}

async function pollGenerationRun(runId) {
  clearGenerationPolling();
  if (!runId) return;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'popup_explore_get_generation',
      runId,
    });
    if (!response?.ok || !response.run) {
      throw new Error(response?.error || '无法读取智能生成状态');
    }
    renderGenerationRun(response.run);
    if (ACTIVE_GENERATION_STATUSES.has(response.run.status)) {
      generationPollTimer = setTimeout(() => pollGenerationRun(runId), 1000);
    } else if (response.run.status !== 'awaiting_approval' && response.run.status !== 'needs_user_input') {
      await removeGenerationRunId(currentSiteKey, runId);
    }
  } catch (error) {
    const resultEl = document.getElementById('exploreGenerateResult');
    resultEl.innerHTML = `<div style="color:#f38ba8">${escHtml(String(error.message || error))}</div>`;
    resultEl.hidden = false;
    const connected = await refreshBridgeStatus();
    if (!connected && activeGenerationRunId === runId) {
      generationPollTimer = setTimeout(() => pollGenerationRun(runId), 3000);
    }
  }
}

async function triggerGenerate({ quick = false } = {}) {
  const btn = document.getElementById(quick ? 'btnExploreQuickGenerate' : 'btnExploreGenerate');
  const resultEl = document.getElementById('exploreGenerateResult');
  if (!(await ensureBridgeConnected('Bridge 未连接，无法启动智能生成'))) {
    resultEl.innerHTML = '<div style="color:#f38ba8">Bridge 未连接，无法启动智能生成。请先启动或重启 webcli bridge。</div>';
    resultEl.hidden = false;
    return;
  }
  btn.disabled = true;
  btn.textContent = '正在启动…';
  let started = false;
  try {
    const saveResult = await ensureMemoryBeforeGenerate();
    if (!saveResult.ok) throw new Error(`生成前保存探索结果失败：${saveResult.error || '未知错误'}`);
    const response = await chrome.runtime.sendMessage({
      type: 'popup_explore_start_generation',
      mode: quick ? 'quick' : 'agent',
      siteKey: currentSiteKey,
      tabId: currentTabId,
    });
    if (!response?.ok || !response.run) throw new Error(response?.error || '智能生成任务启动失败');
    activeGenerationRunId = response.run.id;
    await persistGenerationRunId(currentSiteKey, response.run.id);
    started = true;
    renderGenerationRun(response.run);
    await pollGenerationRun(response.run.id);
  } catch (error) {
    resultEl.innerHTML = `<div style="color:#f38ba8">${escHtml(String(error.message || error))}</div>`;
    resultEl.hidden = false;
  } finally {
    if (!started) btn.disabled = false;
    btn.textContent = quick ? '快速生成' : '智能生成';
  }
}

async function resumeGenerationRun() {
  const answer = document.getElementById('generationResumeAnswer')?.value?.trim();
  if (!activeGenerationRunId || !answer) throw new Error('请填写补充信息后继续。');
  const response = await chrome.runtime.sendMessage({ type: 'popup_explore_resume_generation', runId: activeGenerationRunId, answer });
  if (!response?.ok || !response.run) throw new Error(response?.error || '继续验证失败');
  renderGenerationRun(response.run);
  await pollGenerationRun(response.run.id);
}

async function cancelGenerationRun() {
  if (!activeGenerationRunId) return;
  clearGenerationPolling();
  const response = await chrome.runtime.sendMessage({
    type: 'popup_explore_cancel_generation',
    runId: activeGenerationRunId,
  });
  if (!response?.ok || !response.run) throw new Error(response?.error || '取消任务失败');
  renderGenerationRun(response.run);
  await removeGenerationRunId(currentSiteKey, activeGenerationRunId);
}

async function publishGenerationRun() {
  if (!activeGenerationRunId) return;
  const review = activeInstallationReview;
  if (!confirm('确认上述版本、来源和权限变化，并安装到本机用户目录？')) return;
  clearGenerationPolling();
  const response = await chrome.runtime.sendMessage({
    type: 'popup_explore_publish_generation',
    runId: activeGenerationRunId,
    approval: { reviewId: review?.reviewId, acceptChanges: true },
    siteKey: currentSiteKey,
  });
  if (!response?.ok || !response.run) throw new Error(response?.error || '安装失败');
  renderGenerationRun(response.run, response);
  if (response.run.status === 'completed') {
    await removeGenerationRunId(currentSiteKey, activeGenerationRunId);
    await refreshCurrentTabState();
    setDevWorkflowStep('generate');
  }
}

function clearActionCapturePolling() {
  if (actionCapturePollTimer) {
    clearTimeout(actionCapturePollTimer);
    actionCapturePollTimer = null;
  }
}

function resetActionCaptureForm() {
  document.getElementById('actionCaptureName').value = '';
  document.getElementById('actionCaptureMode').value = 'intercept';
  document.getElementById('actionCaptureTimeout').value = '60';
  document.getElementById('actionCapturePattern').value = '';
}

function setActionCaptureControls(state) {
  const startBtn = document.getElementById('btnActionCaptureStart');
  const stopBtn = document.getElementById('btnActionCaptureStop');
  const resetBtn = document.getElementById('btnActionCaptureReset');
  const skipBtn = document.getElementById('btnSkipCapture');
  const generateBtn = document.getElementById('btnExploreGenerate');
  const quickGenerateBtn = document.getElementById('btnExploreQuickGenerate');
  const type = state?.type || '';
  const isLoading = type === 'action_capture_loading';
  const isStopping = type === 'action_capture_stopping';
  const isAiLoading = type === 'action_capture_ai_loading';
  const isBusy = isLoading || isStopping || isAiLoading;

  startBtn.disabled = isBusy;
  startBtn.textContent = isBusy ? '处理中…' : '开始录制操作';

  stopBtn.hidden = !(isLoading || isStopping);
  stopBtn.disabled = isStopping;
  stopBtn.textContent = isStopping ? '正在结束…' : '结束捕获';

  resetBtn.disabled = isBusy;
  skipBtn.disabled = isBusy;
  if (generateBtn) generateBtn.disabled = isBusy;
  if (quickGenerateBtn) quickGenerateBtn.disabled = isBusy;
}

function formatActionCaptureSeconds(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds || 0)));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function getActionCaptureTiming(state) {
  const timeoutSeconds = Math.max(0, Number(state?.timeoutSeconds || 0));
  const startedAtMs = Number(state?.startedAtMs || state?.timestamp || 0);
  const stopRequestedAtMs = state?.stopRequestedAt ? Date.parse(state.stopRequestedAt) : 0;
  const now = Date.now();

  const elapsedSeconds = startedAtMs > 0
    ? Math.max(0, Math.floor((now - startedAtMs) / 1000))
    : 0;
  const remainingSeconds = timeoutSeconds > 0
    ? Math.max(0, timeoutSeconds - elapsedSeconds)
    : 0;
  const stoppingSeconds = stopRequestedAtMs > 0
    ? Math.max(0, Math.floor((now - stopRequestedAtMs) / 1000))
    : 0;

  return {
    elapsedSeconds,
    remainingSeconds,
    stoppingSeconds,
    elapsedLabel: formatActionCaptureSeconds(elapsedSeconds),
    remainingLabel: formatActionCaptureSeconds(remainingSeconds),
    stoppingLabel: formatActionCaptureSeconds(stoppingSeconds),
  };
}

function resetActionCaptureUi() {
  clearActionCapturePolling();
  lastActionCaptureState = null;
  actionCaptureRenderToken += 1;
  const statusEl = document.getElementById('actionCaptureStatus');
  statusEl.hidden = true;
  statusEl.className = 'action-capture-status';
  statusEl.innerHTML = '';
  setActionCaptureControls(null);
}

function renderActionCaptureState(state) {
  lastActionCaptureState = state;
  const renderToken = ++actionCaptureRenderToken;
  const statusEl = document.getElementById('actionCaptureStatus');
  if (!state) {
    resetActionCaptureUi();
    return;
  }

  statusEl.hidden = false;
  setActionCaptureControls(state);
  if (state.type === 'action_capture_loading') {
    const timing = getActionCaptureTiming(state);
    statusEl.className = 'action-capture-status loading';
    const lines = [
      `正在捕获动作: ${state.actionName || 'unknown_action'}`,
      `超时: ${state.timeoutSeconds || 60}s`,
      `已运行: ${timing.elapsedLabel}`,
      `剩余: ${timing.remainingLabel}`,
      state.pattern ? `匹配: ${state.pattern}` : '',
      '',
      '现在回到页面完成一次真实操作，结束后会分析并保存为工具生成依据。',
    ].filter(Boolean);
    statusEl.innerHTML = `<pre>${escHtml(lines.join('\n'))}</pre>`;
    scheduleActionCapturePoll();
    return;
  }

  if (state.type === 'action_capture_stopping') {
    const timing = getActionCaptureTiming(state);
    statusEl.className = 'action-capture-status loading';
    const lines = [
      `正在结束捕获: ${state.actionName || 'unknown_action'}`,
      `已运行: ${timing.elapsedLabel}`,
      state.stopRequestedAt ? `结束请求时间: ${state.stopRequestedAt}` : '',
      `结束后等待: ${timing.stoppingLabel}`,
      '',
      '正在等待最后一批网络事件收敛并汇总结果…',
    ].filter(Boolean);
    statusEl.innerHTML = `<pre>${escHtml(lines.join('\n'))}</pre>`;
    scheduleActionCapturePoll();
    return;
  }

  if (state.type === 'action_capture_ai_loading') {
    statusEl.className = 'action-capture-status loading';
    const lines = [
      `操作录制完成: ${state.actionName || 'unknown_action'}`,
      `候选请求: ${Array.isArray(state.result?.capturedActions) ? state.result.capturedActions.length : 0}`,
      '',
      '正在调用 AI 分析本次动作候选，请稍候…',
    ].filter(Boolean);
    statusEl.innerHTML = `<pre>${escHtml(lines.join('\n'))}</pre>`;
    scheduleActionCapturePoll();
    return;
  }

  clearActionCapturePolling();

  if (state.type === 'action_capture_error') {
    statusEl.className = 'action-capture-status error';
    statusEl.innerHTML = `<div>操作录制失败</div><pre>${escHtml(state.error || '未知错误')}</pre>`;
    return;
  }

  if (state.type === 'action_capture' && state.result) {
    // Keep the user on step 2 so the capture review remains visible. The
    // explicit "去生成工具" action advances to step 3 after they review it.
    setDevWorkflowStep('capture');
    if (state.result.siteMemoryUpdate?.ok) {
      document.getElementById('btnExploreGenerate').hidden = false;
    }
    statusEl.className = `action-capture-status ${state.result.siteMemoryUpdate?.ok ? 'success' : 'error'}`;
    statusEl.innerHTML = `<div class="capture-review-summary">${escHtml(
      state.result.siteMemoryUpdate?.ok
        ? '操作录制完成，正在整理结果…'
        : '操作录制完成，但结果保存失败。'
    )}</div>`;
    void renderActionCaptureResultDetail(state, statusEl, renderToken);
  }
}

async function clearActionCaptureState() {
  resetActionCaptureUi();
  resetActionCaptureForm();
  try {
    await chrome.runtime.sendMessage({
      type: 'sidepanel_action_capture_clear_state',
      siteKey: currentSiteKey,
    });
  } catch { }
}

async function prepareNextActionCapture() {
  await clearActionCaptureState();
  setDevWorkflowStep('capture');
  showToast('已准备录制下一个操作', 1500);
}

async function stopActionCapture() {
  const activeState = lastActionCaptureState;
  if (!activeState || (activeState.type !== 'action_capture_loading' && activeState.type !== 'action_capture_stopping')) {
    return;
  }

  const tabId = Number(activeState.tabId || currentTabId);
  const siteKey = activeState.siteKey || currentSiteKey;
  const actionName = activeState.actionName || '';
  if (!Number.isFinite(tabId) || !siteKey) {
    renderActionCaptureState({ type: 'action_capture_error', siteKey, actionName, error: '无法定位当前捕获会话' });
    return;
  }

  renderActionCaptureState({
    ...activeState,
    type: 'action_capture_stopping',
    tabId,
    siteKey,
    actionName,
    stopRequestedAt: activeState.stopRequestedAt || new Date().toISOString(),
    startedAtMs: activeState.startedAtMs || activeState.timestamp || Date.now(),
  });

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'sidepanel_action_capture_stop',
      tabId,
      siteKey,
      actionName,
    });
    if (response?.error) {
      renderActionCaptureState({ type: 'action_capture_error', siteKey, actionName, error: response.error });
      return;
    }

    renderActionCaptureState({
      ...activeState,
      type: 'action_capture_stopping',
      tabId,
      siteKey,
      actionName,
      stopRequestedAt: response?.stopRequestedAt || activeState.stopRequestedAt || new Date().toISOString(),
      startedAtMs: activeState.startedAtMs || activeState.timestamp || Date.now(),
    });
  } catch (err) {
    renderActionCaptureState({ type: 'action_capture_error', siteKey, actionName, error: err.message });
  }
}

async function renderActionCaptureResultDetail(state, statusEl, renderToken) {
  const siteMemory = await loadSiteMemoryRecord(state.siteKey || currentSiteKey);
  if (renderToken !== actionCaptureRenderToken) return;

  const result = state.result || {};
  const capturedActions = Array.isArray(result.capturedActions) ? result.capturedActions : [];
  const derivedCandidates = Array.isArray(siteMemory?.actionApiCandidates) ? siteMemory.actionApiCandidates : [];
  const evidenceSummary = siteMemory?.actionEvidenceSummary || {};
  const evidenceSummaries = Array.isArray(evidenceSummary.toolSummaries) ? evidenceSummary.toolSummaries : [];
  const errors = Array.isArray(result.errors) ? result.errors.filter(Boolean) : [];
  const intro = result.siteMemoryUpdate?.ok
    ? '操作录制完成，结果已保存，可继续生成网站工具。'
    : '操作录制完成，但结果保存失败。';
  const persistenceText = result.siteMemoryUpdate?.ok ? 'ok' : (result.siteMemoryUpdate?.error || 'failed');
  const actionAnalysis = result.actionAnalysis || {};
  const analysisSource = actionAnalysis.analysisSource === 'ai'
    ? `AI分析 · ${actionAnalysis.provider || ''}${actionAnalysis.model ? ` / ${actionAnalysis.model}` : ''}`.trim()
    : '规则兜底';
  const confidenceText = typeof actionAnalysis.confidence === 'number'
    ? `${Math.round(actionAnalysis.confidence * 100)}%`
    : '—';

  statusEl.innerHTML = `
    <div class="capture-review">
      <div class="capture-review-summary">${escHtml(intro)}</div>
      <div class="explore-actions">
        <button class="btn-sm secondary" type="button" data-capture-action="next-capture">继续录制下一个操作</button>
        <button class="btn-sm primary" type="button" data-capture-action="go-generate">去生成工具</button>
      </div>
      <div class="capture-review-grid">
        ${renderCaptureMetric('动作名', state.actionName || result.actionName || 'unknown_action')}
        ${renderCaptureMetric('候选请求', String(capturedActions.length))}
        ${renderCaptureMetric('派生候选', String(derivedCandidates.length))}
        ${renderCaptureMetric('证据历史', String(Number(evidenceSummary.historyCount || 0)))}
        ${renderCaptureMetric('推荐工具', result.recommendation?.toolName || '—')}
        ${renderCaptureMetric('保存结果', persistenceText)}
      </div>
      <div class="capture-review-section">
        <div class="capture-review-title">分析结论</div>
        <div class="capture-review-list">
          <div class="capture-review-card">
            <div class="capture-review-kv">
              <div class="capture-review-k">来源</div>
              <div class="capture-review-v">${escHtml(analysisSource)}</div>
              <div class="capture-review-k">置信度</div>
              <div class="capture-review-v">${escHtml(confidenceText)}</div>
              <div class="capture-review-k">动作类型</div>
              <div class="capture-review-v">${escHtml(actionAnalysis.actionKind || '—')}</div>
            </div>
            ${actionAnalysis.summary ? `<div class="capture-review-summary" style="margin-top:8px">${escHtml(actionAnalysis.summary)}</div>` : ''}
            ${actionAnalysis.aiError ? renderPreviewBlock('aiError', actionAnalysis.aiError) : ''}
          </div>
        </div>
      </div>
      <div class="capture-review-section">
        <div class="capture-review-title">下一步建议</div>
        <div class="capture-review-list">
          <div class="capture-review-card">
            <div class="capture-review-kv">
              <div class="capture-review-k">建议</div>
              <div class="capture-review-v">${escHtml(result.recommendation?.nextStep || '—')}</div>
              <div class="capture-review-k">流程</div>
              <div class="capture-review-v">${escHtml(result.workflow?.version || '—')}</div>
              <div class="capture-review-k">保存</div>
              <div class="capture-review-v">${escHtml(persistenceText)}</div>
            </div>
            ${errors.length > 0 ? renderPreviewBlock('errors', errors.join('\n')) : ''}
          </div>
        </div>
      </div>
      <div class="capture-review-section">
        <div class="capture-review-title">本次录制发现的请求</div>
        <div class="capture-review-list">
          ${capturedActions.length > 0
            ? capturedActions.map((candidate, index) => renderCapturedActionCard(candidate, index, result.siteMemoryUpdate)).join('')
            : '<div class="capture-review-summary">没有捕获到可用请求。</div>'}
        </div>
      </div>
      <div class="capture-review-section">
        <div class="capture-review-title">已沉淀的工具候选</div>
        <div class="capture-review-list">
          ${derivedCandidates.length > 0
            ? derivedCandidates.map((candidate) => renderDerivedActionCandidateCard(candidate, evidenceSummaries)).join('')
            : '<div class="capture-review-summary">当前还没有可用于生成的工具候选。</div>'}
        </div>
      </div>
    </div>
  `;
}

async function loadSiteMemoryRecord(siteKey) {
  if (!siteKey) return null;
  try {
    const stored = await chrome.storage.local.get('siteMemories');
    const memories = stored.siteMemories || {};
    return memories[siteKey] || null;
  } catch {
    return null;
  }
}

async function syncGenerateButtonFromSiteMemory(siteKey = currentSiteKey) {
  const button = document.getElementById('btnExploreGenerate');
  if (!button || !siteKey) return false;
  const memory = await loadSiteMemoryRecord(siteKey);
  const hasMemory = Boolean(memory && (memory.captureCount || memory.updatedAt || memory.firstCapturedAt));
  if (hasMemory) {
    button.hidden = false;
  }
  return hasMemory;
}

function renderCaptureMetric(label, value) {
  return `
    <div class="capture-review-metric">
      <div class="capture-review-metric-label">${escHtml(label)}</div>
      <div class="capture-review-metric-value">${escHtml(String(value || '—'))}</div>
    </div>
  `;
}

function renderCapturedActionCard(candidate, index, siteMemoryUpdate = {}) {
  const isUserPrimary = Boolean(candidate?.userSelectedPrimary);
  const isCurrentPrimary = isUserPrimary || Boolean(
    siteMemoryUpdate?.selectedUrl === candidate?.url
    && String(siteMemoryUpdate?.selectedMethod || '').toUpperCase() === String(candidate?.method || 'GET').toUpperCase()
  );
  const headerChips = [
    `<span class="capture-review-chip">${escHtml(String(index + 1))}</span>`,
    `<span class="capture-review-chip">${escHtml(String(candidate?.method || 'GET').toUpperCase())}</span>`,
    candidate?.intercepted ? '<span class="capture-review-chip ok">已记录</span>' : '',
    candidate?.blockedReason ? `<span class="capture-review-chip warn">${escHtml(candidate.blockedReason)}</span>` : '',
    candidate?.aiIsPrimary ? '<span class="capture-review-chip ok">主候选</span>' : '',
    isCurrentPrimary ? `<span class="capture-review-chip ok">${isUserPrimary ? '用户确认主接口' : '当前主接口'}</span>` : '',
    candidate?.aiRisk ? `<span class="capture-review-chip ${candidate.aiRisk === 'high' ? 'error' : 'warn'}">${escHtml(candidate.aiRisk)}</span>` : '',
  ].filter(Boolean).join('');

  return `
    <div class="capture-review-card${isCurrentPrimary ? ' is-primary' : ''}">
      <div class="capture-review-card-header">
        ${headerChips}
      </div>
      <div class="capture-review-card-title">${escHtml(candidate?.url || 'unknown url')}</div>
      <div class="explore-actions" style="margin-top:8px">
        <button class="btn-sm ${isCurrentPrimary ? 'secondary' : 'primary'}" type="button" data-capture-action="select-primary" data-candidate-index="${index}" ${isCurrentPrimary ? 'disabled' : ''}>${isCurrentPrimary ? '当前主接口' : '设为主接口'}</button>
      </div>
      ${candidate?.aiPurpose ? `<div class="capture-review-summary" style="margin-top:6px">${escHtml(candidate.aiPurpose)}</div>` : ''}
      <div class="capture-review-kv">
        <div class="capture-review-k">类型</div>
        <div class="capture-review-v">${escHtml(candidate?.responseContentType || '—')}</div>
        <div class="capture-review-k">原因</div>
        <div class="capture-review-v">${escHtml(candidate?.aiWhy || '—')}</div>
        <div class="capture-review-k">工具名</div>
        <div class="capture-review-v">${escHtml(candidate?.aiToolNameSuggestion || '—')}</div>
        <div class="capture-review-k">参数</div>
        <div class="capture-review-v">${escHtml(Array.isArray(candidate?.aiParameterHints) && candidate.aiParameterHints.length > 0 ? candidate.aiParameterHints.join(', ') : '—')}</div>
      </div>
      ${renderPreviewBlock('requestBodyPreview', candidate?.requestBodyPreview)}
      ${renderPreviewBlock('responsePreview', candidate?.responsePreview)}
    </div>
  `;
}

function renderDerivedActionCandidateCard(candidate, evidenceSummaries) {
  const evidence = evidenceSummaries.find((item) => item.toolName === candidate?.toolName);
  const hints = candidate?.responseHints || {};
  const chips = [
    `<span class="capture-review-chip">${escHtml(String(candidate?.method || 'GET').toUpperCase())}</span>`,
    candidate?.intercepted ? '<span class="capture-review-chip ok">已记录</span>' : '',
    hints?.listPath ? `<span class="capture-review-chip ok">${escHtml(hints.listPath)}</span>` : '',
    evidence?.historyCount ? `<span class="capture-review-chip warn">history:${escHtml(String(evidence.historyCount))}</span>` : '',
    candidate?.primarySelection === 'user' ? '<span class="capture-review-chip ok">用户确认</span>' : '',
    candidate?.primarySelection === 'ai' ? '<span class="capture-review-chip ok">AI主候选</span>' : '',
  ].filter(Boolean).join('');
  const hintSummary = [
    hints?.preferredIdKey ? `preferredId=${hints.preferredIdKey}` : '',
    hints?.preferredDisplayKey ? `preferredDisplay=${hints.preferredDisplayKey}` : '',
    hints?.preferredAvailabilityKey ? `preferredAvailability=${hints.preferredAvailabilityKey}` : '',
  ].filter(Boolean).join(' · ');

  return `
    <div class="capture-review-card">
      <div class="capture-review-card-header">
        ${chips}
      </div>
      <div class="capture-review-card-title">${escHtml(candidate?.toolName || 'unknown_tool')}</div>
      <div class="capture-review-kv">
        <div class="capture-review-k">动作</div>
        <div class="capture-review-v">${escHtml(candidate?.actionName || '—')}</div>
        <div class="capture-review-k">接口</div>
        <div class="capture-review-v">${escHtml(candidate?.url || '—')}</div>
        <div class="capture-review-k">评分</div>
        <div class="capture-review-v">${escHtml(String(evidence?.selectedScore ?? '—'))}</div>
        <div class="capture-review-k">信号</div>
        <div class="capture-review-v">${escHtml(Array.isArray(evidence?.selectedSignals) && evidence.selectedSignals.length > 0 ? evidence.selectedSignals.join(', ') : '—')}</div>
        <div class="capture-review-k">字段</div>
        <div class="capture-review-v">${escHtml(hintSummary || '—')}</div>
      </div>
      ${renderPreviewBlock('requestBodyPreview', candidate?.requestBodyPreview)}
      ${renderPreviewBlock('responsePreview', candidate?.responsePreview)}
    </div>
  `;
}

function renderPreviewBlock(label, value) {
  if (!value) return '';
  return `
    <div class="capture-review-preview">
      <div class="capture-review-preview-label">${escHtml(label)}</div>
      <pre>${escHtml(String(value).slice(0, 1200))}</pre>
    </div>
  `;
}

async function selectPrimaryActionCandidate(candidateIndex) {
  if (!lastActionCaptureState?.result || !currentSiteKey) return;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'sidepanel_action_capture_select_candidate',
      siteKey: currentSiteKey,
      candidateIndex,
    });
    if (!response?.ok || !response.state) {
      throw new Error(response?.error || '设置主接口失败');
    }
    renderActionCaptureState(response.state);
    showToast('已更新主接口，生成工具时将优先使用该请求', 2500);
  } catch (err) {
    showToast(err.message || '设置主接口失败', 3000);
  }
}

function scheduleActionCapturePoll() {
  clearActionCapturePolling();
  actionCapturePollTimer = setTimeout(async () => {
    try {
      const state = await chrome.runtime.sendMessage({ type: 'sidepanel_action_capture_get_state', siteKey: currentSiteKey });
      if (!state) return;
      if (state.type === 'action_capture_loading' || state.type === 'action_capture_stopping' || state.type === 'action_capture_ai_loading') {
        renderActionCaptureState(state);
      } else if (state.type === 'action_capture' || state.type === 'action_capture_error') {
        renderActionCaptureState(state);
      }
    } catch {
      scheduleActionCapturePoll();
    }
  }, 1000);
}

async function triggerActionCapture() {
  if (!currentTabId || !currentSiteKey) {
    renderActionCaptureState({ type: 'action_capture_error', error: '无法获取当前站点信息' });
    return;
  }

  const actionName = document.getElementById('actionCaptureName').value.trim();
  const mode = document.getElementById('actionCaptureMode').value || 'intercept';
  const timeoutSeconds = Number(document.getElementById('actionCaptureTimeout').value || 60);
  const pattern = document.getElementById('actionCapturePattern').value.trim();

  if (!actionName) {
    renderActionCaptureState({ type: 'action_capture_error', error: '请先填写动作名' });
    return;
  }

  renderActionCaptureState({
    type: 'action_capture_loading',
    tabId: currentTabId,
    siteKey: currentSiteKey,
    actionName,
    mode,
    timeoutSeconds,
    pattern,
    startedAtMs: Date.now(),
    timestamp: Date.now(),
  });

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'sidepanel_action_capture_start',
      tabId: currentTabId,
      siteKey: currentSiteKey,
      actionName,
      mode,
      timeoutSeconds,
      pattern,
    });

    if (response?.error) {
      renderActionCaptureState({ type: 'action_capture_error', siteKey: currentSiteKey, actionName, error: response.error });
    } else if (!response?.ok) {
      renderActionCaptureState({ type: 'action_capture_error', siteKey: currentSiteKey, actionName, error: '启动动作捕获失败' });
    }
  } catch (err) {
    renderActionCaptureState({ type: 'action_capture_error', siteKey: currentSiteKey, actionName, error: err.message });
  }
}

async function restoreActionCaptureState() {
  const workflowStepBeforeRestore = devWorkflowStep;
  try {
    const saved = await chrome.runtime.sendMessage({ type: 'sidepanel_action_capture_get_state', siteKey: currentSiteKey });
    if (!saved || !saved.timestamp || Date.now() - saved.timestamp > 900000) return;
    if (saved.siteKey && currentSiteKey && saved.siteKey !== currentSiteKey) return;
    if (!['action_capture_loading', 'action_capture_stopping', 'action_capture_ai_loading'].includes(saved.type)) return;
    renderActionCaptureState(saved);
    // Restoring cached content during tab refresh must not navigate away from
    // the step the user is currently reviewing. Live polling still calls
    // renderActionCaptureState directly and moves to step 2 on completion.
    setDevWorkflowStep(workflowStepBeforeRestore);
  } catch {}
}

// ── Config Tab ───────────────────────────────────────────────────────────────

function inferConfigProvider(config = {}) {
  const provider = String(config.provider || '').trim();
  if (provider && AI_PROVIDER_PRESETS[provider]) return provider;

  const baseUrl = String(config.base_url || '').toLowerCase();
  if (baseUrl.includes('anthropic.com')) return 'anthropic';
  if (baseUrl.includes('api.openai.com')) return 'openai';
  if (baseUrl.includes('api.deepseek.com')) return 'deepseek';
  if (baseUrl.includes('bigmodel.cn')) return 'zhipu';
  if (baseUrl.includes('dashscope.aliyuncs.com')) return 'qwen';
  if (baseUrl) return 'custom';
  return 'openai';
}

function normalizeAiConfigForUi(config = {}) {
  const provider = inferConfigProvider(config);
  const preset = AI_PROVIDER_PRESETS[provider] || AI_PROVIDER_PRESETS.anthropic;
  return {
    provider,
    protocol: String(config.protocol || preset.protocol || 'openai'),
    api_key: String(config.api_key || ''),
    base_url: String(config.base_url ?? preset.baseUrl ?? ''),
    model: String(config.model ?? preset.model ?? ''),
  };
}

function setConfigStatus(type, text) {
  const el = document.getElementById('configStatus');
  if (!text) {
    el.hidden = true;
    el.className = 'config-status';
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.className = `config-status ${type}`;
  el.textContent = text;
}

function syncConfigProtocolVisibility() {
  const provider = document.getElementById('configProvider').value;
  document.getElementById('configProtocolGroup').hidden = provider !== 'custom';
}

function applyConfigProviderPreset(provider, options = {}) {
  const preset = AI_PROVIDER_PRESETS[provider] || AI_PROVIDER_PRESETS.anthropic;
  const baseUrlInput = document.getElementById('configBaseUrl');
  const modelInput = document.getElementById('configModel');
  const protocolInput = document.getElementById('configProtocol');

  if (!options.preserveValues) {
    if (provider === 'custom') {
      if (!protocolInput.value) protocolInput.value = preset.protocol;
    } else {
      protocolInput.value = preset.protocol;
      baseUrlInput.value = preset.baseUrl;
      modelInput.value = preset.model;
    }
  }

  if (provider !== 'custom') {
    protocolInput.value = preset.protocol;
  }
  syncConfigProtocolVisibility();
}

function fillAiConfigForm(config = {}, meta = {}) {
  const normalized = normalizeAiConfigForUi(config);
  document.getElementById('configProvider').value = normalized.provider;
  document.getElementById('configProtocol').value = normalized.protocol;
  document.getElementById('configApiKey').value = normalized.api_key;
  document.getElementById('configBaseUrl').value = normalized.base_url;
  document.getElementById('configModel').value = normalized.model;
  applyConfigProviderPreset(normalized.provider, { preserveValues: true });

  const configPath = meta.configPath || AI_CONFIG_PATH_HINT;
  const loadedText = meta.exists ? '已读取本地配置' : '本地还没有配置文件，保存后会自动创建';
  document.getElementById('configMeta').textContent = `配置文件：${configPath} ｜ ${loadedText}`;
}

function collectAiConfigForm() {
  const provider = document.getElementById('configProvider').value || 'anthropic';
  const protocol = provider === 'custom'
    ? (document.getElementById('configProtocol').value || 'openai')
    : (AI_PROVIDER_PRESETS[provider]?.protocol || 'openai');

  return {
    provider,
    protocol,
    api_key: document.getElementById('configApiKey').value.trim(),
    base_url: document.getElementById('configBaseUrl').value.trim(),
    model: document.getElementById('configModel').value.trim(),
  };
}

async function loadAiConfig() {
  setConfigStatus('loading', '正在读取本地配置…');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'popup_ai_config_get' });
    if (!response?.ok) {
      throw new Error(response?.error || '读取配置失败');
    }
    fillAiConfigForm(response.config || {}, { exists: response.exists, configPath: response.configPath });
    setConfigStatus('success', response.exists ? '已读取本地配置' : '本地还没有配置文件，保存后会自动创建');
  } catch (err) {
    document.getElementById('configMeta').textContent = `配置文件：${AI_CONFIG_PATH_HINT}`;
    setConfigStatus('error', err.message);
  }
}

async function saveAiConfig() {
  const config = collectAiConfigForm();
  if (!(await ensureBridgeConnected())) {
    setConfigStatus('error', 'Bridge 未连接，无法保存配置。请先启动或重启 webcli bridge。');
    return;
  }
  if (!config.api_key) {
    setConfigStatus('error', '请先填写 API Key');
    return;
  }
  if (!config.base_url) {
    setConfigStatus('error', '请先填写 Base URL');
    return;
  }
  if (!config.model) {
    setConfigStatus('error', '请先填写 Model');
    return;
  }

  setConfigStatus('loading', '正在保存配置…');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'popup_ai_config_save', config });
    if (!response?.ok) {
      throw new Error(response?.error || '保存配置失败');
    }
    fillAiConfigForm(response.config || config, { exists: true, configPath: response.configPath });
    setConfigStatus('success', '配置已保存');
  } catch (err) {
    setConfigStatus('error', err.message);
  }
}

async function testAiConfig() {
  const config = collectAiConfigForm();
  if (!(await ensureBridgeConnected())) {
    setConfigStatus('error', 'Bridge 未连接，无法测试配置。请先启动或重启 webcli bridge。');
    return;
  }
  if (!config.api_key) {
    setConfigStatus('error', '请先填写 API Key');
    return;
  }
  if (!config.base_url) {
    setConfigStatus('error', '请先填写 Base URL');
    return;
  }
  if (!config.model) {
    setConfigStatus('error', '请先填写 Model');
    return;
  }

  setConfigStatus('loading', '正在测试当前配置…');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'popup_ai_config_test', config });
    if (!response?.ok) {
      throw new Error(response?.error || '测试配置失败');
    }

    const parts = [
      '配置测试成功',
      response.provider ? `provider=${response.provider}` : '',
      response.model ? `model=${response.model}` : '',
      response.latencyMs != null ? `latency=${response.latencyMs}ms` : '',
      response.preview ? `reply=${response.preview}` : '',
    ].filter(Boolean);
    setConfigStatus('success', parts.join(' ｜ '));
  } catch (err) {
    setConfigStatus('error', err.message);
  }
}

// ── Tool Test Modal ──────────────────────────────────────────────────────────

function openToolTestModal(tool) {
  currentTool = tool;
  document.getElementById('modalToolName').textContent = formatToolDisplayName(tool.name);
  const modalToolDesc = document.getElementById('modalToolDesc');
  modalToolDesc.textContent = tool.description || '';
  modalToolDesc.hidden = !(tool.description || '').trim();
  document.getElementById('modalResult').hidden = true;
  const btnExec = document.getElementById('btnModalExecute');
  btnExec.disabled = false; btnExec.textContent = '执行';
  const params = tool.parameters?.properties || {};
  const required = tool.parameters?.required || [];
  const form = document.getElementById('modalForm');
  if (!Object.keys(params).length) {
    form.innerHTML = '<div style="color:#6c7086;font-size:12px">此工具无需参数</div>';
  } else {
    form.innerHTML = Object.entries(params).map(([key, schema]) => buildToolFieldMarkup(key, schema, required.includes(key))).join('');
  }
  document.getElementById('toolModal').hidden = false;
}

function closeToolTestModal() {
  document.getElementById('toolModal').hidden = true;
  document.getElementById('modalForm').innerHTML = '';
  const resultEl = document.getElementById('modalResult');
  resultEl.hidden = true;
  resultEl.textContent = '';
  resultEl.className = '';
  const btnExec = document.getElementById('btnModalExecute');
  btnExec.disabled = false;
  btnExec.textContent = '执行';
  currentTool = null;
}

async function executeCurrentTool() {
  if (!currentTool || !currentTabId) return;
  const form = document.getElementById('modalForm');
  const resultEl = document.getElementById('modalResult');
  const btn = document.getElementById('btnModalExecute');
  try {
    const args = {};
    for (const input of form.querySelectorAll('[data-param]')) {
      const key = input.dataset.param;
      let val = parseToolFieldValue(input);
      if (val !== undefined && val !== '') args[key] = val;
    }
    if (!currentTool.parameters?.['x-webcli-host-confirmation']) {
      if (!confirmToolExecution(currentTool, args)) return;
      if (toolRequiresConfirmation(currentTool)) args.__confirmed = true;
    }
    btn.disabled = true; btn.textContent = '等待宿主处理 / 确认...'; resultEl.hidden = true;
    const r = await chrome.runtime.sendMessage({ type: 'test_call_tool', tabId: currentTabId, toolName: currentTool.name, args });
    resultEl.hidden = false;
    const states = { cancelled: '已取消', not_submitted: '尚未提交', unknown: '结果未知', failed: '执行失败', succeeded: '执行成功' };
    resultEl.className = r.error || r.execution?.state === 'failed' ? 'result-box result-error' : 'result-box result-success';
    resultEl.textContent = `${states[r.execution?.state] || '调用完成'}\n${r.error || JSON.stringify(r.result, null, 2)}`;
  } catch (e) { resultEl.hidden = false; resultEl.className = 'result-box result-error'; resultEl.textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = '执行'; }
}

function isSupportedTab(tab) {
  if (!tab?.id || !tab?.url) return false;
  try {
    const protocol = new URL(tab.url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

async function queryActiveBrowserTab() {
  const queryVariants = [
    { active: true, currentWindow: true },
    { active: true, lastFocusedWindow: true },
    { active: true },
  ];

  for (const queryInfo of queryVariants) {
    try {
      const tabs = await chrome.tabs.query(queryInfo);
      const supported = tabs.filter(isSupportedTab);
      if (supported.length > 0) {
        return supported.sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0];
      }
    } catch { }
  }
  return null;
}

async function refreshCurrentTabState() {
  const sequence = ++refreshSequence;
  const previousTabId = currentTabId;
  const previousSiteKey = currentSiteKey;
  const tab = await queryActiveBrowserTab();

  if (sequence !== refreshSequence) return;

  if (!isSupportedTab(tab)) {
    currentTabId = null;
    currentSiteKey = null;
    currentTools = [];
    if (previousTabId || previousSiteKey) resetExploreStateForSiteChange();
    document.getElementById('useLoading').hidden = true;
    setHeaderBadge('none', '不支持');
    renderUseTab([]);
    await renderDevTab();
    return;
  }

  currentTabId = tab.id;

  try {
    currentSiteKey = new URL(tab.url).hostname;
  } catch {
    currentSiteKey = null;
  }

  let info;
  try {
    info = await chrome.runtime.sendMessage({ type: 'get_tab_info', tabId: tab.id, url: tab.url });
  } catch {
    if (sequence !== refreshSequence) return;
    document.getElementById('useLoading').hidden = true;
    setHeaderBadge('none', '错误');
    return;
  }

  if (sequence !== refreshSequence) return;

  setWsStatus(info.isConnected ?? false, info.bridgeDisconnectReason || '');

  if (info.domain) currentSiteKey = info.domain;

  const siteChanged = currentSiteKey !== previousSiteKey;
  if (siteChanged) {
    setDevViewMode('auto');
    resetExploreStateForSiteChange();
  }

  if (info.state === 'active') {
    currentTools = Array.isArray(info.tools) ? info.tools : [];
    setHeaderBadge('active', `${currentTools.length} 工具`);
    renderUseTab(currentTools);
  } else {
    currentTools = [];
    setHeaderBadge('none', info.state === 'installed' ? '适配器已发现' : '无适配器');
    renderUseTab([], { adapterInstalled: info.state === 'installed', injectionError: info.injectionError || '' });
  }

  await renderDevTab();
  await syncGenerateButtonFromSiteMemory();
  await restoreGenerationRunForSite();
  await restoreActionCaptureState();
  if (siteChanged) await restoreExploreStateForCurrentSite();
}

function bindTabListeners() {
  if (tabListenersBound) return;
  tabListenersBound = true;

  chrome.tabs.onActivated.addListener(() => {
    refreshCurrentTabState().catch(() => {});
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== currentTabId) return;
    if (changeInfo.status === 'complete' || changeInfo.url) {
      refreshCurrentTabState().catch(() => {});
    }
  });

  chrome.windows.onFocusChanged.addListener(() => {
    refreshCurrentTabState().catch(() => {});
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  initTabs();
  initDevMode();
  initDevEditorTabs();
  bindTabListeners();

  document.querySelectorAll('[data-workflow-step]').forEach((stepEl) => {
    stepEl.addEventListener('click', () => setDevWorkflowStep(stepEl.dataset.workflowStep));
  });

  // Events
  document.getElementById('btnModalClose').addEventListener('click', closeToolTestModal);
  document.getElementById('btnModalCancel').addEventListener('click', closeToolTestModal);
  document.getElementById('btnModalExecute').addEventListener('click', executeCurrentTool);
  document.getElementById('btnSave').addEventListener('click', saveCurrentFile);
  document.getElementById('btnExploreFromDev').addEventListener('click', () => {
    setDevAdvancedCodeVisible(false);
    setDevViewMode('auto');
    setDevWorkflowStep('explore');
    applyDevView(Boolean(currentSiteKey));
  });
  document.getElementById('btnDevShowCode').addEventListener('click', () => {
    const nextVisible = !devAdvancedCodeVisible;
    setDevAdvancedCodeVisible(nextVisible);
    setDevViewMode(nextVisible ? 'editor' : 'auto');
    applyDevView(Boolean(currentSiteKey));
    if (nextVisible) renderDevTab().catch(() => {});
  });
  document.getElementById('exploreGenerateResult').addEventListener('click', (event) => {
    const action = event.target?.dataset?.generateAction;
    if (action === 'open-knowledge') {
      openDevEditorAtFile('knowledgeMarkdown').catch((err) => showToast(err.message));
    } else if (action === 'open-skill') {
      openDevEditorAtFile('skill').catch((err) => showToast(err.message));
    } else if (action === 'open-generated-skill') {
      openDevEditorAtFile('generatedSkill').catch((err) => showToast(err.message));
    } else if (action === 'open-code') {
      openDevEditorAtFile('code').catch((err) => showToast(err.message));
    } else if (action === 'publish-run') {
      publishGenerationRun().catch((err) => showToast(err.message));
    } else if (action === 'resume-run') {
      resumeGenerationRun().catch((err) => showToast(err.message));
    } else if (action === 'cancel-run') {
      cancelGenerationRun().catch((err) => showToast(err.message));
    } else if (action === 'retry-smart') {
      triggerGenerate().catch((err) => showToast(err.message));
    } else if (action === 'quick-generate') {
      triggerQuickGenerate().catch((err) => showToast(err.message));
    }
  });
  document.getElementById('actionCaptureStatus').addEventListener('click', (event) => {
    const action = event.target?.dataset?.captureAction;
    if (action === 'next-capture') {
      prepareNextActionCapture().catch((err) => showToast(err.message));
    } else if (action === 'go-generate') {
      setDevWorkflowStep('generate');
    } else if (action === 'select-primary') {
      selectPrimaryActionCandidate(Number(event.target?.dataset?.candidateIndex)).catch((err) => showToast(err.message));
    }
  });
  document.getElementById('btnExplore').addEventListener('click', triggerWorkflow);
  document.getElementById('btnExploreWorkflow').addEventListener('click', triggerWorkflow);
  document.getElementById('btnExploreReset').addEventListener('click', () => { clearExplorePolling(); showExploreState('idle'); });
  document.getElementById('btnExploreWfReset').addEventListener('click', () => { clearExplorePolling(); lastWorkflowResult = null; showExploreState('idle'); });
  document.getElementById('btnExploreRetry').addEventListener('click', triggerWorkflow);
  document.getElementById('btnGoCaptureStep').addEventListener('click', () => setDevWorkflowStep('capture'));
  document.getElementById('btnExploreSave').addEventListener('click', triggerSaveMemory);
  document.getElementById('btnExploreGenerate').addEventListener('click', triggerGenerate);
  document.getElementById('btnExploreQuickGenerate').addEventListener('click', triggerQuickGenerate);
  document.getElementById('btnActionCaptureStart').addEventListener('click', triggerActionCapture);
  document.getElementById('btnActionCaptureStop').addEventListener('click', stopActionCapture);
  document.getElementById('btnSkipCapture').addEventListener('click', () => setDevWorkflowStep('generate'));
  document.getElementById('btnBackToCaptureStep').addEventListener('click', () => setDevWorkflowStep('capture'));
  document.getElementById('btnActionCaptureReset').addEventListener('click', clearActionCaptureState);
  document.getElementById('configProvider').addEventListener('change', (event) => {
    applyConfigProviderPreset(event.target.value);
    setConfigStatus('', '');
  });
  document.getElementById('btnConfigReload').addEventListener('click', loadAiConfig);
  document.getElementById('btnConfigTest').addEventListener('click', testAiConfig);
  document.getElementById('btnConfigSave').addEventListener('click', saveAiConfig);
  document.getElementById('linkGitHub')?.addEventListener('click', () => chrome.tabs.create({ url: GITHUB_REPO }));

  const manifest = chrome.runtime.getManifest();
  const versionEl = document.getElementById('extVersionRight');
  versionEl.textContent = `v${manifest.version}`;
  versionEl.style.color = '#a6adc8';
  versionEl.style.cursor = 'pointer';
  applyConfigProviderPreset(document.getElementById('configProvider').value, { preserveValues: true });
  await loadAiConfig();
  await refreshCurrentTabState();

  await restoreActionCaptureState();
}

init();
