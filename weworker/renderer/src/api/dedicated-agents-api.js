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

/**
 * Skill 分块安全大小：实测个别机器/安全策略会拦截大请求体的回环上传（1KB 通过、20KB 起被拦，
 * 拦截边界由 net-selftest 的梯度扫描写进日志）。1KB 是已被实测验证安全的大小，
 * 且按「JSON 包装后的完整请求体」计算——切片本身要再减去包装开销与转义膨胀（换行会变成 \n 两个字符）。
 */
const SKILL_UPLOAD_SAFE_REQUEST_BYTES = 1024

/** 按包装后的请求体字节安全切片：每片 JSON.stringify 后不得超过安全线（转义膨胀自动收缩）。 */
function sliceSkillChunks(markdown, maxRequestBytes = SKILL_UPLOAD_SAFE_REQUEST_BYTES) {
  const chunks = []
  let rest = markdown
  while (rest.length > 0) {
    let take = Math.min(rest.length, 512)
    while (take > 1 && JSON.stringify({ data: rest.slice(0, take) }).length > maxRequestBytes) {
      take = Math.floor(take / 2)
    }
    chunks.push(rest.slice(0, Math.max(take, 1)))
    rest = rest.slice(Math.max(take, 1))
  }
  return chunks
}

/**
 * 大内容整包上传被网络层拦截时的兜底：拆成多个小分块（包装后 ≤1KB），经 start/chunk/complete 组装。
 * 每个小请求本身都能通过，与普通上传走同一套冲突（409「已存在」）与校验逻辑。
 */
async function createSkillChunked(skillName, markdown, scope) {
  const chunks = sliceSkillChunks(markdown)
  const started = await postJson('/dedicated-agents/skills/chunked/start', { skill_name: skillName, scope, total_chunks: chunks.length })
  for (let index = 0; index < chunks.length; index += 1) {
    await postJson(`/dedicated-agents/skills/chunked/${encodeURIComponent(started.upload_id)}/${index}`, { data: chunks[index] }, 'PUT')
  }
  return postJson(`/dedicated-agents/skills/chunked/${encodeURIComponent(started.upload_id)}/complete`, {})
}

/** scope: 'private' (only dedicated agents) or 'public' (also the main chat). */
export async function createSkill(skillName, markdown, scope = 'private') {
  try {
    return await postJson('/dedicated-agents/skills', { skill_name: skillName, markdown, scope })
  } catch (error) {
    const blocked = /无法连接 WeWorker 后端/.test(String(error?.message || ''))
    if (!blocked || typeof markdown !== 'string' || JSON.stringify({ skill_name: skillName, markdown, scope }).length <= SKILL_UPLOAD_SAFE_REQUEST_BYTES) throw error
    // 整包大请求在网络层被拦（按体积拦截的场景）：改走分块上传兜底（设置-日志搜「分块上传」）。
    console.error(`[renderer] 整包上传被拦，切换分块上传 chunked-upload：${skillName}（内容 ${markdown.length} 字符）`)
    return createSkillChunked(skillName, markdown, scope)
  }
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
