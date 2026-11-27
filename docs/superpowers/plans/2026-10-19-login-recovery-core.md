# 浏览器登录过期恢复 Implementation Plan（公开通用层）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **本轮用户明确要求不提交：此计划中的所有工作均保持本地未提交、未推送状态。**

**Goal:** 在 WeWorker 桌面端安全地恢复显式批准的 Gitee 登录会话；不得使密码进入普通 WebCLI 工具调用、Bridge 广播、trace、日志或模型上下文。

**Architecture:** 将可单测的登录域验证与只读重试判定从传输实现分离；使用桌面后端现有 keyring 加密保管凭据、用户确认扩展公钥指纹后的单次任务加密、专用定向 Bridge 消息、扩展内置登录执行器。通用机制在公开仓库，内部登录域另行配置与验证；扩展未配对或缺少安全前提时 fail closed。

**Tech Stack:** Node.js ESM、Vitest、TypeScript 后端、Electron/React 设置页、Chrome MV3 WebCrypto、WebSocket Bridge。

**Design:** `docs/superpowers/specs/2026-10-19-login-recovery-core-design.md`。

---

## 文件职责与执行顺序

1. `webcli/login-recovery/policy.js`：纯函数判断业务域到登录域的精确可信映射、HTTPS、同站回跳、只读原调用重试资格；`webcli/__tests__/login-recovery-policy.test.js` 测拒绝外域/写调用/重复尝试。此步骤不得读取密码。
2. `weworker/backend-ts/src/login-recovery/credential-store.ts`：复用 `secret-store.ts`、按登录域在用户数据目录存加密凭据、始终返回脱敏元数据；对应测试检查磁盘/返回/异常信息无密码，密钥库不可用即拒绝。
3. `weworker/backend-ts/src/login-recovery/pairing.ts`、扩展侧 `extension/background/login-pairing.js`：扩展生成**不可导出私钥**，用户在扩展 UI 查指纹并在桌面 UI 明确确认；后端持久化信任的扩展公钥指纹；旧实例、重装、拒绝或更换必须重新配对。单测伪造 `extension_hello`、错误指纹/过期配对码与重放均不得建立信任。
4. `weworker/backend-ts/src/login-recovery/envelope.ts`、`extension/background/login-envelope.js`：经标准 WebCrypto 验证的公钥封装一次性对称密钥与 AES-GCM 任务；加密关联数据绑定配对指纹、tab ID、登录域、业务域、请求 ID 和过期时间；重放缓存按请求 ID 拒绝重复。仅返回结构化非敏感状态码。
5. `webcli/bridge.js`、`extension/background/service-worker.js`：添加专用新消息类型，**仅从经过后端认证的桌面端入口接收**并只向配对的扩展连接定向转发密文；现有 `_broadcast`、`_send` 与普通 `call_tool` 不能承载此任务。浏览器扩展接收消息前校验加密任务、当前 tab URL 和目标登录域。登录通道不可作为旧 `browser_eval` 的包装器。
6. `extension/background/login-executor.js`、`webcli/login-recovery/gitee.js`：按 Gitee 配置核对允许的 HTTPS 登录路径、可信回跳参数、唯一可见表单和人工挑战；在扩展内置执行路径填写提交一次；登录成功后调用 Gitee `whoami` 核验，未验证不报告成功。实际选择器依据实施时经批准的当前页面调查，不能写猜测选择器。
7. `weworker/backend-ts/src/login-recovery/coordinator.ts` + 现有 `webcli-runner.ts` 接点：登录前预检；失败后仅当可证实原调用是**未执行的只读**并且还未重试过时补试一次；对 SSH 等任意写工具与执行结果不明场景返回 `recovered_manual_retry_required`，不自动重放。
8. `weworker/backend-ts/src/server.ts` 和 Renderer 设置页：专用加密凭据录入/更新/删除、启停和配对操作；只在有 `WEWORKER_HTTP_TOKEN` 且密钥库初始化成功时开放，响应只含站点/已配置/状态，不返回用户名或密码。
9. 端到端安全验收：本地 mock Gitee 过期/正确恢复/外域回跳/MFA/密码拒绝/恶意 Bridge 客户端、不同 tab、密文重放及过期；用明文哨兵串扫描所有日志与普通结果；相关测试、类型检查、安全扫描。真实 Gitee 仅用自愿测试账号人工验证。**没有经验证的配对与传输不允许上线自动登录**。

## TDD：第一批纯策略测试及最小实现

**Create:** `webcli/__tests__/login-recovery-policy.test.js`, `webcli/login-recovery/policy.js`。

- [ ] 写失败用例：

```js
import { describe, expect, it } from 'vitest'
import { inspectLoginRedirect, mayRetryOriginal } from '../login-recovery/policy.js'

const policy = {
  site: 'gitee.com',
  loginOrigins: ['https://gitee.com'],
  loginPaths: ['/login'],
  returnOrigins: ['https://gitee.com'],
}

describe('explicit login-domain policy', () => {
  it('recognizes an exact approved login and site-local return', () => {
    expect(inspectLoginRedirect(policy, 'https://gitee.com/login?redirect_to_url=%2F'))
      .toEqual({ ok: true, loginOrigin: 'https://gitee.com', returnOrigin: 'https://gitee.com' })
  })
  it('rejects HTTP, look-alike domains, arbitrary redirects and unexpected path', () => {
    for (const url of [
      'http://gitee.com/login',
      'https://gitee.com.evil.example/login',
      'https://gitee.com/login?redirect_to_url=https%3A%2F%2Fevil.example%2F',
      'https://gitee.com/logout',
    ]) expect(inspectLoginRedirect(policy, url).ok).toBe(false)
  })
  it('permits only proven not-executed reads once', () => {
    expect(mayRetryOriginal({ safety: 'read', executed: false, retryCount: 0 })).toBe(true)
    expect(mayRetryOriginal({ safety: 'write', executed: false, retryCount: 0 })).toBe(false)
    expect(mayRetryOriginal({ safety: 'read', executed: undefined, retryCount: 0 })).toBe(false)
    expect(mayRetryOriginal({ safety: 'read', executed: false, retryCount: 1 })).toBe(false)
  })
})
```

- [ ] `cd webcli && npx vitest run __tests__/login-recovery-policy.test.js`，期望缺模块报 FAIL。
- [ ] 增加最小实现：

```js
export function inspectLoginRedirect(policy, raw) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || !policy.loginOrigins.includes(url.origin)
        || !policy.loginPaths.includes(url.pathname)) return { ok: false, reason: 'login_domain_untrusted' }
    const next = new URL(url.searchParams.get('redirect_to_url') || '/', url.origin)
    if (next.protocol !== 'https:' || !policy.returnOrigins.includes(next.origin)
        || next.username || next.password) return { ok: false, reason: 'login_domain_untrusted' }
    return { ok: true, loginOrigin: url.origin, returnOrigin: next.origin }
  } catch { return { ok: false, reason: 'login_domain_untrusted' } }
}

export function mayRetryOriginal({ safety, executed, retryCount }) {
  return safety === 'read' && executed === false && retryCount === 0
}
```

- [ ] 重跑单测，期望 3 passed；覆盖登录页额外查询参数/重复 return 参数/编码回跳的用例。后续单元按同样红→绿步骤进行；任何未验证真实场景单独列出，不跳过安全门禁。

## 必需的最终验收

- 密钥库或 HTTP token 不可用时无录入与自动登录；模型/CLI/Bridge 广播/日志没有测试密码哨兵串；旧式 `call_tool` 不能承载凭据。
- 扩展配对 UI 完成、跨窗口通信身份绑定、失效/重放测试全绿，且浏览器 URL 在**取值时和填值前**双重核验。
- Gitee mock 闭环和只读单次重试通过；所有写命令回报需人工确认；验证码/MFA 只提示人工处理。
- `git status --short` 列出**未提交**的预期文件；禁止 `git add`、`git commit`、`git push` 和 PR。
