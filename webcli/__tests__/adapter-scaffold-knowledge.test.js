import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeScaffoldFromSiteMemory } from '../adapter-scaffold.js';

const tmpDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-knowledge-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('adapter scaffold knowledge pack', () => {
  it('preserves GET query names without persisting captured values or credentials', () => {
    const outputRoot = makeTmpDir();
    const result = writeScaffoldFromSiteMemory({
      siteKey: '127.0.0.1',
      siteHost: '127.0.0.1',
      siteOrigin: 'http://127.0.0.1:18888',
      updatedAt: '2026-08-17T00:00:00.000Z',
      captureCount: 1,
      workflowVersion: 'opencli-like-v13',
      canonicalEntryUrl: 'http://127.0.0.1:18888/',
      recommendedStrategy: 'COOKIE_API',
      verdictPattern: 'api_driven',
      verdictReason: '最强候选为 http://127.0.0.1:18888/api/projects。',
      resultSignals: {},
      detailHints: { mode: '', bestCandidateHref: '', bestCandidateText: '', networkDetailCandidates: [] },
      pagination: { attempted: false, verified: false, mode: '', targetPage: null, activePageBefore: null, activePageAfter: null, reason: '' },
      listApiCandidates: [{
        method: 'GET',
        url: 'http://127.0.0.1:18888/api/projects?status=active&access_token=[redacted]',
        responsePreview: JSON.stringify({ items: [{ id: 'P-101', name: 'Alpha' }] }),
      }],
      actionApiCandidates: [],
      actionCaptureHistory: [],
    }, { outputRoot });

    const toolSource = fs.readFileSync(
      path.join(result.adapterDir, result.supportFiles.find((file) => file.endsWith('/search_records.generated.js'))),
      'utf8',
    );
    const requestHandlerSource = toolSource.slice(0, toolSource.indexOf('registerTool(siteKey'));
    expect(toolSource).toContain('"status": {');
    expect(toolSource).not.toContain('"status": "active"');
    expect(toolSource).toContain('fetchGet("http://127.0.0.1:18888/api/projects", params)');
    expect(toolSource).not.toContain('"access_token": {');
    expect(requestHandlerSource).not.toContain('[redacted]');
    const integrationGuide = fs.readFileSync(result.files.integrationGuide, 'utf8');
    expect(integrationGuide).toContain('确认 manifest.json 中包含');
    expect(integrationGuide).not.toContain(outputRoot);
  });

  it('keeps V2 query keys without turning structural placeholders into runtime defaults', () => {
    const outputRoot = makeTmpDir();
    const result = writeScaffoldFromSiteMemory({
      siteKey: 'example.test',
      siteHost: 'example.test',
      siteOrigin: 'https://example.test',
      updatedAt: '2026-08-31T00:00:00.000Z',
      captureCount: 1,
      workflowVersion: 'opencli-like-v13',
      canonicalEntryUrl: 'https://example.test/',
      recommendedStrategy: 'PUBLIC_API',
      verdictPattern: 'api_driven',
      resultSignals: {},
      detailHints: { mode: '', bestCandidateHref: '', bestCandidateText: '', networkDetailCandidates: [] },
      pagination: { attempted: false, verified: false, mode: '', targetPage: null, activePageBefore: null, activePageAfter: null, reason: '' },
      listApiCandidates: [{
        method: 'GET',
        url: 'https://example.test/api/projects?page=%3Avalue&query=%3Avalue&status=%3Avalue',
        responsePreview: JSON.stringify({ rows: [{ id: '<string>' }] }),
        apiEvidence: {
          evidenceId: 'GET /api/projects?page,query,status',
          endpointFamily: 'GET /api/projects?page,query,status',
          queryKeys: ['page', 'query', 'status'],
          requestShape: { keys: [] },
          risk: 'read',
          strategyNote: { replayStatus: 'verified' },
        },
      }],
      actionApiCandidates: [],
      actionCaptureHistory: [],
    }, { outputRoot });

    const toolSource = fs.readFileSync(
      path.join(result.adapterDir, result.supportFiles.find((file) => file.endsWith('/search_records.generated.js'))),
      'utf8',
    );
    expect(toolSource).toContain('"page": {');
    expect(toolSource).toContain('"query": {');
    expect(toolSource).toContain('"status": {');
    expect(toolSource).not.toContain(':value');
    expect(toolSource).toContain('...{}');
  });

  it('writes deduped token-friendly WEBCLI_KNOWLEDGE files', () => {
    const outputRoot = makeTmpDir();
    const memory = {
      siteKey: 'example.test',
      siteHost: 'example.test',
      siteOrigin: 'https://example.test',
      updatedAt: '2026-06-12T00:00:00.000Z',
      captureCount: 3,
      workflowVersion: 'opencli-like-v12',
      canonicalEntryUrl: 'https://example.test/app',
      recommendedStrategy: 'api_first',
      verdictPattern: 'api_driven',
      verdictReason: 'Found list and booking APIs.',
      resultSignals: { listCandidates: 1, paginationCandidates: 1 },
      detailHints: { mode: '', bestCandidateHref: '', bestCandidateText: '', networkDetailCandidates: [] },
      pagination: { attempted: false, verified: false, mode: '', targetPage: null, activePageBefore: null, activePageAfter: null, reason: '' },
      listApiCandidates: [
        {
          method: 'GET',
          url: 'https://example.test/api/rooms?bookTime=2026-06-12%2000%3A00%3A00&workplace=HQ&page=1&limit=20&access_token=query-secret',
          sourceSteps: ['search'],
          responsePreview: JSON.stringify({
            data: {
              list: [
                { id: 'r1', roomcode: '902', meetingInfoMaps: {}, capacity: 8 },
              ],
            },
          }),
        },
        {
          method: 'GET',
          url: 'https://example.test/api/rooms?bookTime=2026-06-13%2000%3A00%3A00&workplace=HQ&page=1&limit=20',
          sourceSteps: ['search'],
        },
      ],
      actionApiCandidates: [
        {
          actionName: 'book_room',
          toolName: 'example.test.book_room',
          method: 'POST',
          url: 'https://example.test/api/book',
          requestBodyPreview: JSON.stringify({
            roomId: 'r1',
            startTime: '2026-06-12 15:00:00',
            endTime: '2026-06-12 16:00:00',
            token: 'secret-token',
          }),
          responsePreview: JSON.stringify({ code: 0, data: { id: 'booking-1' } }),
          responseContentType: 'application/json',
          capturedAt: '2026-06-12T00:01:00.000Z',
        },
      ],
      actionCaptureHistory: [
        {
          actionName: 'book_room',
          toolName: 'example.test.book_room',
          method: 'POST',
          url: 'https://example.test/api/book',
          requestBodyPreview: JSON.stringify({
            roomId: 'r2',
            startTime: '2026-06-13 15:00:00',
            endTime: '2026-06-13 16:00:00',
          }),
          responsePreview: JSON.stringify({ code: 0, data: { id: 'booking-2' } }),
          responseContentType: 'application/json',
          capturedAt: '2026-06-12T00:02:00.000Z',
        },
      ],
    };

    const result = writeScaffoldFromSiteMemory(memory, { outputRoot });
    const knowledgeJson = JSON.parse(fs.readFileSync(result.files.knowledgeJson, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(result.files.manifest, 'utf8'));
    const knowledgeMarkdown = fs.readFileSync(result.files.knowledgeMarkdown, 'utf8');
    const skillMarkdown = fs.readFileSync(result.files.skill, 'utf8');

    expect(fs.existsSync(result.files.knowledgeJson)).toBe(true);
    expect(fs.existsSync(result.files.knowledgeMarkdown)).toBe(true);
    expect(result.skillPreserved).toBe(false);
    expect(result.files.generatedSkill).toBe('');
    expect(result.files.writtenSkill).toBe(result.files.skill);
    expect(skillMarkdown).toContain('## 优化上下文');
    expect(skillMarkdown).toContain('WEBCLI_KNOWLEDGE.md');
    expect(skillMarkdown).toContain('Execution: type=api, runtime=background');
    expect(skillMarkdown).toContain('Execution: mode=direct');
    expect(manifest.tool_execution['example.test.search_records']).toEqual({
      type: 'api',
      runtime: 'background',
    });
    const listToolSource = fs.readFileSync(
      path.join(result.adapterDir, result.supportFiles.find((file) => file.endsWith('/search_records.generated.js'))),
      'utf8',
    );
    const actionToolSource = fs.readFileSync(
      path.join(result.adapterDir, result.supportFiles.find((file) => file.endsWith('/book_room.generated.js'))),
      'utf8',
    );
    expect(listToolSource).toContain('generationSource:');
    expect(listToolSource).toContain('"sourceKind": "passive_list"');
    expect(listToolSource).toContain('"level": "read"');
    expect(actionToolSource).toContain('"sourceKind": "action_capture"');
    expect(actionToolSource).toContain('"level": "write"');
    expect(knowledgeJson.version).toBe('webcli-knowledge-v1');
    expect(knowledgeJson.apis.length).toBeGreaterThanOrEqual(2);
    expect(knowledgeJson.apis.length).toBeLessThanOrEqual(50);

    const roomsApis = knowledgeJson.apis.filter((api) => api.path === '/api/rooms');
    expect(roomsApis).toHaveLength(1);
    expect(roomsApis[0].seenCount).toBeGreaterThanOrEqual(2);
    expect(roomsApis[0].queryKeys).toEqual(['bookTime', 'limit', 'page', 'workplace']);
    expect(JSON.stringify(roomsApis[0].examples)).not.toContain('query-secret');

    const bookApi = knowledgeJson.apis.find((api) => api.path === '/api/book');
    expect(bookApi.requestShape.keys).toContain('roomId');
    expect(bookApi.requestShape.keys).not.toContain('token');
    expect(bookApi.requestShape.fieldTypes).not.toHaveProperty('token');
    expect(JSON.stringify(bookApi.examples)).not.toContain('secret-token');
    expect(knowledgeJson.apis.filter((api) => api.path === '/api/book')).toHaveLength(1);
    expect(knowledgeMarkdown).toContain('## 关键接口');
    expect(knowledgeMarkdown).toContain('GET /api/rooms');
  });

  it('merges existing WEBCLI_KNOWLEDGE instead of replacing previous exploration APIs', () => {
    const outputRoot = makeTmpDir();
    const baseMemory = {
      siteKey: 'merge.test',
      siteHost: 'merge.test',
      siteOrigin: 'https://merge.test',
      updatedAt: '2026-06-12T00:00:00.000Z',
      captureCount: 1,
      workflowVersion: 'opencli-like-v12',
      canonicalEntryUrl: 'https://merge.test/app',
      recommendedStrategy: 'api_first',
      verdictPattern: 'api_driven',
      verdictReason: 'Found APIs.',
      resultSignals: {},
      detailHints: { mode: '', bestCandidateHref: '', bestCandidateText: '', networkDetailCandidates: [] },
      pagination: { attempted: false, verified: false, mode: '', targetPage: null, activePageBefore: null, activePageAfter: null, reason: '' },
      listApiCandidates: [
        {
          method: 'GET',
          url: 'https://merge.test/api/rooms?bookTime=2026-06-12%2000%3A00%3A00&workplace=HQ',
          responsePreview: JSON.stringify({ data: { list: [{ id: 'r1', name: 'Room 1' }] } }),
        },
      ],
      actionApiCandidates: [],
      actionCaptureHistory: [],
    };

    const first = writeScaffoldFromSiteMemory(baseMemory, { outputRoot });
    const secondMemory = {
      ...baseMemory,
      captureCount: 2,
      listApiCandidates: [
        {
          method: 'GET',
          url: 'https://merge.test/api/rooms?bookTime=2026-06-13%2000%3A00%3A00&workplace=HQ',
          responsePreview: JSON.stringify({ data: { list: [{ id: 'r2', name: 'Room 2' }] } }),
        },
      ],
      actionApiCandidates: [
        {
          actionName: 'cancel_room',
          toolName: 'merge.test.cancel_room',
          method: 'POST',
          url: 'https://merge.test/api/cancel',
          requestBodyPreview: JSON.stringify({ bookingId: 'b1' }),
          responsePreview: JSON.stringify({ code: 0 }),
          responseContentType: 'application/json',
          capturedAt: '2026-06-12T00:03:00.000Z',
        },
      ],
    };

    writeScaffoldFromSiteMemory(secondMemory, { outputRoot });
    const knowledgeJson = JSON.parse(fs.readFileSync(first.files.knowledgeJson, 'utf8'));

    expect(knowledgeJson.apis.some((api) => api.path === '/api/rooms')).toBe(true);
    expect(knowledgeJson.apis.some((api) => api.path === '/api/cancel')).toBe(true);
    expect(knowledgeJson.apis.filter((api) => api.path === '/api/rooms')).toHaveLength(1);
    expect(knowledgeJson.apis.find((api) => api.path === '/api/rooms').seenCount).toBeGreaterThanOrEqual(2);
    expect(knowledgeJson.summary.generatedTools).toContain('merge.test.cancel_room');
  });

  it('preserves existing SKILL.md and writes generated skill separately on later scaffold runs', () => {
    const outputRoot = makeTmpDir();
    const adapterDir = path.join(outputRoot, 'skill.test');
    fs.mkdirSync(adapterDir, { recursive: true });
    const existingSkill = '# Hand refined skill\n\nKeep this content.\n';
    fs.writeFileSync(path.join(adapterDir, 'SKILL.md'), existingSkill, 'utf8');
    fs.writeFileSync(path.join(adapterDir, 'manifest.json'), JSON.stringify({
      id: 'skill.test',
      name: 'Skill Test',
      description: 'Existing adapter',
      match: ['skill.test'],
      support_files: [],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(adapterDir, 'index.js'), 'window.__webmcpRegister({ name: "skill.test", tools: [] });\n', 'utf8');

    const memory = {
      siteKey: 'skill.test',
      siteHost: 'skill.test',
      siteOrigin: 'https://skill.test',
      updatedAt: '2026-06-12T00:00:00.000Z',
      captureCount: 1,
      workflowVersion: 'opencli-like-v12',
      canonicalEntryUrl: 'https://skill.test/app',
      recommendedStrategy: 'api_first',
      verdictPattern: 'api_driven',
      verdictReason: 'Found APIs.',
      resultSignals: {},
      detailHints: { mode: '', bestCandidateHref: '', bestCandidateText: '', networkDetailCandidates: [] },
      pagination: { attempted: false, verified: false, mode: '', targetPage: null, activePageBefore: null, activePageAfter: null, reason: '' },
      listApiCandidates: [
        {
          method: 'GET',
          url: 'https://skill.test/api/items?page=1',
          responsePreview: JSON.stringify({ data: { list: [{ id: 'i1', name: 'Item 1' }] } }),
        },
      ],
      actionApiCandidates: [],
      actionCaptureHistory: [],
    };

    const result = writeScaffoldFromSiteMemory(memory, { outputRoot });

    expect(fs.readFileSync(path.join(adapterDir, 'SKILL.md'), 'utf8')).toBe(existingSkill);
    expect(result.skillPreserved).toBe(true);
    expect(result.files.writtenSkill).toBe(result.files.generatedSkill);
    expect(fs.existsSync(result.files.generatedSkill)).toBe(true);
    expect(fs.readFileSync(result.files.generatedSkill, 'utf8')).toContain('Skill Test');
  });

  it('uses a user-confirmed primary action instead of a richer follow-up detail request', () => {
    const outputRoot = makeTmpDir();
    const memory = {
      siteKey: 'tasks.example.com',
      siteHost: 'tasks.example.com',
      siteOrigin: 'https://tasks.example.com',
      updatedAt: '2026-07-21T02:00:00.000Z',
      captureCount: 1,
      workflowVersion: 'opencli-action-capture-v1',
      canonicalEntryUrl: 'https://tasks.example.com/',
      recommendedStrategy: 'api_first',
      verdictPattern: 'api_driven',
      verdictReason: 'Captured approval action.',
      resultSignals: {},
      detailHints: { mode: '', bestCandidateHref: '', bestCandidateText: '', networkDetailCandidates: [] },
      pagination: { attempted: false, verified: false, mode: '', targetPage: null, activePageBefore: null, activePageAfter: null, reason: '' },
      listApiCandidates: [],
      actionApiCandidates: [
        {
          actionName: 'approve_todo',
          toolName: 'tasks.example.com.approve_todo',
          method: 'POST',
          url: 'https://tasks.example.com/api/todo/info/12345',
          requestBodyPreview: JSON.stringify({ id: 12345 }),
          responsePreview: JSON.stringify({ data: { id: 12345, title: '申请详情', history: [] } }),
          responseContentType: 'application/json',
          capturedAt: '2026-07-21T02:00:01.000Z',
        },
        {
          actionName: 'approve_todo',
          toolName: 'tasks.example.com.approve_todo',
          method: 'POST',
          url: 'https://tasks.example.com/api/todo/myApprove',
          requestBodyPreview: JSON.stringify({ id: 12345, decision: 'agree' }),
          responsePreview: JSON.stringify({ code: 0, message: 'success' }),
          responseContentType: 'application/json',
          primarySelection: 'user',
          capturedAt: '2026-07-21T02:00:00.500Z',
        },
      ],
      actionCaptureHistory: [],
    };

    const result = writeScaffoldFromSiteMemory(memory, { outputRoot });
    expect(result.actionApiUrls).toContain('https://tasks.example.com/api/todo/myApprove');
    expect(result.actionApiUrls).not.toContain('https://tasks.example.com/api/todo/info/12345');
  });
});
