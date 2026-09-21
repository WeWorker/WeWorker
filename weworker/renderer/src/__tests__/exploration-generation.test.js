import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generationFailureHint, generationPendingQuestion } from '../utils/exploration-evidence.js'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const componentSource = fs.readFileSync(path.resolve(testDir, '../components/exploration/ExplorationPage.jsx'), 'utf8')
const sidebarSource = fs.readFileSync(path.resolve(testDir, '../components/layout/Sidebar.jsx'), 'utf8')
const apiSource = fs.readFileSync(path.resolve(testDir, '../api/exploration-api.js'), 'utf8')

test('client exploration exposes the v1 save, quick generation and smart generation flow', () => {
  assert.match(componentSource, /保存探索结果/)
  assert.match(componentSource, /快速生成/)
  assert.match(componentSource, /智能生成/)
  assert.match(componentSource, /确认发布/)
  assert.match(componentSource, /取消生成/)
  assert.match(componentSource, /开始捕获操作/)
  assert.match(componentSource, /结束捕获/)
  assert.match(componentSource, /设为主接口/)
  assert.match(componentSource, /继续录制下一个操作/)
  assert.match(componentSource, /已沉淀的操作证据/)
  assert.match(componentSource, /action_capture_error/)
  assert.match(componentSource, /fetchExplorationActionCapture\(run\.taskId\)/)
  assert.match(componentSource, /fetchExplorationGeneration\(run\.taskId\)/)
  assert.match(componentSource, /timeoutSeconds: normalizeActionTimeoutSeconds\(actionTimeoutSeconds\)/)
  assert.match(componentSource, /localStorage\.setItem\('weworker:last-exploration-task'/)
  assert.match(componentSource, /nextRun\.actionCapture\?\.status !== 'running'/)
  assert.match(componentSource, /探索已取消，可以直接重新开始/)
  assert.match(componentSource, /generationRunning \|\| generation\.status === 'awaiting_approval'/)
  assert.match(componentSource, /<details open=\{running\}/)
  assert.match(componentSource, /查看探索详情/)
  assert.doesNotMatch(componentSource, /schema_version|list-metrics|adapters\/aiep/)
})

test('API exploration is distinct from the DOM exploration agent in user-facing copy', () => {
  assert.match(sidebarSource, />API 探索</)
  assert.match(componentSource, /网站 API 探索/)
  assert.match(componentSource, /开始 API 探索/)
  assert.doesNotMatch(componentSource, /网站探索agent|开始自动探索/)
})

test('client exploration API owns the generation lifecycle endpoints', () => {
  assert.match(apiSource, /\/save/)
  assert.match(apiSource, /\/scaffold/)
  assert.match(apiSource, /\/generation/)
  assert.match(apiSource, /\/generation\/cancel/)
  assert.match(apiSource, /\/generation\/publish/)
  assert.match(apiSource, /\/action-capture/)
  assert.match(apiSource, /\/action-capture\/stop/)
  assert.match(apiSource, /\/action-capture\/select/)
  assert.match(apiSource, /\/action-capture\/clear/)
  assert.match(apiSource, /\/action-capture\/analyze/)
})

test('failed action analysis is a warning with an evidence-only retry, including restored captures', () => {
  assert.match(componentSource, /type=\{actionAnalysisError \? 'warning' : 'success'\}/)
  assert.match(componentSource, /description=\{actionAnalysisError \|\|/)
  assert.match(componentSource, /重试 AI 分析（无需重新操作）/)
  assert.match(componentSource, /重试扩展保留的 AI 分析/)
  const handler = componentSource.slice(componentSource.indexOf('const handleRetryActionAnalysis ='), componentSource.indexOf('const handleQuickGenerate ='))
  assert.match(handler, /retryExplorationActionAnalysis\(run.taskId\)/)
  assert.doesNotMatch(handler, /startExplorationActionCapture|startExplorationRun/)
})

test('generation failures surface attributed guidance and retry context', () => {
  assert.match(componentSource, /generationFailureHint/)
  assert.match(componentSource, /failureHint\.summary/)
  assert.match(componentSource, /failureHint\.retryHint/)
  assert.match(componentSource, /重新智能生成/)

  assert.equal(generationFailureHint({ status: 'planning' }), null)
  assert.equal(generationFailureHint({ status: 'failed' }), null)
  assert.deepEqual(
    generationFailureHint({
      status: 'failed',
      failureAttribution: { summary: '草稿未通过页面运行验证：工具 example.test.get_user', recommendedAction: 'retry_with_context' },
    }),
    {
      summary: '草稿未通过页面运行验证：工具 example.test.get_user',
      retryHint: '点击「重新智能生成」会携带本次失败上下文，规划阶段将针对失败原因调整计划。',
    },
  )
  const siteHint = generationFailureHint({
    status: 'budget_exceeded',
    failureAttribution: { summary: '目标页面不可用或需要登录', recommendedAction: 'reopen_and_retry' },
  })
  assert.match(siteHint.retryHint, /打开并登录目标页面/)
})

test('restored action captures explain missing details and keep settled evidence visible', () => {
  assert.match(componentSource, /action_capture_restored/)
  assert.match(componentSource, /历史任务的录制明细不随任务保留/)
  assert.match(componentSource, /已沉淀的操作证据/)
})
test('pending generation questions surface an inline answer flow', () => {
  assert.match(componentSource, /generationPendingQuestion/)
  assert.match(componentSource, /生成智能体需要你的输入/)
  assert.match(componentSource, /提交回答并继续/)
  assert.match(componentSource, /resumeExplorationGeneration\(run\.taskId, resumeAnswer\.trim\(\)\)/)
  assert.match(componentSource, /智能编排（实验，遇到问题自主处置并可中途提问）/)
  assert.match(apiSource, /\/generation\/resume/)

  assert.equal(generationPendingQuestion({ status: 'planning' }), null)
  assert.equal(generationPendingQuestion({ status: 'needs_user_input' }), null)
  assert.deepEqual(
    generationPendingQuestion({
      status: 'needs_user_input',
      artifacts: { pendingQuestion: { question: '目标页面需要登录，请处理后继续', context: 'LOGIN_REQUIRED' } },
    }),
    { question: '目标页面需要登录，请处理后继续', context: 'LOGIN_REQUIRED' },
  )
  const topLevel = generationPendingQuestion({
    status: 'needs_user_input',
    pendingQuestion: { question: '确认日期范围？', context: '' },
  })
  assert.equal(topLevel.question, '确认日期范围？')
  assert.equal(topLevel.context, '')
})
