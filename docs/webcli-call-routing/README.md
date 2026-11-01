# WebCLI 调用路由与 Tab 选择

> 本文记录 `webcli call` 从浏览器 Profile 到具体 Tab 的选择规则，以及 Adapter-aware `open_browser` 的登录 Tab 亲和性。示例域名均为脱敏占位符。

## 1. 两级路由模型

WebCLI 调用不是直接“选择最近的网页”，而是依次完成两级路由：

```text
CLI 调用
  → 选择 Browser Profile / Extension connection
  → 在该 Profile 内按命令类型选择执行环境或 Tab
```

Profile 选择错误和 Tab 选择错误是两类独立问题。Bridge 使用 `AsyncLocalStorage` 保存本次调用的 `{ contextId, connection, client }`；后续扩展请求、登录 flow 和安全重试均固定在同一 Profile，不会因为另一浏览器上线而自动切换。

## 2. Browser Profile 选择

CLI 将 `--profile`（或 `WEBCLI_PROFILE`）放入 `call_tool.browserProfile`。`webcli/browser-profiles.js` 的选择顺序为：

1. 本次调用显式 `--profile`；
2. CLI 从 `WEBCLI_PROFILE` 得到的显式值；
3. 保存的默认 Profile；
4. 唯一在线的 WeWorker dedicated browser；
5. 唯一在线的其他 Extension connection。

若显式或默认 Profile 离线，调用失败，不回退到其他浏览器；多个在线连接无法唯一确定时也会失败。Bridge 在路由建立后通过 `_requestNow()` 只向该 connection 发送消息。

## 3. 命令类型与 Tab 行为

| 命令类型 | 是否选择业务 Tab | 主要规则 |
| --- | --- | --- |
| `open_browser` | 新建 Tab | Extension 执行 `open_tab` / `createBrowserTab()`；不复用旧业务 Tab。 |
| Managed background | 否 | 在 Extension offscreen runtime 执行；只有命令显式调用 helper 时才读取 Cookie 或页面上下文。 |
| Managed foreground + `pageRoute` | 是 | 按精确 origin/path 匹配；多匹配时只接受唯一 active，否则报歧义。 |
| Managed foreground（普通） | 是 | 按 `tabDomain` / `routeDomain` / Adapter 主 host 选择，再按 active、lastAccessed、tabId 排序。 |
| Legacy/content-registered | 是 | 仅从工具注册表关联的 Tab 中选择，优先当前窗口 active，再按最近使用排序。 |
| `browser.*` 命名 session | 显式绑定 | 使用 session 保存的 Tab identity，不经过普通 Adapter 路由。 |

## 4. Managed foreground 路由

### 4.1 路由主机

普通 managed Extension 命令依次使用：

```text
command.tabDomain
  → command.routeDomain
  → Adapter primary host
```

Extension 的 `pickRouteTab()` 先选择精确 route host；受信重定向 alias 只在对应优先级下参与。候选 Tab 的排序为：

```text
active=true
  → lastAccessed 较新
  → tabId 较大
```

这里的 `active` 是“该 Tab 在其窗口中处于活动状态”。不同 Chrome 窗口可以同时各有一个 active Tab，因此它不等同于“用户当前正在看的唯一页面”。

命令没有显式 route 且未找到 route host 时，`pickRecentScopeTab()` 会将候选扩大到 Adapter 的整个业务页面范围，但不会把只用于认证的 `login_hosts` 当作业务命令页面。

### 4.2 `pageRoute`

声明 `pageRoute` 的命令采用更严格的来源选择：

- origin 和 pathname 精确匹配；
- 只有一个匹配时直接使用；
- 多个匹配时只有唯一 active 匹配才能使用；
- 仍无法确定时返回 `PAGE_SOURCE_AMBIGUOUS`；
- 缺少页面时返回 `PAGE_SOURCE_ROUTE_MISSING`，不会随意选择其他页面。

### 4.3 没有业务 Tab

普通 managed foreground 命令找不到业务 Tab 时：

1. 如果已存在该 Adapter 声明范围内的登录/SSO Tab，返回结构化 `AUTH_REQUIRED`，交给 Bridge 登录 flow；
2. 否则创建 Adapter 路由入口页并等待页面稳定；
3. 页面落到登录地址时同样返回 `AUTH_REQUIRED`；
4. 页面落到未声明 host 时拒绝继续。

## 5. Managed background 路由

声明以下执行方式的命令不选择普通业务 Tab：

```json
{
  "execution": {
    "type": "api",
    "runtime": "background"
  }
}
```

它在 Extension-owned offscreen runtime 中运行。Cookie、storage、main-world 或 browser fetch 均须由命令显式调用受 manifest host scope 限制的 helper。将 DOM 登录检查简单改为 background 命令通常不安全，因为 Cookie 存在不一定代表具体业务页面可用。

## 6. Legacy Tab 路由

Legacy/content-registered 命令使用 `findTabByDomain()`：

1. 只考虑 `toolRegistry` 中为该 domain 注册过工具的 Tab；
2. 当前窗口 active Tab 优先；
3. 其余 Tab 按 `lastAccessed`、tabId 降序；
4. 再验证实际 hostname、host alias、`tabDomain` 和 `excludeTabDomain`；
5. 选中后激活该 Tab，系统浏览器模式下可聚焦窗口。

Managed v2 命令不依赖这份注册表，因此修改 `findTabByDomain()` 不会改变 managed 命令的选择。

## 7. Adapter-aware `open_browser`

### 7.1 显式 Adapter 绑定

```text
webcli call open_browser --url=<Homepage> --adapter=<adapter-id>
```

Bridge 先验证 Adapter 存在，再只使用该 manifest 的 `homepage_url`、`match` 和 `domains` 校验 URL。额外的全局允许 origin 不能让 URL 与错误 Adapter 绑定。

不传 `--adapter` 时保持纯开页行为，不推断 Adapter，也不进入登录 flow。

### 7.2 旧误判原因

最初的实现顺序是：

```text
open_browser 创建新 Tab
  → 只保留 opened.tabId 在开页结果中
  → SiteLoginCoordinator.login(adapter)
  → auth.check.command 作为普通 managed 命令重新选择 Tab
```

如果新 Tab 已跳转到 SSO，而同一 Profile 仍有旧业务 Tab：

- 新 SSO Tab 不属于业务 route 候选；
- 旧业务 Tab 仍属于 Adapter 页面范围；
- `check.command` 在旧 Tab 执行并可能返回 `logged_in: true`；
- `open_browser` 因而错误返回 `already_logged_in`。

Adapter 的检查逻辑对旧 Tab 可能是正确的，错误在于宿主检查了与本次导航无关的 Tab。

## 8. P0/P1：新建 Tab 的登录观察与绑定

### 8.1 `auth_observe_open`

Adapter-aware `open_browser` 创建 Tab 后，Bridge 向同一 Profile 的 Extension 发送：

```json
{
  "type": "auth_observe_open",
  "site": "app.example.com",
  "tabId": 123
}
```

Extension 只观察这个 tabId，最长 5 秒，并同时检查 `pendingUrl` 与 `url`。结果状态为：

| 状态 | 含义 |
| --- | --- |
| `login` | 该 Tab 正在或已经进入此 Adapter 的 `login_url/login_hosts`；Extension 将其绑定到 `siteLoginTabs`。 |
| `business` | 页面稳定在此 Adapter 的业务页面范围。 |
| `unknown` | 页面落到无法归属的地址或观察超时；Bridge 不宣称已登录。 |
| `closed` | 新建 Tab 已关闭。 |

最终 URL 仅用于验证当前 Adapter，不用于反向推断 Adapter。返回给 Bridge 的 URL会移除 query/fragment，避免 SSO return token 外泄。

### 8.2 登录 flow 固定 Tab

当观察结果为 `login` 时，Bridge 调用：

```text
SiteLoginCoordinator.login(adapter, {
  waitMs: 0,
  skipCheck: true,
  targetTabId: opened.tabId,
  pageUrl: observedLoginUrl
})
```

含义：

- 当前新 Tab 已经证明需要登录，跳过可能选中旧业务 Tab 的全局 `check.command`；
- `targetTabId` 被传给 `auth_open_login`；
- Extension 验证该 Tab 仍是此 Adapter 的登录页，然后固定写入 `siteLoginTabs`；
- 后续 `auth_check`、二维码准备和“显示浏览器”围绕该登录 Tab 运行；
- 目标 Tab 关闭或改变归属时不静默回退旧业务 Tab。

`openSiteLoginTab()` 在没有显式 target 时也会优先复用 `siteLoginTabs` 中已绑定且仍合法的 Tab，再进行全局登录页扫描。

### 8.3 Bridge 返回语义

- `login`：立即返回 `waiting_user`，flow 在后台继续；不重试 `open_browser`；
- `business`：沿用 Adapter 的正常登录检查；
- `unknown`：返回 `unverified`，不使用旧 Tab 结果伪造 `already_logged_in`；
- `closed`：返回 `tab_closed`；
- Adapter 未声明 `auth`：返回 `not_configured`。

## 9. 共享 SSO

登录 flow 身份始终是：

```text
(browser contextId, adapterId)
```

多个 Adapter 可以声明并复用同一个物理 SSO 页面，但：

- `opened.tabId` 只绑定本次显式 Adapter；
- 最终 SSO URL不能决定业务归属；
- 每个 Adapter 仍须独立运行自己的 `auth.check`；
- 一个站点登录成功不能直接批量标记其他站点成功。

## 10. 后续 P2：通用命令级 Tab 亲和性

P0/P1 解决 adapter-aware 开页后的登录误判，但普通 managed foreground 命令仍按 Profile 范围重新选 Tab。若产品需要表达“在我刚打开的这个业务 Tab 执行下一条命令”，应新增宿主信封级 `preferredTabId` 或显式 session：

- 不放入 Adapter 业务参数；
- Extension 使用前验证 tab identity、URL、`pageRoute/tabDomain/routeDomain`；
- 不满足约束时明确失败，不能静默切换旧 Tab；
- 跨 CLI 进程若需要持久亲和性，应复用 `browser.bind` 一类带 identity 的 session，而不是全局记住最后 Tab。

不要用“最大 tabId”或“最近访问 Tab”替代亲和性：登录重定向后的新 Tab 可能已不属于业务 route，修改排序既无法修复该问题，也会影响所有 Adapter。

## 11. 关键文件

| 文件 | 职责 |
| --- | --- |
| `webcli/browser-profiles.js` | Browser Profile 选择、连接固定和离线拒绝。 |
| `webcli/bridge.js` | 调用路由、adapter-aware open、登录协调器及 Profile 上下文。 |
| `webcli/site-login.js` | 登录 flow、targetTabId 传递、检查、二维码和状态事件。 |
| `extension/background/service-worker.js` | Managed/legacy 路由、Tab 选择、`auth_observe_open` 和 `siteLoginTabs`。 |
| `extension/background/host-scope.js` | 业务 host 范围、route Tab 候选与优先级。 |
| `extension/background/site-auth.js` | 登录 URL、login host、SSO 页面识别和安全展示 URL。 |

## 12. 验证范围

P0/P1 的聚焦验证包括：

- 新 Tab 的 `pendingUrl` 命中声明 SSO 时返回 `login`；
- 观察结果绑定同一个 tabId，`auth_open_login` 不创建额外登录 Tab；
- 无效 targetTabId 被拒绝；
- Bridge 在 `login` 状态跳过全局检查并把 targetTabId 传给 Coordinator；
- 普通无 Adapter 的 `open_browser` 保持纯开页；
- 既有 managed route、pageRoute、background 和 legacy 路由测试保持通过。
