import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { writeScaffoldFromSiteMemory } from '../../../../webcli/adapter-scaffold.js'
import type { SiteMemoryRecord } from '../site-memory.js'

const tempDirs: string[] = []

function readGeneratedSupportFiles(manifestPath: string): Array<{ relPath: string, content: string }> {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { support_files?: string[] }
  const adapterDir = path.dirname(manifestPath)
  return (manifest.support_files || []).map((relPath) => ({
    relPath,
    content: fs.readFileSync(path.join(adapterDir, relPath), 'utf8'),
  }))
}

function combineGeneratedSupport(manifestPath: string): string {
  return readGeneratedSupportFiles(manifestPath).map((file) => file.content).join('\n\n')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('writeScaffoldFromSiteMemory', () => {
  it('writes an incremental draft into the existing adapter directory', () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'site-scaffold-'))
    tempDirs.push(outputRoot)

    const adapterDir = path.join(outputRoot, 'tickets.example.com')
    fs.mkdirSync(adapterDir, { recursive: true })
    fs.writeFileSync(path.join(adapterDir, 'index.js'), 'window.__webmcpRegister({ name: "ticketing", tools: [] })\n', 'utf8')
    fs.writeFileSync(path.join(adapterDir, 'manifest.json'), `${JSON.stringify({
      id: 'tickets.example.com',
      name: 'Ticketing',
      match: ['tickets.example.com'],
    }, null, 2)}\n`, 'utf8')

    const memory: SiteMemoryRecord = {
      siteKey: 'tickets.example.com',
      siteHost: 'tickets.example.com',
      siteOrigin: 'https://tickets.example.com',
      updatedAt: '2026-05-12T09:07:17.266Z',
      firstCapturedAt: '2026-05-12T09:07:17.266Z',
      captureCount: 1,
      workflowVersion: 'opencli-like-v12',
      workflowVersionsSeen: ['opencli-like-v12'],
      lastSourceUrl: 'https://tickets.example.com/ticketing/request/index.html#/globalSearch?keyword=test',
      canonicalEntryUrl: 'https://tickets.example.com/ticketing/web/index.html#/',
      canonicalResultUrl: 'https://tickets.example.com/ticketing/request/index.html#/globalSearch?keyword=test',
      verdictPattern: 'api_driven',
      recommendedStrategy: 'COOKIE_API',
      verdictReason: 'best candidate is getCiGroup',
      search: {
        executed: true,
        action: 'search_enter',
        keywordSeed: 'test',
      },
      resultSignals: {
        listCandidates: 5,
        paginationCandidates: 10,
      },
      listApiCandidates: [
        {
          url: 'https://tickets.example.com/ticketing/getCiGroup.spr',
          method: 'POST',
          requestBodyPreview: 'keyword=test&history=lastYear',
          sourceSteps: ['search'],
        },
        {
          url: 'https://tickets.example.com/ticketing/getCiList.spr',
          method: 'POST',
          requestBodyPreview: 'keyword=test&typeId=&currentPage=1&pageSize=20&history=lastYear',
          sourceSteps: ['search'],
        },
      ],
      actionApiCandidates: [],
      detailHints: {
        mode: 'inspect_only',
        bestCandidateHref: 'https://tickets.example.com/ticketing/request/index.html#/requestDetail/12345',
        bestCandidateText: '[12345] test ticket',
        networkDetailCandidates: [
          'https://tickets.example.com/ticketing/request/index.html#/requestDetail/12345',
        ],
      },
      pagination: {
        attempted: true,
        verified: false,
        mode: 'dispatch_click',
        targetPage: 2,
        activePageBefore: 1,
        activePageAfter: 1,
        reason: 'next-page-not-confirmed',
      },
      rawSummary: {
        tabId: 1,
        resultPageUrl: 'https://tickets.example.com/ticketing/request/index.html#/globalSearch?keyword=test',
        finalPageUrl: 'https://tickets.example.com/ticketing/request/index.html#/globalSearch?keyword=test',
      },
    }

    const result = writeScaffoldFromSiteMemory(memory, { outputRoot })

    expect(result.mode).toBe('augment_existing_adapter')
    expect(result.generationStrategy).toBe('list_only')
    expect(result.primaryListApiUrl).toBe('https://tickets.example.com/ticketing/getCiList.spr')
    expect(result.actionApiUrls).toEqual([])
    expect(fs.existsSync(result.files.supportFile)).toBe(true)
    expect(fs.existsSync(result.files.sharedRuntime)).toBe(true)
    expect(fs.existsSync(result.files.indexSnippet)).toBe(true)
    expect(fs.existsSync(result.files.integrationGuide)).toBe(true)
    expect(fs.existsSync(result.files.skill)).toBe(true)

    const supportFile = combineGeneratedSupport(result.files.manifest)
    expect(supportFile).toContain('window.__webmcpGeneratedSupport')
    expect(supportFile).toContain('tickets.example.com.search_records')
    expect(supportFile).toContain('tickets.example.com.fetch_summary_groups')
    expect(supportFile).toContain('tickets.example.com.list_detail_candidates')
    expect(supportFile).toContain('https://tickets.example.com/ticketing/getCiList.spr')
    expect(readGeneratedSupportFiles(result.files.manifest).map((file) => file.relPath)).toEqual(result.supportFiles)

    const snippet = fs.readFileSync(result.files.indexSnippet, 'utf8')
    expect(snippet).toContain('window.__webmcpGeneratedSupport')
    expect(snippet).toContain('tickets.example.com')

    const manifest = JSON.parse(fs.readFileSync(result.files.manifest, 'utf8')) as { support_files?: string[] }
    expect(manifest.support_files).toEqual(result.supportFiles)
    expect(manifest.support_files?.[0]).toBe('webcli-generated/shared/tickets.example.com.runtime.generated.js')
    expect(manifest.support_files?.[manifest.support_files.length - 1]).toBe('webcli-generated/tickets.example.com.site-entry.generated.js')
    expect(result.indexCatalogUpdated).toBe(true)

    const adapterIndexCatalog = JSON.parse(fs.readFileSync(path.join(outputRoot, 'index.json'), 'utf8')) as string[]
    expect(adapterIndexCatalog).toEqual(['tickets.example.com'])
    expect(fs.existsSync(path.join(outputRoot, 'registry.json'))).toBe(false)

    const indexFile = fs.readFileSync(result.files.adapterIndex, 'utf8')
    expect(indexFile).toBe('window.__webmcpRegister({ name: "ticketing", tools: [] })\n')

    const skillFile = fs.readFileSync(result.files.skill, 'utf8')
    expect(skillFile).toContain('# Ticketing')
    expect(skillFile).toContain('Matches: tickets.example.com')
    expect(skillFile).toContain('## 使用建议')
    expect(skillFile).toContain('tickets.example.com.search_records')
    expect(skillFile).toContain('tickets.example.com.list_detail_candidates')
  })

  it('writes an action-first bootstrap draft when only captured action apis are available', () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'site-scaffold-action-'))
    tempDirs.push(outputRoot)

    const memory: SiteMemoryRecord = {
      siteKey: 'rooms.example.com',
      siteHost: 'rooms.example.com',
      siteOrigin: 'https://rooms.example.com',
      updatedAt: '2026-05-13T02:56:57.959Z',
      firstCapturedAt: '2026-05-13T02:56:57.959Z',
      captureCount: 1,
      workflowVersion: 'opencli-action-capture-v1',
      workflowVersionsSeen: ['opencli-action-capture-v1'],
      lastSourceUrl: 'https://rooms.example.com/#/',
      canonicalEntryUrl: 'https://rooms.example.com/#/',
      canonicalResultUrl: 'https://rooms.example.com/#/',
      verdictPattern: '',
      recommendedStrategy: '',
      verdictReason: '',
      search: {
        executed: false,
        action: '',
        keywordSeed: '',
      },
      resultSignals: {
        listCandidates: 0,
        paginationCandidates: 0,
      },
      listApiCandidates: [],
      actionApiCandidates: [
        {
          actionName: 'book_room',
          mode: 'intercept',
          toolName: 'rooms.example.com.book_room_draft',
          url: 'https://rooms.example.com/api/bookings',
          method: 'POST',
          requestBodyPreview: '{"booker":"demo-user","bookerDept":"demo-user","roomId":"room-1","startTime":"2026-05-13 19:00:00","endTime":"2026-05-13 20:00:00","theme":"demo-user预定的会议室","meetingAttendees":[{"attendeeType":1,"meetingAttendee":"demo-user","needNotice":1}],"meetingAttachment":[],"needHidden":0,"description":""}',
          intercepted: true,
          blockedReason: 'side-effect-safe-capture',
          capturedAt: '2026-05-13T02:56:57.959Z',
          sourceWorkflowVersion: 'opencli-action-capture-v1',
        },
      ],
      detailHints: {
        mode: '',
        bestCandidateHref: '',
        bestCandidateText: '',
        networkDetailCandidates: [],
      },
      pagination: {
        attempted: false,
        verified: false,
        mode: '',
        targetPage: null,
        activePageBefore: null,
        activePageAfter: null,
        reason: '',
      },
      rawSummary: {
        tabId: 1,
        resultPageUrl: 'https://rooms.example.com/#/',
        finalPageUrl: 'https://rooms.example.com/#/',
      },
    }

    const result = writeScaffoldFromSiteMemory(memory, { outputRoot })

    expect(result.mode).toBe('bootstrap_adapter_draft')
    expect(result.generationStrategy).toBe('action_only')
    expect(result.primaryListApiUrl).toBe('')
    expect(result.actionApiUrls).toEqual(['https://rooms.example.com/api/bookings'])
    expect(result.toolNames).toContain('rooms.example.com.book_room')
    expect(result.toolNames).not.toContain('rooms.example.com.book_room_draft')
    expect(result.toolNames).not.toContain('rooms.example.com.book_room_normalized')
    expect(result.toolNames).not.toContain('rooms.example.com.list_resources')
    expect(result.toolNames).not.toContain('rooms.example.com.find_available_resources')

    const supportFile = combineGeneratedSupport(result.files.manifest)
    expect(supportFile).toContain('rooms.example.com.book_room')
    expect(supportFile).toContain('https://rooms.example.com/api/bookings')
    expect(supportFile).toContain('meetingAttendees')
    expect(supportFile).toContain('sendJson')

    const manifest = JSON.parse(fs.readFileSync(result.files.manifest, 'utf8')) as { support_files?: string[] }
    expect(manifest.support_files).toEqual(result.supportFiles)
    expect(manifest.support_files?.[0]).toBe('webcli-generated/shared/rooms.example.com.runtime.generated.js')
    expect(manifest.support_files?.[manifest.support_files.length - 1]).toBe('webcli-generated/rooms.example.com.site-entry.generated.js')
    expect(result.indexCatalogUpdated).toBe(true)

    const adapterIndexCatalog = JSON.parse(fs.readFileSync(path.join(outputRoot, 'index.json'), 'utf8')) as string[]
    expect(adapterIndexCatalog).toEqual(['rooms.example.com'])
    expect(fs.existsSync(path.join(outputRoot, 'registry.json'))).toBe(false)

    const indexFile = fs.readFileSync(result.files.adapterIndex, 'utf8')
    expect(indexFile).toContain('window.__webmcpGeneratedSupport')
    expect(indexFile).toContain('rooms.example.com')
  })

  it('prefers a stronger verdict-derived room list api over weak record endpoints when action capture exists', () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'site-scaffold-hybrid-'))
    tempDirs.push(outputRoot)

    const memory: SiteMemoryRecord = {
      siteKey: 'rooms.example.com',
      siteHost: 'rooms.example.com',
      siteOrigin: 'https://rooms.example.com',
      updatedAt: '2026-05-13T02:56:57.963Z',
      firstCapturedAt: '2026-05-13T02:56:57.963Z',
      captureCount: 1,
      workflowVersion: 'opencli-action-capture-v1',
      workflowVersionsSeen: ['opencli-like-v12', 'opencli-action-capture-v1'],
      lastSourceUrl: 'https://rooms.example.com/#/',
      canonicalEntryUrl: 'https://rooms.example.com/#/',
      canonicalResultUrl: 'https://rooms.example.com/#/',
      verdictPattern: 'api_driven',
      recommendedStrategy: 'COOKIE_API',
      verdictReason: '观察到 9 条疑似业务接口请求，其中 9 条呈现列表/分页特征；最强候选为 https://rooms.example.com/api/rooms。',
      search: {
        executed: false,
        action: '',
        keywordSeed: '',
      },
      resultSignals: {
        listCandidates: 4,
        paginationCandidates: 0,
      },
      listApiCandidates: [
        {
          url: 'https://rooms.example.com/api/telemetry/health',
          method: 'GET',
          requestBodyPreview: '',
          sourceSteps: ['final_network'],
        },
        {
          url: 'https://rooms.example.com/api/telemetry/status',
          method: 'GET',
          requestBodyPreview: '',
          sourceSteps: ['final_network'],
        },
      ],
      actionApiCandidates: [
        {
          actionName: 'book_room',
          mode: 'intercept',
          toolName: 'rooms.example.com.book_room_draft',
          url: 'https://rooms.example.com/api/bookings',
          method: 'POST',
          requestBodyPreview: '{"roomId":"room-1","startTime":"2026-05-13 19:00:00","endTime":"2026-05-13 20:00:00"}',
          intercepted: true,
          blockedReason: 'side-effect-safe-capture',
          capturedAt: '2026-05-13T02:56:57.963Z',
          sourceWorkflowVersion: 'opencli-action-capture-v1',
        },
      ],
      detailHints: {
        mode: '',
        bestCandidateHref: '',
        bestCandidateText: '',
        networkDetailCandidates: [],
      },
      pagination: {
        attempted: false,
        verified: false,
        mode: '',
        targetPage: null,
        activePageBefore: null,
        activePageAfter: null,
        reason: '',
      },
      rawSummary: {
        tabId: 1,
        resultPageUrl: 'https://rooms.example.com/#/',
        finalPageUrl: 'https://rooms.example.com/#/',
      },
    }

    const result = writeScaffoldFromSiteMemory(memory, { outputRoot })

    expect(result.generationStrategy).toBe('hybrid')
    expect(result.primaryListApiUrl).toBe('https://rooms.example.com/api/rooms')
    expect(result.secondaryApiUrl).toBe('')

    const supportFile = combineGeneratedSupport(result.files.manifest)
    expect(supportFile).toContain('fetchGet("https://rooms.example.com/api/rooms"')
    expect(supportFile).not.toContain('/api/telemetry/health')
    expect(supportFile).not.toContain('/api/telemetry/status')
  })

  it('generates a query-capable read draft from a captured GET action candidate', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'site-scaffold-filter-'))
    tempDirs.push(outputRoot)

    const memory: SiteMemoryRecord = {
      siteKey: 'rooms.example.com',
      siteHost: 'rooms.example.com',
      siteOrigin: 'https://rooms.example.com',
      updatedAt: '2026-05-13T08:00:00.000Z',
      firstCapturedAt: '2026-05-13T08:00:00.000Z',
      captureCount: 1,
      workflowVersion: 'opencli-action-capture-v1',
      workflowVersionsSeen: ['opencli-action-capture-v1'],
      lastSourceUrl: 'https://rooms.example.com/#/',
      canonicalEntryUrl: 'https://rooms.example.com/#/',
      canonicalResultUrl: 'https://rooms.example.com/#/',
      verdictPattern: 'api_driven',
      recommendedStrategy: 'COOKIE_API',
      verdictReason: '',
      search: {
        executed: false,
        action: '',
        keywordSeed: '',
      },
      resultSignals: {
        listCandidates: 0,
        paginationCandidates: 0,
      },
      listApiCandidates: [],
      actionApiCandidates: [
        {
          actionName: 'book_room',
          mode: 'intercept',
          toolName: 'rooms.example.com.book_room_draft',
          url: 'https://rooms.example.com/api/bookings',
          method: 'POST',
          requestBodyPreview: '{"booker":"demo-user","bookerDept":"demo-user","roomId":"room-1","startTime":"2026-05-13 19:00:00","endTime":"2026-05-13 20:00:00","theme":"demo-user预定的会议室","meetingAttendees":[{"attendeeType":1,"meetingAttendee":"demo-user","needNotice":1}],"meetingAttachment":[],"needHidden":0,"description":""}',
          intercepted: true,
          blockedReason: 'side-effect-safe-capture',
          capturedAt: '2026-05-13T08:02:00.000Z',
          sourceWorkflowVersion: 'opencli-action-capture-v1',
        },
        {
          actionName: 'filter_rooms',
          mode: 'observe',
          toolName: 'rooms.example.com.filter_rooms_draft',
          url: 'https://rooms.example.com/api/rooms?bookTime=2026-05-13%2000%3A00%3A00&workplace=example-campus&floor=11&page=1&limit=999',
          method: 'GET',
          requestBodyPreview: '',
          responsePreview: '{"data":{"list":[{"id":"room-1","roomcode":"1106"}]}}',
          responseContentType: 'application/json',
          responseHints: {
            topLevelKeys: ['data'],
            listPath: 'data.list',
            itemKeys: ['id', 'roomcode'],
            idLikeKeys: ['id'],
            displayLikeKeys: ['roomcode'],
            availabilityLikeKeys: ['meetingInfoMaps'],
            preferredIdKey: 'id',
            preferredDisplayKey: 'roomcode',
            preferredAvailabilityKey: 'meetingInfoMaps',
          },
          intercepted: false,
          blockedReason: '',
          capturedAt: '2026-05-13T08:00:00.000Z',
          sourceWorkflowVersion: 'opencli-action-capture-v1',
        },
        {
          actionName: 'filter_rooms',
          mode: 'observe',
          toolName: 'rooms.example.com.filter_rooms_draft',
          url: 'https://rooms.example.com/api/rooms?bookTime=2026-05-14%2000%3A00%3A00&workplace=example-campus&floor=11&page=1&limit=999',
          method: 'GET',
          requestBodyPreview: '',
          responsePreview: '{"code":0,"msg":"success","data":{"total":2,"list":[...]}}',
          responseContentType: 'application/json',
          responseHints: {
            topLevelKeys: ['code', 'msg', 'data'],
            listPath: 'data.list',
            itemKeys: [],
            idLikeKeys: [],
            displayLikeKeys: [],
            availabilityLikeKeys: [],
            preferredIdKey: '',
            preferredDisplayKey: '',
            preferredAvailabilityKey: '',
          },
          intercepted: false,
          blockedReason: '',
          capturedAt: '2026-05-13T08:01:00.000Z',
          sourceWorkflowVersion: 'opencli-action-capture-v1',
        },
      ],
      detailHints: {
        mode: '',
        bestCandidateHref: '',
        bestCandidateText: '',
        networkDetailCandidates: [],
      },
      pagination: {
        attempted: false,
        verified: false,
        mode: '',
        targetPage: null,
        activePageBefore: null,
        activePageAfter: null,
        reason: '',
      },
      rawSummary: {
        tabId: 1,
        resultPageUrl: 'https://rooms.example.com/#/',
        finalPageUrl: 'https://rooms.example.com/#/',
      },
    }

    const result = writeScaffoldFromSiteMemory(memory, { outputRoot })

    expect(result.generationStrategy).toBe('action_only')
    expect(result.toolNames).toContain('rooms.example.com.book_room')
    expect(result.toolNames).toContain('rooms.example.com.filter_rooms')
    expect(result.toolNames).toContain('rooms.example.com.filter_rooms_normalized')
    expect(result.toolNames).toContain('rooms.example.com.list_resources')
    expect(result.toolNames).toContain('rooms.example.com.find_available_resources')
    expect(result.toolNames).not.toContain('rooms.example.com.book_room_draft')
    expect(result.toolNames).not.toContain('rooms.example.com.filter_rooms_draft')
    expect(result.toolNames).not.toContain('rooms.example.com.prepare_book_room')
    expect(result.toolNames).not.toContain('rooms.example.com.plan_book_room')
    expect(result.toolNames.filter((name) => name === 'rooms.example.com.book_room')).toHaveLength(1)
    expect(result.toolNames.filter((name) => name === 'rooms.example.com.filter_rooms')).toHaveLength(1)
    expect(result.toolNames.filter((name) => name === 'rooms.example.com.filter_rooms_normalized')).toHaveLength(1)

    const supportFile = combineGeneratedSupport(result.files.manifest)
    expect(supportFile).toContain('rooms.example.com.book_room')
    expect(supportFile).toContain('rooms.example.com.filter_rooms')
    expect(supportFile).toContain('rooms.example.com.filter_rooms_normalized')
    expect(supportFile).toContain('rooms.example.com.list_resources')
    expect(supportFile).toContain('rooms.example.com.find_available_resources')
    expect(supportFile).not.toContain('rooms.example.com.prepare_book_room')
    expect(supportFile).not.toContain('rooms.example.com.plan_book_room')
    expect(supportFile.match(/name: "rooms\.example\.com\.book_room"/g)).toHaveLength(1)
    expect(supportFile.match(/name: "rooms\.example\.com\.filter_rooms"/g)).toHaveLength(1)
    expect(supportFile.match(/name: "rooms\.example\.com\.filter_rooms_normalized"/g)).toHaveLength(1)
    expect(supportFile.match(/name: "rooms\.example\.com\.list_resources"/g)).toHaveLength(1)
    expect(supportFile.match(/name: "rooms\.example\.com\.find_available_resources"/g)).toHaveLength(1)
    expect(supportFile).toContain('fetchGet("https://rooms.example.com/api/rooms", args || {})')
    expect(supportFile).toContain('normalizeListItems')
    expect(supportFile).toContain('listSemanticResources')
    expect(supportFile).toContain('findSemanticAvailableResources')
    expect(supportFile).toContain('"bookTime"')
    expect(supportFile).toContain('"workplace"')
    expect(supportFile).toContain('"floor"')
    expect(supportFile).toContain('"limit"')
    expect(supportFile).toContain('"query"')
    expect(supportFile).toContain('"resourceId"')
    expect(supportFile).toContain('actionHints')
    expect(supportFile).toContain('"preferredIdKey": "id"')
    expect(supportFile).toContain('"preferredDisplayKey": "roomcode"')
    expect(supportFile).toContain('"preferredAvailabilityKey": "meetingInfoMaps"')
    expect(supportFile).toContain('"semanticToolNames": [\n      "rooms.example.com.list_resources"')
    expect(supportFile).toContain('"planningHints": {')
    expect(supportFile).not.toContain('"resourceIdParameter"')
    expect(supportFile).toContain('"resourceLookupToolNames": [')
    expect(supportFile).toContain('"rooms.example.com.list_resources"')
    expect(supportFile).toContain('"rooms.example.com.find_available_resources"')
    expect(supportFile).toContain('"resourceLookupNormalizedToolName": "rooms.example.com.filter_rooms_normalized"')
    expect(supportFile).toContain('"availabilityLookupToolName": "rooms.example.com.find_available_resources"')
    expect(supportFile).not.toContain('prepareActionToolName')
    expect(supportFile).not.toContain('planActionToolName')
    expect(supportFile).not.toContain('"startTimeParameter"')
    expect(supportFile).not.toContain('"endTimeParameter"')
    expect(supportFile).toContain('requiresConfirmation: true')
    expect(supportFile).toContain('missing_confirmation')
    expect(supportFile).toContain('__confirmed = false')
    expect(supportFile).toContain('x-webcli-requires-confirmation')
    expect(supportFile).toContain('AGENT_AUTHORED_WRITE_REQUIRED')
    expect(supportFile).toContain('"x-webcli-agent-authored": false')
    expect(supportFile).not.toContain('"booker":"demo-user')
    expect(supportFile).not.toContain('room-1')
    expect(supportFile).not.toContain('2026-05-13 19:00:00')
    expect(supportFile).not.toContain('__fieldSources')
    expect(supportFile).not.toContain('confirmedActionArgs')

    const guide = fs.readFileSync(result.files.integrationGuide, 'utf8')
    expect(guide).toContain('Agent')
    expect(guide).not.toContain('- 资源 ID 参数（book_room）')
    expect(guide).not.toContain('- 时间参数（book_room）')
    expect(guide).toContain('## 运行时启用')
    expect(guide).toContain('写操作由当前调用宿主按最终 payload 完成一次用户确认')

    const fetchUrls: string[] = []
    const context = {
      window: {
        location: {
          origin: 'https://rooms.example.com',
          hostname: 'rooms.example.com',
          href: 'https://rooms.example.com/#/',
        },
      },
      document: {
        body: {
          innerText: 'mocked',
        },
      },
      URL,
      console,
      fetch: async (input: string | URL) => {
        const requestUrl = String(input)
        fetchUrls.push(requestUrl)
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            data: {
              list: [
                {
                  id: 'room-1',
                  roomcode: '1106',
                  meetingInfoMaps: {
                    '2026-05-15T15:00': null,
                  },
                },
                {
                  id: '1985620797049892865',
                  roomcode: '1105',
                  meetingInfoMaps: {
                    '2026-05-15T15:00': null,
                  },
                },
              ],
            },
          }),
        }
      },
    }
    vm.runInNewContext(supportFile, context)
    const generatedSupport = (context.window as {
      __webmcpGeneratedSupport?: Record<string, { tools: Array<{
        name: string
        parameters?: Record<string, unknown>
        handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
      }> }>
    }).__webmcpGeneratedSupport
    const actionTool = generatedSupport?.['rooms.example.com']?.tools.find((tool) => tool.name === 'rooms.example.com.book_room')
    const readTool = generatedSupport?.['rooms.example.com']?.tools.find((tool) => tool.name === 'rooms.example.com.filter_rooms')
    expect(actionTool).toBeTruthy()
    expect(readTool).toBeTruthy()
    expect(actionTool?.parameters?.['x-webcli-requires-confirmation']).toBe(true)
    expect((actionTool?.parameters as { properties?: Record<string, { default?: unknown }> } | undefined)?.properties?.roomId?.default).toBeUndefined()
    expect((readTool?.parameters as { properties?: Record<string, { default?: unknown }> } | undefined)?.properties?.bookTime?.default).toBeUndefined()

    const unconfirmedAction = await actionTool!.handler({
      roomId: 'room-1',
      startTime: '2026-05-15 15:00:00',
      endTime: '2026-05-15 16:00:00',
    }) as {
      ok: boolean
      blocked?: boolean
      warnings?: string[]
      payload?: Record<string, unknown>
    }
    expect(unconfirmedAction.ok).toBe(false)
    expect(unconfirmedAction.blocked).toBe(true)
    expect(unconfirmedAction.warnings).toContain('missing_confirmation')
    expect(unconfirmedAction.payload?.roomId).toBeUndefined()
    expect(fetchUrls).toHaveLength(0)

    await expect(actionTool!.handler({ __confirmed: true })).rejects.toThrow('AGENT_AUTHORED_WRITE_REQUIRED')
    expect(fetchUrls).toHaveLength(0)

    const readResult = await readTool!.handler({ bookTime: '2026-05-15 00:00:00' }) as {
      ok: boolean
      status: number
    }
    expect(readResult.ok).toBe(true)
    expect(readResult.status).toBe(200)
    expect(fetchUrls).toHaveLength(1)
  })

  it('prefers the richer same-tool write capture when weaker variants share the tool name', () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'site-scaffold-write-ranking-'))
    tempDirs.push(outputRoot)

    const memory: SiteMemoryRecord = {
      siteKey: 'rooms.example.com',
      siteHost: 'rooms.example.com',
      siteOrigin: 'https://rooms.example.com',
      updatedAt: '2026-05-14T10:00:00.000Z',
      firstCapturedAt: '2026-05-13T02:56:57.963Z',
      captureCount: 2,
      workflowVersion: 'opencli-action-capture-v1',
      workflowVersionsSeen: ['opencli-action-capture-v1'],
      lastSourceUrl: 'https://rooms.example.com/#/',
      canonicalEntryUrl: 'https://rooms.example.com/#/',
      canonicalResultUrl: 'https://rooms.example.com/#/',
      verdictPattern: '',
      recommendedStrategy: '',
      verdictReason: '',
      search: {
        executed: false,
        action: '',
        keywordSeed: '',
      },
      resultSignals: {
        listCandidates: 0,
        paginationCandidates: 0,
      },
      listApiCandidates: [],
      actionApiCandidates: [
        {
          actionName: 'book_room',
          mode: 'intercept',
          toolName: 'rooms.example.com.book_room_draft',
          url: 'https://rooms.example.com/api/booking/create',
          method: 'POST',
          requestBodyPreview: '{"roomId":"A101","start":"2026-05-14T15:00:00+08:00"}',
          intercepted: true,
          blockedReason: 'side-effect-safe-capture',
          capturedAt: '2026-05-14T10:00:00.000Z',
          sourceWorkflowVersion: 'opencli-action-capture-v1',
        },
        {
          actionName: 'book_room',
          mode: 'intercept',
          toolName: 'rooms.example.com.book_room_draft',
          url: 'https://rooms.example.com/api/bookings',
          method: 'POST',
          requestBodyPreview: '{"booker":"demo-user","bookerDept":"demo-user","roomId":"room-1","startTime":"2026-05-13 19:00:00","endTime":"2026-05-13 20:00:00","theme":"demo-user预定的会议室","meetingAttendees":[{"attendeeType":1,"meetingAttendee":"demo-user","needNotice":1}],"meetingAttachment":[],"needHidden":0,"description":""}',
          intercepted: true,
          blockedReason: 'side-effect-safe-capture',
          capturedAt: '2026-05-13T02:56:57.963Z',
          sourceWorkflowVersion: 'opencli-action-capture-v1',
        },
      ],
      detailHints: {
        mode: '',
        bestCandidateHref: '',
        bestCandidateText: '',
        networkDetailCandidates: [],
      },
      pagination: {
        attempted: false,
        verified: false,
        mode: '',
        targetPage: null,
        activePageBefore: null,
        activePageAfter: null,
        reason: '',
      },
      rawSummary: {
        tabId: 1,
        resultPageUrl: 'https://rooms.example.com/#/',
        finalPageUrl: 'https://rooms.example.com/#/',
      },
    }

    const result = writeScaffoldFromSiteMemory(memory, { outputRoot })
    const supportFile = combineGeneratedSupport(result.files.manifest)

    expect(result.toolNames.filter((name) => name === 'rooms.example.com.book_room')).toHaveLength(1)
    expect(supportFile).toContain('"endpoint": "https://rooms.example.com/api/bookings"')
    expect(supportFile).toContain('"meetingAttendees"')
    expect(supportFile).toContain('AGENT_AUTHORED_WRITE_REQUIRED')
    expect(supportFile).not.toContain('sendJson("https://rooms.example.com/api/bookings", "POST", payload);')
    expect(supportFile).not.toContain('demo-user')
    expect(supportFile).not.toContain('room-1')
  })

  it('retains older non-overlapping generated tools on incremental scaffold generation', () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'site-scaffold-incremental-'))
    tempDirs.push(outputRoot)

    const baseMemory = {
      siteKey: 'rooms.example.com',
      siteHost: 'rooms.example.com',
      siteOrigin: 'https://rooms.example.com',
      updatedAt: '2026-05-14T15:00:00.000Z',
      firstCapturedAt: '2026-05-13T08:00:00.000Z',
      captureCount: 1,
      workflowVersion: 'opencli-action-capture-v1',
      workflowVersionsSeen: ['opencli-action-capture-v1'],
      lastSourceUrl: 'https://rooms.example.com/#/',
      canonicalEntryUrl: 'https://rooms.example.com/#/',
      canonicalResultUrl: 'https://rooms.example.com/#/',
      verdictPattern: '',
      recommendedStrategy: '',
      verdictReason: '',
      search: {
        executed: false,
        action: '',
        keywordSeed: '',
      },
      resultSignals: {
        listCandidates: 0,
        paginationCandidates: 0,
      },
      listApiCandidates: [],
      actionApiCandidates: [],
      detailHints: {
        mode: '',
        bestCandidateHref: '',
        bestCandidateText: '',
        networkDetailCandidates: [],
      },
      pagination: {
        attempted: false,
        verified: false,
        mode: '',
        targetPage: null,
        activePageBefore: null,
        activePageAfter: null,
        reason: '',
      },
      rawSummary: {
        tabId: 1,
        resultPageUrl: 'https://rooms.example.com/#/',
        finalPageUrl: 'https://rooms.example.com/#/',
      },
    } as SiteMemoryRecord

    const firstResult = writeScaffoldFromSiteMemory({
      ...baseMemory,
      actionApiCandidates: [
        {
          actionName: 'book_room',
          mode: 'intercept',
          toolName: 'rooms.example.com.book_room_draft',
          url: 'https://rooms.example.com/api/bookings',
          method: 'POST',
          requestBodyPreview: '{"roomId":"A101","startTime":"2026-05-14 15:00:00","endTime":"2026-05-14 16:00:00"}',
          intercepted: true,
          blockedReason: 'side-effect-safe-capture',
          capturedAt: '2026-05-14T15:00:00.000Z',
          sourceWorkflowVersion: 'opencli-action-capture-v1',
        },
      ],
    }, { outputRoot })

    expect(firstResult.toolNames).toContain('rooms.example.com.book_room')
    expect(fs.existsSync(path.join(firstResult.adapterDir, 'webcli-generated/tools/book_room.generated.js'))).toBe(true)

    const secondResult = writeScaffoldFromSiteMemory({
      ...baseMemory,
      updatedAt: '2026-05-15T15:00:00.000Z',
      actionApiCandidates: [
        {
          actionName: 'cancel_room',
          mode: 'intercept',
          toolName: 'rooms.example.com.cancel_room_draft',
          url: 'https://rooms.example.com/api/bookings/cancel',
          method: 'POST',
          requestBodyPreview: '{"bookingId":"B001"}',
          intercepted: true,
          blockedReason: 'side-effect-safe-capture',
          capturedAt: '2026-05-15T15:00:00.000Z',
          sourceWorkflowVersion: 'opencli-action-capture-v1',
        },
      ],
    }, { outputRoot })

    const manifest = JSON.parse(fs.readFileSync(secondResult.files.manifest, 'utf8')) as { support_files?: string[] }
    expect(secondResult.toolNames).toContain('rooms.example.com.cancel_room')
    expect(secondResult.toolNames).toContain('rooms.example.com.book_room')
    expect(secondResult.removedGeneratedFiles).not.toContain('webcli-generated/tools/book_room.generated.js')
    expect(fs.existsSync(path.join(secondResult.adapterDir, 'webcli-generated/tools/book_room.generated.js'))).toBe(true)
    expect(fs.existsSync(path.join(secondResult.adapterDir, 'webcli-generated/tools/cancel_room.generated.js'))).toBe(true)
    expect(manifest.support_files).toContain('webcli-generated/tools/book_room.generated.js')
    expect(manifest.support_files).toContain('webcli-generated/tools/cancel_room.generated.js')

    const supportFile = combineGeneratedSupport(secondResult.files.manifest)
    expect(supportFile).toContain('name: "rooms.example.com.book_room"')
    expect(supportFile).toContain('name: "rooms.example.com.cancel_room"')
    expect(supportFile).toContain('"rooms.example.com.book_room"')
    expect(supportFile).toContain('"rooms.example.com.cancel_room"')
  })

  it('updates adapter index catalog without creating duplicate entries', () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'site-scaffold-catalog-'))
    tempDirs.push(outputRoot)

    fs.writeFileSync(path.join(outputRoot, 'index.json'), `${JSON.stringify(['docs.example.com', 'rooms.example.com'], null, 2)}\n`, 'utf8')

    const memory: SiteMemoryRecord = {
      siteKey: 'rooms.example.com',
      siteHost: 'rooms.example.com',
      siteOrigin: 'https://rooms.example.com',
      updatedAt: '2026-05-14T15:00:00.000Z',
      firstCapturedAt: '2026-05-13T08:00:00.000Z',
      captureCount: 1,
      workflowVersion: 'opencli-action-capture-v1',
      workflowVersionsSeen: ['opencli-action-capture-v1'],
      lastSourceUrl: 'https://rooms.example.com/#/',
      canonicalEntryUrl: 'https://rooms.example.com/#/',
      canonicalResultUrl: 'https://rooms.example.com/#/',
      verdictPattern: '',
      recommendedStrategy: '',
      verdictReason: '',
      search: {
        executed: false,
        action: '',
        keywordSeed: '',
      },
      resultSignals: {
        listCandidates: 0,
        paginationCandidates: 0,
      },
      listApiCandidates: [],
      actionApiCandidates: [
        {
          actionName: 'book_room',
          mode: 'intercept',
          toolName: 'rooms.example.com.book_room_draft',
          url: 'https://rooms.example.com/api/bookings',
          method: 'POST',
          requestBodyPreview: '{"roomId":"room-1","startTime":"2026-05-13 19:00:00","endTime":"2026-05-13 20:00:00"}',
          intercepted: true,
          blockedReason: 'side-effect-safe-capture',
          capturedAt: '2026-05-14T15:00:00.000Z',
          sourceWorkflowVersion: 'opencli-action-capture-v1',
        },
      ],
      detailHints: {
        mode: '',
        bestCandidateHref: '',
        bestCandidateText: '',
        networkDetailCandidates: [],
      },
      pagination: {
        attempted: false,
        verified: false,
        mode: '',
        targetPage: null,
        activePageBefore: null,
        activePageAfter: null,
        reason: '',
      },
      rawSummary: {
        tabId: 1,
        resultPageUrl: 'https://rooms.example.com/#/',
        finalPageUrl: 'https://rooms.example.com/#/',
      },
    }

    const result = writeScaffoldFromSiteMemory(memory, { outputRoot })
    expect(result.indexCatalogUpdated).toBe(false)

    const adapterIndexCatalog = JSON.parse(fs.readFileSync(path.join(outputRoot, 'index.json'), 'utf8')) as string[]
    expect(adapterIndexCatalog).toEqual(['docs.example.com', 'rooms.example.com'])
    expect(fs.existsSync(path.join(outputRoot, 'registry.json'))).toBe(false)
  })
})
