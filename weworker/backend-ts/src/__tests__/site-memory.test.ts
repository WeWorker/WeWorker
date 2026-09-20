import { describe, expect, it } from 'vitest'
import { analyzeApiExplorationWorkflow, applyApiReplayEvidence } from '../api-exploration-evidence.js'
import { deriveSiteMemoryFromWorkflow } from '../site-memory.js'

describe('deriveSiteMemoryFromWorkflow', () => {
  it('extracts stable memory fields from a v12-style exploration result', () => {
    const memory = deriveSiteMemoryFromWorkflow({
      tabId: 123,
      opened: { url: 'https://tickets.example.com' },
      pageStateBefore: { url: 'https://tickets.example.com/ticketing/web/index.html#/' },
      resultPageState: {
        url: 'https://tickets.example.com/ticketing/request/index.html#/globalSearch?keyword=test',
        listCandidates: 5,
        paginationCandidates: 10,
      },
      pageStateAfter: {
        url: 'https://tickets.example.com/ticketing/request/index.html#/globalSearch?keyword=test',
      },
      verdict: {
        pattern: 'api_driven',
        recommendedStrategy: 'COOKIE_API',
        reason: 'best candidate is /ticketing/getCiGroup.spr',
      },
      workflow: {
        version: 'opencli-like-v12',
      },
      actions: [
        {
          step: 'search',
          result: { executed: true, action: 'search_enter', value: 'test' },
          networkDelta: {
            entries: [
              {
                url: 'https://tickets.example.com/ticketing/getCiGroup.spr',
                method: 'POST',
                requestBodyPreview: 'keyword=test&history=lastYear',
              },
              {
                url: 'https://tickets.example.com/ticketing/getCiList.spr',
                method: 'POST',
                requestBodyPreview: 'keyword=test&typeId=&currentPage=1&pageSize=20&history=lastYear',
              },
            ],
          },
        },
        {
          step: 'pagination',
          result: {
            executed: true,
            mode: 'dispatch_click',
            verified: false,
            targetPage: 2,
            activePageBefore: 1,
            activePageAfter: 1,
            reason: 'next-page-not-confirmed',
          },
          networkDelta: { entries: [] },
        },
        {
          step: 'detail',
          result: {
            executed: false,
            action: 'detail_inspect_only',
            mode: 'inspect_only',
            reason: 'detail-navigation-skipped-permission-safe',
            bestCandidate: {
              href: 'https://tickets.example.com/ticketing/request/index.html#/requestDetail/12345',
              text: '[12345] test ticket',
            },
            networkDetailCandidates: [
              'https://tickets.example.com/ticketing/request/index.html#/requestDetail/12345',
            ],
          },
        },
      ],
    })

    expect(memory).not.toBeNull()
    expect(memory?.siteKey).toBe('tickets.example.com')
    expect(memory?.workflowVersion).toBe('opencli-like-v12')
    expect(memory?.canonicalResultUrl).toContain('/globalSearch?keyword=%3Avalue')
    expect(memory?.listApiCandidates.map((item) => item.url)).toEqual([
      'https://tickets.example.com/ticketing/getCiGroup.spr',
      'https://tickets.example.com/ticketing/getCiList.spr',
    ])
    expect(memory?.actionApiCandidates).toEqual([])
    expect(memory?.detailHints.mode).toBe('inspect_only')
    expect(memory?.detailHints.bestCandidateHref).toContain('/requestDetail/12345')
    expect(memory?.pagination.verified).toBe(false)
    expect(memory?.pagination.targetPage).toBe(2)
  })

  it('keeps query structure without persisting captured values for a passive GET JSON API', () => {
    const memory = deriveSiteMemoryFromWorkflow({
      tabId: 456,
      pageStateBefore: { url: 'http://127.0.0.1:18888/' },
      resultPageState: { url: 'http://127.0.0.1:18888/' },
      pageStateAfter: { url: 'http://127.0.0.1:18888/' },
      network: {
        entries: [{
          url: 'http://127.0.0.1:18888/api/projects?status=active',
          method: 'GET',
          status: 200,
          responseContentType: 'application/json',
          responsePreview: '{"items":[{"id":"P-101","name":"Alpha"}]}',
        }],
      },
      workflow: { version: 'opencli-like-v13' },
    })

    expect(memory?.listApiCandidates).toEqual([
      expect.objectContaining({
        url: 'http://127.0.0.1:18888/api/projects?status=%3Avalue',
        method: 'GET',
        status: 200,
        requestEvidence: expect.objectContaining({ bodyKind: 'none', bodyOmitted: false }),
        sourceSteps: ['final_network'],
        apiEvidence: expect.objectContaining({
          evidenceId: 'GET /api/projects?status',
          verdict: 'likely_data',
          risk: 'read',
          strategyNote: expect.objectContaining({ replayStatus: 'not_run', replayRequired: true }),
          verificationFixture: expect.objectContaining({ notEmpty: ['items.*.id'] }),
        }),
      }),
    ])
    expect(memory?.apiAnalysisV2).toMatchObject({
      schemaVersion: 2,
      likelyDataCount: 1,
      recommendedNextProbe: 'replay_top_candidate',
    })
    expect(memory?.listApiCandidates[0]?.responsePreview).toBeUndefined()
    expect(memory?.listApiCandidates[0]?.responseHints).toMatchObject({
      listPath: 'items',
      itemKeys: ['id', 'name'],
    })
    expect(JSON.stringify(memory)).not.toContain('P-101')
    expect(JSON.stringify(memory)).not.toContain('Alpha')
  })

  it('preserves verified replay strategy and fixture metadata for generation planning', () => {
    const network = {
      entries: [{
        url: 'https://example.test/api/projects?page=1',
        method: 'GET',
        status: 200,
        responseContentType: 'application/json',
        responsePreview: '{"items":[{"id":"P-1"}]}',
      }],
    }
    const initial = analyzeApiExplorationWorkflow({ network })
    const evidenceId = initial.candidates[0]?.evidenceId || ''
    const analysisV2 = applyApiReplayEvidence(initial, evidenceId, {
      transport: 'direct_no_auth',
      status: 200,
      ok: true,
      contentType: 'application/json',
      nonEmpty: true,
      responseShape: initial.candidates[0]!.responseShape,
      durationMs: 4,
      errorCode: '',
      verificationFixture: initial.candidates[0]!.verificationFixture,
    })

    const memory = deriveSiteMemoryFromWorkflow({
      pageStateBefore: { url: 'https://example.test/projects' },
      pageStateAfter: { url: 'https://example.test/projects' },
      network,
      analysisV2,
    })

    expect(memory?.listApiCandidates[0]?.apiEvidence).toMatchObject({
      evidenceId,
      strategyNote: {
        strategy: 'PUBLIC_API',
        contract: 'stable',
        replayStatus: 'verified',
        replayRequired: false,
      },
      verificationFixture: expect.objectContaining({ requiredPaths: ['items'] }),
    })
  })

  it('derives structural V2 candidates without persisting captured response values', () => {
    const network = {
      entries: [{
        url: 'https://example.test/api/projects?page=1&status=active',
        method: 'GET',
        status: 200,
        responseContentType: 'application/json',
        responsePreview: '{"items":[{"id":"P-101","name":"Alpha"}]}',
      }],
    }
    const rawAnalysis = analyzeApiExplorationWorkflow({ network })
    const analysisV2: typeof rawAnalysis = {
      ...rawAnalysis,
      candidates: rawAnalysis.candidates.map((candidate) => ({
        ...candidate,
        observedUrl: 'https://example.test/api/projects?page=%3Avalue&status=%3Avalue',
      })),
    }

    const memory = deriveSiteMemoryFromWorkflow({
      schemaVersion: 'exploration-evidence-v2-persisted',
      pageStateBefore: { url: 'https://example.test/projects?keyword=ExampleUser#/list?building=ExampleBuilding' },
      pageStateAfter: { url: 'https://example.test/projects?keyword=ExampleUser#/list?building=ExampleBuilding' },
      analysisV2,
      workflow: { version: 'exploration-evidence-v2-persisted' },
    })

    const candidate = memory?.listApiCandidates[0]
    expect(candidate?.url).toBe('https://example.test/api/projects?page=%3Avalue&status=%3Avalue')
    expect(candidate?.responsePreview).toBeUndefined()
    expect(candidate?.responseHints).toMatchObject({
      listPath: 'items',
      itemKeys: ['id', 'name'],
      preferredIdKey: 'id',
      preferredDisplayKey: 'name',
    })
    expect(JSON.stringify(memory)).not.toContain('P-101')
    expect(JSON.stringify(memory)).not.toContain('Alpha')
    expect(JSON.stringify(memory)).not.toContain('ExampleUser')
    expect(JSON.stringify(memory)).not.toContain('ExampleBuilding')
    expect(memory?.canonicalEntryUrl).toContain('keyword=%3Avalue')
    expect(memory?.canonicalEntryUrl).toContain('building=%3Avalue')
    expect(candidate?.apiEvidence?.verificationFixture).toMatchObject({
      requiredPaths: ['items'],
      notEmpty: ['items.*.id'],
    })
  })
})
