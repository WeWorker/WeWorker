import { describe, expect, it } from 'vitest';
import {
  buildApiSourceEvidence,
  createApiCandidateFingerprint,
  normalizeRequestBodyEvidence,
  normalizeResponseBodyEvidence,
} from '../generation-harness/index.js';

describe('generation source evidence', () => {
  it('creates the same fingerprint when only captured parameter values change', () => {
    const first = {
      method: 'POST',
      url: 'https://todo.example.com/api/todos?pageSize=20&pageIndex=1',
      requestBodyPreview: '{"keyword":"first"}',
    };
    const second = {
      method: 'POST',
      url: 'https://todo.example.com/api/todos?pageIndex=2&pageSize=50',
      requestBodyPreview: '{"keyword":"second"}',
    };

    expect(createApiCandidateFingerprint(first)).toBe(createApiCandidateFingerprint(second));
  });

  it('classifies selected passive list candidates as reads even when they use POST', () => {
    const evidence = buildApiSourceEvidence({
      method: 'POST',
      url: 'https://todo.example.com/api/todos',
      requestBodyPreview: '{"pageSize":20,"pageIndex":1}',
    }, { sourceKind: 'passive_list' });

    expect(evidence.risk).toMatchObject({
      level: 'read',
      confidence: 0.97,
    });
  });

  it('does not treat every passively observed request as read-only', () => {
    const telemetry = buildApiSourceEvidence({
      method: 'POST',
      url: 'https://todo.example.com/api/analytics/report',
    }, { sourceKind: 'passive_list' });
    const mutation = buildApiSourceEvidence({
      method: 'POST',
      url: 'https://todo.example.com/api/approve/myApprove',
    }, { sourceKind: 'passive_list' });

    expect(telemetry.risk.level).toBe('unknown');
    expect(mutation.risk.level).toBe('write');
  });

  it('keeps only recursive field/type shape for complete JSON and form bodies', () => {
    const json = normalizeRequestBodyEvidence({
      requestBodyPreview: JSON.stringify({
        title: 'private title',
        applicant: { name: 'demo-user', id: '12345' },
        demands: [{ date: '2026-09-16', count: 3 }],
      }),
    });
    const form = normalizeRequestBodyEvidence({ requestBodyPreview: 'keyword=secret&page=2' });

    expect(json).toMatchObject({
      bodyKind: 'json',
      bodyKeys: ['applicant', 'demands', 'title'],
      bodyTruncated: false,
      bodyOmitted: false,
      bodyShape: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          applicant: {
            type: 'object',
            properties: { name: { type: 'string' }, id: { type: 'string' } },
          },
          demands: {
            type: 'array',
            items: {
              type: 'object',
              properties: { date: { type: 'string' }, count: { type: 'integer' } },
            },
          },
        },
      },
    });
    expect(JSON.stringify(json)).not.toContain('private title');
    expect(JSON.stringify(json)).not.toContain('demo-user');
    expect(form).toMatchObject({ bodyKind: 'form', bodyKeys: ['keyword', 'page'], bodyOmitted: false });
    expect(JSON.stringify(form)).not.toContain('secret');
  });

  it('marks truncated or malformed JSON opaque instead of salvaging its prefix', () => {
    const truncated = normalizeRequestBodyEvidence({
      requestBodyPreview: '{"title":"captured","demands":[{"date":"2026-09-16"}...[truncated]',
      requestBodyFullSize: 4096,
    });
    const malformed = normalizeRequestBodyEvidence({ requestBodyPreview: '{"title":"captured"' });

    expect(truncated).toEqual({
      version: 'request-evidence-v1',
      bodyKind: 'opaque',
      bodyShape: null,
      bodyKeys: [],
      bodyFullSize: 4096,
      bodyTruncated: true,
      bodyOmitted: true,
    });
    expect(malformed).toMatchObject({ bodyKind: 'opaque', bodyShape: null, bodyKeys: [], bodyOmitted: true });
    expect(buildApiSourceEvidence({
      method: 'POST',
      url: 'https://requests.example.com/api/submit',
      requestBodyPreview: '{"title":"captured"...[truncated]',
    }, { sourceKind: 'action_capture' })).toMatchObject({
      version: 'api-source-v2',
      bodyKeys: [],
      requestEvidence: { bodyKind: 'opaque', bodyOmitted: true, bodyTruncated: true },
    });
  });

  it('keeps response field/type shape without captured scalar values', () => {
    const evidence = normalizeResponseBodyEvidence({
      responsePreview: JSON.stringify({
        data: {
          user: { id: 'fixture-user-001', name: 'private-user' },
          articles: [{ articleId: 'fixture-article-001', title: 'private-title' }],
          msToken: 'private-token',
        },
      }),
    });

    expect(evidence).toMatchObject({
      version: 'response-evidence-v1',
      bodyKind: 'json',
      bodyShape: {
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: {
              user: { type: 'object' },
              articles: { type: 'array' },
              msToken: { type: 'string' },
            },
          },
        },
      },
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('fixture-user-001');
    expect(serialized).not.toContain('private-user');
    expect(serialized).not.toContain('fixture-article-001');
    expect(serialized).not.toContain('private-title');
    expect(serialized).not.toContain('private-token');
  });
});
