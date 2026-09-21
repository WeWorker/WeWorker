import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyGeneratedWriteTools } from '../generation-harness/index.js';

const tmpDirs = [];

function makeWriteAdapter({
  expectedBody = { title: 'Request', count: 2 },
  actualBody = null,
  representativeArgs = { title: 'Request', visitorCount: 2 },
  confirmationDefault = 'false',
  confirmationGuard = '!__confirmed',
  expectations = {},
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-write-verifier-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'webcli-generated'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'example.test',
    match: ['example.test'],
    support_files: ['webcli-generated/write.js'],
  }));
  const actualBodyExpression = actualBody === null
    ? '{ title, count: visitorCount }'
    : JSON.stringify(actualBody);
  fs.writeFileSync(path.join(dir, 'webcli-generated', 'write.js'), `
    window.__webmcpGeneratedSupport = {
      'example.test': {
        tools: [{
          name: 'example.test.submit_request',
          access: 'write',
          writeVerification: ${JSON.stringify({
            representativeArgs,
            expectedRequest: { method: 'POST', url: 'https://example.test/api/request/submit', body: expectedBody },
            successResponse: { status: 200, body: { code: 0, message: 'ok' } },
            successExpectation: { ok: true },
            failureResponse: { status: 200, body: { code: 409, message: 'conflict' } },
            failureExpectation: { ok: false, message: 'conflict' },
            ...expectations,
            forbiddenValues: ['demo-user', '2444', '2026-09-14'],
          })},
          handler: async ({ __confirmed = ${confirmationDefault}, title, visitorCount } = {}) => {
            if (${confirmationGuard}) return { ok: false, blocked: true, requiresConfirmation: true };
            const response = await fetch('https://example.test/api/request/submit', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(${actualBodyExpression}),
            });
            const data = JSON.parse(await response.text());
            return { ok: response.ok && data.code === 0, message: data.message };
          },
        }],
      },
    };
  `);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('generated write tool verifier', () => {
  it.each(['successExpectation', 'failureExpectation'])('rejects invalid %s with actionable schema feedback', async (field) => {
    for (const value of ['result.ok === true', {}, [], null]) {
      const result = await verifyGeneratedWriteTools({
        adapterDir: makeWriteAdapter({ expectations: { [field]: value } }),
        expectedSiteKey: 'example.test',
      });
      expect(result.passed).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: 'INVALID_WRITE_VERIFICATION', fields: [field],
        message: expect.stringContaining('not JavaScript expression strings'),
      }));
    }
  });

  it.each([true, false])('controls confirmation independently of fixture value %s', async (__confirmed) => {
    const result = await verifyGeneratedWriteTools({
      adapterDir: makeWriteAdapter({ representativeArgs: { title: 'Request', visitorCount: 2, __confirmed } }),
      expectedSiteKey: 'example.test',
    });
    expect(result).toMatchObject({ passed: true, writeToolCount: 1 });
    expect(result.cases).toHaveLength(1);
  });

  it.each([
    { confirmationDefault: 'true' },
    { confirmationDefault: 'undefined', confirmationGuard: '__confirmed === undefined' },
    { confirmationGuard: 'false' },
  ])('rejects unsafe missing/false confirmation handling: %j', async (options) => {
    const result = await verifyGeneratedWriteTools({
      adapterDir: makeWriteAdapter({
        ...options,
        representativeArgs: { title: 'Request', visitorCount: 2, __confirmed: true },
      }),
      expectedSiteKey: 'example.test',
    });
    expect(result.passed).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'WRITE_IO_BEFORE_CONFIRMATION', requestCount: 1 }));
  });

  it('verifies no I/O before confirmation, exact request, and business success/failure', async () => {
    const result = await verifyGeneratedWriteTools({ adapterDir: makeWriteAdapter(), expectedSiteKey: 'example.test' });
    expect(result).toMatchObject({ passed: true, writeToolCount: 1 });
    expect(result.cases[0].request).toMatchObject({
      method: 'POST',
      url: 'https://example.test/api/request/submit',
      body: { title: 'Request', count: 2 },
    });
  });

  it('fails when the confirmed payload differs from the reviewed fixture', async () => {
    const result = await verifyGeneratedWriteTools({
      adapterDir: makeWriteAdapter({ expectedBody: { title: 'Request', count: 3 } }),
      expectedSiteKey: 'example.test',
    });
    expect(result.passed).toBe(false);
    expect(result.errors.map((item) => item.code)).toContain('WRITE_REQUEST_MISMATCH');
  });

  it('fails when the confirmed payload contains fields absent from the exact fixture', async () => {
    const result = await verifyGeneratedWriteTools({
      adapterDir: makeWriteAdapter({
        actualBody: { title: 'Request', count: 2, capturedRecordId: 'stale-id' },
      }),
      expectedSiteKey: 'example.test',
    });
    expect(result.passed).toBe(false);
    expect(result.errors.map((item) => item.code)).toContain('WRITE_REQUEST_MISMATCH');
  });
});
