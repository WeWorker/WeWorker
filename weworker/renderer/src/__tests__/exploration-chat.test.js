import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { explorationComposerMode, explorationControls, explorationEntryId, isExplorationInProgress, isExplorationUrl, shouldSubmitExploration, sortExplorations } from '../utils/exploration-chat.js'

const timeline = [{ type: 'agent_step', step: 1 }]
const controls = (status, extra = {}) => explorationControls({ status, timeline, ...extra })

test('start URL accepts HTTP(S), rejects credentials and invalid schemes', () => {
  for (const url of ['https://example.com', ' http://localhost:8080/path?q=1 ', 'http://127.0.0.1']) assert.equal(isExplorationUrl(url), true)
  for (const url of ['', 'example.com', 'javascript:alert(1)', 'file:///tmp/test', 'https://example:placeholder@example.com', 'https://']) assert.equal(isExplorationUrl(url), false)
})
test('only a non-composing unshifted Enter sends a message', () => {
  assert.equal(shouldSubmitExploration({ key: 'Enter' }), true)
  for (const event of [{ key: 'Enter', shiftKey: true }, { key: 'Enter', nativeEvent: { isComposing: true } }, { key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }, { key: 'a' }]) assert.equal(shouldSubmitExploration(event), false)
})
test('running exploration permits stopping, never concurrent sends/replay', () => {
  assert.deepEqual(controls('running', { globalBusy: true }), { resumable: false, canStop: true, canSend: false, canReplay: false })
  for (const status of ['queued', 'pending', 'starting', 'cancel_requested']) {
    const value = controls(status)
    assert.equal(value.canSend, false)
    assert.equal(value.canReplay, false)
    assert.equal(value.canStop, status !== 'cancel_requested')
  }
})
test('waiting and completed runs can continue only when the runner is free', () => {
  for (const status of ['paused', 'waiting_for_user', 'succeeded', 'failed', 'cancelled']) {
    assert.equal(controls(status).canSend, true)
    assert.equal(controls(status).canReplay, true)
    for (const extra of [{ globalBusy: true }, { replayActive: true }, { disabled: true }, { busy: true }]) {
      assert.equal(controls(status, extra).canSend, false)
      assert.equal(controls(status, extra).canReplay, false)
    }
  }
  assert.equal(controls('succeeded', { timeline: [] }).canReplay, false)
  assert.equal(controls('succeeded', { modelReady: false }).canSend, false)
  assert.equal(controls('running', { modelReady: false }).canStop, true)
  assert.equal(controls(undefined).canSend, false)
})

let server, components
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
  components = await server.ssrLoadModule('/src/components/website-exploration/ExploreWorkspace.jsx')
})
after(async () => { await server?.close() })
test('composer renders the main chat send icon and lower-right controls without instruction labels', () => {
  const html = renderToStaticMarkup(React.createElement(components.ExplorationComposer, { value: '', onChange() {}, onAction() {}, actionDisabled: true }, React.createElement(components.ExplorationControls, { controls: controls('running') })))
  assert.match(html, /chat-input-surface/)
  assert.match(html, /chat-input-action-send/)
  assert.match(html, /aria-label="发送消息"[^>]+disabled/)
  assert.doesNotMatch(html, /追加指令|发送指令/)
  assert.doesNotMatch(html, /回放/)
  assert.equal((html.match(/<button/g) || []).length, 1)
  assert.doesNotMatch(html, />暂停<|>继续</)
  assert.doesNotMatch(html, /取消本次探索|>取消</)
})

test('browser confirmation offers opening the browser and continuing without a typed message', () => {
  const html = renderToStaticMarkup(React.createElement(components.BrowserConfirmation, {
    issue: { type: 'browser_confirmation_required', message: '浏览器需要确认，探索已暂停。' },
    disabled: false, onOpen() {}, onContinue() {},
  }))
  assert.match(html, /需要在浏览器中确认/)
  assert.match(html, /打开浏览器/)
  assert.match(html, /已处理，继续探索/)
  assert.doesNotMatch(html, /wx-error|trajectory\.json|ERR_BLOCKED_BY_CLIENT|disabled/)
  const disabled = renderToStaticMarkup(React.createElement(components.BrowserConfirmation, {
    issue: { type: 'browser_confirmation_required' }, disabled: true,
  }))
  assert.equal((disabled.match(/disabled/g) || []).length, 2)
  assert.equal(renderToStaticMarkup(React.createElement(components.BrowserConfirmation, { issue: { type: 'failed' } })), '')
})
test('replay is hidden unless an existing replay needs to be stopped', () => {
  const empty = renderToStaticMarkup(React.createElement(components.ExplorationControls, { controls: controls(undefined) }))
  assert.equal(empty, '')
  const paused = renderToStaticMarkup(React.createElement(components.ExplorationControls, { controls: controls('waiting_for_user') }))
  assert.equal(paused, '')
  const replay = renderToStaticMarkup(React.createElement(components.ExplorationControls, { controls: controls('succeeded', { replayActive: true }), replayActive: true, cancelReplayDisabled: false }))
  assert.match(replay, /title="停止当前回放">停止回放/)
})
test('new exploration is an inline URL question and supports existing exploration context', () => {
  const source = readFileSync(new URL('../components/website-exploration/ExploreWorkspace.jsx', import.meta.url), 'utf8')
  const creation = source.slice(source.indexOf('function NewExploration'), source.indexOf('export function ExplorationControls'))
  assert.doesNotMatch(creation, /<Modal|createPortal/)
  assert.match(creation, /user-choice-block__question/)
  assert.match(creation, /你想从哪里开始探索\?/)
  assert.match(creation, /autoFocus=/)
  assert.match(creation, /api\.createSiteExploration/)
  assert.match(creation, /api\.createExploration/)
  assert.match(creation, /api\.matchBrowser/)
  assert.ok(source.includes("const [currentId, setCurrentId] = useState(context ? '' : null)"))
  assert.ok(source.includes("selected !== previous.selections[key + '/exploration']"))
})

test('exploration messages have no visible role labels, matching the main conversation', () => {
  const source = readFileSync(new URL('../components/website-exploration/ExploreWorkspace.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /wx-chat-author/)
  const messages = [...source.matchAll(/<article\b[\s\S]*?<\/article>/g)].map(match => match[0])
  assert.ok(messages.length >= 4, 'covers welcome, initial request, steps and timeline messages')
  for (const message of messages) {
    assert.doesNotMatch(message, /网站探索agent|>你<|\? '你'/)
  }
  assert.match(source, /wx-chat-user/)
  assert.match(source, /wx-user-bubble/)
})


test('composer switches immediately on submit and follows all exploration lifecycle states', () => {
  for (const status of ['queued', 'pending', 'starting', 'running', 'cancel_requested']) assert.equal(explorationComposerMode(status), 'stop')
  for (const status of ['paused', 'waiting_for_user']) assert.equal(explorationComposerMode(status), 'send')
  for (const status of [undefined, 'succeeded', 'failed', 'cancelled']) {
    assert.equal(explorationComposerMode(status), 'send')
    assert.equal(explorationComposerMode(status, true), 'stop')
  }
  assert.equal(shouldSubmitExploration({ key: 'Enter' }, 'stop'), false, 'typing Enter must never stop the agent')
  assert.equal(shouldSubmitExploration({ key: 'Enter' }, 'send'), true)
})

test('a single primary button morphs between send arrow and stop square', () => {
  const render = (actionMode, value = '', actionDisabled = false) => renderToStaticMarkup(React.createElement(components.ExplorationComposer, { value, onChange() {}, onAction() {}, actionMode, actionDisabled }))
  const running = render('stop', 'draft retained while running')
  assert.match(running, /chat-input-action-stop/)
  assert.match(running, /aria-label="停止探索"/)
  assert.doesNotMatch(running, /chat-input-action-send/)
  assert.equal((running.match(/<button/g) || []).length, 1)
  assert.match(render('stop', '', true), /aria-label="停止探索"[^>]+disabled/)
  assert.match(render('send'), /chat-input-action-send/)
  assert.match(render('send'), /aria-label="发送消息"/)
  assert.match(render('send', 'continue with this goal'), /aria-label="发送消息"/)
  assert.match(render('send'), /aria-label="发送消息"/)
})


test('running exploration sorts first, then displayed creation time newest first without mutating the snapshot', () => {
  const records = [
    { exploration_id: 'older', status: 'succeeded', created_at_timestamp: 10, updated_at: '2099-01-01' },
    { exploration_id: 'newest', status: 'failed', created_at_timestamp: 30 },
    { exploration_id: 'running', status: 'running', created_at_timestamp: 1 },
    { exploration_id: 'middle', status: 'cancelled', created_at_timestamp: 20 },
  ]
  const original = records.map(item => item.exploration_id)
  assert.deepEqual(sortExplorations(records).map(item => item.exploration_id), ['running', 'newest', 'middle', 'older'])
  assert.deepEqual(records.map(item => item.exploration_id), original)
  records[2].status = 'succeeded'
  assert.deepEqual(sortExplorations(records).map(item => item.exploration_id), ['newest', 'middle', 'older', 'running'])
  assert.deepEqual(sortExplorations(records, 'older').map(item => item.exploration_id), ['older', 'newest', 'middle', 'running'])
})

test('queued and transitioning runs remain pinned; idle records, ties and missing times have stable ordering', () => {
  for (const status of ['queued', 'pending', 'starting', 'running', 'cancel_requested']) {
    assert.equal(sortExplorations([{ exploration_id: 'new', status: 'succeeded', created_at_timestamp: 20 }, { exploration_id: 'active', status, created_at_timestamp: 1 }])[0].exploration_id, 'active')
  }
  const records = [
    { exploration_id: 'invalid', created_at_timestamp: NaN },
    { exploration_id: 'first', status: 'waiting_for_user', created_at_timestamp: 10 },
    { exploration_id: 'second', status: 'paused', created_at_timestamp: 10 },
    { exploration_id: 'missing' },
    { exploration_id: 'new', status: 'succeeded', created_at_timestamp: 20 },
  ]
  assert.deepEqual(sortExplorations(records).map(item => item.exploration_id), ['new', 'first', 'second', 'invalid', 'missing'])
  assert.deepEqual(sortExplorations(), [])
  assert.deepEqual(sortExplorations(null), [])
})


test('completed exploration asks a main-chat-style inline question with develop and continue choices', () => {
  const html = renderToStaticMarkup(React.createElement(components.CompletionQuestion, { onDevelop() {}, onContinue() {} }))
  assert.match(html, /user-choice-block__question/)
  assert.match(html, /探索任务已完成，本次探索结果可生成可复用的网站适配器，以便下次直接操作网站。是否分析探索结果并生成网站适配器？/)
  assert.match(html, /是，生成网站适配器/)
  assert.match(html, /否，还需要进一步探索/)
  assert.equal((html.match(/<button/g) || []).length, 2)
  assert.equal((html.match(/class="user-choice-block__option"/g) || []).length, 2)
  assert.doesNotMatch(html, /role="dialog"|wx-overlay|到WeWorker中开发|wx-chat-author/)
})

test('development choice is acknowledged inline and model readiness only gates continuing exploration', () => {
  const answered = renderToStaticMarkup(React.createElement(components.CompletionQuestion, { developing: true }))
  assert.match(answered, /user-choice-block__answered/)
  assert.doesNotMatch(answered, /<button/)
  const gated = renderToStaticMarkup(React.createElement(components.CompletionQuestion, { continueDisabled: true }))
  assert.equal((gated.match(/disabled=""/g) || []).length, 1)
  const busy = renderToStaticMarkup(React.createElement(components.CompletionQuestion, { developDisabled: true, continueDisabled: true }))
  assert.equal((busy.match(/disabled=""/g) || []).length, 2)
})


test('exploration sidebar reuses the main new-chat button and exposes the full list without search', () => {
  const html = renderToStaticMarkup(React.createElement(components.default, { disabled: false, globalBusy: false }))
  assert.match(html, /wx-history workspace-sidebar/)
  assert.match(html, /class="sidebar-new-chat sidebar-conversation-action"/)
  assert.match(html, /aria-label="新探索"/)
  assert.match(html, /anticon-form/)
  assert.match(html, /工作记录/)
  assert.doesNotMatch(html, /探索记录|搜索记录或状态|搜索探索记录|<input/)
  const source = readFileSync(new URL('../components/website-exploration/ExploreWorkspace.jsx', import.meta.url), 'utf8')
  assert.match(source, /records\.map/)
  assert.doesNotMatch(source, /setFilter|records\.filter/)
})

test('new URL exploration sends directly from the composer without a separate browser/login step', () => {
  const source = readFileSync(new URL('../components/website-exploration/ExploreWorkspace.jsx', import.meta.url), 'utf8')
  const creation = source.slice(source.indexOf('function NewExploration'), source.indexOf('export function ExplorationControls'))
  assert.doesNotMatch(creation, /打开网址|登录按钮|api\.openBrowser/)
  assert.match(creation, /在下方输入探索目标并发送即可开始/)
  assert.match(creation, /composerInput\.current\?\.focus\(\)/)
  assert.match(creation, /<ExplorationComposer inputRef=\{composerInput\}/)
  assert.match(creation, /api\.createSiteExploration\(\{ start_url: startUrl\.trim\(\), instruction \}\)/)
})


test('start page keeps only the URL question and concise goal placeholder', () => {
  const source = readFileSync(new URL('../components/website-exploration/ExploreWorkspace.jsx', import.meta.url), 'utf8')
  const creation = source.slice(source.indexOf('function NewExploration'), source.indexOf('export function ExplorationControls'))
  assert.doesNotMatch(creation, /我会从起始页面了解网站能力|也可以在下方告诉我探索目标|告诉我你想探索什么/)
  assert.match(creation, /placeholder="告诉我你想在这个网站上干什么"/)
  assert.match(creation, /你想从哪里开始探索\?/)
})


test('submitted exploration keeps the answered inline question with no action buttons', () => {
  const html = renderToStaticMarkup(React.createElement(components.CompletionQuestion, { submitted: true }))
  assert.match(html, /user-choice-block__answered/); assert.match(html, /是，生成网站适配器/)
  assert.doesNotMatch(html, /<button|请在开发对话中/)
  assert.match(html, /role="status"/)
})


test('entry opens new exploration when there are no actively running records, regardless of history', () => {
  assert.equal(explorationEntryId(), '')
  assert.equal(explorationEntryId(null), '')
  const records = ['succeeded', 'failed', 'cancelled', 'paused', 'waiting_for_user'].map((status, index) => ({ exploration_id: 'exp_' + index, status, created_at_timestamp: index }))
  assert.equal(explorationEntryId(records), '')
})

test('entry prefers the managed active exploration, then a running record rather than newer history', () => {
  for (const status of ['queued', 'pending', 'starting', 'running', 'cancel_requested']) {
    const records = [{ exploration_id: 'history', status: 'succeeded', created_at_timestamp: 200 }, { exploration_id: 'ongoing', status, created_at_timestamp: 100 }]
    assert.equal(explorationEntryId(records), 'ongoing')
    assert.equal(explorationEntryId(records, 'managed-active'), 'managed-active')
  }
  assert.equal(explorationEntryId([], 'not-yet-in-list'), 'not-yet-in-list')
})

test('entry resolution waits for fresh snapshots and does not restore historical selection or steal manual navigation', () => {
  const source = readFileSync(new URL('../components/website-exploration/ExploreWorkspace.jsx', import.meta.url), 'utf8')
  assert.ok(source.includes("useState(context ? '' : null)"))
  assert.ok(source.includes('currentId === null && activityReady && !list.loading'))
  assert.ok(source.includes("setCurrentId(item.exploration_id)"))
  assert.ok(source.includes("setCurrentId('')"))
  assert.doesNotMatch(source, /selected \|\| records\[0\]|const restored|\|\| restored/)
  assert.ok(source.includes("setCurrentId(explorationEntryId(list.data, activeExplorationId) || [...developingIds][0] || '')"))
  const page = readFileSync(new URL('../components/website-exploration/WebsiteExplorationPage.jsx', import.meta.url), 'utf8')
  assert.ok(page.includes('activityReady={Boolean(status.data || status.error)}'))
})

test('active development is pinned ahead of idle explorations without changing time order', () => {
 const records = [{ exploration_id: 'new', created_at_timestamp: 3 }, { exploration_id: 'dev', created_at_timestamp: 1 }, { exploration_id: 'middle', created_at_timestamp: 2 }]
 assert.deepEqual(sortExplorations(records, '', new Set(['dev'])).map(r => r.exploration_id), ['dev', 'new', 'middle'])
})


test('adapter generation uses non-development wording in every completion state', () => {
  for (const props of [{}, { developing: true }, { submitted: true }]) {
    const html = renderToStaticMarkup(React.createElement(components.CompletionQuestion, props))
    assert.match(html, /探索任务已完成，本次探索结果可生成可复用的网站适配器，以便下次直接操作网站。是否分析探索结果并生成网站适配器？/)
    assert.match(html, /是，生成网站适配器/)
    assert.doesNotMatch(html, /开发|Claude Code/)
  }
  const source = readFileSync(new URL('../components/website-exploration/ExploreWorkspace.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /开发对话|开发中|次开发|开始开发/)
  assert.match(source, /否，还需要进一步探索/)
})


test('in-progress indicator follows the same activity signals as list pinning', () => {
  for (const status of ['queued', 'pending', 'starting', 'running', 'cancel_requested']) {
    assert.equal(isExplorationInProgress({ exploration_id: 'exp', status }), true)
  }
  for (const status of ['succeeded', 'failed', 'cancelled', 'paused', 'waiting_for_user']) {
    assert.equal(isExplorationInProgress({ exploration_id: 'exp', status }), false)
  }
  assert.equal(isExplorationInProgress({ exploration_id: 'exp', status: 'succeeded' }, 'exp'), true)
  assert.equal(isExplorationInProgress({ exploration_id: 'exp', status: 'succeeded' }, '', new Set(['exp'])), true)
})

test('running records distinguish exploration from adapter generation independently of selection', () => {
  for (const selected of [true, false]) {
    for (const [generating, label] of [[false, '探索中'], [true, '生成中']]) {
      const html = renderToStaticMarkup(React.createElement(components.ExplorationRecord, { item: { title: '示例网站', status: 'running' }, selected, inProgress: true, generating }))
      assert.match(html, /is-in-progress/)
      assert.ok(html.includes(label))
      assert.match(html, /anticon-setting/)
      assert.match(html, /wx-record-progress-gear/)
      assert.equal(html.includes('is-active'), selected)
      assert.equal(html.includes('aria-current="true"'), selected)
      assert.doesNotMatch(html, /disabled=/)
    }
  }
  const html = renderToStaticMarkup(React.createElement(components.ExplorationRecord, { item: { title: '示例网站', status: 'succeeded' } }))
  assert.doesNotMatch(html, /is-in-progress|is-active|wx-record-progress-gear|探索中|生成中/)
})

test('only selected rows receive a persistent background and gear respects reduced motion', () => {
 const css = readFileSync(new URL('../components/website-exploration/website-exploration.css', import.meta.url), 'utf8')
 assert.match(css, /\.wx-record\.is-active:not\(\.chat-view \*\)/)
 assert.doesNotMatch(css, /is-in-progress/)
 assert.match(css, /wx-record-gear-turn 1.8s linear infinite/)
 assert.match(css, /prefers-reduced-motion:reduce/)
})

test('idle conversations show no lifecycle badge because they can always continue', () => {
 for (const status of ['succeeded', 'failed', 'cancelled', 'paused', 'waiting_for_user']) {
  const html = renderToStaticMarkup(React.createElement(components.ExplorationRecord, { item: { title: '示例网站', status } }))
  assert.doesNotMatch(html, /wx-status|已完成|探索中|生成中|wx-record-progress/)
 }
 const css = readFileSync(new URL('../components/website-exploration/website-exploration.css', import.meta.url), 'utf8')
 assert.match(css, /\.wx-record-progress \{[^}]*color:var\(--accent\)/)
})
