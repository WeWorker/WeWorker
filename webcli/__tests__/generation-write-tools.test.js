import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPlanSemanticEnhancement,
  readOnlyV2Memory,
  readOnlyV2Plan,
} from '../generation-harness/adapter-generation-workflow.js';
import { writeScaffoldFromSiteMemory } from '../adapter-scaffold.js';

const tmpDirs = [];

function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function listCandidate(url, extra = {}) {
  return {
    url,
    method: 'GET',
    status: 200,
    responseContentType: 'application/json',
    responsePreview: '{"code":0,"data":{"list":[{"id":1}],"total":1},"msg":"ok"}',
    sourceSteps: ['final_network', 'semantic'],
    apiEvidence: { evidenceId: `GET ${url}`, verdict: 'likely_data', risk: 'read', strategyNote: { replayStatus: 'verified' } },
    ...extra,
  };
}

function buildMemory() {
  const evidence = (id) => ({
    evidenceId: id,
    endpointFamily: id,
    risk: 'read',
    strategyNote: { replayStatus: 'verified' },
  });
  return {
    siteKey: 'request.example.test',
    siteHost: 'request.example.test',
    siteOrigin: 'https://request.example.test',
    canonicalEntryUrl: 'https://request.example.test/list',
    recommendedStrategy: 'COOKIE_API',
    verdictPattern: 'api_driven',
    verdictReason: '',
    apiAnalysisV2: {
      schemaVersion: 2,
      candidates: [
        evidence('GET https://request.example.test/api/pages/accessible?_t=1'),
        evidence('GET https://request.example.test/api/requests/owner?page=1&size=10'),
      ],
    },
    // 与真实事故同构：上下文顺序 [0]=listAccessiblePages，[1]=owner/list，
    // 但打分排序会把 owner/list 排到 primary。
    listApiCandidates: [
      listCandidate('https://request.example.test/api/pages/accessible?_t=1'),
      listCandidate('https://request.example.test/api/requests/owner?page=1&size=10'),
    ],
    actionApiCandidates: [{
      actionName: '提交申请',
      method: 'POST',
      url: 'https://request.example.test/api/requests',
      toolName: 'request.example.test.提交申请_draft',
      capturedAt: '2026-09-14T08:00:00.000Z',
      requestBodyPreview: '{"title":"t","startAt":"2026-09-12 00:00:00"}',
      responsePreview: '{"code":0}',
      sourceSteps: ['action_capture'],
    }],
    actionCaptureHistory: [],
    detailHints: { mode: '', bestCandidateHref: '', bestCandidateText: '', networkDetailCandidates: [] },
    pagination: { attempted: false, verified: false, mode: '', targetPage: null, activePageBefore: null, activePageAfter: null, reason: '' },
    resultSignals: {},
    search: { executed: false, action: '', keywordSeed: '' },
  };
}

describe('write tool support and scaffold slot mapping', () => {
  it('treats truncated action request previews as opaque and emits only an agent-authoring skeleton', () => {
    const truncatedPreview = '{"title":"fixture","startAt":"2026-01-01T09:00:00Z","visitors":[{"name":"Example User"}],"notes":"fixture content that is intentionally incomplete...[truncated]';
    const memory = {
      siteKey: 'trunc.example.test',
      siteHost: 'trunc.example.test',
      siteOrigin: 'https://trunc.example.test',
      canonicalEntryUrl: 'https://trunc.example.test/apply',
      recommendedStrategy: 'COOKIE_API',
      verdictPattern: 'api_driven',
      verdictReason: '',
      workflowVersion: 'opencli-action-capture-v1',
      listApiCandidates: [],
      actionApiCandidates: [{
        actionName: '提交申请',
        method: 'POST',
        url: 'https://trunc.example.test/api/submit',
        toolName: 'trunc.example.test.submit_request_draft',
        capturedAt: '2026-09-15T08:00:00.000Z',
        requestBodyPreview: truncatedPreview,
        responsePreview: '{"code":0}',
        sourceSteps: ['action_capture'],
      }],
      actionCaptureHistory: [],
      detailHints: { mode: '', bestCandidateHref: '', bestCandidateText: '', networkDetailCandidates: [] },
      pagination: { attempted: false, verified: false, mode: '', targetPage: null, activePageBefore: null, activePageAfter: null, reason: '' },
      resultSignals: {},
      search: { executed: false, action: '', keywordSeed: '' },
    };

    const outputRoot = makeTmpDir('webcli-truncated-schema-');
    const draft = writeScaffoldFromSiteMemory(memory, { outputRoot });
    const submitName = draft.toolNames.find((name) => name.includes('submit_request'));
    expect(submitName).toBeTruthy();
    const file = path.join(draft.adapterDir, 'webcli-generated', 'tools', `${submitName.split('.').pop()}.generated.js`);
    const source = fs.readFileSync(file, 'utf8');

    expect(source).not.toContain('"title"');
    expect(source).not.toContain('"startAt"');
    expect(source).not.toContain('示例测试');
    expect(source).not.toContain('张三');
    expect(source).toContain('/api/submit');
    expect(source).toContain('"bodyKind": "opaque"');
    expect(source).toContain('"bodyOmitted": true');
    expect(source).toContain('AGENT_AUTHORED_WRITE_REQUIRED');
    expect(source).toContain('access: "write"');
    expect(source).not.toContain('rawBody');
    expect(source).not.toContain('defaultPayload');
  });
  it('keeps action candidates (including write) in generation memory', () => {
    const memory = readOnlyV2Memory(buildMemory());
    expect(memory.actionApiCandidates).toHaveLength(1);
    expect(memory.actionApiCandidates[0].toolName).toContain('提交申请');
    expect(memory.listApiCandidates).toHaveLength(2);
  });

  it('allows planned write tools only when action evidence exists', () => {
    const plan = {
      summary: 'mixed',
      strategy: 'hybrid',
      tools: [
        { name: 'list_owner_records', purpose: '查询记录', risk: 'read', sourceApiIndexes: [1] },
        { name: 'submit_request', purpose: '提交申请', risk: 'write', sourceApiIndexes: [0] },
      ],
    };
    const withWrite = readOnlyV2Plan(plan, { allowWriteTools: true });
    expect(withWrite.tools).toHaveLength(2);
    expect(withWrite.tools[1].risk).toBe('write');

    const withoutWrite = readOnlyV2Plan(plan, { allowWriteTools: false });
    expect(withoutWrite.tools).toHaveLength(1);
    expect(withoutWrite.tools[0].risk).toBe('read');
  });

  it('binds planned tool names to the endpoint matching their candidate, not the slot order', () => {
    const memory = readOnlyV2Memory(buildMemory());
    const plan = {
      summary: '两个查询工具 + 一个写工具',
      strategy: 'hybrid',
      tools: [
        { name: 'list_accessible_pages', purpose: '查询可访问页面', risk: 'read', sourceApiIndexes: [0] },
        { name: 'list_owner_records', purpose: '分页查询申请记录', risk: 'read', sourceApiIndexes: [1] },
        { name: 'submit_request', purpose: '提交申请', risk: 'write', sourceApiIndexes: [0] },
      ],
    };

    const enhancement = buildPlanSemanticEnhancement(memory, plan);
    const bindings = Object.fromEntries(enhancement.toolOverrides.map((override) => [override.toolName, override.sourceToolName]));

    // 计划顺序决定槽位，不再让全站候选打分覆盖计划指定的接口。
    expect(bindings['request.example.test.list_owner_records']).toBe('request.example.test.fetch_summary_groups');
    expect(bindings['request.example.test.list_accessible_pages']).toBe('request.example.test.search_records');
    expect(enhancement.toolOverrides.some((override) => override.sourceToolName.includes('提交申请') && override.toolName.endsWith('.submit_request'))).toBe(true);

    const outputRoot = makeTmpDir('webcli-slot-mapping-');
    const draft = writeScaffoldFromSiteMemory(
      { ...memory, scaffoldSemanticHints: enhancement },
      { outputRoot, plan },
    );
    expect(draft.toolNames).toContain('request.example.test.list_owner_records');
    expect(draft.toolNames).toContain('request.example.test.list_accessible_pages');
    expect(draft.toolNames).toContain('request.example.test.submit_request');

    const ownerToolFile = draft.toolNames.includes('request.example.test.list_owner_records')
      ? path.join(draft.adapterDir, 'webcli-generated', 'tools', 'list_owner_records.generated.js')
      : '';
    const ownerSource = fs.readFileSync(ownerToolFile, 'utf8');
    expect(ownerSource).toContain('/api/requests/owner');
    expect(ownerSource).not.toContain('listAccessiblePages');

    const pagesToolFile = path.join(draft.adapterDir, 'webcli-generated', 'tools', 'list_accessible_pages.generated.js');
    const pagesSource = fs.readFileSync(pagesToolFile, 'utf8');
    expect(pagesSource).toContain('/api/pages/accessible');

    const submitSource = fs.readFileSync(path.join(draft.adapterDir, 'webcli-generated', 'tools', 'submit_request.generated.js'), 'utf8');
    expect(submitSource).toContain('/api/requests');
  });
});
