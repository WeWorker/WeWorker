import { isApiResponseFailure } from './api-response-failure.mjs';

const SENSITIVE_OUTPUT_KEY_RE = /api[_-]?key|authorization|cookie|credential|password|passwd|secret|session|ticket|token|csrf/i;

function valueKind(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function findSensitiveOutputPath(value, pathPrefix = '$', depth = 0) {
  if (depth > 8 || value == null) return '';
  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 20); index++) {
      const found = findSensitiveOutputPath(value[index], `${pathPrefix}[${index}]`, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_OUTPUT_KEY_RE.test(key)) return `${pathPrefix}.${key}`;
    const found = findSensitiveOutputPath(child, `${pathPrefix}.${key}`, depth + 1);
    if (found) return found;
  }
  return '';
}

export function describeGenerationOutputShape(value) {
  const kinds = new Set();
  const visit = (current, depth = 0) => {
    const kind = valueKind(current);
    kinds.add(kind);
    if (depth >= 6 || current == null) return;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 3)) visit(item, depth + 1);
    } else if (typeof current === 'object') {
      for (const child of Object.values(current).slice(0, 30)) visit(child, depth + 1);
    }
  };
  visit(value);
  return {
    rootKind: valueKind(value),
    containsKinds: [...kinds].sort(),
    rootKeys: (() => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const keys = Object.keys(value)
        .map((key) => (/[\u3400-\u9fff\uff00-\uffef]/.test(key) || /^\d{4,}/.test(key) ? '*' : key))
        .slice(0, 30);
      return [...new Set(keys)].sort();
    })(),
  };
}

function pathSegments(path) {
  return String(path || '')
    .replace(/^\$\.?/, '')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function valuesAtPath(root, path) {
  let current = [root];
  for (const segment of pathSegments(path)) {
    const next = [];
    for (const value of current) {
      if (segment === '*') {
        if (Array.isArray(value)) next.push(...value);
        else if (value && typeof value === 'object') next.push(...Object.values(value));
      } else if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, segment)) {
        next.push(value[segment]);
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  if (current.length === 0) {
    const terminal = pathSegments(path).filter((segment) => segment !== '*').pop();
    const rows = Array.isArray(root) ? root : findFirstArray(root);
    if (terminal) {
      return (rows || [])
        .filter((item) => item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, terminal))
        .map((item) => item[terminal]);
    }
  }
  return current;
}

function findFirstArray(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return null;
  for (const child of Object.values(value)) {
    const found = findFirstArray(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function isNonEmpty(value) {
  if (value == null || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function validateFixture(output, fixture) {
  if (!fixture || typeof fixture !== 'object') return [];
  const errors = [];
  let serialized = '';
  try { serialized = JSON.stringify(output).toLowerCase(); } catch {}

  const forbidden = fixture.mustNotContain || [];
  const legacyAuthFixture = fixture.source === 'captured_response' && forbidden.length === 3
    && ['login', 'captcha', 'access denied'].every(keyword => forbidden.some(needle => String(needle).toLowerCase().trim() === keyword));
  for (const needle of forbidden) {
    // Older generated fixtures used global auth keywords. Their response-level
    // meaning is checked by isApiResponseFailure; matching result titles is wrong.
    if (legacyAuthFixture) continue;
    if (needle && serialized.includes(String(needle).toLowerCase())) {
      errors.push({ code: 'OUTPUT_FORBIDDEN_CONTENT', message: `返回值包含禁止内容: ${needle}`, value: needle });
    }
  }
  for (const path of fixture.requiredPaths || []) {
    const nestedListFallback = Array.isArray(output)
      ? output.length > 0
      : Boolean(findFirstArray(output));
    if (valuesAtPath(output, path).length === 0 && !nestedListFallback) {
      errors.push({ code: 'OUTPUT_REQUIRED_PATH_MISSING', message: `返回值缺少探索样本中的路径: ${path}`, path });
    }
  }
  for (const [path, expected] of Object.entries(fixture.types || {})) {
    const values = valuesAtPath(output, path);
    if (values.length === 0) {
      errors.push({ code: 'OUTPUT_TYPE_PATH_MISSING', message: `无法验证字段类型，路径不存在: ${path}`, path });
      continue;
    }
    const invalid = expected === 'null'
      ? undefined
      : values.find((value) => value !== null && valueKind(value) !== expected);
    if (invalid !== undefined) {
      errors.push({ code: 'OUTPUT_FIELD_TYPE_MISMATCH', message: `字段 ${path} 应为 ${expected}，实际为 ${valueKind(invalid)}`, path, expected, actual: valueKind(invalid) });
    }
  }
  for (const path of fixture.notEmpty || []) {
    const values = valuesAtPath(output, path);
    if (values.length === 0 || !values.some(isNonEmpty)) {
      errors.push({ code: 'OUTPUT_EXPECTED_NON_EMPTY', message: `字段应至少有一个非空值: ${path}`, path });
    }
  }
  for (const path of fixture.mustBeTruthy || []) {
    const values = valuesAtPath(output, path);
    const flattenedListFallback = values.length === 0
      && (Array.isArray(output) ? output.length > 0 : Boolean(findFirstArray(output)));
    if (!flattenedListFallback && (values.length === 0 || !values.some(Boolean))) {
      errors.push({ code: 'OUTPUT_EXPECTED_TRUTHY', message: `探索样本中的关键路径未返回有效值: ${path}`, path });
    }
  }
  if (fixture.rowCount && typeof fixture.rowCount === 'object') {
    const rows = findFirstArray(output);
    if (rows) {
      const min = Number(fixture.rowCount.min);
      const max = Number(fixture.rowCount.max);
      if (Number.isFinite(min) && rows.length < min) {
        errors.push({ code: 'OUTPUT_ROW_COUNT_MISMATCH', message: `返回行数 ${rows.length} 小于探索基线下限 ${min}`, actual: rows.length, min, max });
      } else if (Number.isFinite(max) && rows.length > max) {
        errors.push({ code: 'OUTPUT_ROW_COUNT_MISMATCH', message: `返回行数 ${rows.length} 超过探索基线上限 ${max}`, actual: rows.length, min, max });
      }
    }
  }
  return errors;
}

function isGeneratedFetchEnvelope(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  const keys = ['ok', 'status', 'url', 'data', 'rawText'];
  return Object.keys(output).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(output, key))
    && typeof output.ok === 'boolean'
    && Number.isInteger(output.status)
    && typeof output.url === 'string'
    && typeof output.rawText === 'string';
}

function capturedBusinessOutput(output, contract, fetchEnvelope) {
  if (!fetchEnvelope || contract.kind !== 'captured_sample') return output;
  const capturedKeys = contract.capturedShape?.rootKeys || [];
  // An API can itself return envelope-shaped JSON. Keep that captured contract
  // at its original level rather than treating every `data` property as a wrapper.
  if (['ok', 'status', 'url', 'data', 'rawText'].every(key => capturedKeys.includes(key))) return output;
  return output.data;
}

export function validateGenerationPreviewOutputV2(output, contract = {}) {
  const errors = [];
  const warnings = [];
  const outputShape = describeGenerationOutputShape(output);
  try {
    JSON.stringify(output);
  } catch (error) {
    errors.push({ code: 'OUTPUT_NOT_SERIALIZABLE', message: error?.message || String(error) });
  }
  if (isApiResponseFailure(output)) {
    errors.push({ code: 'LOGIN_OR_HTML_RESPONSE', message: '工具返回了登录页或 HTML 页面内容' });
  }
  const sensitivePath = findSensitiveOutputPath(output);
  if (sensitivePath) errors.push({ code: 'SENSITIVE_OUTPUT_DETECTED', message: `返回值包含敏感字段: ${sensitivePath}` });
  const fetchEnvelope = isGeneratedFetchEnvelope(output);
  if (fetchEnvelope && (!output.ok || output.status < 200 || output.status >= 300)) {
    errors.push({ code: 'OUTPUT_HTTP_ERROR', message: '工具查询返回了失败的 HTTP 响应', status: output.status });
  }
  const businessOutput = capturedBusinessOutput(output, contract, fetchEnvelope);
  if (contract.kind === 'captured_sample' && contract.capturedShape) {
    const runtimeShape = describeGenerationOutputShape(businessOutput);
    const capturedShape = contract.capturedShape;
    const compatible = runtimeShape.rootKind === capturedShape.rootKind
      || (capturedShape.containsKinds || []).includes(runtimeShape.rootKind)
      || (runtimeShape.containsKinds || []).includes(capturedShape.rootKind);
    if (!compatible) {
      errors.push({
        code: 'OUTPUT_SHAPE_MISMATCH',
        message: `返回类型与捕获样本不兼容：捕获为 ${capturedShape.rootKind}，调用结果为 ${runtimeShape.rootKind}`,
        capturedShape,
        runtimeShape,
      });
    }
  }
  const fixtureDiagnostics = contract.fixtureDiagnostics;
  if (fixtureDiagnostics && typeof fixtureDiagnostics === 'object') {
    const droppedPaths = [...new Set(Object.values(fixtureDiagnostics)
      .flatMap((paths) => Array.isArray(paths) ? paths : [])
      .map(String)
      .filter(Boolean))];
    if (droppedPaths.length > 0) {
      warnings.push({
        code: 'INCONSISTENT_CAPTURED_FIXTURE_IGNORED',
        message: `已忽略 ${droppedPaths.length} 条无法由捕获样本证明的历史断言`,
        paths: droppedPaths,
      });
    }
  }
  errors.push(...validateFixture(businessOutput, contract.verificationFixture));
  return {
    passed: errors.length === 0,
    errors,
    warnings,
    outputKind: valueKind(output),
    outputShape,
    outputPreview: JSON.stringify(outputShape),
  };
}

export function selectCompatibleCaptureBoundEntry(entries = [], contract = {}) {
  const candidates = Array.isArray(entries) ? entries.filter(Boolean) : [];
  for (let index = candidates.length - 1; index >= 0; index--) {
    const entry = candidates[index];
    let output;
    try {
      output = typeof entry?.responsePreview === 'string'
        ? JSON.parse(entry.responsePreview)
        : entry?.responsePreview;
    } catch {
      continue;
    }
    if (output !== undefined && validateGenerationPreviewOutputV2(output, contract).passed) {
      return entry;
    }
  }
  return candidates[candidates.length - 1] || null;
}
