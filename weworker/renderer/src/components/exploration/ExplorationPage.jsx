import React, { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Input,
  InputNumber,
  Popconfirm,
  Progress,
  Select,
  Space,
  Steps,
  Tag,
  Tooltip,
} from 'antd'
import { LoadingOutlined } from '@ant-design/icons'
import {
  cancelExplorationRun,
  cancelExplorationGeneration,
  clearExplorationActionCapture,
  fetchExplorableTabs,
  fetchExplorationActionCapture,
  fetchExplorationCapabilities,
  fetchExplorationGeneration,
  fetchExplorationRun,
  publishExplorationGeneration,
  resumeExplorationGeneration,
  retryExplorationActionAnalysis,
  saveExplorationMemory,
  selectExplorationActionCandidate,
  startExplorationRun,
  startExplorationActionCapture,
  startExplorationGeneration,
  stopExplorationActionCapture,
} from '../../api/exploration-api.js'
import {
  collectExplorationRequests,
  explorationPhaseLabel,
  explorationTaskSteps,
  generationFailureHint,
  generationPendingQuestion,
  isActionCaptureInFlight,
  isGenerationStatusActive,
  lastRunSummaryLine,
  normalizeActionTimeoutSeconds,
  restoredRunNotice,
  shouldAutoRestoreExplorationRun,
} from '../../utils/exploration-evidence.js'

const cardStyle = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--bg-secondary)',
  padding: 16,
}

const TASK_STEP_ITEMS = [
  { title: '捕获页面' },
  { title: '分析证据' },
  { title: '补充录制' },
  { title: '生成 Adapter' },
  { title: '本机安装' },
]

function normalizeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return ({
    BRIDGE_DISCONNECTED: 'WebCLI Bridge 尚未连接，请确认客户端服务正在运行。',
    EXTENSION_DISCONNECTED: 'Chrome 插件尚未连接，请确认插件已经启用。',
    EXTENSION_CAPABILITY_MISSING: '当前插件版本不支持客户端探索，请更新并重新加载插件。',
    TARGET_TAB_NOT_FOUND: '目标页面已经关闭或发生变化，请重新选择。',
  })[message] || message
}

function generationStatusLabel(status) {
  return ({
    created: '准备生成',
    context_ready: '整理探索证据',
    planning: 'Agent 制定生成计划',
    drafting: '生成 Adapter 草稿',
    static_validating: '静态验证',
    revising: '修正草稿',
    runtime_validating: '页面运行验证',
    publishing: '安装 Adapter',
    awaiting_approval: '等待确认安装',
    completed: '已安装',
    failed: '生成失败',
    cancelled: '已取消',
    budget_exceeded: '达到生成预算上限',
    needs_user_input: '需要补充信息',
  })[status] || '生成准备中'
}

function generationFailure(status) {
  return ['failed', 'cancelled', 'budget_exceeded', 'needs_user_input'].includes(status)
}

function previewText(value, limit = 1200) {
  if (value == null || value === '') return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function isPrimaryCaptureCandidate(candidate, index, capture) {
  if (candidate?.userSelectedPrimary) return true
  const update = capture?.result?.siteMemoryUpdate || {}
  return update.selectedUrl === candidate?.url
    && String(update.selectedMethod || '').toUpperCase() === String(candidate?.method || 'GET').toUpperCase()
    && (!Number.isInteger(capture?.selectedCandidateIndex) || capture.selectedCandidateIndex === index)
}

function methodTagColor(method) {
  return ({
    GET: 'green',
    POST: 'blue',
    PUT: 'geekblue',
    PATCH: 'purple',
    DELETE: 'red',
  })[String(method || 'GET').toUpperCase()] || 'default'
}

export default function ExplorationPage({ onClose }) {
  const [capabilities, setCapabilities] = useState(null)
  const [tabs, setTabs] = useState([])
  const [selectedTabId, setSelectedTabId] = useState('')
  const [goal, setGoal] = useState('分析当前页面可以沉淀哪些稳定、可复用的 API 查询能力')
  const [actionName, setActionName] = useState('')
  const [actionMode, setActionMode] = useState('intercept')
  const [actionTimeoutSeconds, setActionTimeoutSeconds] = useState(60)
  const [actionPattern, setActionPattern] = useState('')
  const [run, setRun] = useState(null)
  const [lastRun, setLastRun] = useState(null)
  const [restoreNotice, setRestoreNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [generationMessage, setGenerationMessage] = useState('')
  const [busyAction, setBusyAction] = useState('')
  const [captureElapsed, setCaptureElapsed] = useState(0)
  const [resumeAnswer, setResumeAnswer] = useState('')

  const requests = useMemo(() => collectExplorationRequests(run?.evidence), [run?.evidence])
  const running = run?.status === 'preparing' || run?.status === 'running'
  const generation = run?.generationRun
  const generationRunning = isGenerationStatusActive(generation?.status)
  const actionCapture = run?.actionCapture
  const actionAnalysisError = actionCapture?.result?.actionAnalysis?.aiError
  const actionCaptureRunning = isActionCaptureInFlight(actionCapture)
  const actionCaptureRecording = actionCapture?.type === 'action_capture_loading'
  const generationStarted = Boolean(run?.generationRunId || run?.scaffoldResult)
  const runCollapsible = Boolean(run) && !running && !shouldAutoRestoreExplorationRun(run)
  const taskSteps = explorationTaskSteps(run)
  const taskTitle = String(run?.tab?.title || run?.goal || 'API 探索任务').trim()
  const anyBusy = busyAction !== ''
  const pendingQuestion = generationPendingQuestion(generation)
  const failureHint = generationFailureHint(generation)

  const loadRuntime = async () => {
    setLoading(true)
    setError('')
    try {
      const nextCapabilities = await fetchExplorationCapabilities()
      setCapabilities(nextCapabilities)
      if (!nextCapabilities.passiveExploration) {
        if (!nextCapabilities.bridgeConnected) throw new Error('BRIDGE_DISCONNECTED')
        if (!nextCapabilities.extensionConnected) throw new Error('EXTENSION_DISCONNECTED')
        throw new Error('EXTENSION_CAPABILITY_MISSING')
      }
      const nextTabs = await fetchExplorableTabs()
      setTabs(nextTabs)
      const active = nextTabs.find((tab) => tab.active) || nextTabs[0]
      setSelectedTabId((current) => nextTabs.some((tab) => String(tab.id) === String(current))
        ? current
        : (active ? String(active.id) : ''))
    } catch (nextError) {
      setError(normalizeError(nextError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadRuntime()
  }, [])

  useEffect(() => {
    const taskId = window.localStorage.getItem('weworker:last-exploration-task')
    if (!taskId) return
    fetchExplorationRun(taskId)
      .then((savedRun) => {
        if (shouldAutoRestoreExplorationRun(savedRun)) {
          setRun(savedRun)
          setRestoreNotice(restoredRunNotice(savedRun))
        } else {
          setLastRun(savedRun)
        }
      })
      .catch((restoreError) => {
        // 任务不存在才清除指针；网络失败（如后端尚未就绪）保留指针，等待下次加载恢复。
        const message = restoreError instanceof Error ? restoreError.message : String(restoreError)
        if (message === 'EXPLORATION_RUN_NOT_FOUND') {
          window.localStorage.removeItem('weworker:last-exploration-task')
        }
      })
  }, [])

  useEffect(() => {
    if (restoreNotice && run && !shouldAutoRestoreExplorationRun(run)) setRestoreNotice('')
  }, [run, restoreNotice])

  useEffect(() => {
    if (!run?.taskId || !running) return undefined
    let stopped = false
    const poll = async () => {
      try {
        const nextRun = await fetchExplorationRun(run.taskId)
        if (!stopped) setRun(nextRun)
      } catch (nextError) {
        if (!stopped) setError(normalizeError(nextError))
      }
    }
    const timer = window.setInterval(poll, 900)
    void poll()
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [run?.taskId, running])

  useEffect(() => {
    if (!run?.taskId || !run?.generationRunId || !generationRunning) return undefined
    let stopped = false
    const poll = async () => {
      try {
        const nextRun = await fetchExplorationGeneration(run.taskId)
        if (!stopped) setRun(nextRun)
      } catch (nextError) {
        if (!stopped) setGenerationMessage(normalizeError(nextError))
      }
    }
    const timer = window.setInterval(poll, 1000)
    void poll()
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [run?.taskId, run?.generationRunId, generationRunning])

  useEffect(() => {
    if (!run?.taskId || !actionCaptureRunning) return undefined
    let stopped = false
    const poll = async () => {
      try {
        const nextRun = await fetchExplorationActionCapture(run.taskId)
        if (!stopped && nextRun) {
          setRun(nextRun)
          if (nextRun.actionCapture?.status !== 'running') setGenerationMessage('')
        }
      } catch (nextError) {
        if (!stopped) setGenerationMessage(normalizeError(nextError))
      }
    }
    const timer = window.setInterval(poll, 1000)
    void poll()
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [run?.taskId, actionCaptureRunning])

  useEffect(() => {
    if (!actionCaptureRecording) {
      setCaptureElapsed(0)
      return undefined
    }
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setCaptureElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [actionCaptureRecording])

  const handleStart = async () => {
    if (!goal.trim() || !selectedTabId || busyAction) return
    setBusyAction('start')
    setError('')
    setGenerationMessage('')
    setRestoreNotice('')
    setLastRun(null)
    setRun(null)
    try {
      const nextRun = await startExplorationRun({ goal: goal.trim(), tabId: Number(selectedTabId) })
      window.localStorage.setItem('weworker:last-exploration-task', nextRun.taskId)
      setRun(nextRun)
    } catch (nextError) {
      setError(normalizeError(nextError))
    } finally {
      setBusyAction('')
    }
  }

  const handleOpenLastRun = () => {
    if (!lastRun) return
    setRestoreNotice('')
    setRun(lastRun)
  }

  const handleCollapseRun = () => {
    if (!run || !runCollapsible) return
    setLastRun(run)
    setRun(null)
  }

  const handleSaveMemory = async () => {
    if (!run?.taskId || busyAction) return
    setBusyAction('saveMemory')
    setGenerationMessage('')
    try {
      setRun(await saveExplorationMemory(run.taskId))
      setGenerationMessage('探索结果已保存，可以开始生成 Adapter。')
    } catch (nextError) {
      setGenerationMessage(normalizeError(nextError))
    } finally {
      setBusyAction('')
    }
  }

  const handleStartActionCapture = async () => {
    if (!run?.taskId || busyAction || !actionName.trim()) return
    setBusyAction('startCapture')
    setGenerationMessage('已开始捕获操作，请回到目标页面完成一次真实操作。')
    try {
      setRun(await startExplorationActionCapture(run.taskId, {
        actionName: actionName.trim(),
        mode: actionMode,
        timeoutSeconds: normalizeActionTimeoutSeconds(actionTimeoutSeconds),
        pattern: actionPattern.trim(),
      }))
    } catch (nextError) {
      setGenerationMessage(normalizeError(nextError))
    } finally {
      setBusyAction('')
    }
  }

  const handleStopActionCapture = async () => {
    if (!run?.taskId || busyAction) return
    setBusyAction('stopCapture')
    setGenerationMessage('正在结束捕获并整理操作结果…')
    try {
      setRun(await stopExplorationActionCapture(run.taskId))
      setGenerationMessage('')
    } catch (nextError) {
      setGenerationMessage(normalizeError(nextError))
    } finally {
      setBusyAction('')
    }
  }

  const handleSelectActionCandidate = async (candidateIndex) => {
    if (!run?.taskId || busyAction) return
    setBusyAction(`selectCandidate:${candidateIndex}`)
    setGenerationMessage('正在更新主接口…')
    try {
      setRun(await selectExplorationActionCandidate(run.taskId, candidateIndex))
      setGenerationMessage('已更新主接口，生成工具时会优先使用该请求。')
    } catch (nextError) {
      setGenerationMessage(normalizeError(nextError))
    } finally {
      setBusyAction('')
    }
  }

  const handlePrepareNextActionCapture = async () => {
    if (!run?.taskId || busyAction) return
    setBusyAction('nextCapture')
    setGenerationMessage('')
    try {
      setRun(await clearExplorationActionCapture(run.taskId))
      setActionName('')
      setActionMode('intercept')
      setActionTimeoutSeconds(60)
      setActionPattern('')
      setGenerationMessage('已保留此前录制证据，可以继续录制下一个操作。')
    } catch (nextError) {
      setGenerationMessage(normalizeError(nextError))
    } finally {
      setBusyAction('')
    }
  }

  const handleRetryActionAnalysis = async () => {
    if (!run?.taskId || busyAction) return
    setBusyAction('retryAnalysis')
    try {
      setRun(await retryExplorationActionAnalysis(run.taskId))
      setGenerationMessage('正在重新分析已有捕获证据，不会重复操作网站。')
    } catch (nextError) {
      setGenerationMessage(normalizeError(nextError))
    } finally {
      setBusyAction('')
    }
  }

  const handleQuickGenerate = async () => {
    if (!run?.taskId || busyAction) return
    setBusyAction('quickGenerate')
    setGenerationMessage('正在生成 Adapter 草稿…')
    try {
      setRun(await startExplorationGeneration(run.taskId, { mode: 'auto' }))
      setGenerationMessage('已开始生成并验证；需要时会自动修复一次，通过后可确认安装。')
    } catch (nextError) {
      setGenerationMessage(normalizeError(nextError))
    } finally {
      setBusyAction('')
    }
  }

  const handleResumeGeneration = async () => {
    if (!run?.taskId || busyAction || !resumeAnswer.trim()) return
    setBusyAction('resumeGeneration')
    setGenerationMessage('正在提交回答并继续生成…')
    try {
      setRun(await resumeExplorationGeneration(run.taskId, resumeAnswer.trim()))
      setResumeAnswer('')
      setGenerationMessage('已提交回答，生成从暂停点继续。')
    } catch (nextError) {
      setGenerationMessage(normalizeError(nextError))
    } finally {
      setBusyAction('')
    }
  }

  const handleSmartGenerate = async () => {
    if (!run?.taskId || busyAction) return
    setBusyAction('smartGenerate')
    setGenerationMessage('正在启动智能生成…')
    try {
      setRun(await startExplorationGeneration(run.taskId, { mode: 'agent' }))
      setGenerationMessage('智能生成已启动，客户端会持续显示草稿和验证进度。')
    } catch (nextError) {
      setGenerationMessage(normalizeError(nextError))
    } finally {
      setBusyAction('')
    }
  }

  const handleCancelGeneration = async () => {
    if (!run?.taskId || busyAction) return
    setBusyAction('cancelGeneration')
    try {
      setRun(await cancelExplorationGeneration(run.taskId))
      setGenerationMessage('已取消生成任务。')
    } catch (nextError) {
      setGenerationMessage(normalizeError(nextError))
    } finally {
      setBusyAction('')
    }
  }

  const handlePublishGeneration = async () => {
    if (!run?.taskId || busyAction) return
    setBusyAction('publishGeneration')
    setGenerationMessage('正在安装并刷新目标页面…')
    try {
      const nextRun = await publishExplorationGeneration(run.taskId, {
        reviewId: generation?.artifacts?.installationReview?.reviewId, acceptChanges: true,
      })
      setRun(nextRun)
      if (nextRun.generationRun?.status !== 'completed') {
        setGenerationMessage(nextRun.generationRun?.lastError?.message || '请重新检查安装信息并确认。')
        return
      }
      setGenerationMessage(nextRun.generationRefreshError
        ? `Adapter 已安装，但目标页面刷新失败：${nextRun.generationRefreshError}`
        : 'Adapter 已安装，目标页面已刷新。')
    } catch (nextError) {
      setGenerationMessage(normalizeError(nextError))
    } finally {
      setBusyAction('')
    }
  }

  const handleCancel = async () => {
    if (!run?.taskId || busyAction) return
    setBusyAction('cancelRun')
    try {
      setRun(await cancelExplorationRun(run.taskId))
    } catch (nextError) {
      setError(normalizeError(nextError))
    } finally {
      setBusyAction('')
    }
  }

  const timeoutSeconds = normalizeActionTimeoutSeconds(actionTimeoutSeconds)
  const captureProgress = Math.min(100, Math.round((captureElapsed / Math.max(timeoutSeconds, 1)) * 100))

  return (
    <section style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)' }}>
      <header style={{
        minHeight: 58,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '0 22px',
        borderBottom: '1px solid var(--border)',
        position: 'sticky',
        top: 0,
        zIndex: 2,
        background: 'var(--bg-primary)',
      }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>网站 API 探索</div>
          <div style={{ marginTop: 3, fontSize: 11, color: 'var(--text-muted)' }}>客户端分析页面 API，Chrome 插件只执行被动网络捕获</div>
        </div>
        <button type="button" onClick={onClose} style={{ border: 0, background: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
      </header>

      <div style={{ width: 'min(960px, calc(100% - 40px))', margin: '22px auto 44px', display: 'grid', gap: 14 }}>
        {!run && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>新建 API 探索</div>
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>请选择明确的页面；探索开始后该页面会刷新一次。</div>
              </div>
              <Button data-app-button="action" size="small" onClick={loadRuntime} loading={loading} disabled={loading}>刷新页面列表</Button>
            </div>

            <label style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Chrome 页面</span>
              <Select
                value={selectedTabId || undefined}
                onChange={setSelectedTabId}
                disabled={tabs.length === 0}
                placeholder={tabs.length === 0 ? '没有可探索的 HTTP(S) 页面' : '选择要探索的页面'}
                style={{ width: '100%' }}
                options={tabs.map((tab) => ({
                  value: String(tab.id),
                  label: `${tab.active ? '当前 · ' : ''}${tab.title || tab.url}`,
                }))}
                showSearch
                optionFilterProp="label"
              />
            </label>

            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>希望分析哪些 API 能力</span>
              <Input.TextArea
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                rows={3}
                maxLength={2000}
                style={{ resize: 'vertical' }}
              />
            </label>

            {error && <Alert type="error" showIcon style={{ marginTop: 12 }} message={error} />}

            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <Button data-app-button="action"
                type="primary"
                loading={busyAction === 'start'}
                disabled={loading || anyBusy || !selectedTabId || !goal.trim() || !capabilities?.passiveExploration}
                onClick={handleStart}
              >
                开始 API 探索
              </Button>
            </div>
          </div>
        )}

        {restoreNotice && (
          <Alert
            type="info"
            showIcon
            closable
            onClose={() => setRestoreNotice('')}
            message={<span>继续上次探索 · {restoreNotice}</span>}
          />
        )}

        {lastRun && !run && (
          <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>上次探索 · {lastRunSummaryLine(lastRun)}</div>
              {String(lastRun.goal || '').trim() && (
                <div title={lastRun.goal} style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lastRun.goal}</div>
              )}
            </div>
            <Button data-app-button="action" style={{ flexShrink: 0 }} onClick={handleOpenLastRun}>查看上次探索结果</Button>
          </div>
        )}

        {run && (
          <>
            <div style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{taskTitle}</span>
                    <Tag color={run.status === 'failed' ? 'error' : running ? 'processing' : 'success'} style={{ marginInlineEnd: 0 }}>
                      {explorationPhaseLabel(run.phase)}
                    </Tag>
                  </div>
                  {run.goal && (
                    <div title={run.goal} style={{ marginTop: 5, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.goal}</div>
                  )}
                </div>
                <Space size={8} style={{ flexShrink: 0 }}>
                  {running && <Button data-app-button="action" size="small" danger loading={busyAction === 'cancelRun'} onClick={handleCancel}>取消探索</Button>}
                  {runCollapsible && (
                    <Tooltip title="收起结果，回到新建 API 探索">
                      <Button size="small" onClick={handleCollapseRun}>收起结果</Button>
                    </Tooltip>
                  )}
                </Space>
              </div>
              <Steps
                size="small"
                style={{ marginTop: 16 }}
                current={taskSteps.current}
                status={taskSteps.status}
                items={TASK_STEP_ITEMS.map((item, index) => (
                  taskSteps.loading && index === taskSteps.current
                    ? { ...item, icon: <LoadingOutlined /> }
                    : item
                ))}
              />
              {error && <Alert type="error" showIcon style={{ marginTop: 12 }} message={error} />}
            </div>

            <div style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>API 探索过程</div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{requests.length > 0 ? `已捕获 ${requests.length} 个接口` : running ? '等待捕获…' : ''}</span>
              </div>
              {run.status === 'failed' && run.error && (
                <Alert type="error" showIcon style={{ marginTop: 10 }} message={run.error} />
              )}

              <details open={running} style={{ marginTop: 10 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 11, userSelect: 'none' }}>
                  {running ? '探索进行中，查看详情' : '查看探索详情'}
                  {requests.length > 0 ? `（${requests.length} 个接口）` : ''}
                </summary>
                <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.65, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
                  {run.summary || (run.status === 'cancelled'
                    ? '探索已取消，可以直接重新开始。'
                    : run.status === 'failed'
                      ? '探索未完成，请根据上方提示处理后重新开始。'
                      : run.phase === 'exploring'
                        ? '正在刷新目标页面并捕获 Fetch/XHR…'
                        : '正在启动 API 分析…')}
                </div>

                {run.analysisError && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginTop: 10 }}
                    message={`API 分析暂不可用：${run.analysisError}`}
                  />
                )}

                {requests.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 7 }}>捕获到的接口（{requests.length}）</div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {requests.slice(0, 40).map((request) => (
                        <div key={`${request.method}-${request.url}`} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 9px', borderRadius: 7, background: 'var(--bg-primary)', border: '1px solid var(--border)', minWidth: 0 }}>
                          <Tag color={methodTagColor(request.method)} style={{ marginInlineEnd: 0, flexShrink: 0 }}>{request.method}</Tag>
                          <code title={request.url} style={{ color: 'var(--text-secondary)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{request.url}</code>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </details>
            </div>

            {run.status === 'completed' && (
              <>
                <div style={cardStyle}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>补充录制操作（可选）</div>
                  <div style={{ marginTop: 5, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.55 }}>
                    被动探索没有覆盖搜索、筛选、分页、详情或业务动作时，可以先录制一次。开始后回到目标页面完成真实操作，再返回这里结束捕获。
                  </div>

                  {actionCaptureRecording && (
                    <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
                        正在捕获「{actionCapture?.actionName || actionName}」：请回到目标页面完成一次真实操作（已进行 {captureElapsed} 秒 / 最长 {timeoutSeconds} 秒）
                      </div>
                      <Progress percent={captureProgress} size="small" status={captureProgress >= 100 ? 'exception' : 'active'} showInfo={false} />
                    </div>
                  )}

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginTop: 10 }}>
                    <Input
                      value={actionName}
                      onChange={(event) => setActionName(event.target.value)}
                      disabled={actionCaptureRunning || anyBusy}
                      placeholder="操作名称，例如搜索项目"
                    />
                    <Select
                      value={actionMode}
                      onChange={setActionMode}
                      disabled={actionCaptureRunning || anyBusy}
                      style={{ width: '100%' }}
                      options={[
                        { value: 'intercept', label: '记录并放行' },
                        { value: 'observe', label: '只观察' },
                      ]}
                    />
                    <Tooltip title="最长捕获时间（秒）">
                      <InputNumber
                        min={5}
                        max={300}
                        value={actionTimeoutSeconds}
                        onChange={(value) => setActionTimeoutSeconds(value ?? 60)}
                        disabled={actionCaptureRunning || anyBusy}
                        style={{ width: '100%' }}
                      />
                    </Tooltip>
                  </div>
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 11 }}>高级捕获条件</summary>
                    <Input
                      value={actionPattern}
                      onChange={(event) => setActionPattern(event.target.value)}
                      disabled={actionCaptureRunning || anyBusy}
                      placeholder="可选 URL 匹配条件"
                      style={{ marginTop: 7 }}
                    />
                  </details>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                    {!actionCaptureRunning && (
                      <Button data-app-button="action"
                        loading={busyAction === 'startCapture'}
                        disabled={!capabilities?.actionCapture || anyBusy || generationStarted || !actionName.trim()}
                        onClick={handleStartActionCapture}
                      >
                        开始捕获操作
                      </Button>
                    )}
                    {actionCaptureRecording && (
                      <Button data-app-button="action" type="primary" loading={busyAction === 'stopCapture' || actionCapture?.type === 'action_capture_stopping'} onClick={handleStopActionCapture}>
                        结束捕获
                      </Button>
                    )}
                    {actionCapture?.type === 'action_capture_stopping' && (
                      <Button data-app-button="action" type="primary" loading disabled>正在结束…</Button>
                    )}
                  </div>
                  {!capabilities?.actionCapture && <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 11 }}>当前插件版本不支持客户端操作捕获，请更新并重新加载插件。</div>}
                  {actionCapture?.type === 'action_capture_ai_loading' && <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 11 }}>操作已完成，正在整理接口和参数…</div>}
                  {actionCapture?.type === 'action_capture_error' && <Alert type="error" showIcon style={{ marginTop: 8 }} message={actionCapture.error || '操作捕获失败'} />}
                  {actionCapture?.type === 'action_capture' && (
                    <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
                      <Alert
                        type={actionAnalysisError ? 'warning' : 'success'}
                        showIcon
                        message={`操作捕获完成，发现 ${Array.isArray(actionCapture.result?.capturedActions) ? actionCapture.result.capturedActions.length : 0} 个请求候选，已合并到当前探索结果。`}
                        description={actionAnalysisError || actionCapture.result?.actionAnalysis?.summary || undefined}
                      />

                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {actionAnalysisError && <Button data-app-button="action" loading={busyAction === 'retryAnalysis'} disabled={anyBusy || generationStarted} onClick={handleRetryActionAnalysis}>重试 AI 分析（无需重新操作）</Button>}
                        <Button data-app-button="action" loading={busyAction === 'nextCapture'} disabled={anyBusy || generationStarted} onClick={handlePrepareNextActionCapture}>继续录制下一个操作</Button>
                      </div>

                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>本次录制发现的请求</div>
                      {(actionCapture.result?.capturedActions || []).map((candidate, index) => {
                        const primary = isPrimaryCaptureCandidate(candidate, index, actionCapture)
                        return (
                          <div key={`${candidate.method || 'GET'}-${candidate.url || index}`} style={{ padding: 11, borderRadius: 8, border: `1px solid ${primary ? 'var(--accent)' : 'var(--border)'}`, background: 'var(--bg-primary)', display: 'grid', gap: 8 }}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                              <Tag color={methodTagColor(candidate.method)} style={{ marginInlineEnd: 0 }}>{String(candidate.method || 'GET').toUpperCase()}</Tag>
                              {primary && <Tag color="processing" style={{ marginInlineEnd: 0 }}>当前主接口</Tag>}
                              {candidate.aiRisk && <Tag color="warning" style={{ marginInlineEnd: 0 }}>{candidate.aiRisk}</Tag>}
                            </div>
                            <code title={candidate.url} style={{ color: 'var(--text-secondary)', fontSize: 10.5, wordBreak: 'break-all' }}>{candidate.url || '未知接口'}</code>
                            {candidate.aiPurpose && <div style={{ color: 'var(--text-secondary)', fontSize: 11, lineHeight: 1.5 }}>{candidate.aiPurpose}</div>}
                            {candidate.aiWhy && <div style={{ color: 'var(--text-muted)', fontSize: 10.5, lineHeight: 1.5 }}>识别原因：{candidate.aiWhy}</div>}
                            {!primary && (
                              <Button data-app-button="action"
                                size="small"
                                type="primary"
                                loading={busyAction === `selectCandidate:${index}`}
                                disabled={anyBusy || generationStarted}
                                onClick={() => handleSelectActionCandidate(index)}
                              >
                                设为主接口
                              </Button>
                            )}
                            {candidate.requestBodyPreview && <details><summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 10.5 }}>请求参数</summary><pre style={{ margin: '7px 0 0', padding: 8, borderRadius: 6, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', fontSize: 10 }}>{previewText(candidate.requestBodyPreview)}</pre></details>}
                            {candidate.responsePreview && <details><summary style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: 10.5 }}>响应摘要</summary><pre style={{ margin: '7px 0 0', padding: 8, borderRadius: 6, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', fontSize: 10 }}>{previewText(candidate.responsePreview)}</pre></details>}
                          </div>
                        )
                      })}

                    </div>
                  )}
                </div>
                {actionCapture?.type === 'action_capture_restored' && (
                  <Alert type="info" showIcon style={{ marginTop: 8 }} message="历史任务的录制明细不随任务保留；已沉淀到站点记忆的操作证据如下（脱敏）。"
                    action={<Button data-app-button="action" loading={busyAction === 'retryAnalysis'} disabled={anyBusy || generationStarted} onClick={handleRetryActionAnalysis}>重试扩展保留的 AI 分析</Button>} />
                )}

                {Array.isArray(run.siteMemory?.actionCaptureHistory) && run.siteMemory.actionCaptureHistory.length > 0 && (
                  <details style={{ marginTop: 12 }}>
                    <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 11, fontWeight: 700 }}>已沉淀的操作证据（{run.siteMemory.actionCaptureHistory.length}）</summary>
                    <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                      {run.siteMemory.actionCaptureHistory.map((candidate, index) => (
                        <div key={`${candidate.actionName}-${candidate.url}-${index}`} style={{ padding: '8px 9px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-primary)', fontSize: 10.5, color: 'var(--text-secondary)' }}>
                          <strong>{candidate.actionName || '未命名操作'}</strong> · {candidate.method || 'GET'} · {candidate.toolName || '待生成工具'}
                          <div title={candidate.url} style={{ marginTop: 4, wordBreak: 'break-all', color: 'var(--text-muted)' }}>{candidate.url}</div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                <div style={cardStyle}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>下一步：生成 Adapter</div>
                  <div style={{ marginTop: 5, fontSize: 11, color: 'var(--text-muted)' }}>
                    直接生成并验证；复杂参数或多接口任务可选智能生成。通过验证后确认安装。
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                    {!run.siteMemory && <Button data-app-button="action" loading={busyAction === 'saveMemory'} disabled={anyBusy || actionCaptureRunning} onClick={handleSaveMemory}>保存探索结果</Button>}
                    <Button data-app-button="action" type="primary" loading={busyAction === 'quickGenerate'} disabled={generationRunning || anyBusy || actionCaptureRunning} onClick={handleQuickGenerate}>生成并验证</Button>
                    <Button data-app-button="action" loading={busyAction === 'smartGenerate'} disabled={generationRunning || anyBusy || actionCaptureRunning} onClick={handleSmartGenerate}>智能生成</Button>

                  </div>
                </div>
              </>
            )}
          </>
        )}

        {generationMessage && <Alert type="info" showIcon message={generationMessage} />}

        {run?.scaffoldResult && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Tag color="success" style={{ marginInlineEnd: 0 }}>已生成</Tag>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Adapter</span>
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
              历史生成记录，文件 {Object.keys(run.scaffoldResult.files || {}).length} 个。
              {run.scaffoldResult.browserRefreshError ? ' 当前目标页面未能自动刷新，请重新打开或刷新页面。' : ' 当前目标页面已刷新。'}
            </div>
          </div>
        )}

        {generation && (
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Adapter 生成</div>
              <Tag color={generationFailure(generation.status) ? 'error' : generation.status === 'completed' ? 'success' : 'processing'} style={{ marginInlineEnd: 0 }}>
                {generationStatusLabel(generation.status)}
              </Tag>
            </div>

            <div style={{ marginTop: 12, display: 'grid', gap: 7, fontSize: 12, color: 'var(--text-secondary)' }}>
              <div>
                已生成工具：{Array.isArray(generation.artifacts?.draft?.toolNames) ? generation.artifacts.draft.toolNames.length : 0} 个
                {Array.isArray(generation.artifacts?.draft?.toolNames) && generation.artifacts.draft.toolNames.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    {generation.artifacts.draft.toolNames.map((toolName) => (
                      <Tag key={toolName} style={{ marginInlineEnd: 0 }}>{toolName}</Tag>
                    ))}
                  </div>
                )}
              </div>
              {generation.artifacts?.staticValidation && <div>静态验证：{generation.artifacts.staticValidation.passed ? '通过' : '未通过'}</div>}
              {generation.artifacts?.runtimeValidation && <div>页面运行验证：{generation.artifacts.runtimeValidation.passed ? '通过' : '未通过'}</div>}
              {failureHint ? (
                <div>
                  <div style={{ color: '#ef4444' }}>{failureHint.summary}</div>
                  {failureHint.retryHint && <div style={{ marginTop: 3, color: 'var(--text-muted)' }}>{failureHint.retryHint}</div>}
                </div>
              ) : generation.lastError?.message && (
                <div style={{ color: '#ef4444' }}>{generation.lastError.message}</div>
              )}
            </div>

            {pendingQuestion && (
              <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--accent)', background: 'color-mix(in srgb, var(--accent) 6%, transparent)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>生成智能体需要你的输入</div>
                <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{pendingQuestion.question}</div>
                {pendingQuestion.context && <div style={{ marginTop: 3, fontSize: 11, color: 'var(--text-muted)' }}>{pendingQuestion.context}</div>}
                <Input.TextArea
                  value={resumeAnswer}
                  onChange={(event) => setResumeAnswer(event.target.value)}
                  rows={2}
                  maxLength={4000}
                  placeholder="输入你的回答…"
                  style={{ marginTop: 8, resize: 'vertical' }}
                />
                <Button data-app-button="action" type="primary" style={{ marginTop: 8 }} loading={busyAction ===
'resumeGeneration'
} disabled={anyBusy || !resumeAnswer.trim()} onClick={handleResumeGeneration}>提交回答并继续</Button>
              </div>
            )}
            {(generation.status === 'awaiting_approval' || generationRunning) && (
              <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, background: 'color-mix(in srgb, var(--accent) 8%, transparent)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                {generation.status === 'awaiting_approval'
                  ? '请核对工具清单、验证结果和安装评审。确认后安装到本机用户 Adapter 目录，刷新工具与 Skill。'
                  : '正在生成并验证：完成草稿、静态验证和页面运行验证后，等待你确认安装。'}
              </div>
            )}

            {generation.artifacts?.installationReview && (
              <Alert type="info" style={{ marginTop: 12 }} message="本机安装评审" description={
                <div>
                  <div>{generation.artifacts.installationReview.name} · {generation.artifacts.installationReview.currentVersion || '未安装'} → {generation.artifacts.installationReview.version}</div>
                  <div>来源：{generation.artifacts.installationReview.currentSource || '无'} → 本机生成</div>
                  <div>申请权限：{generation.artifacts.installationReview.permissions.join('、') || '无'}</div>
                  {generation.artifacts.installationReview.addedPermissions.length > 0 && <div>新增权限：{generation.artifacts.installationReview.addedPermissions.join('、')}</div>}
                  {generation.artifacts.installationReview.sourceChange && <div>安装将切换此 Adapter 的更新来源。</div>}
                  {generation.artifacts.installationReview.downgrade && <div>安装将降级当前版本。</div>}
                </div>
              } />
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
              {(generationRunning || generation.status === 'awaiting_approval') && (
                <Button data-app-button="action" loading={busyAction === 'cancelGeneration'} disabled={anyBusy} onClick={handleCancelGeneration}>取消生成</Button>
              )}
              {generation.status === 'awaiting_approval' && (
                <Popconfirm
                  title="安装并启用 Adapter？"
                  description="确认上述版本、来源和权限变化，安装到本机用户目录并启用，随后刷新工具与 Skill。"
                  okText="安装并启用"
                  cancelText="再想想"
                  onConfirm={handlePublishGeneration}
                >
                  <Button data-app-button="action" type="primary" loading={busyAction === 'publishGeneration'} disabled={anyBusy}>安装并启用</Button>
                </Popconfirm>
              )}
              {generationFailure(generation.status) && (
                <Button data-app-button="action" loading={busyAction === 'smartGenerate'} disabled={anyBusy} onClick={handleSmartGenerate}>重新智能生成</Button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
