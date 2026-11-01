import { it, expect } from 'vitest';
import { normalizeVerificationCases, applyVerificationCases } from '../exploration-verification.js';
const cases = [{ id: 'first', args: { keyword: 'Example', page: 1 }, expect: { types: { 'data.items.*.id': 'string' }, patterns: { 'data.items.*.id': '^example-[0-9]+$' }, rowCount: { path: 'data.items', min: 1, max: 20 } } }];
it('round-trips typed authored cases without converting business argument types', () => {
  const normalized = normalizeVerificationCases(cases);
  expect(normalized[0].args.page).toBe(1); expect(normalizeVerificationCases(normalized)).toEqual(normalized);
  expect(normalizeVerificationCases([{ id: 'empty', args: {}, expect: { rowCount: { path: '$', max: 0 } } }])[0].expect.version).toBe(1);
});
it('rejects ambiguous ids, credential storage, malformed assertions and expensive regex syntax', () => {
  expect(() => normalizeVerificationCases([...cases, ...cases])).toThrow();
  expect(() => normalizeVerificationCases([{ ...cases[0], args: { nested: { token: 'placeholder-only' } } }])).toThrow();
  for (const expectValue of [{ unknown: [] }, {}, { types: { 'data.items': 'record' } }, { rowCount: { path: 'items', min: 2, max: 1 } }, { patterns: { id: '^(a+)+$' } }, { patterns: { id: '^.*.*.*$' } }]) {
    expect(() => normalizeVerificationCases([{ ...cases[0], expect: expectValue }])).toThrow();
  }
});
it('author arguments fix missing schema defaults but cannot promote write or evidence-free tools', () => {
  const test = { toolName: 'example.com.search', risk: { level: 'read', confidence: 0.9 }, execute: false, contract: { kind: 'captured_sample' }, missingRequired: ['keyword'] };
  const result = applyVerificationCases([test], { [test.toolName]: normalizeVerificationCases(cases) })[0];
  expect(result.execute).toBe(true); expect(result.arguments).toEqual(cases[0].args); expect(result.caseId).toBe('first');
  expect(applyVerificationCases([{ ...test, risk: { level: 'write', confidence: 1 } }], { [test.toolName]: cases })[0].execute).toBe(false);
  expect(applyVerificationCases([{ ...test, contract: { kind: 'json' } }], { [test.toolName]: cases })[0].execute).toBe(false);
});

import { auditVerification } from '../exploration-verification.js';
it('reports structure-only cases and assertion changes',()=>{
 const cases=[{id:'one',args:{kind:'rating'},expect:{equals:{kind:'rating'},types:{items:'array'}}}];
 expect(auditVerification(cases).map(x=>x.code)).toContain('STRUCTURE_ONLY_VERIFICATION');
 const strong=[{id:'one',args:{kind:'rating'},expect:{equals:{'items.0.score':10}}}];
 expect(auditVerification(strong)).toEqual([]);
 expect(auditVerification(cases,strong).map(x=>x.code)).toContain('VERIFICATION_CHANGED');
 expect(auditVerification([],strong).map(x=>x.code)).toContain('VERIFICATION_CHANGED');
});
