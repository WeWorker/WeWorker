import { describe, expect, it } from 'vitest'
import { analyzeApiEvidenceEntry, analyzeApiExplorationWorkflow, applyApiReplayEvidence } from '../api-exploration-evidence.js'
import { summarizeReplayResult } from '../api-candidate-replay.js'

const candidate = (response: unknown) => analyzeApiEvidenceEntry({
  url: 'https://example.com/api/search?q=fixture', method: 'GET', status: 200,
  responseContentType: 'application/json', responsePreview: JSON.stringify(response),
})

describe('API response failure classification', () => {
  it('filters JSON icon/font assets while keeping business JSON endpoints', () => {
    for (const path of ['/bfs/svg-next/icon/v1.json', '/assets/icons/index.json', '/static/fonts/metadata.json']) {
      const result = analyzeApiEvidenceEntry({ url: `https://example.com${path}`, method: 'GET', status: 200, responseContentType: 'application/json', responsePreview: '{"items":[{"id":"fixture"}]}' })
      expect(result.verdict).toBe('noise')
      expect(result.signals).toContain('static_asset')
    }
    for (const path of ['/api/search.json?keyword=icon', '/api/assets/list', '/api/static/search.json']) {
      const result = analyzeApiEvidenceEntry({ url: `https://example.com${path}`, method: 'GET', status: 200, responseContentType: 'application/json', responsePreview: '{"items":[{"id":"fixture"}]}' })
      expect(result.verdict).toBe('likely_data')
    }
  })
  it.each(['实现登录功能教程', '请登录提示的设计', 'Login tutorial', 'Captcha implementation', 'Fix access denied errors'])(
    'keeps a valid data response containing %s', title => {
      const result = candidate({ code: 0, data: { items: [{ id: 'fixture-item', title }] } })
      expect(result.verdict).toBe('likely_data')
      expect(result.signals).not.toContain('blocked_payload')
      expect(result.verificationFixture?.mustNotContain).toEqual([])
    },
  )

  it.each([
    { code: 401, message: 'Unauthorized' },
    { code: -1, message: '未登录，请先登录' },
    { error: { message: 'Captcha required' } },
    { error: 'Access denied' },
  ])('rejects actual authentication and access errors: %j', response => {
    const result = candidate(response)
    expect(result.verdict).toBe('blocked')
    expect(result.signals).toContain('blocked_payload')
    expect(result.verificationFixture).toBeNull()
  })

  it('uses response semantics during replay as well as initial classification', () => {
    for (const title of ['Login tutorial', '实现登录功能教程', 'Captcha implementation']) {
      const replay = summarizeReplayResult({ transport: 'browser_page', status: 200, ok: true, contentType: 'application/json', responsePreview: JSON.stringify({ data: { items: [{ title }] } }), durationMs: 1, errorCode: '' }, {})
      expect(replay.nonEmpty).toBe(true)
    }
    expect(summarizeReplayResult({ transport: 'browser_page', status: 200, ok: true, contentType: 'application/json', responsePreview: '{"code":401,"message":"Please log in"}', durationMs: 1, errorCode: '' }, {}).nonEmpty).toBe(false)
  })

  it('retains a verified replay after another safe probe, without transferring it to a different origin or contract', () => {
    const entry = { url: 'https://example.com/api/search?q=fixture', method: 'GET', status: 200, responseContentType: 'application/json', responsePreview: '{"items":[{"id":"fixture"}]}' }
    const workflow = { network: { entries: [entry] } }
    const initial = analyzeApiExplorationWorkflow(workflow)
    const replay = summarizeReplayResult({ transport: 'browser_page', status: 200, ok: true, contentType: 'application/json', responsePreview: entry.responsePreview, durationMs: 1, errorCode: '' }, entry)
    const verified = applyApiReplayEvidence(initial, initial.candidates[0].evidenceId, replay)
    const updated = analyzeApiExplorationWorkflow({ ...workflow, actions: [{ step: 'safe_search', networkDelta: { entries: [{ ...entry, url: 'https://example.com/api/search?q=another' }] } }] }, verified)
    expect(updated.candidates[0].strategyNote.replayStatus).toBe('verified')
    for (const changed of [
      { ...entry, url: 'https://other.example.com/api/search?q=fixture' },
      { ...entry, responsePreview: '{"records":[{"name":"fixture"}]}' },
      { ...entry, status: 403, responsePreview: '{"error":"Access denied"}' },
    ]) {
      const analysis = analyzeApiExplorationWorkflow({ network: { entries: [changed] } }, verified)
      expect(analysis.candidates[0].strategyNote.replayStatus).not.toBe('verified')
    }
  })

  it('compares later probes with the original truncated capture rather than the fuller replay response', () => {
    const entry = { url: 'https://example.com/api/search?q=fixture', method: 'GET', status: 200, responseContentType: 'application/json', responsePreview: '{"items":[{"title":"...[truncated]' }
    const initial = analyzeApiExplorationWorkflow({ network: { entries: [entry] } })
    const replay = summarizeReplayResult({ transport: 'browser_page', status: 200, ok: true, contentType: 'application/json', responsePreview: '{"items":[{"id":"fixture","title":"Example"}]}', durationMs: 1, errorCode: '' }, entry)
    const verified = applyApiReplayEvidence(initial, initial.candidates[0].evidenceId, replay)
    expect(verified.candidates[0].responseShape.kind).toBe('object')
    const later = analyzeApiExplorationWorkflow({ network: { entries: [entry] }, actions: [{ step: 'safe_search', networkDelta: { entries: [{ ...entry, url: 'https://example.com/api/search?q=another' }] } }] }, verified)
    expect(later.candidates[0].strategyNote.replayStatus).toBe('verified')
    expect(later.candidates[0].responseShape.kind).toBe('object')
    expect(later.candidates[0].replayCaptureDigest).toMatch(/^[a-f0-9]{64}$/)
    const changed = analyzeApiExplorationWorkflow({ network: { entries: [{ ...entry, responsePreview: '{"records":[]}' }] } }, verified)
    expect(changed.candidates[0].strategyNote.replayStatus).not.toBe('verified')
  })
})
