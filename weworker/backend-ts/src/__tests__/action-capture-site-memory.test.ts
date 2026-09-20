import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveSiteMemoryFromWorkflow, saveSiteMemoryFromActionCapture } from '../site-memory.js'

const SITE_MEMORY_ENV = 'WEWORKER_SITE_MEMORY_FILE'
const tempDirs: string[] = []
let previousSiteMemoryFile = ''

beforeEach(() => {
  previousSiteMemoryFile = process.env[SITE_MEMORY_ENV] || ''
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-site-memory-'))
  tempDirs.push(dir)
  process.env[SITE_MEMORY_ENV] = path.join(dir, 'site-memory.json')
})

afterEach(() => {
  if (previousSiteMemoryFile) process.env[SITE_MEMORY_ENV] = previousSiteMemoryFile
  else delete process.env[SITE_MEMORY_ENV]
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

  it('keeps existing action evidence when a V2 passive exploration saves site memory', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-memory-v2-preserve-'))
    const previousFile = process.env.WEWORKER_SITE_MEMORY_FILE
    process.env.WEWORKER_SITE_MEMORY_FILE = path.join(tempDir, 'site-memory.json')
    try {
      const { saveSiteMemoryFromWorkflow, getSiteMemory } = await import('../site-memory.js')
      const workflowResult = {
        pageStateBefore: { url: 'https://preserve.example.test/list' },
        resultPageState: { url: 'https://preserve.example.test/list' },
        network: { entries: [{ method: 'GET', url: 'https://preserve.example.test/api/list?page=1' }] },
        analysisV2: { schemaVersion: 2, candidates: [] },
        workflow: { version: 'exploration-evidence-v2-persisted' },
      }
      const first = saveSiteMemoryFromWorkflow(workflowResult)
      expect(first).not.toBeNull()
      // 模拟动作捕获已沉淀一条写操作证据
      const store = JSON.parse(fs.readFileSync(process.env.WEWORKER_SITE_MEMORY_FILE, 'utf8'))
      store.sites['preserve.example.test'].actionApiCandidates = [{
        actionName: '提交申请', method: 'POST', url: 'https://preserve.example.test/api/submit',
        toolName: 'preserve.example.test.submit_draft', capturedAt: '2026-09-15T02:00:00.000Z',
        responsePreview: '{"data":{"userId":"fixture-user-001","name":"private-user"}}',
      }]
      store.sites['preserve.example.test'].actionCaptureHistory = store.sites['preserve.example.test'].actionApiCandidates
      fs.writeFileSync(process.env.WEWORKER_SITE_MEMORY_FILE, JSON.stringify(store))

      const second = saveSiteMemoryFromWorkflow(workflowResult)
      expect(second?.actionApiCandidates).toHaveLength(1)
      expect(second?.actionCaptureHistory).toHaveLength(1)
      const persisted = getSiteMemory('preserve.example.test')
      expect(persisted?.actionApiCandidates?.map((candidate) => candidate.toolName))
        .toEqual(['preserve.example.test.submit_draft'])
      expect(persisted?.actionApiCandidates?.[0]?.responsePreview).toBeUndefined()
      expect(JSON.stringify(persisted)).not.toContain('fixture-user-001')
      expect(JSON.stringify(persisted)).not.toContain('private-user')
    } finally {
      if (previousFile === undefined) delete process.env.WEWORKER_SITE_MEMORY_FILE
      else process.env.WEWORKER_SITE_MEMORY_FILE = previousFile
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
describe('saveSiteMemoryFromActionCapture', () => {
  it('prefers an approval endpoint over a POST detail refresh for Chinese action names', () => {
    const saved = saveSiteMemoryFromActionCapture({
      site: 'tasks.example.com',
      actionName: '批阅待办',
      mode: 'intercept',
      workflow: { version: 'opencli-action-capture-v1' },
      capturedActions: [
        {
          url: 'https://tasks.example.com/api/todo/info/12345',
          method: 'POST',
          requestBodyPreview: '{"id":12345}',
          responsePreview: '{"data":{"id":12345,"title":"申请详情","history":[]}}',
          intercepted: true,
        },
        {
          url: 'https://tasks.example.com/api/todo/myApprove',
          method: 'POST',
          requestBodyPreview: '{"id":12345,"decision":"agree"}',
          responsePreview: '{"code":0,"message":"success"}',
          intercepted: true,
        },
      ],
      recommendation: { toolName: 'tasks.example.com.approve_todo_draft' },
    })

    expect(saved?.actionApiCandidates[0]?.url).toBe('https://tasks.example.com/api/todo/myApprove')
  })

  it('accepts an intercepted action capture result and returns a site memory record with action candidates', () => {
    const base = deriveSiteMemoryFromWorkflow({
      tabId: 1,
      opened: { url: 'https://rooms.example.com/' },
      pageStateBefore: { url: 'https://rooms.example.com/' },
      resultPageState: { url: 'https://rooms.example.com/' },
      pageStateAfter: { url: 'https://rooms.example.com/' },
      workflow: { version: 'opencli-like-v12' },
      verdict: { pattern: 'dom_driven', recommendedStrategy: 'UI', reason: 'ui first' },
      actions: [],
    })

    expect(base?.siteKey).toBe('rooms.example.com')

    const saved = saveSiteMemoryFromActionCapture({
      site: 'rooms.example.com',
      actionName: 'book_room',
      mode: 'intercept',
      workflow: { version: 'opencli-action-capture-v1' },
      capturedActions: [
        {
          url: 'https://rooms.example.com/api/booking/create',
          method: 'POST',
          requestBodyPreview: '{"roomId":"A101","start":"2026-05-14T15:00:00+08:00"}',
          intercepted: true,
          blockedReason: 'side-effect-safe-capture',
        },
      ],
      recommendation: {
        toolName: 'rooms.example.com.book_room_draft',
      },
    })

    expect(saved?.siteKey).toBe('rooms.example.com')
    expect(saved?.actionApiCandidates[0]?.actionName).toBe('book_room')
    expect(saved?.actionApiCandidates[0]?.url).toBe('https://rooms.example.com/api/booking/create')
    expect(saved?.actionApiCandidates[0]?.intercepted).toBe(true)
    expect(saved?.actionApiCandidates[0]?.toolName).toBe('rooms.example.com.book_room_draft')
    expect(saved?.actionCaptureHistory).toHaveLength(1)
    expect(saved?.actionCaptureHistory?.[0]?.url).toBe('https://rooms.example.com/api/booking/create')
    expect(saved?.actionEvidenceSummary?.historyCount).toBe(1)
    expect(saved?.actionEvidenceSummary?.toolSummaries[0]?.selectedUrl).toBe('https://rooms.example.com/api/booking/create')
  })

  it('prefers the business-relevant read request and preserves response structure without values', () => {
    const saved = saveSiteMemoryFromActionCapture({
      site: 'rooms.example.com',
      actionName: 'filter_rooms',
      mode: 'observe',
      workflow: { version: 'opencli-action-capture-v1' },
      capturedActions: [
        {
          url: 'https://rooms.example.com/',
          method: 'GET',
        },
        {
          url: 'https://rooms.example.com/api/directory/users',
          method: 'GET',
          responsePreview: '{"code":0}',
        },
        {
          url: 'https://rooms.example.com/api/rooms?bookTime=2026-05-13%2000%3A00%3A00&workplace=example-campus&floor=11&page=1&limit=999',
          method: 'GET',
          responseContentType: 'application/json',
          responsePreview: '{"data":{"list":[{"id":"room-1","roomcode":"1106"}]}}',
        },
      ],
      recommendation: {
        toolName: 'rooms.example.com.filter_rooms_draft',
      },
    })

    expect(saved?.actionApiCandidates[0]?.actionName).toBe('filter_rooms')
    expect(saved?.actionApiCandidates[0]?.toolName).toBe('rooms.example.com.filter_rooms_draft')
    expect(saved?.actionApiCandidates[0]?.url).toContain('/api/rooms?')
    expect(saved?.actionApiCandidates[0]?.responsePreview).toBeUndefined()
    expect(JSON.stringify(saved)).not.toContain('"roomcode":"1106"')
    expect(saved?.actionApiCandidates[0]?.responseContentType).toBe('application/json')
    expect(saved?.actionApiCandidates[0]?.responseHints?.listPath).toBe('data.list')
    expect(saved?.actionApiCandidates[0]?.responseHints?.itemKeys).toContain('id')
    expect(saved?.actionApiCandidates[0]?.responseHints?.displayLikeKeys).toContain('roomcode')
    expect(saved?.actionApiCandidates[0]?.responseHints?.preferredIdKey).toBe('id')
    expect(saved?.actionApiCandidates[0]?.responseHints?.preferredDisplayKey).toBe('roomcode')
    expect(saved?.actionCaptureHistory).toHaveLength(1)
    expect(saved?.actionEvidenceSummary?.toolSummaries[0]?.selectedSignals).toContain('has_response_shape')
    expect(saved?.actionEvidenceSummary?.toolSummaries[0]?.selectedSignals).toContain('json_response')
  })

  it('extracts fallback response hints from abbreviated response previews', () => {
    const saved = saveSiteMemoryFromActionCapture({
      site: 'rooms.example.com',
      actionName: 'filter_rooms',
      mode: 'observe',
      workflow: { version: 'opencli-action-capture-v1' },
      capturedActions: [
        {
          url: 'https://rooms.example.com/api/rooms?bookTime=2026-05-14%2000%3A00%3A00&workplace=example-campus&floor=11&page=1&limit=999',
          method: 'GET',
          responseContentType: 'application/json',
          responsePreview: '{"code":0,"msg":"success","data":{"total":2,"list":[...]}}',
        },
      ],
      recommendation: {
        toolName: 'rooms.example.com.filter_rooms_draft',
      },
    })

    expect(saved?.actionApiCandidates[0]?.responseHints?.listPath).toBe('data.list')
    expect(saved?.actionApiCandidates[0]?.responseHints?.topLevelKeys).toContain('code')
    expect(saved?.actionApiCandidates[0]?.responseHints?.topLevelKeys).toContain('data')
    expect(saved?.actionApiCandidates[0]?.responseHints?.preferredIdKey).toBe('')
    expect(saved?.actionCaptureHistory).toHaveLength(1)
  })

  it('keeps the stronger exact capture when a later weaker duplicate arrives', () => {
    const first = saveSiteMemoryFromActionCapture({
      site: 'rooms.example.com',
      actionName: 'filter_rooms',
      mode: 'observe',
      workflow: { version: 'opencli-action-capture-v1' },
      capturedActions: [
        {
          url: 'https://rooms.example.com/api/rooms?bookTime=2026-05-14%2000%3A00%3A00&workplace=example-campus&floor=11&page=1&limit=999',
          method: 'GET',
          responseContentType: 'application/json',
          responsePreview: '{"code":0,"msg":"success","data":{"total":2,"list":[{"id":"room-1","roomId":"room-1","roomcode":"1106","meetingInfoMaps":{"2026-05-14T14:30":null}}]}}',
        },
      ],
      recommendation: {
        toolName: 'rooms.example.com.filter_rooms_draft',
      },
    })

    const second = saveSiteMemoryFromActionCapture({
      site: 'rooms.example.com',
      actionName: 'filter_rooms',
      mode: 'observe',
      workflow: { version: 'opencli-action-capture-v1' },
      capturedActions: [
        {
          url: 'https://rooms.example.com/api/rooms?bookTime=2026-05-14%2000%3A00%3A00&workplace=example-campus&floor=11&page=1&limit=999',
          method: 'GET',
          responseContentType: 'application/json',
          responsePreview: '{"code":0,"msg":"success","data":{"total":2,"list":[...]}}',
        },
      ],
      recommendation: {
        toolName: 'rooms.example.com.filter_rooms_draft',
      },
    })

    expect(first?.actionApiCandidates).toHaveLength(1)
    expect(first?.actionCaptureHistory).toHaveLength(1)
    expect(second?.actionApiCandidates).toHaveLength(1)
    expect(second?.actionCaptureHistory).toHaveLength(1)
    expect(second?.actionApiCandidates[0]?.responseHints?.preferredAvailabilityKey).toBe('meetingInfoMaps')
    expect(second?.actionApiCandidates[0]?.responseHints?.availabilityLikeKeys).toContain('meetingInfoMaps')
    expect(second?.actionApiCandidates[0]?.responsePreview).toBeUndefined()
    expect(second?.actionCaptureHistory?.[0]?.responsePreview).toBeUndefined()
    expect(second?.actionEvidenceSummary?.historyCount).toBe(1)
    expect(second?.actionEvidenceSummary?.toolSummaries[0]?.selectedSignals).toContain('response_hints:14')
    expect(second?.actionEvidenceSummary?.toolSummaries[0]?.candidates).toHaveLength(1)
  })

  it('keeps the richer same-tool write capture ahead of a weaker later variant', () => {
    const first = saveSiteMemoryFromActionCapture({
      site: 'rooms.example.com',
      actionName: 'book_room',
      mode: 'intercept',
      workflow: { version: 'opencli-action-capture-v1' },
      capturedActions: [
        {
          url: 'https://rooms.example.com/api/bookings',
          method: 'POST',
          requestBodyPreview: '{"booker":"demo-user","bookerDept":"demo-user","roomId":"room-1","startTime":"2026-05-13 19:00:00","endTime":"2026-05-13 20:00:00","theme":"demo-user预定的会议室","meetingAttendees":[{"attendeeType":1,"meetingAttendee":"demo-user","needNotice":1}],"meetingAttachment":[],"needHidden":0,"description":""}',
          intercepted: true,
          blockedReason: 'side-effect-safe-capture',
        },
      ],
      recommendation: {
        toolName: 'rooms.example.com.book_room_draft',
      },
    })

    const second = saveSiteMemoryFromActionCapture({
      site: 'rooms.example.com',
      actionName: 'book_room',
      mode: 'intercept',
      workflow: { version: 'opencli-action-capture-v1' },
      capturedActions: [
        {
          url: 'https://rooms.example.com/api/booking/create',
          method: 'POST',
          requestBodyPreview: '{"roomId":"A101","start":"2026-05-14T15:00:00+08:00"}',
          intercepted: true,
          blockedReason: 'side-effect-safe-capture',
        },
      ],
      recommendation: {
        toolName: 'rooms.example.com.book_room_draft',
      },
    })

    expect(first?.actionApiCandidates[0]?.url).toBe('https://rooms.example.com/api/bookings')
    expect(first?.actionCaptureHistory).toHaveLength(1)
    expect(second?.actionApiCandidates[0]?.toolName).toBe('rooms.example.com.book_room_draft')
    expect(second?.actionApiCandidates[0]?.url).toBe('https://rooms.example.com/api/bookings')
    expect(second?.actionApiCandidates[0]?.requestBodyPreview).toBeUndefined()
    expect(second?.actionApiCandidates[0]?.requestEvidence).toMatchObject({
      bodyKind: 'json',
      bodyOmitted: false,
      bodyTruncated: false,
    })
    expect(second?.actionApiCandidates[0]?.requestEvidence?.bodyKeys).toContain('meetingAttendees')
    expect(second?.actionCaptureHistory).toHaveLength(2)
    expect(second?.actionCaptureHistory?.some((item) => item.url === 'https://rooms.example.com/api/booking/create')).toBe(true)
    expect(second?.actionCaptureHistory?.some((item) => item.url === 'https://rooms.example.com/api/bookings')).toBe(true)
    expect(second?.actionEvidenceSummary?.historyCount).toBe(2)
    expect(second?.actionEvidenceSummary?.bestViewCount).toBe(1)
    expect(second?.actionEvidenceSummary?.toolSummaries[0]?.historyCount).toBe(2)
    expect(second?.actionEvidenceSummary?.toolSummaries[0]?.selectedUrl).toBe('https://rooms.example.com/api/bookings')
    expect(second?.actionEvidenceSummary?.toolSummaries[0]?.selectedSignals).toContain('request_fields:10')
    expect(second?.actionEvidenceSummary?.toolSummaries[0]?.candidates.some((item) => (
      item.selected && item.url === 'https://rooms.example.com/api/bookings'
    ))).toBe(true)
  })

  it('persists truncated write bodies as opaque evidence without salvaging prefix fields or values', () => {
    const saved = saveSiteMemoryFromActionCapture({
      site: 'requests.example.com',
      actionName: 'submit_request',
      mode: 'intercept',
      workflow: { version: 'opencli-action-capture-v1' },
      capturedActions: [{
        url: 'https://requests.example.com/api/requests',
        method: 'POST',
        requestBodyPreview: '{"title":"private request","startAt":"2026-09-12","demands":[...[truncated]',
        requestBodyFullSize: 4096,
        requestBodyTruncated: true,
        intercepted: true,
      }],
      recommendation: { toolName: 'requests.example.com.submit_request_draft' },
    })

    expect(saved?.actionApiCandidates[0]?.requestBodyPreview).toBeUndefined()
    expect(saved?.actionApiCandidates[0]?.requestEvidence).toEqual({
      version: 'request-evidence-v1',
      bodyKind: 'opaque',
      bodyShape: null,
      bodyKeys: [],
      bodyFullSize: 4096,
      bodyTruncated: true,
      bodyOmitted: true,
    })
    expect(JSON.stringify(saved)).not.toContain('private request')
    expect(JSON.stringify(saved)).not.toContain('2026-09-12')
  })
})
