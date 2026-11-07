import { normalizePathParameters, resolvePathRequest } from './generation-harness/path-parameters.js';
import { buildApiSourceEvidence } from './generation-harness/source-evidence.js';
import { validateHttpContract } from './http-contract.js';

export const isHttpStrategy = strategy => ['PUBLIC_API', 'COOKIE_API', 'AUTH_API'].includes(strategy);

export function httpToolContract(tool, candidate) {
  if (!Array.isArray(tool.sourceApiIndexes) || tool.sourceApiIndexes.length !== 1 || !Number.isInteger(tool.sourceApiIndexes[0])) {
    throw Object.assign(new Error('Host HTTP plans require exactly one observed API source index.'), { code: 'INVALID_PLAN' });
  }
  const version = tool.auth !== undefined || tool.cookies?.storeId !== undefined || tool.cookies?.partitionKey !== undefined ? 2 : 1;
  const spec = { version, strategy: tool.strategy, origins: [new URL(candidate.url).origin],
    ...(tool.auth !== undefined ? { auth: tool.auth } : {}),
    ...(tool.cookies !== undefined ? { cookies: tool.cookies } : {}) };
  validateHttpContract({ runtime: 'http', http: spec });
  return spec;
}

/** Scaffold from structure only. Actual values and response mappings belong to the calling Agent. */
export function buildHttpTool(site, tool, candidate) {
  const endpoint = new URL(candidate.url);
  if (tool.risk === 'write') return {
    toolDefinition: { name: site + '.' + tool.name, runtime: 'http', http: httpToolContract(tool, candidate), access: 'write',
      description: tool.purpose || 'Perform the explicitly authored API write when invoked.',
      parameters: { type: 'object', properties: {}, additionalProperties: false,
        'x-webcli-agent-authored': false },
      generationSource: { ...buildApiSourceEvidence(candidate, { sourceKind: candidate.declared ? 'authored_write_declaration' : 'observed_write' }), risk: { level: 'write', confidence: 1 } } },
    v2Content: `module.exports = async function (args = {}, api) {
  // Author the input schema, request and success/failure interpretation.
  // Declared endpoint: ${candidate.method} ${endpoint.origin}${endpoint.pathname}
  throw new Error('AGENT_AUTHORED_WRITE_REQUIRED');
};\n`,
  };
  const bindings = normalizePathParameters(candidate, tool.pathParameters);
  const segments = endpoint.pathname.slice(1).split('/');
  for (const binding of bindings) segments[binding.segmentIndex] = ':id';
  endpoint.pathname = '/' + segments.join('/');
  const safe = name => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) && !/password|passwd|secret|cookie|authorization|credential|api.?key|csrf|session|token/i.test(name) && !['constructor', 'prototype'].includes(name);
  const queryKeys = [...endpoint.searchParams.keys()].filter(safe);
  for (const key of [...endpoint.searchParams.keys()]) if (!queryKeys.includes(key)) endpoint.searchParams.delete(key);
  const bodyKeys = candidate.method === 'POST' ? (candidate.requestEvidence?.bodyKeys || []).filter(safe) : [];
  const keys = [...new Set([...queryKeys, ...bodyKeys, ...bindings.map(item => item.name)])];
  const parameters = { type: 'object', additionalProperties: false, properties: Object.fromEntries(keys.map(key => [key,
    { description: bindings.find(item => item.name === key)?.description || 'Provide the public ' + key + ' request field.' }])),
    required: bindings.map(item => item.name) };
  for (const binding of bindings) Object.assign(parameters.properties[binding.name], { type: 'string', minLength: 1, maxLength: 512 });
  const method = candidate.method;
  const form = candidate.requestEvidence?.bodyKind === 'form';
  const requestBody = method === 'POST' ? form
    ? `request.body = new URLSearchParams(body).toString(); request.headers = {'content-type':'application/x-www-form-urlencoded'};`
    : 'request.json = body;' : '';
  return { toolDefinition: { name: site + '.' + tool.name, runtime: 'http', http: httpToolContract(tool, candidate), access: 'read',
    description: tool.purpose || 'Read the observed API via host HTTP.', parameters,
    generationSource: candidate.sourceEvidence || buildApiSourceEvidence(candidate, { sourceKind: 'passive_list' }) },
    v2Content: `module.exports = async function (args = {}, api) {
  if (Object.keys(args).some(key => !${JSON.stringify(keys)}.includes(key))) throw new Error('Unexpected API parameter.');
  const resolved = (${resolvePathRequest.toString()})(${JSON.stringify(endpoint.href)}, ${JSON.stringify(bindings)}, args);
  const body = resolved.params;
  ${candidate.requestSemantics?.kind === 'graphql' ? "if (typeof body.query !== 'string' || !/^\\s*(query\\b|\\{)/.test(body.query) || /\\b(mutation|subscription)\\b/.test(body.query)) throw new Error('Only an authored GraphQL query is allowed.');" : ''}
  const request = {url: resolved.url, method: ${JSON.stringify(method)}};
  ${requestBody}
  return api.request(request);
};\n` };
}
