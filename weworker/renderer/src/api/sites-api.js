import { backendFetch } from './http.js'
const API = 'http://127.0.0.1:8765'

async function readJsonResponse(res) {
  const text = await res.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    const hint = text.trimStart().startsWith('<')
      ? '后端接口不可用，请重启 WeWorker 后重试'
      : text.slice(0, 160)
    throw new Error(hint)
  }
}

function makeSkillImportJobId() {
  try {
    return crypto.randomUUID()
  } catch {
    return `skill-import-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  }
}

async function importSkillResourcesViaIpc(payload, onProgress) {
  const ipc = window.electronAPI?.importSkillResources
  if (!ipc) return null
  const jobId = payload.jobId || makeSkillImportJobId()
  const unsubscribe = typeof window.electronAPI?.onSkillResourceImportProgress === 'function'
    ? window.electronAPI.onSkillResourceImportProgress((progress) => {
        if (!progress || progress.id !== jobId) return
        onProgress?.(progress)
      })
    : () => {}
  try {
    onProgress?.({
      id: jobId,
      status: 'pending',
      total_bytes: 0,
      copied_bytes: 0,
      total_files: Array.isArray(payload.paths) ? payload.paths.length : 0,
      copied_files: 0,
      current_file: '',
      error: null,
    })
    const data = await ipc({ ...payload, jobId })
    return data
  } finally {
    unsubscribe?.()
  }
}

let registryIconMapCache = null

async function loadRegistryIconMap() {
  if (registryIconMapCache) return registryIconMapCache
  try {
    const res = await backendFetch(`${API}/registry-icons`)
    if (!res.ok) return null
    registryIconMapCache = await res.json()
    return registryIconMapCache
  } catch {
    return null
  }
}

/** True when /sites came from an older backend without `icon`. */
function sitesNeedIconEnrich(sites) {
  return (
    Array.isArray(sites)
    && sites.length > 0
    && sites.every((s) => s.icon == null || s.icon === '')
  )
}

/** Merge registry icons when missing on site objects (fallback for older backends). */
async function enrichSitesWithIcons(sites) {
  if (!sitesNeedIconEnrich(sites)) return sites
  const map = await loadRegistryIconMap()
  if (!map?.byId) return sites
  const fallback = map.defaultIcon || 'globe'
  return sites.map((s) => ({
    ...s,
    icon: s.icon || map.byId[s.id] || fallback,
  }))
}

export async function fetchSites() {
  const res = await backendFetch(`${API}/sites`)
  if (!res.ok) throw new Error(`failed to load sites (${res.status})`)
  const sites = await res.json()
  if (!Array.isArray(sites)) throw new Error('failed to load sites')
  return enrichSitesWithIcons(sites)
}

/**
 * 当前生效的 `!别名` 清单（后端从 router 配置算出来，含 `!` 前缀）。
 *
 * 输入框用它判断 `!xxx` 该走聊天还是走 shell。取不到时返回空数组——调用方回退到随包
 * 静态清单，绝不会因为后端暂时不可用而让 `!` 命令整体失灵。
 */
export async function fetchRouterAliases() {
  const res = await backendFetch(`${API}/router/aliases`)
  if (!res.ok) throw new Error(`failed to load router aliases (${res.status})`)
  const body = await res.json()
  return Array.isArray(body?.aliases) ? body.aliases.filter((alias) => typeof alias === 'string') : []
}

/** Bulk welcome visibility; falls back to per-site calls on older backends. */
export async function setWelcomeVisibility(visible, enabledSiteIds) {
  const targetVisible = visible === true
  const applyPerSite = () =>
    Promise.all(
      enabledSiteIds.map((id) =>
        backendFetch(`${API}/sites/${encodeURIComponent(id)}/visibility`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visible: targetVisible }),
        }),
      ),
    )

  try {
    const res = await backendFetch(`${API}/sites/welcome-visibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visible: targetVisible }),
    })
    if (!res.ok) await applyPerSite()
  } catch {
    await applyPerSite()
  }
}

export async function updateSiteScenario(siteId, scenarioId, patch) {
  let res
  try {
    res = await backendFetch(`${API}/sites/${encodeURIComponent(siteId)}/scenarios/${encodeURIComponent(scenarioId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  } catch {
    throw new Error('无法连接后端服务')
  }
  let data = {}
  try {
    data = await res.json()
  } catch {
    // ignore non-json error bodies
  }
  if (!res.ok) throw new Error(data.detail || `保存场景失败 (${res.status})`)
  return data.scenario
}

export async function createSiteScenario(siteId, scenario) {
  let res
  try {
    res = await backendFetch(`${API}/sites/${encodeURIComponent(siteId)}/scenarios`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scenario),
    })
  } catch {
    throw new Error('无法连接后端服务')
  }
  let data = {}
  try {
    data = await res.json()
  } catch {
    // ignore non-json error bodies
  }
  if (!res.ok) throw new Error(data.detail || `新增场景失败 (${res.status})`)
  return data.scenario
}

export async function deleteSiteScenario(siteId, scenarioId) {
  let res
  try {
    res = await backendFetch(`${API}/sites/${encodeURIComponent(siteId)}/scenarios/${encodeURIComponent(scenarioId)}`, {
      method: 'DELETE',
    })
  } catch {
    throw new Error('无法连接后端服务')
  }
  let data = {}
  try {
    data = await res.json()
  } catch {
    // ignore non-json error bodies
  }
  if (!res.ok) throw new Error(data.detail || `删除场景失败 (${res.status})`)
  return true
}

export async function resetSiteScenario(siteId, scenarioId, fields) {
  const options = {
    method: 'POST',
  }
  if (Array.isArray(fields) && fields.length > 0) {
    options.headers = { 'Content-Type': 'application/json' }
    options.body = JSON.stringify({ fields })
  }
  const res = await backendFetch(`${API}/sites/${encodeURIComponent(siteId)}/scenarios/${encodeURIComponent(scenarioId)}/reset`, options)
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || '恢复默认值失败')
  return data.scenario
}

export async function updateSiteCustomSkills(siteId, skills) {
  const res = await backendFetch(`${API}/sites/${encodeURIComponent(siteId)}/custom-skills`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skills }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.detail || '保存自定义 skill 失败')
  return data.skills || []
}

function isBackendUnavailableError(error) {
  if (!(error instanceof Error)) return false
  return error.message === 'Failed to fetch'
    || error.name === 'TypeError'
    || error.message.includes('后端服务未启动')
    || error.message.includes('后端接口不可用')
}

export async function importPublicSkillResources(skillName, paths, parentRelativePath = '', onProgress) {
  const ipcResult = await importSkillResourcesViaIpc({
    source: 'public-custom',
    skillId: skillName,
    paths,
    parentRelativePath: parentRelativePath || '',
  }, onProgress)
  if (ipcResult) return ipcResult.resources || []
  try {
    const res = await backendFetch(`${API}/skills/${encodeURIComponent(skillName)}/resources/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths,
        parentRelativePath: parentRelativePath || '',
      }),
    })
    const data = await readJsonResponse(res)
    if (!res.ok) throw new Error(data.detail || '导入公共 skill 资源失败')
    return data.resources || []
  } catch (apiError) {
    throw isBackendUnavailableError(apiError)
      ? new Error('后端服务未启动，请重启 WeWorker 后重试')
      : apiError
  }
}

export async function importCustomSkillResources(siteId, skillId, paths, parentRelativePath = '', onProgress, skillName = '') {
  const ipcResult = await importSkillResourcesViaIpc({
    source: 'custom',
    siteId,
    skillId,
    skillName,
    paths,
    parentRelativePath: parentRelativePath || '',
  }, onProgress)
  if (ipcResult) return ipcResult
  try {
    const res = await backendFetch(`${API}/sites/${encodeURIComponent(siteId)}/custom-skills/${encodeURIComponent(skillId)}/resources/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths,
        parentRelativePath: parentRelativePath || '',
      }),
    })
    const data = await readJsonResponse(res)
    if (!res.ok) throw new Error(data.detail || '导入 skill 资源失败')
    return data.skill
  } catch (apiError) {
    throw isBackendUnavailableError(apiError)
      ? new Error('后端服务未启动，请重启 WeWorker 后重试')
      : apiError
  }
}

export async function previewPublicSkillResource(skillName, relativePath) {
  const params = new URLSearchParams({ path: relativePath || '' })
  const res = await backendFetch(`${API}/skills/${encodeURIComponent(skillName)}/resources/preview?${params.toString()}`)
  const data = await readJsonResponse(res)
  if (!res.ok) throw new Error(data.detail || '预览资源失败')
  return data
}

export async function previewCustomSkillResource(siteId, skillId, relativePath) {
  const params = new URLSearchParams({ path: relativePath || '' })
  const res = await backendFetch(`${API}/sites/${encodeURIComponent(siteId)}/custom-skills/${encodeURIComponent(skillId)}/resources/preview?${params.toString()}`)
  const data = await readJsonResponse(res)
  if (!res.ok) throw new Error(data.detail || '预览资源失败')
  return data
}

export async function loadSkillResourcePreview({ source, skillId, siteId, relativePath }) {
  const normalizedPath = String(relativePath || '').replace(/\\/g, '/')
  try {
    if (source === 'public-custom' || source === 'third-party') {
      return await previewPublicSkillResource(skillId, relativePath)
    }
    if (source === 'custom') {
      return await previewCustomSkillResource(siteId, skillId, relativePath)
    }
    throw new Error('当前 skill 不支持预览')
  } catch (apiError) {
    try {
      if (source === 'public-custom' || source === 'third-party') {
        const fromList = await fetchPublicSkillResourceContent(skillId, normalizedPath)
        if (fromList) return fromList
      }
    } catch {}
    const ipc = window.electronAPI?.readSkillResourcePreview
    if (ipc) {
      try {
        return await ipc({ source, skillId, siteId, relativePath: normalizedPath })
      } catch (ipcError) {
        throw ipcError instanceof Error ? ipcError : apiError
      }
    }
    throw apiError instanceof Error ? apiError : new Error('预览失败')
  }
}

async function fetchPublicSkillResourceContent(skillName, relativePath) {
  const res = await backendFetch(`${API}/skills`)
  const data = await readJsonResponse(res)
  if (!res.ok) throw new Error(data.detail || '获取 skill 失败')
  const skill = Array.isArray(data)
    ? data.find((item) => item?.name === skillName)
    : null
  if (!skill) throw new Error('skill not found')
  const resource = (skill.resources || []).find((item) => item?.relativePath === relativePath)
  if (!resource || typeof resource.content !== 'string') throw new Error('resource content not available')
  return {
    ok: true,
    content: resource.content,
    truncated: false,
    isBinary: false,
    size: resource.size || resource.content.length,
    previewBytes: resource.content.length,
  }
}

export async function fetchPublicSkillDirectory(skillName) {
  const res = await backendFetch(`${API}/skills/${encodeURIComponent(skillName)}/directory`)
  const data = await readJsonResponse(res)
  if (!res.ok) throw new Error(data.detail || '获取 skill 文件夹路径失败')
  return data
}

export async function importPublicSkillZipPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('请选择 ZIP 文件')
  try {
    const res = await backendFetch(`${API}/skills/import-zip-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    })
    const data = await readJsonResponse(res)
    if (!res.ok) throw new Error(data.detail || '导入 Skill ZIP 失败')
    return data
  } catch (error) {
    if (error instanceof TypeError || error?.message === 'Failed to fetch') {
      throw new Error('后端服务未重启，请重启 WeWorker 后再导入')
    }
    throw error
  }
}

export async function fetchCustomSkillDirectory(siteId, skillId) {
  const res = await backendFetch(`${API}/sites/${encodeURIComponent(siteId)}/custom-skills/${encodeURIComponent(skillId)}/directory`)
  const data = await readJsonResponse(res)
  if (!res.ok) throw new Error(data.detail || '获取 skill 文件夹路径失败')
  return data
}
