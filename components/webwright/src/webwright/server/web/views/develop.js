// 开发工作区：主体直接展示当前开发代码，不使用「开发中版本／正式版本」槽位术语。
// 「继续开发」不放在顶部动作栏：用户继续开发一定带着具体意见/指令，
// 因此改为代码卡下方的指令输入框 + 提交按钮，指令必填。
// 当前开发代码允许显式进入编辑状态并保存；正式版本保持只读。
// 当前开发依据支持用户明确选择一次 Debug Run 作为补充证据（对齐产品设计第六章）。

import * as api from "../api.js";
import { state, setState } from "../state.js";
import { esc, statusBadge, toneBadge, toast } from "../util.js";
import { isBusy, refreshActivity } from "../components/activity_status.js";
import { collectParams, renderParamForm, eventsFor, renderHistorySelector, renderRunDetail } from "../components/debug_runner.js?v=8";
import { renderRunEvents } from "../components/run_events.js";

let developmentStream = { url: null, close: null };
let codeEditSession = null;

export async function renderDevelop(container) {
  const tool = await api.getTool(state.toolkitId, state.toolId);
  if (!tool) {
    container.innerHTML = `<div class="ws-empty">请选择一个 Tool</div>`;
    return;
  }
  const [slots, debugRuns] = await Promise.all([
    api.getSlots(state.toolkitId, tool.tool_id),
    api.listDebugRuns(state.toolkitId, tool.tool_id),
  ]);
  const dev = slots.development;
  const firstDevelopment = !dev && !slots.formal;
  const restartFromExploration = Boolean(
    state.restartFromExploration && state.sourceExplorationId);
  const initialDevelopment = firstDevelopment || restartFromExploration;
  const publishable = slots.publish_eligible;
  const evidenceId = state.debugRunEvidenceId === null ? dev?.debug_run_evidence_id : state.debugRunEvidenceId;
  const evidenceRun = evidenceId
    ? debugRuns.find((r) => r.debug_run_id === evidenceId) || null
    : null;
  const developing = ["queued", "running"].includes(slots.latest_run?.status);
  const blocked = isBusy() && !developing;
  const editing = Boolean(
    codeEditSession
    && codeEditSession.toolkitId === state.toolkitId
    && codeEditSession.toolId === tool.tool_id);

  container.innerHTML = `
    <div class="ws-toolbar" style="justify-content: flex-start; margin-bottom: 12px;">
      <div class="ws-actions">
        ${developing ? `
          <button class="btn btn-ghost" id="cancelDev">取消开发</button>
        ` : initialDevelopment ? `
        ` : dev ? `
          <button class="btn btn-ghost" id="restartDev" ${blocked || editing ? "disabled" : ""}>重新开始</button>
          <button class="btn btn-primary" id="publish" title="应用到 Adapter，应用后本次修改正式生效" ${publishable && !blocked && !editing ? "" : "disabled"}>应用到 Adapter</button>
        ` : `
          <button class="btn btn-primary" id="startFromFormal" ${blocked ? "disabled" : ""}>基于已应用版本开发</button>
          <button class="btn btn-ghost" id="restartFromExploration" ${blocked ? "disabled" : ""}>从探索重新开发</button>
        `}
      </div>
    </div>

    ${developing ? `<div class="hint-card">Developer Agent 正在运行，完成后将自动刷新当前代码。</div>` : ""}
    ${editing ? `<div class="hint-card">正在编辑当前开发代码。请先保存或取消修改，再执行其他开发操作。</div>` : ""}
    ${dev && !publishable && !developing ? `<div class="hint-card warn-card">
      当前修改尚未应用到 Adapter。请先在右侧运行一次测试。
    </div>` : ""}

    <div class="dev-grid">
      <div class="dev-main-pane">
        ${toolDefinitionCard(tool)}
        ${latestRunCard(slots.latest_run)}
        ${initialDevelopment
          ? initialDevelopmentCard(state.sourceExplorationId, slots.latest_run, restartFromExploration)
          : dev
            ? sourceCard(dev) + codeCard(dev, editing, isBusy()) + (developing ? "" : instructionCard(editing, evidenceRun, debugRuns))
          : developing
            ? runningDevelopmentCard(slots.latest_run)
            : emptyCard(slots, slots.latest_run)}
        ${formalCard(slots.formal)}
      </div>
      <div class="dev-debug-pane" id="inlineDebugContainer">
        <!-- Inline Debugger 会挂载到这里 -->
      </div>
    </div>
  `;

  container.querySelector("#publish")?.addEventListener("click", async () => {
    await api.publishTool(state.toolkitId, tool.tool_id);
    toast("已成功应用到 Adapter");
    setState({});
  });
  container.querySelector("#restartDev")?.addEventListener("click", async () => {
    openRestartDevelopmentModal(tool);
  });
  container.querySelector("#startFromFormal")?.addEventListener("click", async () => {
    await api.startDevelopmentFromFormal(state.toolkitId, tool.tool_id);
    toast("已基于已应用代码创建本轮开发");
    setState({ restartFromExploration: false });
  });
  container.querySelector("#startInitialDevelopment")?.addEventListener("click", async () => {
    if (!state.sourceExplorationId) {
      toast("请先在探索工作区选择一次成功 Exploration");
      return;
    }
    const input = container.querySelector("#initialDevInstruction");
    const initialInstruction = input.value.trim();
    if (!initialInstruction) {
      toast("请先填写首次开发指令");
      input.focus();
      return;
    }
    const run = restartFromExploration
      ? await api.restartDevelopmentFromExploration(
        state.toolkitId, tool.tool_id, state.sourceExplorationId, initialInstruction)
      : await api.startDevelopment(state.toolkitId, tool.tool_id, {
        instruction: initialInstruction,
        sourceExplorationId: state.sourceExplorationId,
      });
    await refreshActivity();
    watchDevelopment(run.events_url);
    toast("已提交开发，Developer Agent 正在运行");
    setState({ sourceExplorationId: null, restartFromExploration: false, debugRunEvidenceId: null });
  });
  container.querySelector("#restartFromExploration")?.addEventListener("click", () =>
    openExplorationRestartModal(tool));
  container.querySelector("#continueDev")?.addEventListener("click", async () => {
    const input = container.querySelector("#devInstruction");
    const instruction = input.value.trim();
    if (!instruction) {
      toast("请先描述本次要修改或补充的内容");
      input.focus();
      return;
    }
    const run = await api.continueDevelopment(state.toolkitId, tool.tool_id, instruction, evidenceId || "");
    await refreshActivity();
    watchDevelopment(run.events_url);
    toast("已提交开发指令，Developer Agent 正在运行");
    setState({});
  });
  container.querySelector("#cancelDev")?.addEventListener("click", async () => {
    await api.cancelDevelopment(state.toolkitId, tool.tool_id);
    await refreshActivity();
    toast("已取消本次开发");
    setState({});
  });
  container.querySelector("#leftEvidenceSelect")?.addEventListener("change", (e) => {
    const val = e.target.value;
    if (!val) {
      setState({ debugRunEvidenceId: null });
    } else {
      setState({ debugRunEvidenceId: val });
    }
  });
  container.querySelector("#clearLeftEvidence")?.addEventListener("click", () => {
    setState({ debugRunEvidenceId: null });
  });

  const debugContainer = container.querySelector("#inlineDebugContainer");
  if (debugContainer) {
    renderInlineDebugger(debugContainer, tool, slots.development, debugRuns);
  }

  container.querySelector("#editDevelopmentCode")?.addEventListener("click", () => {
    if (codeEditSession && !editing) {
      toast("请先保存或取消另一个 Tool 的代码修改");
      return;
    }
    codeEditSession = {
      toolkitId: state.toolkitId,
      toolId: tool.tool_id,
      expectedCodeHash: dev.code_hash,
      draft: dev.code,
    };
    setState({});
  });
  const codeEditor = container.querySelector("#developmentCodeEditor");
  codeEditor?.addEventListener("input", () => {
    if (codeEditSession) codeEditSession.draft = codeEditor.value;
  });
  container.querySelector("#cancelDevelopmentCodeEdit")?.addEventListener("click", () => {
    codeEditSession = null;
    toast("已取消代码修改");
    setState({});
  });
  container.querySelector("#saveDevelopmentCode")?.addEventListener("click", async (event) => {
    const saveButton = event.currentTarget;
    const errorBox = container.querySelector("#developmentCodeError");
    const cancelButton = container.querySelector("#cancelDevelopmentCodeEdit");
    const code = codeEditor?.value || "";
    if (!code.trim()) {
      errorBox.hidden = false;
      errorBox.textContent = "开发代码不能为空。";
      codeEditor?.focus();
      return;
    }
    if (code === dev.code) {
      codeEditSession = null;
      toast("代码没有变化");
      setState({});
      return;
    }
    saveButton.disabled = true;
    cancelButton.disabled = true;
    errorBox.hidden = true;
    try {
      await api.updateDevelopmentCode(
        state.toolkitId,
        tool.tool_id,
        code,
        codeEditSession.expectedCodeHash);
      codeEditSession = null;
      toast("代码已保存，请重新调试当前版本");
      setState({});
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = error.message || String(error);
      saveButton.disabled = false;
      cancelButton.disabled = false;
    }
  });

  if (developing) watchDevelopment(`/api/toolkits/${encodeURIComponent(state.toolkitId)}/tools/${encodeURIComponent(tool.tool_id)}/development/events`);
}

function toolDefinitionCard(tool) {
  return `<section class="dev-card tool-definition-card">
    <div class="dev-card-head"><h3>Tool 基础定义</h3><span class="badge badge-muted">只读</span></div>
    <div class="kv"><span>功能描述</span><span>${esc(tool.goal)}</span></div>
    <div class="kv"><span>起始 URL</span><span class="url">${esc(tool.start_url)}</span></div>
    <div class="kv"><span>页面效果</span><span>${esc(tool.expected_effect || "—")}</span></div>
  </section>`;
}

function emptyCard(slots, latestRun) {
  return `<div class="dev-card">
    <div class="slot-empty">${latestRun?.status === "failed" ? `上次开发失败：${esc(latestRun.error || "未知错误")}<br/>` : ""}尚未开始开发。${slots.formal
      ? "可以基于已发布版本继续开发，或选择一次成功 Exploration 重新开发。"
      : "请选择一次成功 Exploration 开始开发。"}</div>
  </div>`;
}

function initialDevelopmentCard(sourceExplorationId, latestRun, restartFromExploration = false) {
  return `<div class="dev-card">
    <h3>首次开发</h3>
    ${latestRun?.status === "failed" ? `<div class="error-banner">上次开发失败：${esc(latestRun.error || "未知错误")}</div>` : ""}
    <div class="kv">
      <span>来源 Exploration</span>
      <span class="mono">${esc(sourceExplorationId || "尚未选择")}</span>
    </div>
    ${sourceExplorationId
      ? (restartFromExploration
        ? `<p class="muted small">本轮会完全基于所选 Exploration 重新实现此 Tool。点击「开始开发」后才清空当前开发中修改。</p>`
        : `<p class="muted small">Developer Agent 将基于所选 Exploration 和下面的指令生成首个实现。</p>`)
      : `<p class="muted small">请先到探索工作区选择一次成功 Exploration 作为开发输入。</p>`}
    <label class="field">
      <span class="field-label">首次开发指令</span>
      <textarea id="initialDevInstruction" class="dev-instruction" rows="4"
        placeholder="描述首个实现需要重点关注的内容，例如：优先使用稳定定位器，并在下载完成后返回文件名"></textarea>
      <span class="field-hint">必填。该指令会与所选 Exploration 一起提供给 Developer Agent。</span>
    </label>
    <div class="run-bar" style="margin-top: 10px;">
      <button class="btn btn-primary" id="startInitialDevelopment" ${sourceExplorationId ? "" : "disabled"}>开始开发</button>
    </div>
  </div>`;
}

function runningDevelopmentCard(run) {
  return `<div class="dev-card">
    <h3>正在生成开发代码</h3>
    <div class="kv"><span>来源 Exploration</span><span class="mono">${esc(run?.source_exploration_id || "处理中")}</span></div>
    <div class="kv"><span>开发指令</span><span>${esc(run?.instruction || "处理中")}</span></div>
    <p class="muted small">Developer Agent 完成后会自动显示本轮生成的代码和开发依据。</p>
  </div>`;
}

function openRestartDevelopmentModal(tool) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <h3>重新开始开发</h3>
      <p>当前开发中的全部修改将被清空且不可恢复。</p>
      <p class="muted small">已发布版本不受影响。清空后，如需继续开发，请重新选择开发入口。</p>
      <div class="modal-error" hidden></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-cancel>取消</button>
        <button type="button" class="btn btn-danger" data-submit>确认清空</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const errorBox = overlay.querySelector(".modal-error");
  overlay.querySelector("[data-cancel]").addEventListener("click", () => overlay.remove());
  overlay.querySelector("[data-submit]").addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      await api.restartDevelopment(state.toolkitId, tool.tool_id);
      overlay.remove();
      toast("已清空本次开发的全部修改");
      setState({ sourceExplorationId: null, restartFromExploration: false, debugRunEvidenceId: null });
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = error.message || String(error);
      event.currentTarget.disabled = false;
    }
  });
}

async function openExplorationRestartModal(tool) {
  const explorations = (await api.listExplorations(state.toolkitId, tool.tool_id))
    .filter((item) => item.status === "succeeded");
  const selectedExplorationId = explorations.some(
    (item) => item.exploration_id === state.sourceExplorationId)
    ? state.sourceExplorationId
    : explorations[0]?.exploration_id;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal exploration-restart-modal">
      <h3>从探索重新开发</h3>
      <p class="muted small">选择属于当前 Tool 的一次成功 Exploration。Developer Agent 将完全基于该 Exploration 重新实现此 Tool。</p>
      <form class="modal-form" novalidate>
        ${explorations.length ? `
          <div class="exploration-picker-list">
            ${explorations.map((item) => `
              <label class="exploration-picker-item">
                <input type="radio" name="source_exploration_id" value="${esc(item.exploration_id)}"
                  ${selectedExplorationId === item.exploration_id ? "checked" : ""} />
                <span class="mono">${esc(item.exploration_id)}</span>
                ${statusBadge(item.status)}
                <span class="muted small grow-right">${esc(item.created_at || "")}</span>
              </label>`).join("")}
          </div>` : `<p class="slot-empty">当前 Tool 没有成功的 Exploration，请先到探索工作区完成一次探索。</p>`}
        <div class="restart-warning">
          <strong>当前开发中修改将被清空且不可恢复。</strong>
          <span>现有已发布版本不受影响；点击后先填写开发指令，真正开始开发时才清空当前开发中修改。</span>
        </div>
        <div class="modal-error" hidden></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-cancel>取消</button>
          <button type="submit" class="btn btn-primary" ${explorations.length ? "" : "disabled"}>选择并填写指令</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("[data-cancel]").addEventListener("click", () => overlay.remove());
  const form = overlay.querySelector("form");
  const errorBox = overlay.querySelector(".modal-error");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const sourceExplorationId = new FormData(form).get("source_exploration_id");
    if (!sourceExplorationId) {
      errorBox.hidden = false;
      errorBox.textContent = "请选择一次成功 Exploration。";
      return;
    }
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    errorBox.hidden = true;
    try {
      overlay.remove();
      toast("已选择 Exploration，请填写开发指令后开始重新开发");
      setState({
        sourceExplorationId,
        restartFromExploration: true,
        debugRunEvidenceId: null,
      });
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = error.message || String(error);
      submitButton.disabled = false;
    }
  });
}

function latestRunCard(run) {
  if (!run || !["queued", "running", "failed", "cancelled"].includes(run.status)) return "";
  const error = run.status === "failed"
    ? `<div class="error-banner">${esc(run.error || "Developer Agent 未返回可用结果。")}</div>`
    : "";
  return `<div class="dev-card development-run-card">
    <div class="dev-card-head"><h3>最近一次 Development Run</h3>${statusBadge(run.status)}</div>
    <div class="kv"><span>运行 ID</span><span class="mono small">${esc(run.development_run_id)}</span></div>
    <div class="kv"><span>创建时间</span><span>${esc(run.created_at || "—")}</span></div>
    ${error}
    <div class="run-bar">
      <a class="btn btn-ghost btn-sm" href="/api/development-runs/${encodeURIComponent(run.development_run_id)}/files/process.log" target="_blank" rel="noreferrer">查看 Developer 日志</a>
      ${run.has_runtime_errors ? `<a class="btn btn-ghost btn-sm" href="/api/development-runs/${encodeURIComponent(run.development_run_id)}/files/runtime_errors.jsonl" target="_blank" rel="noreferrer">查看异常详情</a>` : ""}
    </div>
  </div>`;
}

function sourceCard(dev) {
  return `<div class="dev-card">
    <h3>当前开发依据</h3>
    <div class="kv"><span>来源 Exploration</span><span class="mono">${esc(dev.source_exploration_id || "—")}</span></div>
    <div class="kv"><span>开发起点</span><span>${dev.based_on_formal_hash ? "已发布版本" : "首次开发"}</span></div>
    <div class="kv"><span>更新时间</span><span>${esc(dev.updated_at)}</span></div>
    ${dev.last_instruction ? `<div class="kv"><span>最近开发指令</span><span>${esc(dev.last_instruction)}</span></div>` : ""}
  </div>`;
}

// 当前开发代码：显式进入编辑状态，只保存代码正文；Schema 与契约保持只读。
function codeCard(slot, editing, busy) {
  const codeContent = editing ? `
    <textarea id="developmentCodeEditor" class="development-code-editor" spellcheck="false"
      aria-label="当前开发代码">${esc(codeEditSession.draft)}</textarea>
    <div id="developmentCodeError" class="modal-error" hidden></div>` : `<pre class="code"><code>${esc(slot.code)}</code></pre>`;
  const codeActions = editing ? `
    <div class="run-bar code-edit-actions">
      <button type="button" class="btn btn-ghost" id="cancelDevelopmentCodeEdit">取消修改</button>
      <button type="button" class="btn btn-primary" id="saveDevelopmentCode">保存修改</button>
      <span class="muted small">只修改 Python 代码；函数签名必须与当前参数 Schema 保持一致。</span>
    </div>` : `
    <div class="run-bar code-edit-actions">
      <button type="button" class="btn btn-ghost" id="editDevelopmentCode" ${busy ? "disabled" : ""}>编辑代码</button>
    </div>`;
  return `<div class="dev-card">
    <div class="dev-card-head">
      <p class="slot-desc">${esc(slot.description)}</p>
    </div>
    ${slotMeta(slot, codeContent)}
    ${codeActions}
  </div>`;
}

// 继续开发的入口：支持关联 Debug 运行记录，提交后交给 Developer Agent 处理。
function instructionCard(editing, evidenceRun, runs) {
  let options = `<option value="">+ 关联 Debug Run 试运行记录 (可选)</option>`;
  if (runs && runs.length) {
    options += runs.map(r => {
      const time = esc(r.created_at.slice(-8));
      const icon = r.status === "succeeded" ? "✅" : r.status === "failed" ? "❌" : "⏳";
      const label = `${icon} #${esc(r.debug_run_id)} (${time})`;
      return `<option value="${esc(r.debug_run_id)}" ${r.debug_run_id === evidenceRun?.debug_run_id ? "selected" : ""}>${label}</option>`;
    }).join("");
  }

  const isAttached = !!evidenceRun;

  return `<div class="dev-card" style="border: 1px solid ${isAttached ? 'var(--primary, #2563eb)' : 'var(--border)'}; transition: border-color 0.2s ease;">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
      <h3 style="margin: 0;">继续开发</h3>
      <span class="muted small">Developer Agent 提交流</span>
    </div>

    <!-- 上下文参考 Chip (Classic Agent Attachment Style) -->
    <div style="margin-bottom: 10px; display: flex; align-items: center; gap: 8px;">
      <div style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; background: ${isAttached ? 'var(--primary-weak, rgba(37, 99, 235, 0.1))' : 'var(--panel-2)'}; border: 1px solid ${isAttached ? 'var(--primary, #2563eb)' : 'var(--border)'}; border-radius: 20px; font-size: 12px;">
        <span style="color: ${isAttached ? 'var(--primary)' : 'var(--muted)'};">📎 上下文参考:</span>
        <select id="leftEvidenceSelect" style="background: transparent; border: none; outline: none; font-family: var(--font-mono); font-size: 11.5px; font-weight: 600; color: ${isAttached ? 'var(--primary)' : 'var(--text)'}; cursor: pointer; max-width: 260px;">
          ${options}
        </select>
        ${isAttached ? `<button type="button" id="clearLeftEvidence" style="border:none; background:transparent; color:var(--primary); cursor:pointer; padding:0 2px; font-size:12px;" title="清除引用">✖</button>` : ''}
      </div>
    </div>

    <textarea id="devInstruction" class="dev-instruction" rows="3"
      placeholder="描述本次要修改或补充的内容，例如：增加分页参数、修复搜索框定位不稳定的问题"></textarea>
    <div class="run-bar" style="margin-top: 10px;">
      <button class="btn btn-primary" id="continueDev" ${editing ? "disabled" : ""}>提交</button>
      <span class="muted small">Developer Agent 将基于当前代码${isAttached ? '及关联的试运行证据' : ''}与指令生成新的实现</span>
    </div>
  </div>`;
}

// 已发布版本默认收起，点击展开对照；从未发布时只显示一行事实。
function formalCard(slot) {
  if (!slot) {
    return `<div class="dev-card formal-card">
      <div class="formal-none muted small">尚未发布过版本</div>
    </div>`;
  }
  return `<details class="dev-card formal-card">
    <summary class="formal-summary">
      <span class="formal-title">已发布版本</span>
      <span class="badge badge-muted">只读</span>
      <span class="formal-hint muted small">展开对照 ▾</span>
    </summary>
    <div class="formal-body">
      <p class="slot-desc">${esc(slot.description)}</p>
      ${slotMeta(slot)}
    </div>
  </details>`;
}

function slotMeta(slot, codeContent = `<pre class="code"><code>${esc(slot.code)}</code></pre>`) {
  return `
    <div class="kv"><span>参数</span><span>${paramSummary(slot.parameters_schema)}</span></div>
    <div class="kv"><span>返回</span><span>${paramSummary(slot.result_schema)}</span></div>
    ${codeContent}`;
}

function paramSummary(schema) {
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  const parts = Object.entries(props).map(([k, v]) =>
    `<code>${esc(k)}${required.has(k) ? "*" : ""}:${esc(v.type)}</code>`);
  return parts.join(" ") || "—";
}

// --- 即时调试面板 (Inline Debugger) ---
let inlineDebugStream = { debugRunId: null, close: null };
let selectedInlineRunId = null;

function renderInlineDebugger(container, tool, devSlot, runs) {
  if (!devSlot) {
    container.innerHTML = `<div class="dev-card"><div class="slot-empty">请先在左侧开始开发，生成开发中代码。</div></div>`;
    return;
  }
  const running = runs.find((run) => ["queued", "running"].includes(run.status));
  const blocked = isBusy() && !running;

  // 默认选中第一条（最近的一条）
  if (selectedInlineRunId === null && runs.length > 0) {
    selectedInlineRunId = runs[0].debug_run_id;
  }
  const selectedRun = runs.find(r => r.debug_run_id === selectedInlineRunId) || runs[0];

  container.innerHTML = `
    <div class="dev-card">
      <div class="dev-card-head">
        <h3>即时调试</h3>
      </div>
      <form id="inlineParamForm">${renderParamForm(devSlot.parameters_schema)}</form>
      <div class="run-bar">
        <button class="btn btn-primary" id="inlineRunTool" ${blocked || running ? "disabled" : ""}>运行测试</button>
      </div>
    </div>

    <div class="dev-card">
      <div class="dev-card-head" style="margin-bottom:0;">
        <h3 style="margin:0;">试运行历史</h3>
      </div>
      <div style="margin-top: 12px; margin-bottom: 12px;">
        ${renderHistorySelector(runs, selectedInlineRunId)}
      </div>
      <div id="inlineRunDetail">
        ${renderRunDetail(selectedRun)}
      </div>
    </div>
  `;

  if (selectedRun) {
    renderRunEvents(container.querySelector(".run-events-container"), eventsFor(selectedRun));
  }

  container.querySelector("#inlineRunTool")?.addEventListener("click", async () => {
    const params = collectParams(container, devSlot.parameters_schema);
    const run = await api.runDebugTool(state.toolkitId, tool.tool_id, "development", params);
    selectedInlineRunId = run.debug_run_id;
    await refreshActivity();
    watchInlineDebugRun(run.debug_run_id, run.events_url);
    toast("已提交测试运行");
    setState({});
  });

  container.querySelector("#debugRunHistorySelect")?.addEventListener("change", (e) => {
    selectedInlineRunId = e.target.value;
    renderInlineDebugger(container, tool, devSlot, runs);
  });

  // 已将引用按钮转移到左侧下拉列表，此处旧的事件监听已移除
  container.querySelector("#leftEvidenceSelect")?.addEventListener("change", (e) => {
    const evidenceId = e.target.value;
    setState({ debugRunEvidenceId: evidenceId || null });
    if (evidenceId) {
       toast(`已引用 #${evidenceId} 作为开发参考`);
    }
  });

  if (running) {
    watchInlineDebugRun(running.debug_run_id, `/api/debug-runs/${encodeURIComponent(running.debug_run_id)}/events`);
  }
}

function watchInlineDebugRun(debugRunId, eventsUrl) {
  if (inlineDebugStream.debugRunId === debugRunId && inlineDebugStream.close) return;
  inlineDebugStream.close?.();
  const close = api.watchEvents(eventsUrl, (name) => {
    if (["debug_run_succeeded", "debug_run_failed", "debug_run_cancelled"].includes(name)) {
      inlineDebugStream = { debugRunId: null, close: null };
      close();
    }
    refreshActivity().catch(() => {});
    setState({});
  });
  inlineDebugStream = { debugRunId, close };
}

function watchDevelopment(eventsUrl) {
  if (developmentStream.url === eventsUrl && developmentStream.close) return;
  developmentStream.close?.();
  const close = api.watchEvents(eventsUrl, (name) => {
    if (["development_succeeded", "development_failed", "development_cancelled"].includes(name)) {
      developmentStream = { url: null, close: null };
      close();
    }
    refreshActivity().catch(() => {});
    setState({});
  });
  developmentStream = { url: eventsUrl, close };
}
