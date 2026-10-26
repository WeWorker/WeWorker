// 调试工作区：仅针对已发布的正式版本代码，按参数 Schema 填参运行并查看 Debug Run 历史。

import * as api from "../api.js";
import { state, setState } from "../state.js";
import { esc, statusBadge, toneBadge, toast } from "../util.js";
import { renderRunEvents } from "../components/run_events.js";
import { collectParams, renderParamForm, eventsFor } from "../components/debug_runner.js";
import { isBusy, refreshActivity } from "../components/activity_status.js";
import { openLightbox } from "../components/lightbox.js";

let debugStream = { debugRunId: null, close: null };

export async function renderDebug(container) {
  const exportStatus = await api.getExportStatus(state.toolkitId);
  const tool = exportStatus.tools.find(item => item.tool_id === state.toolId);
  if (!tool) {
    container.innerHTML = `<div class="ws-empty">请选择一个已有正式产物的 Tool。</div>`;
    return;
  }
  const runs = await api.listDebugRuns(state.toolkitId, tool.tool_id);
  const activeSlot = tool;
  const running = runs.find((run) => ["queued", "running"].includes(run.status));
  const blocked = isBusy() && !running;

  container.innerHTML = `
    <div class="debug-grid">
      <div class="debug-left">
        <div class="dev-card">
          <div class="dev-card-head">
            <h3>参数</h3>
          </div>
          <form id="paramForm">${renderParamForm(activeSlot.parameters_schema)}</form>
          <div class="run-bar">
            <button class="btn btn-primary" id="runTool" ${blocked || running ? "disabled" : ""}>运行</button>
            <span class="muted small">运行前校验：域名归属、版本存在、参数合法</span>
          </div>
        </div>

        <div class="dev-card">
          <div class="dev-card-head">
            <h3>运行事件</h3>
            <span class="muted small">结构化状态 · 非原始终端</span>
          </div>
          <div class="run-console" id="runEvents"></div>
        </div>
      </div>

      <div class="debug-right">
        <div class="dev-card">
          <h3>Debug Run 历史</h3>
          ${runs.length ? runs.map((r) => runRow(r, exportStatus.distribution_hash)).join("") : `<div class="slot-empty">暂无运行记录</div>`}
        </div>
      </div>
    </div>
  `;

  renderRunEvents(container.querySelector("#runEvents"), eventsFor(runs[0]));

  container.querySelector("#runTool")?.addEventListener("click", async () => {
    const params = collectParams(container, activeSlot.parameters_schema);
    const run = await api.runDebugTool(state.toolkitId, tool.tool_id, "formal", params, exportStatus.distribution_hash);
    await refreshActivity();
    watchDebugRun(run.debug_run_id, run.events_url);
    toast("已提交运行");
    setState({});
  });

  container.querySelectorAll("[data-cancel-run]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api.cancelDebugRun(button.dataset.cancelRun);
      await refreshActivity();
      toast("已取消 Debug Run");
      setState({});
    });
  });
  container.querySelectorAll("[data-repeat-run]").forEach((button) => {
    button.addEventListener("click", async () => {
      const previous = runs.find((run) => run.debug_run_id === button.dataset.repeatRun);
      if (!previous) return;
      const run = await api.runDebugTool(state.toolkitId, tool.tool_id, previous.channel || "formal", previous.parameters, exportStatus.distribution_hash);
      await refreshActivity();
      watchDebugRun(run.debug_run_id, run.events_url);
      toast("已按原参数重复运行");
      setState({});
    });
  });

  container.querySelectorAll("[data-lightbox]").forEach((image) => {
    image.addEventListener("click", (event) => {
      event.preventDefault();
      openLightbox(image.src, image.alt);
    });
  });
  if (running) watchDebugRun(running.debug_run_id, `/api/debug-runs/${encodeURIComponent(running.debug_run_id)}/events`);
}

function runRow(r, currentArtifactHash) {
  const artifactMatch = r.channel === "formal" && r.distribution_hash === currentArtifactHash;
  return `
    <details class="run-item">
      <summary>
        ${statusBadge(r.status)}
        ${toneBadge(r.channel === "formal" ? "正式" : "开发中", r.channel === "formal" ? "muted" : "primary")}
        <span class="mono small">${esc(r.debug_run_id)}</span>
        <span class="muted small">${esc(r.created_at)}</span>
      </summary>
      <div class="run-detail">
        ${r.channel === "formal" ? `<div class="kv"><span>运行版本</span><span>${toneBadge(artifactMatch ? "当前产物" : "旧产物", artifactMatch ? "ok" : "warn")}</span></div>` : ""}
        <div class="kv"><span>参数</span><span class="mono small">${esc(JSON.stringify(r.parameters))}</span></div>
        ${r.status === "succeeded"
          ? `<div class="kv"><span>结果</span><span class="mono small">${esc(JSON.stringify(r.result))}</span></div>`
          : r.status === "failed"
            ? `<div class="kv"><span>错误</span><span class="danger-text small">${esc(r.error)}</span></div>`
            : ""}
        <div class="kv"><span>页面前</span><span class="url small">${esc(r.before_page.url)}</span></div>
        <div class="kv"><span>页面后</span><span class="url small">${esc(r.after_page.url)}</span></div>
        ${r.screenshot_url ? `<a class="debug-shot" href="${esc(r.screenshot_url)}"><img data-lightbox src="${esc(r.screenshot_url)}" alt="Debug Run 截图" loading="lazy" /></a>` : ""}
        <div class="run-bar">
          <a class="btn btn-ghost btn-sm" href="/api/debug-runs/${encodeURIComponent(r.debug_run_id)}/files/process.log" target="_blank" rel="noreferrer">查看日志</a>
          ${["queued", "running"].includes(r.status)
            ? `<button class="btn btn-ghost btn-sm" data-cancel-run="${esc(r.debug_run_id)}">取消</button>`
            : `<button class="btn btn-ghost btn-sm" data-repeat-run="${esc(r.debug_run_id)}" ${isBusy() ? "disabled" : ""}>重复运行</button>`}
        </div>
      </div>
    </details>`;
}

function watchDebugRun(debugRunId, eventsUrl) {
  if (debugStream.debugRunId === debugRunId && debugStream.close) return;
  debugStream.close?.();
  const close = api.watchEvents(eventsUrl, (name) => {
    if (["debug_run_succeeded", "debug_run_failed", "debug_run_cancelled"].includes(name)) {
      debugStream = { debugRunId: null, close: null };
      close();
    }
    refreshActivity().catch(() => {});
    setState({});
  });
  debugStream = { debugRunId, close };
}
