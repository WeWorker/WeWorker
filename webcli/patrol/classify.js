/**
 * 巡检的两级判定：
 *   1) classifyConnectivity —— 这条命令"跑通了吗"
 *   2) evaluateTool        —— 跑通之后"结果还对吗"（结构 → 内容）
 *
 * 判定策略：上一层不通过就不往下判（与自检工具"超时直接返回"一致）。
 * 判定必须是确定性代码——不可交给 LLM。
 *
 * 本层把一切连通失败（含 login_required）判为 failed；编排层（patrol/index.js 的
 * mapLoginUncovered）随后**只**把 login_required 重定性为 uncovered——登录态失效
 * 是"整站转未覆盖，不算失败"（spec 验收 5）。permission_denied / timeout / error
 * 维持 failed。
 */

const LOGIN_PATTERNS = [/未登录/, /登录态失效/, /请先登录/, /需要登录/, /认证失败/, /login required/i, /authentication required/i, /not logged in/i]
const PERMISSION_PATTERNS = [/无权限/, /权限不足/, /permission denied/i, /no permission/i]
const TIMEOUT_PATTERNS = [/超时/, /timeout/i, /timed out/i]

/** 连通层：退出码 + 特征词。 */
export function classifyConnectivity({ exitCode, stdout = '', stderr = '', timedOut = false }) {
  if (timedOut) return { ok: false, reason: 'timeout' }
  if (exitCode === 0) return { ok: true }

  const text = `${stdout}\n${stderr}`
  if (LOGIN_PATTERNS.some((re) => re.test(text))) return { ok: false, reason: 'login_required' }
  if (PERMISSION_PATTERNS.some((re) => re.test(text))) return { ok: false, reason: 'permission_denied' }
  if (TIMEOUT_PATTERNS.some((re) => re.test(text))) return { ok: false, reason: 'timeout' }
  return { ok: false, reason: 'error' }
}

/**
 * 工具级判定。
 * @param {{ connectivity: {ok: boolean, reason?: string},
 *           shapeDiff: object | null,     // null = 无基线，只判连通
 *           emptiedPaths: string[] }} input
 * @returns {{ verdict: 'pass'|'failed', kind: string|null, details: object }}
 */
export function evaluateTool({ connectivity, shapeDiff, emptiedPaths = [] }) {
  if (!connectivity.ok) {
    return { verdict: 'failed', kind: connectivity.reason, details: { reason: connectivity.reason } }
  }

  if (shapeDiff === null) {
    return { verdict: 'pass', kind: null, details: { needsBaseline: true } }
  }

  if (shapeDiff.degraded) {
    return {
      verdict: 'failed',
      kind: 'site_changed',
      details: {
        missing: shapeDiff.missing,
        typeChanged: shapeDiff.typeChanged,
        added: shapeDiff.added,
      },
    }
  }

  if (emptiedPaths.length > 0) {
    return { verdict: 'failed', kind: 'content_degraded', details: { emptied: emptiedPaths } }
  }

  return { verdict: 'pass', kind: null, details: { added: shapeDiff.added } }
}
