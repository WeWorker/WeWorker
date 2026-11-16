// 快速创建流程专用的少量 API 封装（其余复用 api/dedicated-agents-api.js）。
import { backendFetch } from '../../../api/http.js'

async function readJsonResponse(response) {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.detail || `请求失败（${response.status}）`)
  return data
}

const agentPath = (id) => `/dedicated-agents/${encodeURIComponent(id)}`

/** 快速创建流程在配对完成后调用，为 Bot 注册定时任务。 */
export async function createAgentTask(agentId, { title, cron_expression, prompt_template, targets }) {
  return readJsonResponse(await backendFetch(`${agentPath(agentId)}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, cron_expression, prompt_template, targets }),
  }))
}

/** 该 Bot 已观察到的通知目标（企微会话），返回最新在前。 */
export async function fetchAgentNotificationTargets(agentId) {
  const data = await readJsonResponse(await backendFetch(`${agentPath(agentId)}/notification-targets`))
  return Array.isArray(data.targets) ? data.targets : []
}

/** 该 Bot 现有的定时任务（用于重挂载/刷新后按标题去重，避免重复创建）。 */
export async function fetchAgentTasks(agentId) {
  const data = await readJsonResponse(await backendFetch(`${agentPath(agentId)}/tasks`))
  return Array.isArray(data.tasks) ? data.tasks : []
}
