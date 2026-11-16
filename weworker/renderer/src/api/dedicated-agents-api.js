import { backendFetch } from './http.js'

async function readJsonResponse(response) {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.detail || `请求失败（${response.status}）`)
  return data
}

function postJson(path, body, method = 'POST') {
  return backendFetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(readJsonResponse)
}

const agentPath = (id) => `/dedicated-agents/${encodeURIComponent(id)}`

export async function fetchAgents() {
  const data = await readJsonResponse(await backendFetch('/dedicated-agents'))
  return Array.isArray(data.agents) ? data.agents : []
}

export async function fetchAgentDetail(id) {
  return readJsonResponse(await backendFetch(agentPath(id)))
}

export function createAgent(body) {
  return postJson('/dedicated-agents', body)
}

export function updateAgent(id, patch) {
  return postJson(agentPath(id), patch, 'PATCH')
}

export function resetAgentPairing(id) {
  return postJson(`${agentPath(id)}/pairing/reset`, {})
}

export async function deleteAgent(id, { keepConversations = false } = {}) {
  return readJsonResponse(await backendFetch(`${agentPath(id)}${keepConversations ? '?keep_conversations=1' : ''}`, { method: 'DELETE' }))
}

export function startWecomQr() {
  return postJson('/dedicated-agents/wecom-qr/start', {})
}

export function pollWecomQr(sessionId) {
  return postJson('/dedicated-agents/wecom-qr/poll', { session_id: sessionId })
}

export function startWeixinQr() {
  return postJson('/dedicated-agents/weixin-qr/start', {})
}

export function pollWeixinQr(sessionId) {
  return postJson('/dedicated-agents/weixin-qr/poll', { session_id: sessionId })
}

export async function fetchAgentSkills() {
  const data = await readJsonResponse(await backendFetch('/dedicated-agents/skills'))
  return Array.isArray(data.skills) ? data.skills : []
}

export async function fetchAgentSkill(name) {
  return readJsonResponse(await backendFetch(`/dedicated-agents/skills/${encodeURIComponent(name)}`))
}

/** Update history for a skill (desktop edits and conversation rewrites), newest first. */
export async function fetchSkillUpdates(name) {
  const data = readJsonResponse(await backendFetch(`/dedicated-agents/skills/${encodeURIComponent(name)}/updates`))
  return Array.isArray(data.updates) ? data.updates : []
}

export function suggestSkillName(siteId) {
  return postJson('/dedicated-agents/skills/suggest-name', { site_id: siteId })
}

export function generateSkill(body) {
  return postJson('/dedicated-agents/skills/generate', body)
}

export function reviseSkill(body) {
  return postJson('/dedicated-agents/skills/revise', body)
}

/** scope: 'private' (only dedicated agents) or 'public' (also the main chat). */
export function createSkill(skillName, markdown, scope = 'private') {
  return postJson('/dedicated-agents/skills', { skill_name: skillName, markdown, scope })
}

export function setSkillScope(skillName, scope) {
  return postJson(`/dedicated-agents/skills/${encodeURIComponent(skillName)}/scope`, { scope })
}

export function createConversation(agentId) {
  return postJson(`${agentPath(agentId)}/conversations`, {})
}

export async function deleteConversation(agentId, workId) {
  return readJsonResponse(await backendFetch(`${agentPath(agentId)}/conversations/${encodeURIComponent(workId)}`, { method: 'DELETE' }))
}

export function importSkillFile(sourcePath, scope = 'private', skillName = '') {
  return postJson('/dedicated-agents/skills/import', {
    source_path: sourcePath,
    scope,
    ...(skillName ? { skill_name: skillName } : {}),
  })
}

export function saveSkill(skillName, markdown) {
  return postJson(`/dedicated-agents/skills/${encodeURIComponent(skillName)}`, { markdown }, 'PUT')
}

export async function fetchWorkMessages(workId) {
  const data = await readJsonResponse(await backendFetch(`/works/${encodeURIComponent(workId)}`))
  return Array.isArray(data.messages) ? data.messages : []
}
