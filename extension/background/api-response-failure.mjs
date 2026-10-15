const HTML_DOCUMENT_RE = /^(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i;
const AUTH_FAILURE_RE = /^(?:(?:error|错误)\s*[:：]\s*)?(?:please\s+(?:log\s*in|sign\s*in)\b|(?:log\s*in|sign\s*in|authentication|authorization)\s+(?:is\s+)?required\b|not\s+logged\s+in\b|unauthorized\b|unauthenticated\b|access\s+denied\b|forbidden\b|captcha(?:\s+(?:is\s+)?required)?(?:$|[\s.!,:;])|session\s+(?:has\s+)?expired\b|login$|请(?:先|重新)?登录|未登录|尚未登录|需要登录|登录(?:已)?(?:过期|失效)|会话(?:已)?(?:过期|失效)|请(?:先|完成|输入|进行).{0,12}(?:验证码|验证)|访问被拒绝|无权访问)/i;

/** Inspect response/error envelopes, never titles or other records inside data lists. */
export function isApiResponseFailure(value, depth = 0) {
  if (depth > 4 || value == null) return false;
  if (typeof value === 'string') {
    const text = value.replace(/^\uFEFF/, '').trim();
    if (HTML_DOCUMENT_RE.test(text)) return true;
    if (/^[{["]/.test(text)) {
      try { return isApiResponseFailure(JSON.parse(text), depth + 1); } catch {}
    }
    return AUTH_FAILURE_RE.test(text);
  }
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.ok === 'boolean' && Number.isInteger(value.status)
    && typeof value.url === 'string' && typeof value.rawText === 'string'
    && Object.prototype.hasOwnProperty.call(value, 'data')) {
    return isApiResponseFailure(value.data, depth + 1) || isApiResponseFailure(value.rawText, depth + 1);
  }
  for (const key of ['code', 'status', 'statusCode']) {
    if (value[key] === 401 || value[key] === 403 || value[key] === '401' || value[key] === '403') return true;
  }
  for (const key of ['message', 'msg', 'error', 'error_description', 'detail', 'reason']) {
    const field = value[key];
    if (typeof field === 'string' && isApiResponseFailure(field, depth + 1)) return true;
    if (key === 'error' && field && typeof field === 'object' && isApiResponseFailure(field, depth + 1)) return true;
  }
  return false;
}
