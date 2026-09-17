import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isActionCaptureInFlight,
  isGenerationStatusActive,
  explorationTaskSteps,
  lastRunSummaryLine,
  restoredRunNotice,
  shouldAutoRestoreExplorationRun,
} from '../utils/exploration-evidence.js'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const componentSource = fs.readFileSync(path.resolve(testDir, '../components/exploration/ExplorationPage.jsx'), 'utf8')

const COMPLETED_RUN = {
  taskId: 'task-1',
  status: 'completed',
  phase: 'completed',
  goal: '分析当前页面可以沉淀哪些稳定、可复用的 API 查询能力',
  tab: { id: 1, title: '会议室预定' },
  evidence: {
    network: { entries: [
      { method: 'GET', url: 'https://example.com/api/rooms' },
      { method: 'POST', url: 'https://example.com/api/search' },
    ] },
  },
}

test('shouldAutoRestoreExplorationRun restores only runs that still need attention', () => {
  assert.equal(shouldAutoRestoreExplorationRun(null), false)
  assert.equal(shouldAutoRestoreExplorationRun({}), false)

  assert.equal(shouldAutoRestoreExplorationRun({ ...COMPLETED_RUN, status: 'preparing' }), true)
  assert.equal(shouldAutoRestoreExplorationRun({ ...COMPLETED_RUN, status: 'running' }), true)

  for (const type of ['action_capture_loading', 'action_capture_stopping', 'action_capture_ai_loading']) {
    assert.equal(shouldAutoRestoreExplorationRun({ ...COMPLETED_RUN, actionCapture: { type } }), true)
  }
  assert.equal(shouldAutoRestoreExplorationRun({ ...COMPLETED_RUN, actionCapture: { type: 'action_capture' } }), false)
  assert.equal(shouldAutoRestoreExplorationRun({ ...COMPLETED_RUN, actionCapture: { type: 'action_capture_error' } }), false)

  for (const status of ['created', 'planning', 'drafting', 'static_validating', 'runtime_validating', 'publishing']) {
    assert.equal(shouldAutoRestoreExplorationRun({ ...COMPLETED_RUN, generationRun: { status } }), true)
  }
  assert.equal(shouldAutoRestoreExplorationRun({ ...COMPLETED_RUN, generationRun: { status: 'awaiting_approval' } }), true)
  assert.equal(shouldAutoRestoreExplorationRun({ ...COMPLETED_RUN, generationRun: { status: 'needs_user_input' } }), true)

  assert.equal(shouldAutoRestoreExplorationRun(COMPLETED_RUN), false)
  assert.equal(shouldAutoRestoreExplorationRun({ ...COMPLETED_RUN, generationRun: { status: 'completed' } }), false)
  assert.equal(shouldAutoRestoreExplorationRun({ ...COMPLETED_RUN, status: 'failed', phase: 'failed' }), false)
  assert.equal(shouldAutoRestoreExplorationRun({ ...COMPLETED_RUN, status: 'cancelled', phase: 'cancelled' }), false)
  assert.equal(shouldAutoRestoreExplorationRun({ ...COMPLETED_RUN, generationRun: { status: 'failed' } }), false)
})

test('restoredRunNotice explains why the previous run was restored', () => {
  assert.match(restoredRunNotice({ status: 'running' }), /仍在进行/)
  assert.match(restoredRunNotice({ taskId: 't', status: 'completed', actionCapture: { type: 'action_capture_ai_loading' } }), /操作捕获/)
  assert.match(restoredRunNotice({ taskId: 't', status: 'completed', generationRun: { status: 'drafting' } }), /生成仍在进行/)
  assert.match(restoredRunNotice({ taskId: 't', status: 'completed', generationRun: { status: 'awaiting_approval' } }), /确认发布/)
  assert.match(restoredRunNotice({ taskId: 't', status: 'completed', generationRun: { status: 'needs_user_input' } }), /补充信息/)
})

test('lastRunSummaryLine summarizes a finished run for the lightweight entry', () => {
  assert.equal(lastRunSummaryLine(COMPLETED_RUN), 'API 探索完成 · 会议室预定 · 2 个接口')
  assert.equal(lastRunSummaryLine({ ...COMPLETED_RUN, tab: {} }), 'API 探索完成 · 2 个接口')
  assert.equal(lastRunSummaryLine({ ...COMPLETED_RUN, evidence: null }), 'API 探索完成 · 会议室预定')
  assert.equal(lastRunSummaryLine({ phase: 'failed' }), 'API 探索失败')
  const longTitle = Array(40).fill('长').join('')
  assert.match(lastRunSummaryLine({ ...COMPLETED_RUN, tab: { title: longTitle } }), /长… · 2 个接口$/)
})

test('generation and capture activity helpers normalize their inputs', () => {
  assert.equal(isGenerationStatusActive('drafting'), true)
  assert.equal(isGenerationStatusActive('completed'), false)
  assert.equal(isGenerationStatusActive(null), false)
  assert.equal(isGenerationStatusActive(undefined), false)
  assert.equal(isActionCaptureInFlight({ type: 'action_capture_loading' }), true)
  assert.equal(isActionCaptureInFlight(null), false)
  assert.equal(isActionCaptureInFlight({ type: 'action_capture' }), false)
})

test('exploration page restores in-flight runs and keeps finished runs behind a lightweight entry', () => {
  assert.match(componentSource, /shouldAutoRestoreExplorationRun\(savedRun\)/)
  assert.match(componentSource, /setLastRun\(savedRun\)/)
  assert.match(componentSource, /继续上次探索 · \{restoreNotice\}/)
  assert.match(componentSource, /\{lastRun && !run && \(/)
  assert.match(componentSource, /查看上次探索结果/)
  assert.match(componentSource, /收起结果/)
  assert.match(componentSource, /新建 API 探索/)
  assert.match(componentSource, /runCollapsible = Boolean\(run\) && !running && !shouldAutoRestoreExplorationRun\(run\)/)
  assert.match(componentSource, /if \(restoreNotice && run && !shouldAutoRestoreExplorationRun\(run\)\) setRestoreNotice\(''\)/)
  assert.match(componentSource, /setLastRun\(null\)/)
})

test('explorationTaskSteps drives the task workbench stepper across the whole lifecycle', () => {
  assert.deepEqual(explorationTaskSteps(null), { current: -1, status: 'wait', loading: false })
  assert.deepEqual(explorationTaskSteps({ taskId: 't', status: 'running', phase: 'exploring' }), { current: 0, status: 'process', loading: true })
  assert.deepEqual(explorationTaskSteps({ taskId: 't', status: 'running', phase: 'analyzing' }), { current: 1, status: 'process', loading: true })
  assert.deepEqual(explorationTaskSteps({ taskId: 't', status: 'failed', phase: 'exploring' }), { current: 0, status: 'error', loading: false })
  assert.deepEqual(explorationTaskSteps({ taskId: 't', status: 'failed', phase: 'analyzing' }), { current: 1, status: 'error', loading: false })
  assert.deepEqual(explorationTaskSteps({ taskId: 't', status: 'cancelled', phase: 'cancelled' }), { current: 0, status: 'wait', loading: false })
  assert.deepEqual(explorationTaskSteps({ ...COMPLETED_RUN }), { current: 2, status: 'process', loading: false })
  assert.deepEqual(
    explorationTaskSteps({ ...COMPLETED_RUN, actionCapture: { type: 'action_capture_loading' } }),
    { current: 2, status: 'process', loading: true },
  )
  assert.deepEqual(
    explorationTaskSteps({ ...COMPLETED_RUN, actionCapture: { type: 'action_capture_ai_loading' } }),
    { current: 2, status: 'process', loading: true },
  )
  assert.deepEqual(
    explorationTaskSteps({ ...COMPLETED_RUN, generationRun: { status: 'drafting' }, generationRunId: 'g' }),
    { current: 3, status: 'process', loading: true },
  )
  assert.deepEqual(
    explorationTaskSteps({ ...COMPLETED_RUN, generationRun: { status: 'runtime_validating' }, generationRunId: 'g' }),
    { current: 3, status: 'process', loading: true },
  )
  assert.deepEqual(
    explorationTaskSteps({ ...COMPLETED_RUN, generationRun: { status: 'awaiting_approval' }, generationRunId: 'g' }),
    { current: 3, status: 'process', loading: false },
  )
  assert.deepEqual(
    explorationTaskSteps({ ...COMPLETED_RUN, generationRun: { status: 'needs_user_input' }, generationRunId: 'g' }),
    { current: 3, status: 'process', loading: false },
  )
  assert.deepEqual(
    explorationTaskSteps({ ...COMPLETED_RUN, generationRun: { status: 'failed' }, generationRunId: 'g' }),
    { current: 3, status: 'error', loading: false },
  )
  assert.deepEqual(
    explorationTaskSteps({ ...COMPLETED_RUN, generationRun: { status: 'completed' }, generationRunId: 'g' }),
    { current: 4, status: 'finish', loading: false },
  )
  assert.deepEqual(
    explorationTaskSteps({ ...COMPLETED_RUN, scaffoldResult: { files: {} } }),
    { current: 4, status: 'finish', loading: false },
  )
})

test('exploration page renders a task workbench with antd and lifecycle-aware controls', () => {
  assert.match(componentSource, /from 'antd'/)
  assert.match(componentSource, /import \{ LoadingOutlined \} from '@ant-design\/icons'/)
  assert.match(componentSource, /icon: <LoadingOutlined \/>/)
  assert.match(componentSource, /taskSteps\.loading && index === taskSteps\.current/)
  assert.match(componentSource, /TASK_STEP_ITEMS/)
  assert.match(componentSource, /title: '捕获页面'/)
  assert.match(componentSource, /title: '发布安装'/)
  assert.match(componentSource, /explorationTaskSteps\(run\)/)
  assert.match(componentSource, /取消探索/)
  assert.match(componentSource, /正在捕获「\{actionCapture\?\.actionName \|\| actionName\}」/)
  assert.match(componentSource, /setCaptureElapsed/)
  assert.match(componentSource, /确认发布 Adapter？/)
  assert.match(componentSource, /请先核对上方工具清单和验证结果/)
  assert.doesNotMatch(componentSource, /清空当前录制结果/)
  assert.doesNotMatch(componentSource, /API 探索中…/)
})

test('every exploration action exposes an in-flight loading state', () => {
  assert.match(componentSource, /const \[busyAction, setBusyAction\] = useState\(''\)/)
  assert.match(componentSource, /const anyBusy = busyAction !== ''/)
  for (const action of ['start', 'saveMemory', 'startCapture', 'stopCapture', 'nextCapture', 'quickGenerate', 'smartGenerate', 'cancelGeneration', 'publishGeneration', 'cancelRun']) {
    assert.match(componentSource, new RegExp(`setBusyAction\\('${action}'\\)`), `handler should mark ${action}`)
    assert.match(componentSource, new RegExp(`busyAction === '${action}'`), `button should show loading for ${action}`)
  }
  assert.match(componentSource, /busyAction === `selectCandidate:\$\{index\}`/)
  assert.doesNotMatch(componentSource, /setActionBusy|actionBusy/)
})

test('antd theme bridge resolves CSS variables into ConfigProvider tokens', () => {
  const bridgeSource = fs.readFileSync(path.resolve(testDir, '../theme/antd-theme.js'), 'utf8')
  const appSource = fs.readFileSync(path.resolve(testDir, '../App.jsx'), 'utf8')
  assert.match(bridgeSource, /useAntdThemeConfig/)
  assert.match(bridgeSource, /--accent/)
  assert.match(bridgeSource, /darkAlgorithm/)
  assert.match(bridgeSource, /defaultAlgorithm/)
  assert.match(appSource, /ConfigProvider locale=\{zhCN\} theme=\{antdThemeConfig\}/)
  assert.match(appSource, /useAntdThemeConfig\(theme\)/)
})
