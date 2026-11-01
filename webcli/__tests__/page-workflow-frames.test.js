import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizePageWorkflow, pageWorkflowContract, validatePageWorkflowContract, workflowValues } from '../exploration-workflow.js';
import { workflowPermissionTargets, workflowOriginTargets, workflowOriginRoutes } from '../page-workflow-origins.js';
import { buildPageTool, pageObservation } from '../exploration-page.js';
import { validateV2Manifest } from '../adapter-package-validation.js';
import { requiresWorkflowFrameCapability } from '../page-workflow-frames.js';

const frames = [{ selector: '#owner', origin: 'https://example.org', pathname: '/child' }];
const result = { strategy: 'DOM_STATE', path: ['publicResult'] };
const input = () => ({ mode: 'workflow', steps: [
  { frames, pathname: '/child', query: { mode: 'navigate', resultOrigin: 'https://example.net', resultPathname: '/items', result } },
  { pathname: '/entry', query: { mode: 'read', result } },
  { frames, origin: 'https://example.net', pathname: '/items', query: { mode: 'read', result } },
] });
it('roundtrips passive reads and retained frame chains independently of the main route', () => {
  const source = normalizePageWorkflow(input()), contract = pageWorkflowContract(source);
  expect(pageWorkflowContract(validatePageWorkflowContract(contract))).toEqual(contract);
  expect(workflowValues(source, {})).toEqual({});
  expect(() => workflowValues(source, { injected: 'value' })).toThrow();
  expect(workflowOriginRoutes(source, 'https://example.com').map(x => x.origin)).toEqual(['https://example.org','https://example.com','https://example.net']);
  expect(workflowOriginTargets(source, 'https://example.com', '/entry')).toEqual([
    { origin: 'https://example.com', pathname: '/entry' }, { origin: 'https://example.com', pathname: '/entry' },
  ]);
  expect(workflowPermissionTargets(source, 'https://example.com', '/entry')).toContainEqual({ origin: 'https://example.net', pathname: '/items' });
});
it('requires the new capability for passive reads even without frame owners', () => {
  const source = normalizePageWorkflow({ mode: 'workflow', steps: [0,1].map(() => ({ pathname: '/entry', query: { mode: 'read', result } })) });
  expect(requiresWorkflowFrameCapability(source)).toBe(true);
  expect(requiresWorkflowFrameCapability({ steps: [{ query: { mode: 'filter' } }] })).toBe(false);
});
it('rejects transient IDs, changed owner declarations, discontinuous paths and missing cross-origin continuation', () => {
  for (const mutate of [
    x => x.steps[0].frames[0].frameId = 42,
    x => x.steps[0].pathname = '/other',
    x => x.steps[2].pathname = '/other',
    x => x.steps[2].frames = [{ ...frames[0], pathname: '/items' }],
  ]) { const source = structuredClone(input()); mutate(source); expect(() => normalizePageWorkflow(source)).toThrow(); }
  const source = input(); delete source.steps[2].origin;
  expect(() => workflowOriginRoutes(normalizePageWorkflow(source), 'https://example.com')).toThrow();
});
it('generated manifests require all frame permission hosts while retaining the observed main tab', () => {
  const source = normalizePageWorkflow(input());
  const generated = buildPageTool('example', { name: 'read' }, pageObservation({ source, url: 'https://example.com/entry', shape: {}, reason: 'Public frame read' })).toolDefinition;
  expect(generated.pageRoute.pathname).toBe('/entry');
  const manifest = { schema_version: 2, name: 'example', version: '1.0.0', description: 'Example', match: ['example.com'], commands: [{ id: 'read', runtime: 'extension', module: 'extension/commands/read.js', description: 'Read', schema: generated.parameters, safety: 'read', pageRoute: generated.pageRoute, pageStrategy: generated.pageStrategy, pageWorkflow: true }] };
  expect(() => validateV2Manifest(manifest)).toThrow();
  manifest.match.push('example.org'); expect(() => validateV2Manifest(manifest)).toThrow();
  manifest.match.push('example.net'); expect(() => validateV2Manifest(manifest)).not.toThrow();
  expect(readFileSync(new URL('../page-workflow-frames.js', import.meta.url), 'utf8')).toBe(readFileSync(new URL('../../extension/background/page-workflow-frames.js', import.meta.url), 'utf8'));
});
