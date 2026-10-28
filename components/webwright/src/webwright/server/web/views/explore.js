// 探索工作区：左侧 Exploration 列表，右侧经典 Agent 历史流和固定底部 Prompt。

import * as api from "../api.js";
import { state, setState } from "../state.js";
import { esc, statusBadge, toneBadge, toast } from "../util.js";
import { isBusy, refreshActivity } from "../components/activity_status.js";
import { openLightbox } from "../components/lightbox.js";

// 当前选中的 Exploration：跨重渲染保留，切换 Tool 后重置为该 Tool 的第一条。
let selected = { toolId: null, explorationId: null };
let activeStream = { explorationId: null, close: null };
let search = { toolId: null, value: "" };

const PAUSABLE = new Set(["running"]);
const RESUMABLE = new Set(["waiting_for_user"]);
const CANCELLABLE = new Set(["running", "pause_requested", "waiting_for_user"]);

export async function renderExplore(container) {
  const tool = await api.getTool(state.toolkitId, state.toolId);
  if (!tool) {
    container.innerHTML = `<div class="ws-empty">请选择一个 Tool</div>`;
    return;
  }
  const [allExps, slots] = await Promise.all([
    api.listExplorations(state.toolkitId, tool.tool_id),
    api.getSlots(state.toolkitId, tool.tool_id),
  ]);
  if (search.toolId !== tool.tool_id) search = { toolId: tool.tool_id, value: "" };
  const exps = allExps.filter((item) => !search.value || `${item.exploration_id} ${item.status}`.toLowerCase().includes(search.value));

  if (selected.toolId !== tool.tool_id) {
    selected = { toolId: tool.tool_id, explorationId: exps[0]?.exploration_id || null };
  }
  const summary = exps.find((e) => e.exploration_id === selected.explorationId) || null;
  const current = summary ? await api.getExploration(summary.exploration_id) : null;

  container.innerHTML = `
    <div class="explore-layout">
      <aside class="explore-list dev-card">
        <div class="explore-list-actions">
          <button class="btn btn-primary" id="newExp" ${isBusy() ? "disabled" : ""}>+ 新建探索</button>
          <button class="btn" id="refreshExpList">刷新</button>
        </div>
        <input class="search-box" id="searchExp" placeholder="搜索 ID 或状态…" value="${esc(search.value)}" />
        <div class="explore-list-scroll">
          ${exps.length ? exps.map((e) => listItemHtml(e)).join("") : `<div class="slot-empty">还没有 Exploration</div>`}
        </div>
      </aside>
      <section class="explore-detail dev-card">
        ${current ? detailHtml(current, tool, slots) : `
          <div class="ws-empty">
            <strong>还没有探索记录</strong>
            <span>点击左侧「新建探索」开始。</span>
          </div>`}
      </section>
    </div>
  `;

  container.querySelector("#newExp")?.addEventListener("click", () => openNewExplorationModal(tool));
  container.querySelector("#refreshExpList")?.addEventListener("click", () => setState({}));
  container.querySelector("#searchExp")?.addEventListener("input", (event) => {
    search.value = event.target.value.trim().toLowerCase();
    container.querySelectorAll("[data-select-item]").forEach((item) => {
      item.hidden = !item.textContent.toLowerCase().includes(search.value);
    });
  });
  container.querySelectorAll("[data-select-item]").forEach((el) => {
    el.addEventListener("click", () => {
      selected = { toolId: tool.tool_id, explorationId: el.dataset.selectItem };
      setState({});
    });
  });

  if (current) bindDetailActions(container, tool, current, slots);
  container.querySelectorAll("[data-lightbox]").forEach((image) => {
    image.addEventListener("click", (event) => {
      event.preventDefault();
      openLightbox(image.src, image.alt);
    });
  });
  if (current && ["queued", "running", "pause_requested", "cancel_requested", "starting_browser"].includes(current.status)) {
    ensureExplorationStream(current.exploration_id);
  }
}

function listItemHtml(e) {
  return `
    <div class="explore-card ${e.exploration_id === selected.explorationId ? "active" : ""}" data-select-item="${esc(e.exploration_id)}">
      <div class="explore-card-title" title="${esc(e.exploration_id)}">${esc(e.exploration_id)}</div>
      <div class="explore-card-row">${statusBadge(e.status)}<span class="grow">步骤 ${e.step_count}</span></div>
      <div class="explore-card-row muted">${esc(e.created_at)}</div>
    </div>`;
}

function detailHtml(e, tool, slots) {
  const canPause = PAUSABLE.has(e.status);
  const canResume = RESUMABLE.has(e.status);
  const canCancel = CANCELLABLE.has(e.status);
  const timeline = e.timeline || [];
  const steps = timeline.filter((item) => item.type === "agent_step");
  const canSelectInput = !slots.development && !slots.formal
    && e.status === "succeeded" && e.completed_goal && !e.used_by_development;

  return `
    <header class="explore-detail-head">
      <div class="explore-detail-title">
        <div class="d-titlerow">
          <h3 class="mono">${esc(e.exploration_id)}</h3>
          ${statusBadge(e.status)}
          <span class="muted small">${steps.length ? `${steps.length} 步` : ""}</span>
        </div>
        <div class="url">${esc(e.final_url || tool.start_url)}</div>
      </div>
      <div class="explore-toolbar">
        <button class="btn btn-sm" id="pauseExp" ${canPause ? "" : "disabled"}>${e.status === "pause_requested" ? "正在暂停" : "暂停"}</button>
        <button class="btn btn-sm ${canResume ? "btn-primary" : ""}" id="resumeExp" ${canResume ? "" : "disabled"}>继续</button>
        <button class="btn btn-sm" id="cancelExp" ${canCancel ? "" : "disabled"}>${e.status === "cancel_requested" ? "正在取消" : "取消"}</button>
        <span class="sep"></span>
        <button class="btn btn-sm" id="replayExp" ${steps.length && !isBusy() ? "" : "disabled"}>回放</button>
        <button class="btn btn-ghost btn-sm" id="refreshExp">刷新</button>
        ${canSelectInput ? `<button class="btn btn-primary btn-sm" id="selectExpInput">选为开发输入</button>` : ""}
      </div>
    </header>

    ${e.active_issue ? `<div class="explore-state-note ${e.active_issue.type === "failed" ? "error" : ""}">${esc(e.active_issue.message)}</div>` : ""}

    <div class="agent-history">
      <section class="agent-goal">
        <span class="agent-message-label">目标</span>
        <strong>${esc(tool.goal)}</strong>
        ${tool.expected_effect ? `<p>${esc(tool.expected_effect)}</p>` : ""}
        <span class="agent-goal-url mono">${esc(tool.start_url)}</span>
      </section>
      ${timeline.length ? renderTimeline(timeline) : `<div class="slot-empty">暂无执行步骤</div>`}
    </div>

    <footer class="agent-prompt">
      ${canResume ? `<div class="agent-prompt-note">请在 Agent 浏览器完成需要的人工操作，然后继续探索。</div>` : ""}
      <div class="agent-prompt-row">
        <textarea id="expFollowup" rows="2" placeholder="${canResume ? "我已处理好，请继续" : "输入追加指令…"}"></textarea>
        <span class="muted small">⌘/Ctrl + Enter</span>
        <button class="btn btn-primary" id="expFollowupBtn">${canResume ? "继续探索" : "发送"}</button>
      </div>
    </footer>
  `;
}

function renderTimeline(items) {
  const output = [];
  let stepGroup = [];
  const flushSteps = () => {
    if (!stepGroup.length) return;
    output.push(`<section class="agent-step-segment" aria-label="Agent 步骤流"><span class="agent-role-label">Agent</span><div class="step-timeline">${renderSteps(stepGroup)}</div></section>`);
    stepGroup = [];
  };
  for (const item of items) {
    if (item.type === "agent_step") {
      stepGroup.push(item);
      continue;
    }
    flushSteps();
    if (item.type === "user") {
      output.push(`<section class="agent-user-message"><span class="agent-message-label">User</span>${esc(item.content)}</section>`);
    } else if (item.type === "agent_final") {
      output.push(`<section class="agent-final-message"><span class="agent-message-label">Agent · 最终结果</span><div class="result-card">${esc(item.content)}</div></section>`);
    }
  }
  flushSteps();
  return output.join("");
}

function formatUrl(url) {
  if (!url) return "";
  try {
    return decodeURIComponent(url);
  } catch (_) {
    return url;
  }
}

function renderSteps(steps) {
  return steps.map((s) => {
    const meta = stepStatusMeta(s.status, s.done);
    const node = meta.cls === "ok" ? "✓" : meta.cls === "err" ? "✕" : esc(String(s.step));
    const observation = s.observation || {};
    const hasObservation = observation.title || observation.url || observation.screenshot_url;
    const codeLines = s.code ? s.code.split("\n").length : 0;

    return `
      <div class="step-row ${meta.cls}" data-step-status="${esc(s.status || "unknown")}">
        <div class="step-node">${node}</div>
        <div class="step-card">
          <div class="step-card-header">
            <div class="step-title-row">
              <span class="step-title">步骤 ${esc(s.step)}</span>
              ${toneBadge(meta.label, meta.tone)}
            </div>
            ${s.url ? `<div class="step-header-url mono" title="${esc(s.url)}">${esc(s.url)}</div>` : ""}
          </div>

          <div class="step-card-body">
            ${s.thought ? `
              <section class="step-thinking">
                <div class="step-thinking-header">
                  <span class="step-thinking-icon">💡</span>
                  <span class="step-section-label">Agent 思考</span>
                </div>
                <div class="step-thought">${esc(s.thought)}</div>
              </section>` : ""}

            ${s.code ? `
              <details class="step-code">
                <summary class="step-code-header">
                  <div class="step-code-title">
                    <span class="step-code-icon">⚡</span>
                    <span class="step-code-label">执行动作</span>
                    <span class="step-code-lines muted">${codeLines} 行</span>
                  </div>
                </summary>
                <div class="step-code-body">
                  <pre><code>${esc(s.code)}</code></pre>
                </div>
              </details>` : ""}

            ${hasObservation ? `
              <section class="step-observation ${observation.success === false ? "error" : ""}">
                <div class="browser-mockup-header">
                  <span class="browser-icon">🌐</span>
                  <span class="browser-page-title" title="${esc(observation.title || "")}">${esc(observation.title || "执行后页面")}</span>
                  ${observation.url ? `
                    <span class="browser-title-sep">•</span>
                    <span class="browser-url-text mono" title="${esc(observation.url)}">${esc(formatUrl(observation.url))}</span>` : ""}
                </div>
                <div class="browser-mockup-body">
                  ${observation.screenshot_url ? `
                    <a class="step-shot" href="${esc(observation.screenshot_url)}">
                      <img data-lightbox src="${esc(observation.screenshot_url)}" alt="步骤 ${esc(s.step)} 页面截图" loading="lazy" />
                      <span class="step-shot-badge">点击放大预览</span>
                    </a>` : ""}
                </div>
              </section>` : ""}
          </div>
        </div>
      </div>`;
  }).join("");
}

function stepStatusMeta(status, done) {
  if (status === "error") return { cls: "err", tone: "danger", label: "失败" };
  if (status === "done") return { cls: "ok", tone: "success", label: "完成" };
  if (status === "ok" || done) return { cls: "ok", tone: "success", label: "成功" };
  if (status === "unknown" || !status) return { cls: "run", tone: "warn", label: "运行中" };
  return { cls: "", tone: "muted", label: String(status) };
}

function bindDetailActions(container, tool, exp, slots) {
  container.querySelector("#pauseExp")?.addEventListener("click", async () => {
    await api.pauseExploration(exp.exploration_id);
    setState({});
  });
  container.querySelector("#resumeExp")?.addEventListener("click", async () => {
    await api.resumeExploration(exp.exploration_id);
    await refreshActivity();
    setState({});
  });
  container.querySelector("#cancelExp")?.addEventListener("click", async () => {
    await api.cancelExploration(exp.exploration_id);
    await refreshActivity();
    toast("已取消该 Exploration");
    setState({});
  });
  container.querySelector("#replayExp")?.addEventListener("click", async () => {
    const replay = await api.replayExploration(exp.exploration_id);
    await refreshActivity();
    toast("已开始回放原始步骤");
    api.watchEvents(replay.events_url, (name) => {
      refreshActivity().catch(() => {});
      if (name === "replay_succeeded") toast("回放完成");
      if (name === "replay_failed" || name === "replay_cancelled") toast("回放未完成");
    });
  });
  container.querySelector("#refreshExp")?.addEventListener("click", () => setState({}));
  container.querySelector("#selectExpInput")?.addEventListener("click", async () => {
    toast("已选择该 Exploration 作为开发输入");
    setState({ workspace: "develop", sourceExplorationId: exp.exploration_id, restartFromExploration: false });
  });

  const followupBtn = container.querySelector("#expFollowupBtn");
  const followupBox = container.querySelector("#expFollowup");
  const canResume = RESUMABLE.has(exp.status);
  const submitFollowup = async () => {
    const content = followupBox.value.trim();
    if (canResume) {
      await api.resumeExploration(exp.exploration_id, content);
      await refreshActivity();
      setState({});
      return;
    }
    if (!content) return;
    await api.sendExplorationFollowup(exp.exploration_id, content);
    await refreshActivity();
    followupBox.value = "";
    setState({});
  };
  followupBtn?.addEventListener("click", submitFollowup);
  followupBox?.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
      ev.preventDefault();
      submitFollowup();
    }
  });
}

// 新建 Exploration：自动带入功能描述、运行后达成的页面效果与起始 URL（只读），只允许补充不改变根本目标的指令。
function openNewExplorationModal(tool) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <h3>新建探索</h3>
      <div class="kv"><span>功能描述</span><span>${esc(tool.goal)}</span></div>
      <div class="kv"><span>运行后达成的页面效果</span><span>${esc(tool.expected_effect)}</span></div>
      <div class="kv"><span>起始 URL</span><span class="url">${esc(tool.start_url)}</span></div>
      <label class="field">
        <span class="field-label">补充指令（可选）</span>
        <textarea id="expInstruction" class="dev-instruction" rows="3"
          placeholder="不能改变 Tool 根本目标，仅作为本次探索的补充说明"></textarea>
      </label>
      <div class="url-check" id="preparedPageStatus">正在检测 Agent 浏览器中的目标页面…</div>
      <label class="field" id="preparedPageField" hidden><span class="field-label">探索页面</span><select id="preparedPageSelect"></select></label>
      <p class="muted small">探索从所选页面的当前状态开始，不会自动返回起始网址。</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="openBrowserForExp">打开起始网址</button>
        <button type="button" class="btn btn-ghost" id="recheckPreparedPage">重新检测</button>
        <button type="button" class="btn btn-ghost" data-cancel>取消</button>
        <button type="button" class="btn btn-primary" id="startExpBtn" disabled>启动探索</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let matchedTargetId = "";
  let checkVersion = 0;
  let submitting = false;
  const pageSelect = overlay.querySelector("#preparedPageSelect");
  pageSelect.addEventListener("change", () => {
    matchedTargetId = pageSelect.value;
    overlay.querySelector("#startExpBtn").disabled = !matchedTargetId || isBusy() || submitting;
  });
  const close = () => {
    checkVersion++;
    window.removeEventListener("focus", checkPreparedPage);
    overlay.remove();
  };
  overlay.querySelector("[data-cancel]").addEventListener("click", close);
  overlay.querySelector("#openBrowserForExp").addEventListener("click", async () => {
    await api.openBrowser(tool.start_url);
    await checkPreparedPage();
    toast("已在 Agent 浏览器打开 Tool 起始 URL");
  });
  overlay.querySelector("#recheckPreparedPage").addEventListener("click", checkPreparedPage);
  overlay.querySelector("#startExpBtn").addEventListener("click", async () => {
    if (!matchedTargetId || submitting) return;
    const instruction = overlay.querySelector("#expInstruction").value.trim();
    submitting = true;
    checkVersion++;
    overlay.querySelector("#startExpBtn").disabled = true;
    try {
      const created = await api.createExploration(state.toolkitId, tool.tool_id, instruction, matchedTargetId);
      close();
      await refreshActivity();
      toast("已创建探索，正在执行…");
      selected = { toolId: tool.tool_id, explorationId: created.exploration_id };
      setState({});
    } catch (error) {
      overlay.querySelector("#preparedPageStatus").textContent = error.message;
    } finally {
      submitting = false;
      overlay.querySelector("#startExpBtn").disabled = !matchedTargetId || isBusy();
    }
  });
  window.addEventListener("focus", checkPreparedPage);
  checkPreparedPage();
  overlay.querySelector("#expInstruction").focus();

  async function checkPreparedPage() {
    if (submitting) return;
    const version = ++checkVersion;
    const status = overlay.querySelector("#preparedPageStatus");
    const startButton = overlay.querySelector("#startExpBtn");
    const previousTargetId = matchedTargetId;
    matchedTargetId = "";
    pageSelect.replaceChildren();
    overlay.querySelector("#preparedPageField").hidden = true;
    startButton.disabled = true;
    status.className = "url-check";
    status.textContent = "正在检测 Agent 浏览器中的目标页面…";
    try {
      const result = await api.matchBrowser(tool.start_url, state.toolkitId, tool.tool_id);
      if (version !== checkVersion) return;
      if (result.targets?.length) {
        const preferred = result.targets.find(item => item.target_id === previousTargetId) || result.target;
        matchedTargetId = preferred?.target_id || "";
        pageSelect.innerHTML = `<option value="" disabled>请选择要探索的页面</option>` + result.targets.map(item => `<option value="${esc(item.target_id)}">${esc(item.title ? item.title + ' — ' : '')}${esc(item.url)}</option>`).join("");
        pageSelect.value = matchedTargetId;
        overlay.querySelector("#preparedPageField").hidden = false;
        status.className = "url-check ok";
        status.textContent = "已找到允许域名内的页面，请确认探索页面。";
        startButton.disabled = !matchedTargetId || isBusy();
      } else {
        status.className = "url-check warn";
        status.innerHTML = "未找到允许域名内的页面。请打开起始网址并<strong>完成登录</strong>，或修改 Adapter 允许域名后重新检测。";
      }
    } catch (error) {
      if (version !== checkVersion) return;
      status.className = "url-check error";
      status.textContent = error.message;
    }
  }
}

function ensureExplorationStream(explorationId) {
  if (activeStream.explorationId === explorationId && activeStream.close) return;
  activeStream.close?.();
  const close = api.watchEvents(`/api/explorations/${encodeURIComponent(explorationId)}/events`, (name) => {
    if (["waiting_for_user", "exploration_succeeded", "exploration_failed", "exploration_cancelled"].includes(name)) {
      activeStream = { explorationId: null, close: null };
      close();
    }
    refreshActivity().catch(() => {});
    setState({});
  });
  activeStream = { explorationId, close };
}
