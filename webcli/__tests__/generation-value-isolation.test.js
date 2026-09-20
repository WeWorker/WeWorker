import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeScaffoldFromSiteMemory } from '../adapter-scaffold.js';
import {
  buildActionCaptureAnalysisPayload,
  buildExplorationAnalysisPayload,
  buildPrompt,
  buildScaffoldSemanticPayload,
} from '../ai-analyzer.js';
import { buildContextSections } from '../generation-harness/adapter-generation-workflow.js';

const temporaryDirectories = [];
const capturedValues = [
  '00000000-0000-4000-8000-000000000001',
  'verify-fingerprint-private',
  'device-fingerprint-private',
  'ms-token-private',
  'a-bogus-private',
  'fixture-user-001',
  'fixture-article-001',
  'session-private-value',
  'private-user-name',
  'private-article-title',
  'response-token-private',
];

function makeCandidate() {
  return {
    actionName: 'like_article',
    toolName: 'example.com.like_article_draft',
    method: 'POST',
    url: 'https://api.example.com/interact_api/v1/digg/save'
      + '?uuid=00000000-0000-4000-8000-000000000001'
      + '&verifyFp=verify-fingerprint-private'
      + '&fp=device-fingerprint-private'
      + '&msToken=ms-token-private'
      + '&a_bogus=a-bogus-private',
    requestBodyPreview: JSON.stringify({
      userId: 'fixture-user-001',
      articleId: 'fixture-article-001',
      sessionId: 'session-private-value',
    }),
    responsePreview: JSON.stringify({
      data: {
        user: { id: 'fixture-user-001', name: 'private-user-name' },
        article: { id: 'fixture-article-001', title: 'private-article-title' },
        token: 'response-token-private',
      },
    }),
    responseContentType: 'application/json',
    status: 200,
    capturedAt: '2026-09-18T01:00:00.000Z',
  };
}

function expectNoCapturedValues(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const captured of capturedValues) expect(serialized).not.toContain(captured);
}

function readTree(root) {
  const chunks = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) chunks.push(readTree(target));
    else chunks.push(fs.readFileSync(target, 'utf8'));
  }
  return chunks.join('\n');
}

afterEach(() => {
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

describe('OpenCLI-aligned captured value isolation', () => {
  it('exposes only endpoint keys and body shapes to every model-facing context', () => {
    const candidate = makeCandidate();
    const explorationResult = {
      pageStateAfter: { url: candidate.url, title: 'Example' },
      resultPageState: { url: candidate.url, title: 'Example result' },
      network: { entries: [candidate] },
      actions: [{ step: 'capture', result: {}, networkDelta: { entries: [candidate] } }],
    };
    const captureResult = {
      site: 'example.com',
      actionName: 'like_article',
      beforeTab: { url: candidate.url },
      finalTab: { url: candidate.url },
      capturedActions: [candidate],
    };
    const memory = {
      siteKey: 'example.com',
      siteHost: 'example.com',
      listApiCandidates: [candidate],
      actionApiCandidates: [candidate],
    };

    const modelInputs = [
      buildPrompt('example.com', [candidate], ''),
      buildExplorationAnalysisPayload({ siteKey: 'example.com', explorationResult, heuristicVerdict: null }),
      buildActionCaptureAnalysisPayload({ captureResult }),
      buildScaffoldSemanticPayload(memory),
      buildContextSections(memory),
    ];
    for (const modelInput of modelInputs) expectNoCapturedValues(modelInput);

    const combined = JSON.stringify(modelInputs);
    for (const key of ['uuid', 'verifyFp', 'fp', 'msToken', 'a_bogus', 'userId', 'articleId', 'sessionId']) {
      expect(combined).toContain(key);
    }
    expect(combined).toContain('response-evidence-v1');
  });

  it('does not persist captured request, query, or response values in generated artifacts', () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-value-isolation-'));
    temporaryDirectories.push(outputRoot);
    const candidate = makeCandidate();
    const result = writeScaffoldFromSiteMemory({
      siteKey: 'example.com',
      siteHost: 'example.com',
      siteOrigin: 'https://example.com',
      canonicalEntryUrl: candidate.url,
      canonicalResultUrl: candidate.url,
      lastSourceUrl: candidate.url,
      updatedAt: '2026-09-18T01:00:00.000Z',
      captureCount: 1,
      workflowVersion: 'opencli-aligned-value-isolation-v1',
      recommendedStrategy: 'COOKIE_API',
      verdictPattern: 'api_driven',
      verdictReason: `Captured ${candidate.url}`,
      resultSignals: {},
      detailHints: { mode: '', bestCandidateHref: '', bestCandidateText: '', networkDetailCandidates: [] },
      pagination: { attempted: false, verified: false, mode: '', targetPage: null, activePageBefore: null, activePageAfter: null, reason: '' },
      listApiCandidates: [candidate],
      actionApiCandidates: [candidate],
      actionCaptureHistory: [candidate],
    }, { outputRoot });

    const artifacts = readTree(result.adapterDir);
    expectNoCapturedValues(artifacts);
    expect(artifacts).toContain('response-evidence-v1');
    expect(artifacts).toContain('articleId');
    expect(artifacts).toContain('userId');

    const knowledge = JSON.parse(fs.readFileSync(result.files.knowledgeJson, 'utf8'));
    const api = knowledge.apis.find((item) => item.path === '/interact_api/v1/digg/save');
    expect(api.queryKeys).toEqual(['a_bogus', 'fp', 'uuid', 'verifyFp']);
    expect(api.requestShape.keys).toEqual(['articleId', 'userId']);
    expect(api.responseEvidence.bodyShape.properties.data.type).toBe('object');
    expect(api.examples.every((example) => !Object.hasOwn(example, 'responseSample'))).toBe(true);
  });
});
