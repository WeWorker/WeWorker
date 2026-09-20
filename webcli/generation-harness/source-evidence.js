import { createHash } from 'node:crypto';

const WRITE_API_SIGNAL_RE = /approve|reject|delete|remove|update|edit|submit|create|add|cancel|publish|confirm|apply|save|write|mutation|审批|批准|驳回|删除|修改|提交|创建|新增|取消|发布|确认|更新/i;
const READ_API_SIGNAL_RE = /(?:^|[^a-z])(get|list|search|query|fetch|check|find|read|status|detail|summary|page)(?:$|[^a-z])|查询|列表|搜索|获取|读取|查看|详情|状态|分页|待办/i;
const SYSTEM_API_SIGNAL_RE = /analytics|telemetry|tracking|track|heartbeat|beacon|report|refresh.?token|session|mark.?read|埋点|心跳|上报|刷新令牌|标记已读/i;
const TRUNCATION_MARKER_RE = /(?:\.{0,3}\[truncated\]|…\s*\[truncated\])\s*$/i;

function shapeOf(value, depth = 0) {
  if (depth >= 8) return { type: 'unknown' };
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.length > 0 ? shapeOf(value[0], depth + 1) : { type: 'unknown' },
    };
  }
  if (typeof value === 'object') {
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, shapeOf(nested, depth + 1)])),
    };
  }
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'string') return { type: 'string' };
  return { type: 'unknown' };
}

function bodyKeysFromShape(shape) {
  return shape?.type === 'object' && shape.properties && typeof shape.properties === 'object'
    ? Object.keys(shape.properties).sort()
    : [];
}

function legacyBody(candidate) {
  return candidate?.requestBodyPreview ?? candidate?.requestBody;
}

function legacyResponseBody(candidate) {
  return candidate?.responsePreview ?? candidate?.responseBodyPreview ?? candidate?.responseBody;
}

function emptyBodyEvidence(version) {
  return {
    version,
    bodyKind: 'none',
    bodyShape: null,
    bodyKeys: [],
    bodyFullSize: 0,
    bodyTruncated: false,
    bodyOmitted: false,
  };
}

function opaqueBodyEvidence(version, { fullSize = 0, truncated = false } = {}) {
  return {
    version,
    bodyKind: 'opaque',
    bodyShape: null,
    bodyKeys: [],
    bodyFullSize: fullSize,
    bodyTruncated: truncated,
    bodyOmitted: true,
  };
}

/**
 * OpenCLI-aligned request evidence. Values never leave this boundary; only
 * recursive types and field names survive. A clipped or malformed body is
 * deliberately opaque instead of being repaired into an executable prefix.
 */
export function normalizeRequestBodyEvidence(candidate = {}) {
  const supplied = candidate?.requestEvidence;
  if (supplied && typeof supplied === 'object') {
    const bodyTruncated = Boolean(supplied.bodyTruncated);
    const bodyOmitted = bodyTruncated || Boolean(supplied.bodyOmitted);
    const bodyShape = bodyOmitted ? null : (supplied.bodyShape && typeof supplied.bodyShape === 'object' ? supplied.bodyShape : null);
    return {
      version: 'request-evidence-v1',
      bodyKind: bodyOmitted ? 'opaque' : String(supplied.bodyKind || (bodyShape ? 'json' : 'none')),
      bodyShape,
      bodyKeys: bodyKeysFromShape(bodyShape),
      bodyFullSize: Number.isFinite(Number(supplied.bodyFullSize)) ? Number(supplied.bodyFullSize) : 0,
      bodyTruncated,
      bodyOmitted,
    };
  }

  const body = legacyBody(candidate);
  if (body == null || body === '') {
    return emptyBodyEvidence('request-evidence-v1');
  }

  if (typeof body === 'object') {
    const bodyShape = shapeOf(body);
    return {
      version: 'request-evidence-v1',
      bodyKind: 'json',
      bodyShape,
      bodyKeys: bodyKeysFromShape(bodyShape),
      bodyFullSize: 0,
      bodyTruncated: false,
      bodyOmitted: false,
    };
  }

  const text = String(body).trim();
  const explicitTruncation = Boolean(candidate?.bodyTruncated || candidate?.requestBodyTruncated)
    || TRUNCATION_MARKER_RE.test(text)
    || (Number.isFinite(Number(candidate?.requestBodyFullSize)) && Number(candidate.requestBodyFullSize) > text.length);
  if (explicitTruncation) {
    return {
      version: 'request-evidence-v1',
      bodyKind: 'opaque',
      bodyShape: null,
      bodyKeys: [],
      bodyFullSize: Number(candidate?.requestBodyFullSize) || text.length,
      bodyTruncated: true,
      bodyOmitted: true,
    };
  }

  try {
    const parsed = JSON.parse(text);
    const bodyShape = shapeOf(parsed);
    return {
      version: 'request-evidence-v1',
      bodyKind: 'json',
      bodyShape,
      bodyKeys: bodyKeysFromShape(bodyShape),
      bodyFullSize: text.length,
      bodyTruncated: false,
      bodyOmitted: false,
    };
  } catch {
    if (text.startsWith('{') || text.startsWith('[')) {
      return {
        version: 'request-evidence-v1',
        bodyKind: 'opaque',
        bodyShape: null,
        bodyKeys: [],
        bodyFullSize: text.length,
        bodyTruncated: false,
        bodyOmitted: true,
      };
    }
  }

  if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(text)) {
    const parsed = Object.fromEntries(new URLSearchParams(text));
    const bodyShape = shapeOf(parsed);
    return {
      version: 'request-evidence-v1',
      bodyKind: 'form',
      bodyShape,
      bodyKeys: bodyKeysFromShape(bodyShape),
      bodyFullSize: text.length,
      bodyTruncated: false,
      bodyOmitted: false,
    };
  }

  return {
    version: 'request-evidence-v1',
    bodyKind: 'opaque',
    bodyShape: null,
    bodyKeys: [],
    bodyFullSize: text.length,
    bodyTruncated: false,
    bodyOmitted: true,
  };
}

/**
 * Response evidence is deliberately structural. Captured scalar values are
 * available to the in-process runtime verifier, but never enter model prompts,
 * generation context, generated source, or persisted knowledge artifacts.
 */
export function normalizeResponseBodyEvidence(candidate = {}) {
  const supplied = candidate?.responseEvidence;
  if (supplied && typeof supplied === 'object') {
    const bodyTruncated = Boolean(supplied.bodyTruncated);
    const bodyOmitted = bodyTruncated || Boolean(supplied.bodyOmitted);
    const bodyShape = bodyOmitted
      ? null
      : (supplied.bodyShape && typeof supplied.bodyShape === 'object' ? shapeOfShape(supplied.bodyShape) : null);
    return {
      version: 'response-evidence-v1',
      bodyKind: bodyOmitted ? 'opaque' : String(supplied.bodyKind || (bodyShape ? 'json' : 'none')),
      bodyShape,
      bodyKeys: bodyKeysFromShape(bodyShape),
      bodyFullSize: Number.isFinite(Number(supplied.bodyFullSize)) ? Number(supplied.bodyFullSize) : 0,
      bodyTruncated,
      bodyOmitted,
    };
  }

  const body = legacyResponseBody(candidate);
  if (body == null || body === '') return emptyBodyEvidence('response-evidence-v1');
  if (typeof body === 'object') {
    const bodyShape = shapeOf(body);
    return {
      version: 'response-evidence-v1',
      bodyKind: 'json',
      bodyShape,
      bodyKeys: bodyKeysFromShape(bodyShape),
      bodyFullSize: 0,
      bodyTruncated: false,
      bodyOmitted: false,
    };
  }

  const text = String(body).trim();
  const fullSize = Number(candidate?.responseBodyFullSize) || text.length;
  const truncated = Boolean(candidate?.responseBodyTruncated || candidate?.responseTruncated)
    || TRUNCATION_MARKER_RE.test(text)
    || fullSize > text.length;
  if (truncated) return opaqueBodyEvidence('response-evidence-v1', { fullSize, truncated: true });

  try {
    const bodyShape = shapeOf(JSON.parse(text));
    return {
      version: 'response-evidence-v1',
      bodyKind: 'json',
      bodyShape,
      bodyKeys: bodyKeysFromShape(bodyShape),
      bodyFullSize: text.length,
      bodyTruncated: false,
      bodyOmitted: false,
    };
  } catch {
    return opaqueBodyEvidence('response-evidence-v1', { fullSize: text.length });
  }
}

function shapeOfShape(shape, depth = 0) {
  if (!shape || typeof shape !== 'object' || depth >= 8) return { type: 'unknown' };
  const type = ['null', 'array', 'object', 'integer', 'number', 'boolean', 'string', 'unknown'].includes(shape.type)
    ? shape.type
    : 'unknown';
  if (type === 'array') return { type, items: shapeOfShape(shape.items, depth + 1) };
  if (type === 'object') {
    const properties = shape.properties && typeof shape.properties === 'object' && !Array.isArray(shape.properties)
      ? shape.properties
      : {};
    return {
      type,
      properties: Object.fromEntries(Object.entries(properties).slice(0, 100).map(([key, nested]) => [key, shapeOfShape(nested, depth + 1)])),
    };
  }
  return { type };
}

function parseBodyKeys(candidate) {
  return normalizeRequestBodyEvidence(candidate).bodyKeys;
}

export function normalizeApiEndpoint(candidate = {}) {
  const method = String(candidate.method || 'GET').toUpperCase();
  const rawEndpoint = String(candidate.url || '').trim();
  let endpoint = rawEndpoint;
  let queryKeys = [];
  try {
    const base = 'http://webcli.invalid';
    const url = new URL(rawEndpoint, base);
    endpoint = url.origin === base ? url.pathname : `${url.protocol}//${url.host}${url.pathname}`;
    queryKeys = [...new Set([...url.searchParams.keys()])].sort();
  } catch {
    const queryIndex = rawEndpoint.indexOf('?');
    const hashIndex = rawEndpoint.indexOf('#');
    const endIndex = [queryIndex, hashIndex].filter((value) => value >= 0).sort((left, right) => left - right)[0];
    endpoint = endIndex == null ? rawEndpoint : rawEndpoint.slice(0, endIndex);
    if (queryIndex >= 0) {
      const queryEnd = hashIndex > queryIndex ? hashIndex : rawEndpoint.length;
      queryKeys = [...new Set([...new URLSearchParams(rawEndpoint.slice(queryIndex + 1, queryEnd)).keys()])].sort();
    }
  }
  return {
    method,
    endpoint,
    queryKeys,
    bodyKeys: parseBodyKeys(candidate),
  };
}

export function createApiCandidateFingerprint(candidate = {}) {
  const normalized = normalizeApiEndpoint(candidate);
  const identity = JSON.stringify(normalized);
  return `api-v1-${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
}

export function classifyApiCandidateRisk(candidate = {}, { sourceKind = '' } = {}) {
  const normalized = normalizeApiEndpoint(candidate);
  const probe = [
    normalized.endpoint,
    candidate.actionName,
    candidate.toolName,
    candidate.description,
  ].filter(Boolean).join(' ');
  const evidence = [`source:${sourceKind || 'unknown'}`, `method:${normalized.method}`];

  if (SYSTEM_API_SIGNAL_RE.test(probe)) {
    return { level: 'unknown', confidence: 0.2, evidence: [...evidence, 'system_or_telemetry_signal'] };
  }
  if (WRITE_API_SIGNAL_RE.test(probe)) {
    return { level: 'write', confidence: 0.99, evidence: [...evidence, 'mutation_signal'] };
  }
  if (sourceKind === 'passive_list') {
    return {
      level: 'read',
      confidence: 0.97,
      evidence: [...evidence, 'passive_exploration_list_candidate'],
    };
  }
  if (READ_API_SIGNAL_RE.test(probe)) {
    return { level: 'read', confidence: 0.92, evidence: [...evidence, 'query_signal'] };
  }
  if (normalized.method === 'GET' || normalized.method === 'HEAD') {
    return { level: 'read', confidence: 0.86, evidence: [...evidence, 'safe_http_method'] };
  }
  if (sourceKind === 'action_capture') {
    return { level: 'write', confidence: 0.88, evidence: [...evidence, 'captured_user_action_non_read'] };
  }
  return { level: 'unknown', confidence: 0.4, evidence };
}

export function buildApiSourceEvidence(candidate = {}, { sourceKind = '' } = {}) {
  const normalized = normalizeApiEndpoint(candidate);
  const requestEvidence = normalizeRequestBodyEvidence(candidate);
  return {
    version: 'api-source-v2',
    fingerprint: createApiCandidateFingerprint(candidate),
    sourceKind,
    method: normalized.method,
    endpoint: normalized.endpoint,
    queryKeys: normalized.queryKeys,
    bodyKeys: normalized.bodyKeys,
    requestEvidence,
    risk: classifyApiCandidateRisk(candidate, { sourceKind }),
  };
}
