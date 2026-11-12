// Preserve the pre-existing route fallback heuristics while retiring the
// independent profile dispatcher. These are advisory: guarded dispatch still
// rejects structured errors before any direct answer is emitted.
const AUTH_FAILURE_RE = /登录超时|重新登录|登录态无效|未登录|统一认证|\/cas\/login|passport|logged_in["'\s:]+false/i
const RETCODE_3001_RE = /["']?retCode["']?\s*:\s*3001\b/
const AUTH_CODE_RE = /["'](AUTH_ERROR|UNAUTHORIZED|NOT_LOGGED_IN)["']/i
const MISSING_ARG_RE =
  /(is\s+required|为必填参数|missing\s+(?:required\s+)?(?:param|arg|parameter|argument)|MISSING_ARG)/i

export function looksLikeAuthFailure(raw: string): boolean {
  if (!raw) return false
  return AUTH_FAILURE_RE.test(raw) || RETCODE_3001_RE.test(raw) || AUTH_CODE_RE.test(raw)
}

export function looksLikeMissingArg(raw: string): boolean {
  if (!raw) return false
  return MISSING_ARG_RE.test(raw)
}
