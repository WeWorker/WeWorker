function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizeEntry(value) {
  const entry = asObject(value)
  const request = asObject(entry.request)
  const method = String(entry.method || request.method || 'GET').toUpperCase()
  const url = String(entry.url || request.url || '')
  if (!url) return null
  return {
    method,
    url,
    status: Number.isFinite(Number(entry.status)) ? Number(entry.status) : null,
  }
}

export function collectExplorationRequests(evidence) {
  const source = asObject(evidence)
  const candidates = [
    asObject(source.network).entries,
    asObject(source.initialNetwork).entries,
    asObject(source.resultPageState).networkEntries,
  ]
  const seen = new Set()
  const result = []
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    for (const rawEntry of candidate) {
      const entry = normalizeEntry(rawEntry)
      if (!entry) continue
      const key = `${entry.method} ${entry.url}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(entry)
    }
  }
  return result
}

export function explorationPhaseLabel(phase) {
  return ({
    preparing: '准备 API 分析',
    exploring: '捕获页面 API',
    analyzing: '分析 API 证据',
    completed: 'API 探索完成',
    failed: 'API 探索失败',
    cancelled: '已取消',
  })[phase] || '等待开始'
}

export function normalizeActionTimeoutSeconds(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 5) return 60
  return Math.min(Math.round(parsed), 300)
}

const ACTIVE_GENERATION_STATUSES = new Set([
  'created', 'context_ready', 'planning', 'drafting', 'static_validating',
  'revising', 'runtime_validating', 'publishing',
])

const USER_ACTION_GENERATION_STATUSES = new Set(['awaiting_approval', 'needs_user_input'])

const IN_FLIGHT_ACTION_CAPTURE_TYPES = new Set([
  'action_capture_loading', 'action_capture_stopping', 'action_capture_ai_loading',
])

export function isGenerationStatusActive(status) {
  return ACTIVE_GENERATION_STATUSES.has(String(status || ''))
}

export function isActionCaptureInFlight(actionCapture) {
  const capture = asObject(actionCapture)
  return IN_FLIGHT_ACTION_CAPTURE_TYPES.has(String(capture.type || ''))
}

export function shouldAutoRestoreExplorationRun(run) {
  const source = asObject(run)
  if (!source.taskId) return false
  if (source.status === 'preparing' || source.status === 'running') return true
  if (isActionCaptureInFlight(source.actionCapture)) return true
  const generation = asObject(source.generationRun)
  if (generation.status) {
    if (isGenerationStatusActive(generation.status)) return true
    if (USER_ACTION_GENERATION_STATUSES.has(String(generation.status))) return true
  }
  return false
}

export function restoredRunNotice(run) {
  const source = asObject(run)
  if (source.status === 'preparing' || source.status === 'running') {
    return '上一次 API 探索仍在进行，已恢复进度展示。'
  }
  if (isActionCaptureInFlight(source.actionCapture)) {
    return '上一次操作捕获尚未结束，已恢复捕获状态。'
  }
  const generation = asObject(source.generationRun)
  const status = String(generation.status || '')
  if (isGenerationStatusActive(status)) {
    return '上一次 Adapter 生成仍在进行，已恢复进度展示。'
  }
  if (status === 'awaiting_approval') {
    return '上一次智能生成正在等待确认发布，请在下方结果中处理。'
  }
  if (status === 'needs_user_input') {
    return '上一次智能生成需要补充信息，请在下方结果中处理。'
  }
  return '已恢复上一次 API 探索任务。'
}

export function lastRunSummaryLine(run) {
  const source = asObject(run)
  const parts = [explorationPhaseLabel(source.phase)]
  const tabTitle = String(asObject(source.tab).title || '').trim()
  if (tabTitle) parts.push(tabTitle.length > 24 ? `${tabTitle.slice(0, 24)}…` : tabTitle)
  const count = collectExplorationRequests(source.evidence).length
  if (count > 0) parts.push(`${count} 个接口`)
  return parts.join(' · ')
}

const GENERATION_FAILURE_STATUSES = new Set(['failed', 'cancelled', 'budget_exceeded'])

/**
 * 失败归因提示：优先使用 Harness 下发的 failureAttribution，
 * 返回 { summary, retryHint }；无归因时返回 null（调用方回退到原始错误信息）。
 */
export function generationFailureHint(generation) {
  const source = asObject(generation)
  if (!GENERATION_FAILURE_STATUSES.has(String(source.status || ''))) return null
  const attribution = asObject(source.failureAttribution)
  const summary = String(attribution.summary || '').trim()
  if (!summary) return null
  const recommendedAction = String(attribution.recommendedAction || '').trim()
  const retryHint = recommendedAction === 'reopen_and_retry'
    ? '请先打开并登录目标页面，再点击「重新智能生成」。'
    : '点击「重新智能生成」会携带本次失败上下文，规划阶段将针对失败原因调整计划。'
  return { summary, retryHint }
}

/**
 * 编排模式等待用户输入时的问题：来自 pendingQuestion 顶层字段或 artifacts.pendingQuestion，
 * 返回 { question, context }；无问题返回 null。
 */
export function generationPendingQuestion(generation) {
  const source = asObject(generation)
  if (String(source.status || '') !== 'needs_user_input') return null
  const artifacts = asObject(source.artifacts)
  const pending = asObject(source.pendingQuestion || artifacts.pendingQuestion)
  const question = String(pending.question || '').trim()
  if (!question) return null
  return { question, context: String(pending.context || '').trim() }
}

/**
 * 任务步骤条状态机：捕获页面 → 分析证据 → 补充录制 → 生成 Adapter → 发布安装。
 * 返回 antd Steps 的 current/status；loading 表示当前阶段由系统执行中
 * （探索/捕获/生成进行时），等待用户操作的阶段（待录制、待确认发布）为 false。
 * 无任务时 current 为 -1。
 */
export function explorationTaskSteps(run) {
  const source = asObject(run)
  if (!source.taskId) return { current: -1, status: 'wait', loading: false }
  const phase = String(source.phase || '')
  if (source.status === 'preparing' || source.status === 'running') {
    return { current: phase === 'analyzing' ? 1 : 0, status: 'process', loading: true }
  }
  if (source.status === 'failed') {
    return { current: phase === 'exploring' ? 0 : 1, status: 'error', loading: false }
  }
  if (source.status === 'cancelled') {
    return { current: 0, status: 'wait', loading: false }
  }
  if (isActionCaptureInFlight(source.actionCapture)) {
    return { current: 2, status: 'process', loading: true }
  }
  const generation = asObject(source.generationRun)
  const generationStatus = String(generation.status || '')
  if (source.generationRunId || source.scaffoldResult || generationStatus) {
    if (source.scaffoldResult || generationStatus === 'completed') {
      return { current: 4, status: 'finish', loading: false }
    }
    if (GENERATION_FAILURE_STATUSES.has(generationStatus)) {
      return { current: 3, status: 'error', loading: false }
    }
    return { current: 3, status: 'process', loading: isGenerationStatusActive(generationStatus) }
  }
  return { current: 2, status: 'process', loading: false }
}
