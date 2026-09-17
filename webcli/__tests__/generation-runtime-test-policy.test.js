import { describe, expect, it } from 'vitest';
import {
  buildApiSourceEvidence,
  buildRuntimeTestCases,
  classifyGeneratedToolRisk,
  inferOutputContract,
  resolveRuntimeTestArguments,
} from '../generation-harness/index.js';

describe('generation runtime test policy', () => {
  it('allows high-confidence reads and blocks mutation-like tools', () => {
    expect(classifyGeneratedToolRisk({
      tool: { name: 'example.test.search_records', description: '查询记录' },
      planTool: { risk: 'read' },
    })).toMatchObject({ level: 'read', confidence: 0.95 });

    expect(classifyGeneratedToolRisk({
      tool: { name: 'example.test.delete_record', description: '删除记录' },
      planTool: { risk: 'read' },
    })).toMatchObject({ level: 'write' });

    expect(classifyGeneratedToolRisk({
      tool: { name: 'tasks.example.com.todo_list', description: '查询待办列表' },
    })).toMatchObject({ level: 'read', confidence: 0.76 });
  });

  it('uses schema defaults without replaying captured request values', () => {
    const result = resolveRuntimeTestArguments({
      risk: { level: 'read', confidence: 0.95 },
      tool: {
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string' },
            page: { type: 'number', default: 1 },
            unknownId: { type: 'string' },
          },
          required: ['keyword', 'page', 'unknownId'],
        },
      },
      memory: {
        listApiCandidates: [{ url: 'https://example.test/api/search?keyword=room' }],
      },
    });

    expect(result.args).toEqual({ page: 1 });
    expect(result.missingRequired).toEqual(['keyword', 'unknownId']);
    expect(result.capturedRequestKeys).toEqual(['keyword']);
    expect(result.ready).toBe(false);
  });

  it('builds executable cases only for safe tools with complete arguments', () => {
    const cases = buildRuntimeTestCases({
      registeredTools: [
        {
          name: 'example.test.check_login_status',
          description: '检查登录状态',
          parameters: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'example.test.search_records',
          description: '查询记录',
          parameters: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'example.test.submit_record',
          description: '提交记录',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      ],
      plan: {
        tools: [
          { name: 'example.test.search_records', risk: 'read' },
          { name: 'example.test.submit_record', risk: 'write' },
        ],
      },
      memory: {
        listApiCandidates: [{
          url: 'https://example.test/api/search?page=1',
          responsePreview: '{"code":0,"data":{"records":[{"id":1}]}}',
          apiEvidence: {
            verificationFixture: {
              source: 'captured_response',
              rowCount: { min: 1, max: 10 },
              requiredPaths: ['data.records'],
              types: { 'data.records.*.id': 'number' },
              notEmpty: ['data.records.*.id'],
              mustNotContain: ['login'],
              mustBeTruthy: ['data.records'],
            },
          },
        }],
      },
    });

    expect(cases[0]).toMatchObject({
      execute: false,
      skipReason: 'login_status_utility_not_runtime_tested',
    });
    expect(cases[1]).toMatchObject({
      execute: true,
      contract: {
        kind: 'captured_sample',
        capturedShape: { rootKind: 'object', containsKinds: ['array', 'number', 'object'] },
        verificationFixture: expect.objectContaining({ requiredPaths: ['data.records'] }),
      },
    });
    expect(cases[2]).toMatchObject({ execute: false, risk: { level: 'write' } });
  });

  it('skips runtime assertions for tools marked unverifiable by revision', () => {
    const cases = buildRuntimeTestCases({
      registeredTools: [
        {
          name: 'example.test.search_records',
          description: '查询记录',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      ],
      plan: {
        tools: [
          {
            name: 'example.test.search_records',
            risk: 'read',
            unverifiable: { reason: 'fixture 断言无法自动满足', revision: 1 },
          },
        ],
      },
      memory: {
        listApiCandidates: [{
          url: 'https://example.test/api/search?page=1',
          responsePreview: '{"code":0,"data":{"records":[{"id":1}]}}',
          apiEvidence: {
            verificationFixture: {
              source: 'captured_response',
              rowCount: { min: 1, max: 10 },
              requiredPaths: ['data.records'],
              types: { 'data.records.*.id': 'number' },
              notEmpty: ['data.records.*.id'],
              mustNotContain: ['login'],
              mustBeTruthy: ['data.records'],
            },
          },
        }],
      },
    });

    expect(cases[0]).toMatchObject({
      execute: false,
      unverifiable: true,
      skipReason: 'marked_unverifiable_by_revision',
    });
  });

  it('drops persisted type assertions that the captured sample itself cannot satisfy', () => {
    const [testCase] = buildRuntimeTestCases({
      registeredTools: [{
        name: 'example.test.getuserinfo',
        description: '查询当前用户信息',
        parameters: { type: 'object', properties: {}, required: [] },
      }],
      plan: { tools: [{ name: 'example.test.getuserinfo', risk: 'read' }] },
      memory: {
        listApiCandidates: [{
          url: 'https://example.test/api/userinfo',
          responsePreview: '{"code":0,"data":{"roleIdList":[]},"msg":"success"}',
          apiEvidence: {
            verificationFixture: {
              source: 'captured_response',
              rowCount: { min: 0, max: 10 },
              requiredPaths: ['data.roleIdList'],
              types: {
                'data.roleIdList.*.code': 'number',
                'data.roleIdList.*.data': 'object',
                'data.roleIdList.*.msg': 'string',
              },
              notEmpty: [],
              mustNotContain: ['login'],
              mustBeTruthy: ['data.roleIdList'],
            },
          },
        }],
      },
    });

    expect(testCase.contract.verificationFixture).toMatchObject({
      requiredPaths: ['data.roleIdList'],
      types: {},
      mustBeTruthy: ['data.roleIdList'],
    });
    expect(testCase.contract.fixtureDiagnostics.droppedTypePaths).toEqual([
      'data.roleIdList.*.code',
      'data.roleIdList.*.data',
      'data.roleIdList.*.msg',
    ]);
  });

  it('does not claim scalar top-level arrays contain object rows', () => {
    const contract = inferOutputContract({}, {
      responsePreview: '[101,202]',
      apiEvidence: {
        replay: {
          responseShape: {
            kind: 'array',
            topLevelKeys: [],
            listPath: '$',
            itemKeys: [],
            valueTypes: {},
            rowCount: 2,
          },
        },
      },
    });

    expect(contract.capturedShape).toEqual({
      rootKind: 'array',
      containsKinds: ['array'],
      rootKeys: [],
    });
  });

  it('keeps a nested scalar list as an array without claiming object item fields', () => {
    const contract = inferOutputContract({}, {
      responsePreview: '{"code":0,"data":{"roleIdList":[101,202]},"msg":"success"}',
      apiEvidence: {
        replay: {
          responseShape: {
            kind: 'object',
            topLevelKeys: ['code', 'data', 'msg'],
            listPath: 'data.roleIdList',
            itemKeys: [],
            valueTypes: {},
            rowCount: 2,
          },
        },
      },
    });

    expect(contract.capturedShape).toEqual({
      rootKind: 'object',
      containsKinds: ['array', 'object'],
      rootKeys: ['code', 'data', 'msg'],
    });
  });

  it('marks verified V2 reads as capture-bound when persistent placeholders omit real values', () => {
    const [testCase] = buildRuntimeTestCases({
      registeredTools: [{
        name: 'v2.example.test.list_rooms',
        description: '查询会议室',
        parameters: {
          type: 'object',
          properties: { workplace: { type: 'string' } },
          required: ['workplace'],
        },
      }],
      plan: { tools: [{ name: 'list_rooms', risk: 'read' }] },
      memory: {
        listApiCandidates: [{
          url: 'https://v2.example.test/api/rooms?workplace=%3Avalue',
          responsePreview: '{"data":{"<key>":[{"id":"<string>"}]}}',
          apiEvidence: {
            evidenceId: 'GET /api/rooms?workplace',
            endpointFamily: 'GET /api/rooms?workplace',
            risk: 'read',
            strategyNote: { replayStatus: 'verified' },
            verificationFixture: { requiredPaths: ['data.*'] },
          },
        }],
      },
    });

    expect(testCase).toMatchObject({
      execute: true,
      captureBound: true,
      captureBoundEvidenceId: 'GET /api/rooms?workplace',
      captureBoundEndpointFamily: 'GET /api/rooms?workplace',
    });
    expect(JSON.stringify(testCase)).not.toContain('real-business-value');
  });

  it('does not type-check or replay captured query values into runtime arguments', () => {
    const [testCase] = buildRuntimeTestCases({
      registeredTools: [{
        name: 'example.test.search_records',
        description: '查询记录',
        parameters: {
          type: 'object',
          properties: { filters: { type: 'array' } },
          required: ['filters'],
        },
      }],
      memory: {
        listApiCandidates: [{
          url: 'https://example.test/api/search?filters=active',
          responsePreview: '{"data":[]}',
        }],
      },
    });

    expect(testCase).toMatchObject({
      execute: false,
      skipReason: 'missing_safe_test_arguments',
      validationErrors: [],
      capturedRequestKeys: ['filters'],
    });
  });

  it('executes the same passive list interface regardless of the generated tool name', () => {
    const candidate = {
      url: 'https://tasks.example.com/api/todos?pageSize=20&pageIndex=1',
      method: 'POST',
      responsePreview: '{"code":0,"data":{"records":[{"id":1}]}}',
    };
    const [testCase] = buildRuntimeTestCases({
      registeredTools: [{
        name: 'tasks.example.com.todo_list',
        description: '查询待办列表',
        parameters: {
          type: 'object',
          properties: {
            pageSize: { type: 'integer', default: 20 },
            pageIndex: { type: 'integer', default: 1 },
          },
          required: [],
        },
      }],
      plan: { tools: [{ name: 'tasks.example.com.list_todos', risk: 'read' }] },
      memory: { listApiCandidates: [candidate] },
    });

    expect(testCase).toMatchObject({
      execute: true,
      risk: { level: 'read', confidence: 0.97 },
      sourceEvidence: {
        version: 'api-source-v2',
        fingerprint: expect.stringMatching(/^api-v1-/),
        sourceKind: 'passive_list',
        risk: expect.objectContaining({ level: 'read' }),
      },
      arguments: { pageSize: 20, pageIndex: 1 },
      contract: { kind: 'captured_sample' },
    });
  });

  it('keeps captured approval interfaces classified as writes', () => {
    const [testCase] = buildRuntimeTestCases({
      registeredTools: [{
        name: 'tasks.example.com.approve_todo',
        description: '审批待办',
        parameters: { type: 'object', properties: {}, required: [] },
      }],
      memory: {
        actionApiCandidates: [{
          toolName: 'tasks.example.com.approve_todo',
          actionName: '审批待办',
          method: 'POST',
          url: 'https://tasks.example.com/api/approve/myApprove',
          responsePreview: '{"code":0}',
        }],
      },
    });

    expect(testCase).toMatchObject({
      execute: false,
      skipReason: 'tool_is_not_high_confidence_read_only',
      risk: { level: 'write' },
    });
  });

  it('matches captured samples by interface fingerprint instead of tool order or name', () => {
    const first = {
      method: 'GET',
      url: 'https://example.test/api/first?cursor=wrong',
      responsePreview: '{"data":{"records":[]}}',
    };
    const second = {
      method: 'GET',
      url: 'https://example.test/api/second?cursor=correct',
      responsePreview: '{"data":{"records":[{"id":2}]}}',
    };
    const [testCase] = buildRuntimeTestCases({
      registeredTools: [{
        name: 'example.test.any_model_generated_name',
        description: '模型任意命名',
        generationSource: buildApiSourceEvidence(second, { sourceKind: 'passive_list' }),
        parameters: {
          type: 'object',
          properties: { cursor: { type: 'string' } },
          required: ['cursor'],
        },
      }],
      memory: { listApiCandidates: [first, second] },
    });

    expect(testCase).toMatchObject({
      execute: false,
      arguments: {},
      argumentSources: {},
      capturedRequestKeys: ['cursor'],
      skipReason: 'missing_safe_test_arguments',
      sourceEvidence: { endpoint: 'https://example.test/api/second' },
    });
  });

  it('does not trust source risk metadata when its fingerprint has no captured match', () => {
    const [testCase] = buildRuntimeTestCases({
      registeredTools: [{
        name: 'example.test.todo_list',
        description: '查询列表',
        generationSource: {
          version: 'api-source-v1',
          fingerprint: 'api-v1-unmatched',
          sourceKind: 'passive_list',
          risk: { level: 'read', confidence: 1, evidence: ['claimed_read'] },
        },
        parameters: { type: 'object', properties: {}, required: [] },
      }],
      memory: {
        listApiCandidates: [{
          method: 'GET',
          url: 'https://example.test/api/actual',
          responsePreview: '{"data":[]}',
        }],
      },
    });

    expect(testCase.execute).toBe(false);
    expect(testCase.sourceEvidence).toBeNull();
    expect(testCase.skipReason).toBe('missing_captured_response_sample');
  });
});
