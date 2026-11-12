import { backendFetch } from './http.js'
import { useWorksStore } from '../store/works.js'

async function request(path, options = {}) {
  let response
  try {
    const workId = useWorksStore.getState().activeWorkId
    if (!workId) throw new Error('请先打开一个对话工作区')
    const separator = path.includes('?') ? '&' : '?'
    response = await backendFetch(`/router/fast-routes${path}${separator}workId=${encodeURIComponent(workId)}`, options)
  } catch (error) {
    if (error?.message === '请先打开一个对话工作区') throw error
    throw new Error('无法连接后端服务')
  }
  const raw = await response.text()
  let data = {}
  if (raw) {
    try { data = JSON.parse(raw) } catch { throw new Error('后端返回格式无效') }
  }
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `请求失败 (${response.status})`)
  return data
}

const candidatePath = (id) => `/candidates/${encodeURIComponent(id)}`
const jsonPost = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export async function listFastRoutes() {
  const data = await request('')
  if (!Array.isArray(data.candidates) || !Array.isArray(data.routes)) throw new Error('快捷路由列表格式无效')
  return data
}

export const testFastRouteCandidate = (id, displayFields = []) => request(`${candidatePath(id)}/test`, jsonPost({ displayFields }))
export const approveFastRouteCandidate = (id, displayFields, previewToken, expectedRevision) =>
  request(`${candidatePath(id)}/approve`, jsonPost({ displayFields, previewToken, expectedRevision }))
export const ignoreFastRouteCandidate = (id) => request(`${candidatePath(id)}/ignore`, jsonPost({}))
export const deleteLocalFastRoute = (id, expectedRevision) => request(`/local/${encodeURIComponent(id)}`, {
  method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision }),
})
