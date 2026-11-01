# WeWorker 网站登录处理逻辑分析

> **性质：** 基于代码的静态分析；未启动应用、未调用真实站点或执行端到端登录测试。
>
> **分析范围：** WeWorker 桌面端、WebCLI Bridge、Chrome 扩展、Adapter 登录元数据及登录凭据存储。

## 结论摘要

WeWorker 的网站登录不由 AI Agent、Renderer 或单个 Adapter 自行编排，而是统一收口到 **WebCLI Bridge** 的 `SiteLoginCoordinator`。业务工具调用发生认证失败后，Bridge 会打开或复用站点登录页、等待用户在真实页面完成扫码/短信/密码等流程、验证登录状态，并按安全策略恢复原调用。

```text
业务工具调用
  → Bridge 转发给浏览器扩展
  → Adapter / 扩展返回 AUTH_REQUIRED
  → SiteLoginCoordinator 打开或复用登录页
  → 用户在真实网站完成登录
  → Bridge 验证登录态
  → 读操作自动重试一次；写操作通常要求重新确认
```

核心实现：

- `webcli/site-login.js`：登录状态机 `SiteLoginCoordinator`
- `webcli/bridge.js`：业务调用包装、认证事件发布、Profile 隔离及凭据控制
- `extension/background/site-auth.js`：登录地址、SSO 域和 Cookie 检查规则
- `extension/background/service-worker.js`：登录 Tab 管理及扩展侧认证请求
- `weworker/electron/main.js`：桌面端 IPC 和系统通知

## 1. 架构与职责

| 层级 | 职责 |
| --- | --- |
| Adapter manifest | 声明登录页、SSO 域、Cookie/命令验证方式、命令读写属性。 |
| 浏览器扩展 | 执行 Cookie 检查，识别登录页面，创建/复用登录 Tab，回传 `AUTH_REQUIRED`。 |
| WebCLI Bridge | 统一维护登录 flow、等待与轮询、决定重试策略、向桌面/CLI 发布登录事件。 |
| Electron 主进程 | 通过受限 IPC 请求登录控制；向 Renderer 转发认证事件；窗口失焦时显示通知。 |
| Renderer | 显示登录状态，提供“显示浏览器”“取消”“管理自动登录”等交互。 |
| AI Agent / Backend | 使用 Adapter 的元数据辅助工具选择；不持有网站账号密码，也不是登录状态机的执行主体。 |

普通业务调用通过 `webcli/bridge.js` 的 `callTool()` 和 `_callToolWithLogin()` 执行。对于 `runtime: "extension"` 的 Adapter 命令，Bridge 会在调用失败后交给 `SiteLoginCoordinator.handleFailure()` 处理。HTTP 或 Webwright 工具不经过这层扩展登录恢复包装。

## 2. Adapter 登录声明

Adapter 可在 `manifest.json` 中通过 `auth` 描述认证能力：

```json
{
  "auth": {
    "login_url": "https://passport.example.com/login",
    "login_hosts": ["passport.example.com"],
    "check": {
      "cookies": {
        "url": "https://www.example.com/",
        "all": ["session"]
      },
      "command": "whoami"
    }
  }
}
```

关键字段：

- `auth.login_url`：没有现成登录页时，应打开的登录地址。
- `auth.login_hosts`：允许的独立 SSO / 认证域名。
- `auth.check.cookies`：通过浏览器 Cookie 判断会话状态。
- `auth.check.command`：由 Adapter 提供的只读登录态验证命令，例如 `whoami`。
- `requires_auth`：不应与“是否声明登录能力”混同。站点可以允许匿名读取，但仍声明 `auth`，以便在访问需登录功能时进行恢复。

Cookie 检查支持：

- `all`：所有指定 Cookie 都存在；
- `any`：任一指定 Cookie 存在；
- `equals`：Cookie 的值精确匹配；
- `not`：Cookie 的值不得匹配。

实现见 `extension/background/site-auth.js` 的 `evaluateCookieCheck()`。

## 3. 未登录检测

### 3.1 显式认证失败

首选路径是 Adapter 或扩展显式抛出 `AUTH_REQUIRED`：

- 页面已经跳转到登录页；
- Adapter 调用的接口返回 HTTP 401；
- Adapter 能直接判断当前会话无效。

扩展把错误转换为结构化的 `auth` 数据，包含站点、失败阶段和可选页面 URL：

```json
{
  "code": "AUTH_REQUIRED",
  "auth": {
    "site": "example.com",
    "phase": "handler",
    "pageUrl": "https://passport.example.com/login"
  }
}
```

`phase` 只有 `navigation` 和 `handler` 两种关键值，后续用于判断写操作是否可以安全重试。

### 3.2 失败后的兜底检查

`SiteLoginCoordinator._failureIsLogin()` 在满足下列条件时，会把扩展层失败再用 `auth.check` 验证一次：

- 错误来自扩展或页面执行，而非本地参数校验；
- manifest 声明了 `auth.check`；
- 错误不是确认缺失、参数错误或命令不可用；
- 当前命令不是登录检查命令本身；
- 登录检查确认为 `logged_in === false`。

这避免了将 `INVALID_ARGS`、`CONFIRMATION_REQUIRED` 等错误误判为登录失效。

## 4. 登录页选择、Tab 复用与安全范围

登录页 URL 的优先级如下：

1. 工具认证错误中传入的 `pageUrl`；
2. `manifest.auth.login_url`；
3. 合法的 `homepage_url`；
4. Adapter 主域名首页。

扩展的 `openSiteLoginTab()` 会优先复用已存在的登录/SSO Tab；若没有，才创建新的 Tab。主动打开的 URL 必须在 manifest 声明的域名范围内。对于未声明的 SSO 域，扩展只会复用网站自身已跳转过去的现有 Tab，不会根据外部请求直接打开。

这样可避免 Adapter 或调用方借登录流程诱导打开任意 URL。

相关实现：

- `extension/background/site-auth.js`：`isLoginPageUrl()`、`loginStartUrl()`
- `extension/background/service-worker.js`：`findSiteLoginTab()`、`openSiteLoginTab()`、`checkSiteLogin()`

## 5. 登录状态机与用户交互

`SiteLoginCoordinator` 以 **站点 + 浏览器 Profile** 维度管理 flow。同一 Profile 内，同一个站点同时只维护一个登录 flow；并发的同站业务调用会复用该 flow。

状态大致为：

```text
login_required
  → 自动登录尝试（可选）
  → waiting_user
  → logged_in / cancelled / timeout / failed
```

流程如下：

1. Bridge 发送 `login_required` 认证事件；
2. 请求扩展打开或复用登录页；
3. 对非手动流程预留短暂 grace period，允许仍然有效的会话自行跳转；
4. 若用户已启用自动登录，在专用浏览器中尝试 CDP 表单填充；
5. 不能自动完成时，在后台准备登录页和二维码并通知用户；只有用户点击“显示浏览器”时才将对应登录 Tab 切到前台；
6. 每 1.5 秒检查 Cookie、登录页状态和可选命令验证；
7. 登录成功、取消、失败或超时后发送 `auth_event`。

默认参数：

| 项目 | 值 |
| --- | --- |
| 单次业务调用等待登录 | 75 秒 |
| 允许的最大调用等待 | 15 分钟 |
| 登录 flow 总超时 | 10 分钟 |
| 状态轮询周期 | 1.5 秒 |
| 专用浏览器截图刷新周期 | 15 秒 |

如果调用方先达到等待上限，登录 flow 不会立即终止，而是继续后台等待并发布事件；该次业务调用则返回 `AUTH_REQUIRED`，用户完成登录后通常需要重新执行。

## 5.1 二维码登录：通用发现与 Adapter 定制结合

二维码能力遵循与 `auth.login_url`、`auth.check.command` 相同的设计原则：**宿主提供默认能力，Adapter 只在需要时补充精确实现**。二维码只用于把登录入口展示给用户，不参与登录成功判断；登录是否完成仍由 `auth.check` 或业务命令重试确认。

目标流程：

```text
进入已验证的登录页
  → Adapter 是否声明 qr.command？
      → 是：在当前登录 Tab 执行精确获取命令
      → 精确命令未找到/失败：继续通用发现
  → 否：直接通用发现
  → 找到二维码：提取或裁剪二维码并展示
  → 未找到二维码：不展示整页截图，提示用户打开浏览器手动登录
```

### `auth.qr.mode` 的语义

`mode` 只表达“是否允许宿主尝试二维码发现”，不暴露 heuristic 等内部算法名称：

| 配置 | 行为 |
| --- | --- |
| 未声明 `auth.qr` | 默认 `auto`；宿主尝试一次通用二维码发现。普通 Adapter 无需增加配置。 |
| `"qr": { "mode": "auto" }` | 显式启用，等价于默认行为。适合希望在 manifest 中明确表达能力的 Adapter。 |
| `"qr": { "mode": "off" }` | 完全跳过二维码准备、查找和提取，直接提示用户打开浏览器完成账号密码、短信或其他登录。 |

`off` 适用于明确不支持二维码、页面上的二维码与登录无关、或自动点击登录方式不合适的网站。它既降低无意义的页面扫描，也为误识别提供明确退出机制。

当前已经实现 `auto/off`：`auto` 是默认值；不再要求 PACE 等共用 Passport 登录页的 Adapter 重复声明二维码配置。

### 通用二维码发现

宿主只在由 `login_url/login_hosts` 验证过的当前登录 Tab 中执行以下受限逻辑：

1. 查找已经可见的 `img`、`canvas`、SVG 或典型二维码容器；
2. 若二维码尚未显示，查找唯一、高置信度的扫码登录方式切换控件；
3. 控件特征可来自可见文本、`aria-label`、`title`、`id`、`class` 和通用 `data-*` 标记；
4. 仅点击明确表示扫码/二维码登录的唯一候选，不点击登录、提交、确认、授权、注册、密码登录或短信登录；
5. 等待二维码出现，优先提取 data URI/canvas 图片；无法直接提取但能确认二维码时，才使用页面截图兜底；
6. 没找到二维码时停止自动操作，只提示用户打开浏览器手动登录。

常见 Passport 页面结构已纳入通用规则，而不是写入某个业务 Adapter：

```html
<a id="switcher_qlogin" class="qrcode_switch"></a>
<div class="login_qrcode">
  <img class="qrcode" src="data:image/...">
</div>
```

因此 PACE、ITSM、DPMS 等共享该类登录页的 Adapter 不需要分别配置二维码选择器。

### `auth.qr.command`：计划中的精确扩展点

对于通用发现无法可靠处理的网站，目标 schema 允许 Adapter 像 `check.command` 一样提供宿主专用命令：

```json
{
  "auth": {
    "login_url": "https://passport.example.com/login",
    "check": { "command": "check-login-status" },
    "qr": { "command": "get-login-qrcode" }
  }
}
```

目标语义：

- 命令由登录 flow 调用，不暴露给 AI 作为普通业务工具；
- 命令固定运行在当前 flow 绑定的登录 Tab，而不是普通业务 Tab；
- 登录 Tab 必须仍匹配该 Adapter 的 `login_url/login_hosts`；
- 命令负责必要的精确切换、等待和二维码定位，可返回图片 data URI 或可验证的页面矩形；
- Bridge 校验图片格式、大小和页面范围后落入短期登录目录；
- 命令返回 `found: false`、超时或失败时，继续执行宿主通用发现；
- `mode: "off"` 时不执行 command，也不执行通用发现。

建议返回协议：

```json
{
  "found": true,
  "image_data_url": "data:image/png;base64,...",
  "expires_at": "2026-10-24T16:40:00Z"
}
```

或在无法直接读取图片时：

```json
{
  "found": true,
  "rect": { "x": 640, "y": 180, "width": 300, "height": 300 }
}
```

`auth.qr.command` 目前是目标设计，尚未接入 manifest 校验和运行时；在运行时实现完成前，校验器不会接受该字段，避免出现“配置合法但实际不执行”的假能力。

## 6. 登录完成后的重试策略

登录恢复遵循“防重复副作用”原则：

| 命令类型 | 登录完成后的行为 |
| --- | --- |
| 读操作 | 自动重试一次。 |
| 写操作，认证在 `navigation` 阶段失败 | 可自动重试，因为业务动作尚未执行。 |
| 写操作，认证在 `handler` 阶段失败 | 返回 `AUTH_RETRY_REQUIRED`，需要用户确认后重新执行。 |
| 登录后重试仍返回 `AUTH_REQUIRED` | 返回 `still_required`，不无限重试。 |

对应逻辑在 `webcli/site-login.js` 的 `handleFailure()`：

```js
const safeToRetry =
  (command?.safety || 'read') === 'read' ||
  auth.phase === 'navigation';
```

此策略能够避免登录恢复造成重复发帖、下单、付款、点赞、提交表单等操作。

## 7. 桌面端集成

Electron 主进程对 Renderer 仅提供固定的登录控制动作，Renderer 不能传入任意 URL 或路径：

```text
site-auth:control
  → sanitizeSiteAuthRequest()
  → BrowserControlClient.authRequest()
  → ws://localhost:3711 Bridge
```

Bridge 发出的 `auth_event` 会通过 `electron/main.js` 转发：

```text
Bridge auth_event
  → BrowserControlClient.onAuthEvent()
  → mainWindow.webContents.send('site-auth:event', event)
  → Renderer SiteLoginNotice
```

当主窗口不可见或未聚焦时，主进程会显示系统通知；点击通知会显示 WeWorker 浏览器。

Renderer 会处理：

- `login_required`
- `waiting_user`
- `autologin_started`
- `autologin_failed`
- `logged_in`
- `cancelled`
- `timeout`

## 7.1 `open_browser` 的登录感知参数

`webcli call open_browser --url=<URL>` 仍是 Bridge 内置的通用开页工具。未传 `--adapter` 时，它只校验 URL 是否属于受控 origin 并创建 Tab，不推断网站归属，也不进入登录 flow。

打开已知 Adapter 网站时，可显式绑定：

```text
webcli call open_browser --url=<该 Adapter 的 Homepage> --adapter=<adapter-id>
```

Bridge 会校验 Adapter 当前可用、URL 确实属于该 Adapter 的 `homepage_url/match/domains`，再打开页面并以 `waitMs: 0` 启动或复用该 Adapter 的 `SiteLoginCoordinator`。开页调用不会等待完整登录，也不会重放开页动作；返回结果同时携带认证状态：

```json
{
  "success": true,
  "tabId": 123,
  "auth": {
    "site": "example.com",
    "status": "waiting_user",
    "flowActive": true
  }
}
```

若 Adapter 已登录，状态为 `already_logged_in`；若 Adapter 未声明 `auth`，页面仍会打开并返回 `not_configured`。`waiting_user` 表示开页已成功、登录 flow 在后台继续，不应重试 `open_browser`。桌面端通过现有 `auth_event` 展示二维码或手动登录提示。

显式参数解决了共享 SSO 的归属问题：初始业务 URL 和 `--adapter` 决定 flow 身份，最终登录 URL只按该 Adapter 的 `login_url/login_hosts` 验证，绝不用于反查 Adapter。若 URL 与 Adapter 不一致，Bridge 在开页前拒绝，避免错误绑定。

## 7.2 AI 与确定性调用如何使用

`open_browser` 主要通过系统提示和 WebCLI Skill 暴露给 AI，而不是一个独立的 MCP 工具 schema：

- 主 Agent：`weworker/backend-ts/src/agent.ts` 与 `prompts/agent.md`；
- WebCLI Skill：`webcli/skills/webcli/SKILL.md`；
- 专属 Agent：`weworker/backend-ts/src/dedicated-agents/agent-runtime.ts`；
- 桌面命令模板：`weworker/renderer/src/utils/chat-slash-commands.js`。

这些入口统一遵循：常规 Host-managed Adapter 业务命令仍直接调用，不机械地先开页面；只有用户明确要求显示网站、通用浏览器/探索流程或 Skill 明确要求页面准备时才使用 `open_browser`。已知 Adapter 必须传 `--adapter=<id>`；探索未知网页时省略。

Backend 的确定性页面准备 `weworker/backend-ts/src/api-query-router/page-prep.ts` 在工具声明 `navigate_before` 时也会调用 `open_browser`，并从工具目录携带其 `adapterId`，因此同样可接入登录 flow。

共享 SSO 下，逻辑 flow 始终按 `(browser contextId, adapterId)` 隔离。不同 Adapter 可以复用一个物理 SSO Tab，但登录完成仍分别执行各自的 `auth.check`，不能因一个站点成功就批量标记其他站点已登录。

当前显式绑定实现不等待 `open_tab` 的最终导航 URL，而是开页后直接使用 Adapter 的 `auth.check` 和既有 `login()` 状态机。若未来出现没有可靠 `auth.check`、且开页重定向时序导致重复登录 Tab 的 Adapter，再增加以 `tabId` 为范围的有界导航观察，不需要恢复 URL 反查。

## 7.3 企业微信机器人登录通知

WeWorker Backend 会监听 Bridge 现有的 `auth_event`，并仅在登录事件能唯一匹配当前企业微信会话中的 WebCLI 调用时通知用户，不改变桌面端或 WebCLI 的协议和行为。

有可用二维码时，企业微信会发送经过路径、大小和格式校验的登录图片；没有二维码时，提示用户到运行 WeWorker 的电脑完成登录，并仅在 Adapter 允许自动登录时建议在桌面端保存凭据。登录文字与最终结果共用同一条流式回复以保证顺序，且不会写入 Agent 对话历史；并发归属不明确时不主动发送，避免跨会话泄露。

## 8. Browser Profile、Cookie 与凭据

### 8.1 浏览器会话

- **WeWorker 专用浏览器模式**：使用独立 Chrome 用户数据目录，站点 Cookie 由 Chrome 持久化。
- **系统浏览器模式**：使用已连接用户 Chrome 的既有会话与 Cookie。
- Bridge 以 `contextId` 固定业务调用、登录 flow 与扩展连接，登录成功后重试不会跳到另一个浏览器 Profile。

### 8.2 自动登录能力策略

`auth.autologin.mode` 区分“站点是否允许自动登录”和“用户是否已经开启自动登录”：

| 配置 | 站点能力行为 |
| --- | --- |
| 未声明 `auth.autologin` | 默认 `auto`；站点允许用户保存密码并开启自动登录。 |
| `"autologin": { "mode": "auto" }` | 显式允许；还可以同时声明 `switch/username/password/submit` CSS 选择器。 |
| `"autologin": { "mode": "off" }` | 禁止保存、启用、解密和自动填写凭据，也不在手工登录后推荐开启。 |

`auto` 不是默认替用户登录：用户偏好仍默认关闭，只有用户主动保存凭据后才会启用。`off` 适用于动态密码、PIN+TOKEN、一次性口令、强制二次认证或站点策略不允许保存密码的场景，例如：

```json
{
  "auth": {
    "login_url": "http://passport.example.com/signin",
    "autologin": { "mode": "off" },
    "check": { "command": "check-login-status" }
  }
}
```

`off` 只关闭凭据自动登录，不关闭二维码发现、短信验证码、人工登录、`auth.check` 或登录后的业务任务恢复。若过去已经为该站保存过密码，运行时会立即视为禁用，桌面设置仍保留“删除密码”入口，避免用户无法清理历史密文。

Windows 上，允许自动登录的网站由 `webcli/credential-vault.js` 使用当前用户的 DPAPI 加密凭据。设计边界如下：

- 密码不会回传到 Renderer；
- 扩展、Adapter、后端 Agent 和模型均不读取密码；
- Bridge 仅在 CDP 填写真实登录页时解密使用；
- 自动填写仅允许 HTTPS 页面（本地测试地址例外）且必须属于 Adapter 声明的登录域名范围；
- 自动登录失败存在冷却时间，避免反复填写。

## 9. 已识别的问题与建议

### P0：UI 对“登录完成后自动继续”的描述不够准确

部分 UI 或系统通知可被理解为“任务一定会自动继续”，但实际情况是：

- 仅仍在等待中的读操作可自动重试；
- 业务调用若已在默认 75 秒后返回，登录 flow 虽继续运行，原调用不会自动恢复；
- 写操作通常必须重新确认；
- Renderer 的“继续”更接近把提示写入聊天输入，而不是恢复原始 RPC。

**建议：** UI 明确区分“正在自动重试”“登录完成，请重新执行”“操作可能已执行，需重新确认”三种状态；对可安全重放的读调用考虑保留 invocation ID / flow ID 来恢复。

### P1：登录成功判断存在偏宽松路径

对于没有 `check.command` 的 Adapter，离开登录页可能被当作登录成功。Cookie fingerprint 能降低旧 Cookie 误判概率，但不等于服务端会话必然有效。

**建议：**

- 生产 Adapter 尽可能提供 `whoami`、用户资料接口等强验证命令；
- 检查结果为 `null` 时使用 `unverified`，避免直接视为成功；
- 对登录后再次出现 `AUTH_REQUIRED` 做可观测性统计与 Adapter 告警。

### P1：登录页截图的隐私与生命周期需要加强

专用浏览器会将登录页或二维码截图落盘，例如：

```text
~/.webcli/login/<contextId>/<site>.jpg
~/.webcli/login-qrcode.png
```

截图可能包含二维码、账号、验证码或其他个人信息。当前静态分析中未见明确的 TTL、成功后清理、取消/超时清理或 ACL 加固逻辑。

**建议：**

- 使用受限临时目录；
- 在成功、取消、失败、超时后删除；
- 添加启动时过期文件清理；
- Windows 上显式设置仅当前用户可读的 NTFS ACL；
- 通过受控本地协议提供图片，而不是向 UI 暴露任意文件路径。

### P2：系统浏览器模式可能抢占用户焦点

新建登录 Tab 时使用 `active: true`。多站点并行或用户正在浏览其他内容时，系统 Chrome 可能被强制切换。

**建议：** 系统浏览器模式下优先后台创建 Tab，通过桌面通知或用户点击“显示登录页”再前台聚焦；专用浏览器模式则继续保留当前显式展示行为。

### P2：`requires_auth` 与 `auth` 需要明确分工

部分站点可以匿名读取，但仍支持登录恢复。若后端或模型上下文只读取 `requires_auth`，可能将“可匿名访问”误解成“无登录能力”。

**建议：** 在 Adapter schema 中区分：

- 站点是否声明认证能力；
- 每个命令是否需要认证；
- 命令是否支持自动登录恢复；
- 是否存在强验证命令。

## 10. 关键文件索引

| 文件 | 重点内容 |
| --- | --- |
| `webcli/site-login.js` | `SiteLoginCoordinator`，状态机、检查、超时、重试、自动登录和截图。 |
| `webcli/bridge.js` | 工具调用到登录 flow 的收口、按 Profile 隔离 coordinator、认证事件发布和固定控制 API。 |
| `extension/background/site-auth.js` | 登录 URL 与域名规则、Cookie 判断、Cookie fingerprint、`AUTH_REQUIRED` 结构化数据。 |
| `extension/background/service-worker.js` | 受管 Adapter 调用、认证错误回传、登录 Tab 创建/复用、Cookie 检查。 |
| `weworker/electron/main.js` | `site-auth:control` IPC、认证事件转发、失焦时的原生通知。 |
| `weworker/electron/site-auth-ipc.js` | 桌面登录控制请求的参数清洗和动作白名单。 |
| `weworker/electron/dedicated-browser.js` | 桌面应用到本地 Bridge 的浏览器与认证控制客户端。 |
| `weworker/renderer/src/components/site-login/SiteLoginNotice.jsx` | Renderer 中的登录状态提示和用户动作。 |
| `webcli/credential-vault.js` | Windows DPAPI 凭据存储及自动登录偏好。 |

## 验证状态

本文是代码静态分析结果。以下事项尚未在本机完成验证：

- 真实网站的扫码、短信验证码和账号密码登录；
- Bridge 在实际扩展重连时的登录 flow 恢复；
- 多浏览器 Profile 并发登录；
- 登录截图的创建、读取与清理；
- WebSocket Bridge 的本机客户端访问控制和 Origin 策略；
- 写操作在认证失败不同阶段的端到端重试保护。
