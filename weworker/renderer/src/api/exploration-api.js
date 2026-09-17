import { backendFetch } from './http.js'

async function readJsonResponse(response) {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.detail || `Request failed: ${response.status}`)
  return data
}

export async function fetchExplorationCapabilities() {
  return readJsonResponse(await backendFetch('/exploration/capabilities'))
}

export async function fetchExplorableTabs() {
  const data = await readJsonResponse(await backendFetch('/exploration/tabs'))
  return Array.isArray(data.tabs) ? data.tabs : []
}

export async function startExplorationRun({ goal, tabId }) {
  return readJsonResponse(await backendFetch('/exploration/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal, tabId }),
  }))
}

export async function fetchExplorationRun(taskId) {
  return readJsonResponse(await backendFetch(`/exploration/runs/${encodeURIComponent(taskId)}`))
}

export async function cancelExplorationRun(taskId) {
  return readJsonResponse(await backendFetch(`/exploration/runs/${encodeURIComponent(taskId)}/cancel`, {
    method: 'POST',
  }))
}

export async function saveExplorationMemory(taskId) {
  return readJsonResponse(await backendFetch(`/exploration/runs/${encodeURIComponent(taskId)}/save`, {
    method: 'POST',
  }))
}

export async function generateExplorationScaffold(taskId) {
  return readJsonResponse(await backendFetch(`/exploration/runs/${encodeURIComponent(taskId)}/scaffold`, {
    method: 'POST',
  }))
}

export async function startExplorationActionCapture(taskId, input) {
  return readJsonResponse(await backendFetch(`/exploration/runs/${encodeURIComponent(taskId)}/action-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }))
}

export async function fetchExplorationActionCapture(taskId) {
  return readJsonResponse(await backendFetch(`/exploration/runs/${encodeURIComponent(taskId)}/action-capture`))
}

export async function stopExplorationActionCapture(taskId) {
  return readJsonResponse(await backendFetch(`/exploration/runs/${encodeURIComponent(taskId)}/action-capture/stop`, {
    method: 'POST',
  }))
}

export async function selectExplorationActionCandidate(taskId, candidateIndex) {
  return readJsonResponse(await backendFetch(`/exploration/runs/${encodeURIComponent(taskId)}/action-capture/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidateIndex }),
  }))
}

export async function clearExplorationActionCapture(taskId) {
  return readJsonResponse(await backendFetch(`/exploration/runs/${encodeURIComponent(taskId)}/action-capture/clear`, {
    method: 'POST',
  }))
}

export async function startExplorationGeneration(taskId, options = {}) {
  const payload = {}
  if (typeof options.goal === 'string' && options.goal.trim()) payload.goal = options.goal.trim()
  if (options.mode === 'agent' || options.mode === 'classic') payload.mode = options.mode
  return readJsonResponse(await backendFetch(`/exploration/runs/${encodeURIComponent(taskId)}/generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }))
}

export async function resumeExplorationGeneration(taskId, answer) {
  return readJsonResponse(await backendFetch(`/exploration/runs/${encodeURIComponent(taskId)}/generation/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }),
  }))
}

export async function fetchExplorationGeneration(taskId) {
  return readJsonResponse(await backendFetch(`/exploration/runs/${encodeURIComponent(taskId)}/generation`))
}

export async function cancelExplorationGeneration(taskId) {
  return readJsonResponse(await backendFetch(`/exploration/runs/${encodeURIComponent(taskId)}/generation/cancel`, {
    method: 'POST',
  }))
}

export async function publishExplorationGeneration(taskId) {
  return readJsonResponse(await backendFetch(`/exploration/runs/${encodeURIComponent(taskId)}/generation/publish`, {
    method: 'POST',
  }))
}
