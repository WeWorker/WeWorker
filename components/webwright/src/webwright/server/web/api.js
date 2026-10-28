// 真实 HTTP API 适配层。视图只依赖这里暴露的稳定数据形状。

async function request(path, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  if (init.body !== undefined && typeof init.body !== "string") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(init.body);
  }
  const response = await fetch(path, init);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || String(payload || `${response.status} ${response.statusText}`);
    throw new Error(message);
  }
  return payload;
}

function encode(value) {
  return encodeURIComponent(value);
}

function post(path, body = {}) {
  return request(path, { method: "POST", body });
}

function normalizeTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function normalizeExploration(item, timeline = []) {
  return {
    ...item,
    created_at: normalizeTime(item.created_at),
    updated_at: normalizeTime(item.updated_at),
    timeline,
  };
}

function normalizeRun(run) {
  return {
    ...run,
    created_at: normalizeTime(run.created_at),
    started_at: normalizeTime(run.started_at),
    finished_at: normalizeTime(run.finished_at),
    before_page: run.before_page || { url: "", title: "" },
    after_page: run.after_page || { url: "", title: "" },
  };
}

export async function listToolkits() {
  return (await request("/api/toolkits")).toolkits;
}

export async function listTools(toolkitId) {
  return (await request(`/api/toolkits/${encode(toolkitId)}/tools`)).tools;
}

export function getToolkit(toolkitId) {
  return request(`/api/toolkits/${encode(toolkitId)}`);
}

export function getTool(toolkitId, toolId) {
  return request(`/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}`);
}

export async function getSlots(toolkitId, toolId) {
  const base = `/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}`;
  const [formalPayload, developmentPayload] = await Promise.all([
    request(`${base}/formal`),
    request(`${base}/development`),
  ]);
  return {
    formal: formalPayload.formal,
    development: developmentPayload.development,
    publish_eligible: developmentPayload.publish_eligible,
    latest_run: developmentPayload.latest_run ? normalizeRun(developmentPayload.latest_run) : null,
  };
}

export async function listExplorations(toolkitId, toolId) {
  const payload = await request(`/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}/explorations`);
  return payload.explorations.map((item) => normalizeExploration(item));
}

export async function getExploration(explorationId) {
  const base = `/api/explorations/${encode(explorationId)}`;
  const [item, timelinePayload] = await Promise.all([
    request(base),
    request(`${base}/timeline`),
  ]);
  return normalizeExploration(item, timelinePayload.items || []);
}

export async function listDebugRuns(toolkitId, toolId) {
  const payload = await request(`/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}/debug-runs`);
  return payload.debug_runs.map(normalizeRun);
}

export async function getBrowserStatus() {
  const status = await request("/api/browser/status");
  return { ...status, running: Boolean(status.available), cdp_url: status.cdp_url || "" };
}

export function openBrowser(url = "") {
  return post("/api/browser/open", url ? { url } : {});
}

export function matchBrowser(url, toolkitId, toolId) {
  return request(`/api/browser/match?url=${encode(url)}${toolkitId ? `&toolkit_id=${encode(toolkitId)}&tool_id=${encode(toolId)}` : ''}`);
}

export function getActivity() {
  return request("/api/activity");
}

export async function createToolkit({ name, description, allowed_domains }) {
  const domains = String(allowed_domains || "").split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
  return post("/api/toolkits", { name: String(name || "").trim(), description, allowed_domains: domains });
}

export function createTool(toolkitId, body) {
  return post(`/api/toolkits/${encode(toolkitId)}/tools`, body);
}

export function updateToolkit(toolkitId, body) {
  return request(`/api/toolkits/${encode(toolkitId)}`, { method: "PUT", body });
}

export function deleteToolkit(toolkitId) {
  return request(`/api/toolkits/${encode(toolkitId)}`, { method: "DELETE" });
}

export function updateTool(toolkitId, toolId, body) {
  return request(`/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}`, { method: "PUT", body });
}

export function deleteTool(toolkitId, toolId) {
  return request(`/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}`, { method: "DELETE" });
}

export function createExploration(toolkitId, toolId, instruction, targetId) {
  return post(`/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}/explorations`, { instruction, target_id: targetId });
}

export function pauseExploration(explorationId) {
  return post(`/api/explorations/${encode(explorationId)}/pause`, { reason: "User requested pause" });
}

export function resumeExploration(explorationId, note = "") {
  return post(`/api/explorations/${encode(explorationId)}/resume`, { note });
}

export function cancelExploration(explorationId) {
  return post(`/api/explorations/${encode(explorationId)}/cancel?force=true`, { reason: "User cancelled Exploration" });
}

export function sendExplorationFollowup(explorationId, content) {
  return post(`/api/explorations/${encode(explorationId)}/messages`, { content });
}

export function replayExploration(explorationId) {
  return post(`/api/explorations/${encode(explorationId)}/replay`, { from_step: 1, new_tab: false, delay_ms: 300 });
}

export function startDevelopment(toolkitId, toolId, { instruction, sourceExplorationId = "" } = {}) {
  return post(`/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}/development/start`, {
    instruction,
    source_exploration_id: sourceExplorationId,
  });
}

export function startDevelopmentFromFormal(toolkitId, toolId) {
  return post(`/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}/development/reset-from-formal`);
}

export function restartDevelopmentFromExploration(toolkitId, toolId, sourceExplorationId, instruction) {
  return post(`/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}/development/restart-from-exploration`, {
    source_exploration_id: sourceExplorationId,
    instruction,
  });
}

export function continueDevelopment(toolkitId, toolId, instruction, debugRunEvidenceId = "") {
  return post(`/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}/development/messages`, {
    instruction,
    debug_run_evidence_id: debugRunEvidenceId,
  });
}

export function cancelDevelopment(toolkitId, toolId) {
  return post(`/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}/development/cancel`);
}

export function updateDevelopmentCode(toolkitId, toolId, code, expectedCodeHash) {
  return request(`/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}/development`, {
    method: "PUT",
    body: { code, expected_code_hash: expectedCodeHash },
  });
}

export function restartDevelopment(toolkitId, toolId) {
  return request(`/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}/development`, { method: "DELETE" });
}

export function publishTool(toolkitId, toolId) {
  return post(`/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}/publish`);
}

export function getExportStatus(toolkitId) {
  return request(`/api/toolkits/${encode(toolkitId)}/export-status`);
}

export function exportToolkitUrl(toolkitId) {
  return `/api/toolkits/${encode(toolkitId)}/export`;
}

export function getHealth() {
  return request("/api/health");
}

export function installToolkitToWeWorker(toolkitId) {
  return post(`/api/toolkits/${encode(toolkitId)}/install-to-weworker`);
}

export function runDebugTool(toolkitId, toolId, channel, parameters, expectedDistributionHash) {
  return post(`/api/toolkits/${encode(toolkitId)}/tools/${encode(toolId)}/debug-runs`, { channel, parameters, ...(channel === "formal" ? { expected_distribution_hash: expectedDistributionHash } : {}) });
}

export function cancelDebugRun(debugRunId) {
  return post(`/api/debug-runs/${encode(debugRunId)}/cancel`);
}

export function watchEvents(path, onEvent) {
  const source = new EventSource(path);
  const names = [
    "step_finished", "exploration_started", "waiting_for_user", "pause_requested", "cancel_requested",
    "exploration_succeeded", "exploration_failed", "exploration_cancelled",
    "development_started", "development_succeeded", "development_failed", "development_cancelled",
    "debug_run_started", "debug_run_succeeded", "debug_run_failed", "debug_run_cancelled",
    "replay_started", "replay_succeeded", "replay_failed", "replay_cancelled",
  ];
  for (const name of names) {
    source.addEventListener(name, (event) => {
      let data = {};
      try { data = JSON.parse(event.data || "{}"); } catch { data = {}; }
      onEvent(name, data);
    });
  }
  source.onerror = () => source.close();
  return () => source.close();
}
