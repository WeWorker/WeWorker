/**
 * `ensureLogin(adapterId)` —— 巡检与账号体系之间唯一的接口。
 *
 * 巡检**不关心**账号从哪来、怎么登；它只问"这站现在能不能用"：
 *   { ok: true,  source: 'session' | 'account', account? }
 *   { ok: false, reason: 'no-account' | 'login-failed' | 'login-blocked' }
 *
 * 本子项目只提供这个接口与**默认降级实现**（没有账号库时如实说 no-account）；
 * 账号库与自动登录由子项目 2 实现并注入。
 */
export function createEnsureLogin({ probeSession, tryAccounts }) {
  return async function ensureLogin(adapterId) {
    try {
      const sessionOk = await probeSession(adapterId)
      if (sessionOk) return { ok: true, source: 'session' }
    } catch {
      // 探测自身坏了（如 bridge 断连）：登录态真假未知，如实降级 login-failed，
      // 不落到账号路径、不炸整轮巡检。
      return { ok: false, reason: 'login-failed' }
    }

    try {
      const result = await tryAccounts(adapterId)
      if (!result) return { ok: false, reason: 'login-failed' }
      if (result.account) return { ok: true, source: 'account', account: result.account }
      return { ok: false, reason: result.reason ?? 'login-failed' }
    } catch {
      return { ok: false, reason: 'login-failed' }
    }
  }
}

/**
 * 默认实现：只能判断"当前进程里有没有可用登录态"，不涉及账号库。
 *
 * **probeStatus 参数语义**（spec 要求「查 session-store + 探一次 `check_login_status`」）：
 * - `probeStatus(adapterId, sessionStore)` 由**调用方注入**：当 adapterId 对应适配器包里
 *   存在 `check_login_status` 类工具时，调用方应基于 sessionStore **真实探一次**并返回
 *   布尔结果；子项目 2 落地前由编排层负责构造这个探针。
 * - **未注入 probeStatus 时**回退为"假定登录态可用"——登录问题由连通层兜底归为
 *   `login_required` → 未覆盖，不会误报为结构/内容退化。真实探测是后续子项目的注入点，
 *   本期不在内核里硬编码探测方式。
 */
export function createDefaultEnsureLogin({ sessionStore, probeStatus } = {}) {
  return createEnsureLogin({
    probeSession: probeStatus
      ? async (adapterId) => Boolean(await probeStatus(adapterId, sessionStore))
      : async () => true,
    tryAccounts: async () => ({ reason: 'no-account' }),
  })
}
