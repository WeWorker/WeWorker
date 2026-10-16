# Chrome Extension 开发规范

开发一个 WebMCP Adapter 扩展功能的标准流程、配置说明与约束。配套问题清单见 [KNOWN_ISSUES.md](./KNOWN_ISSUES.md)。

---

## 1. 扩展在整个链路里的角色

```
CLI / 桌面端            WebCLI Bridge              Chrome 扩展
    │                  ws://localhost:3711              │
    │  call_tool ─────►│──────── 转发 ────────►│  Service Worker
    │                  │                         │      │
    │                  │◄──────── 结果 ─────────│  Injector → DOM
    │  ◄─── 结果 ──────│                         │
```

扩展是链路的第三段，做三件事：

1. **检测 URL** — 决定向页面注入哪个 adapter
2. **维护工具注册表** — 按域名聚合工具，把 `call_tool` 路由到正确的 tab
3. **在页面里执行** — content script 暴露注册 API，执行 handler 操作 DOM

---

## 2. 目录结构与文件职责

```
extension/
├── manifest.json              扩展清单（权限、入口声明）
├── background/
│   └── service-worker.js      MV3 后台：连 Bridge、维护工具注册表、路由 call_tool
├── content/
│   └── injector.js            注入每个页面：暴露注册 API、接 call_tool 执行 handler
├── adapters/
│   ├── index.json             已注册 adapter 域名清单（被 web_accessible_resources 暴露）
│   └── <domain>/
│       ├── index.js           各网站 adapter：注册具名工具
│       └── manifest.json      Adapter 元数据（能力定义 + 客户端展示字段）
├── popup/                     工具栏弹窗 UI
├── sidepanel/                 侧边栏（含 Monaco 编辑器，在线写/调 adapter）
├── icons/                     16/48/128 三种尺寸图标
├── test/                      本地测试页
└── README.md                  扩展工作原理、adapter 注册流程、开发指南
```

---

## 3. manifest.json 配置逐项说明

当前清单 `manifest_version: 3`，`version: 0.2.1`。

### 顶层字段

| 配置项 | 当前值 | 作用 |
|---|---|---|
| `manifest_version` | `3` | 声明 MV3，强制 service worker 模型（会被挂起，影响后台脚本写法） |
| `name` | `"WebMCP Adapter"` | 扩展显示名称 |
| `version` | `"0.2.1"` | 扩展版本号，Chrome 用它判断是否需要更新 |
| `description` | 见 manifest | 扩展描述，展示在扩展管理页 |

### background

```json
{
  "service_worker": "background/service-worker.js",
  "type": "module"
}
```

- `service_worker`：后台脚本入口，承载 Bridge WebSocket 连接与工具路由
- `type: "module"`：以 ES module 加载，允许使用 `import` 拆分代码

### content_scripts

```json
[{
  "matches": ["<all_urls>"],
  "js": ["content/injector.js"],
  "run_at": "document_idle"
}]
```

- `matches: <all_urls>`：向所有页面注入，因为 adapter 可能对接任意域名
- `js`：注入器脚本，暴露页面侧注册 API 并处理 `call_tool`
- `run_at: document_idle`：等 DOM 基本就绪后再注入，减少时序问题

### permissions

| 权限 | 用途 | 不给会怎样 |
|---|---|---|
| `tabs` | 查询/激活 tab、读 URL | 无法按域名找到目标页签 |
| `activeTab` | 操作当前激活页 | 截图、注入受限 |
| `scripting` | `chrome.scripting.executeScript` 注入 adapter | adapter 无法被注入 |
| `nativeMessaging` | 与本地 host 通信通道 | 部分原生消息路径失效 |
| `storage` | `chrome.storage.local` 持久化 | 已装 adapter 列表、探索结果无法落地 |
| `alarms` | 定时唤醒 SW | MV3 SW 被挂起后无法定时恢复 |
| `notifications` | 系统通知 | 无法提示用户 |
| `debugger` | CDP 动作（如文件上传 `DOM.setFileInputFiles`） | 依赖 CDP 的工具失效 |
| `sidePanel` | 启用侧边栏 | 在线编辑 adapter 的面板打不开 |

### host_permissions

```json
["<all_urls>"]
```

允许操作任意站点——adapter 可能对接内部/外部任何域名。

### web_accessible_resources

```json
[{
  "resources": ["adapters/index.json", "adapters/*/index.js", "adapters/*/manifest.json"],
  "matches": ["<all_urls>"]
}]
```

让 Service Worker 和页面能 fetch 这些文件——SW 按 URL 命中后需动态读取并注入对应 adapter。

> 注：上面是当前实际配置。扩展自身与 Adapter 都使用 `manifest.json`，必须通过目录位置区分，详见 §6.1。

### 其余字段

- `side_panel.default_path`：侧边栏入口 HTML
- `action`：工具栏图标和 tooltip
- `icons`：扩展管理页展示用图标

---

## 4. 开发一个扩展功能的标准流程

### Step 1：确认权限

新增能力先检查 `permissions` / `host_permissions` 是否够用。原则：最小化新增。

### Step 2：定入口

| 功能类型 | 放哪里 |
|---|---|
| UI 功能 | `popup/` 或 `sidepanel/` |
| 后台逻辑（与 Bridge 通信、工具路由） | `background/service-worker.js` |
| 页面内操作 | `content/injector.js` 或具体 adapter |

### Step 3：走消息协议

所有跨层通信用 `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`，消息统一带 `type` 字段。新增交互 = 新增一个 `type` 分支。参考现有的：
- `call_tool` / `call_tool_result` / `call_tool_error`
- `register_tools` / `resync_tools`
- `extension_hello` / `extension_connected` / `extension_disconnected`
- `get_trace_logs`（traceID 链路日志）

### Step 4：本地加载

1. Chrome 打开 `chrome://extensions/`
2. 开启"开发者模式"（右上角）
3. "加载已解压的扩展程序" → 选 `extension/` 目录
4. 确认扩展出现在列表中

### Step 5：调试

| 目标 | 怎么做 |
|---|---|
| Service Worker 日志 | 扩展卡片 → 点 "Service Worker" 链接 → 打开后台控制台 |
| Content Script 日志 | 目标页面 DevTools → Console |
| Bridge 侧日志 | 看 `webcli` 进程 stderr（`[Bridge]` 前缀） |

### Step 6：改完重载

- 改 `service-worker.js` / `manifest.json`：必须在扩展页点刷新按钮
- 改 adapter：刷新目标网页即可（adapter 会重新注入并注册）
- 改 `content/injector.js`：刷新扩展 + 刷新页面

### Step 7：验证注册

后台控制台应看到类似 `Domain <x> registered N tools` 的日志，确认工具进了注册表。

---

## 5. MV3 三条硬约束

### 5.1 Service Worker 会被挂起

Chrome 随时可挂起 SW，内存中的工具注册表会丢失。**现有应对**：唤醒后向所有 tab 发 `resync_tools`，content script 重新上报。新增的内存态都要有同样的重建路径，或落到 `chrome.storage.local`。

### 5.2 Content Script 注入有时序

Adapter 注入与 handler 注册不是瞬时的。注入器里有"轮询等待最多 8 秒"的兜底。新增工具调用要复用这个机制，别假设 handler 立即就绪。

### 5.3 Adapter 不能用 import/export

Adapter 是被全量注入的脚本，运行在 isolated world，只能通过页面注册 API 注册工具，不能用 ES module 语法。

---

## 6. 与 KNOWN_ISSUES 直接相关的开发注意点

以下三点来自 [KNOWN_ISSUES.md](./KNOWN_ISSUES.md)，开发时需要特别留意：

### 6.1 Adapter 元数据文件：`manifest.json`

当前实现统一使用 `manifest.json`。扩展清单和 Adapter 清单通过目录位置区分：

- `extension/manifest.json` = 扩展清单（Chrome 规定文件名，不可改）
- `extension/adapters/<domain>/manifest.json` = 单个 Adapter 的元数据
- 改 Adapter 元数据时，确认编辑的是 `adapters/<domain>/manifest.json`，不要误改扩展清单
- adapter 元数据当前混入了 WeWorker 客户端展示字段（`hidden`、`enabled`、`quick_prompts`、`test_prompts`），这些**不属于** adapter 能力定义。新增 adapter 时，能力字段（`match`、`requires_auth`、`auth_check_tool`、`support_files`、`homepage_url`）与客户端展示字段要分清

> 如果未来决定重命名，必须在独立变更中同步全部读取方、构建脚本、测试和 `web_accessible_resources`；当前贡献不要混用两种文件名。

### 6.2 Bridge 端口冲突（3711）

WebCLI CLI 与 WeWorker 桌面端都会在 3711 启动 Bridge，后启动的一方会 `EADDRINUSE`。

- 开发联调时：**先** `webcli service start -d`，**再**启动 WeWorker，避免 FATAL 日志
- 或只用其中一个客户端
- 新增依赖 Bridge 的功能时，不要假设"自己独占 3711"——未来会加端口探测复用机制

### 6.3 内置工具走哪条路径要想清楚

WeWorker 存在两条 Bridge 通信路径：BridgeClient（WebSocket 直连）走内置 MCP 工具，Bash + `webcli call` 走 adapter 工具。新增工具前先判断它属于哪类，避免两条链路重复实现、维护翻倍。

---

## 7. 新增 Adapter 的快速路径

只为新网站写 adapter（不改扩展本体）时：

1. 在 `extension/adapters/<domain>/` 下建 `index.js` + `manifest.json`
2. 在 `extension/adapters/index.json` 数组里追加域名
3. 刷新扩展 → 打开目标网页 → 看控制台确认注册
4. 完整编写规范见下文 §8

---

## 8. Adapter 开发规范

Adapter 是一个运行在页面 isolated world 的 JS 文件，通过 `window.__webmcpRegister` 向扩展注册工具，让 AI 能操作对应网站。每个 Adapter 一个目录：`index.js`（工具实现）+ `manifest.json`（元数据）。

### 8.1 工具注册结构

```js
window.__webmcpRegister({
  name: 'My Site Adapter',
  tools: [
    {
      name: 'mysite.com.do_something',          // 见 §8.2 命名规范
      description: '执行某操作；AI 据此描述决定何时调用',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '查询内容' } },
        required: ['query'],
      },
      handler: async ({ query }) => {
        const el = document.querySelector('.result');
        return { data: el?.textContent };       // 返回值须可 JSON 序列化
      },
    },
  ],
});
```

### 8.2 工具命名规范

格式 `{domain}.{action_name}`：

- `domain` — 网站主域名，如 `jd.com`、`mail.163.com`
- `action_name` — 下划线分隔的动词短语，如 `get_orders`、`search_emails`

示例：`jd.com.get_orders`、`mail.163.com.search_emails`。SW 按 `domain` 前缀把 `call_tool` 路由到对应 tab，命名错误会导致路由不到。

### 8.3 Handler 约束（isolated world）

Adapter 运行在扩展的 isolated world，与 §5.3 一致：

- ✅ 可访问/操作 DOM（`document.querySelector` 等）
- ✅ 可用 `fetch` 发请求
- ❌ 不能访问页面 JS 变量（`window.React`、页面全局变量等）
- ❌ 不能用 `import` / `export` / `require`

Handler 返回值会被 `JSON.stringify` 后传给 AI，确保可序列化。注入有时序（§5.2），别假设 handler 立即就绪。

### 8.4 常用工具函数

建议在 adapter 文件顶部定义：

```js
// 等待元素出现
function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); reject(new Error(`Timeout: ${selector}`)); }, timeout);
  });
}

// 延迟
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
```

### 8.5 工具级可选字段

除 `name` / `description` / `parameters` / `handler`，工具还支持：

| 字段 | 类型 | 说明 |
|---|---|---|
| `tabDomain` | string | 强制路由到指定域名的 tab。如支付工具需在结算页执行，设为 `pc-settlement-lite-pro.pf.jd.com` |
| `excludeTabDomain` | string | 排除指定域名的 tab。如普通工具不应在结算页执行 |

### 8.6 文件上传：`file_path` + CDP action

工具参数定义 `file_path`（本地绝对路径）。handler 先用 DOM 操作定位 `<input type="file">`，再返回 `__cdp_action` 对象，由 SW 通过 `chrome.debugger` 在内核层完成设置：

```js
handler: async ({ file_path }) => {
  // 1. 先完成 DOM 操作（点按钮、开弹窗）
  const uploadBtn = document.querySelector('.upload-btn');
  if (!uploadBtn) return { error: '未找到上传按钮' };
  uploadBtn.click();
  await sleep(500);

  // 2. 定位 file input
  if (!document.querySelector('input[type="file"]')) return { error: '未找到文件上传控件' };

  // 3. 返回 CDP action
  return {
    __cdp_action: 'set_file_input',
    selector: 'input[type="file"]',   // 需能唯一定位
    files: [file_path],                // 支持多文件
  };
}
```

SW 处理流程：`debugger.attach` → `DOM.querySelector` → `DOM.setFileInputFiles`（绕过 JS 安全限制）→ 立即 `detach`。CDP 期间浏览器顶部会短暂出现"正在调试此浏览器"提示条。

### 8.7 发现机制：`index.json` + `manifest.json`

扩展靠两层文件发现并加载 adapter：

- `adapters/index.json` — 已安装 adapter 的 ID 列表，启动时读取以确定有哪些可用：

  ```json
  ["jd.com", "mail.163.com", "mail.google.com"]
  ```

- `adapters/<id>/manifest.json` — 每个 Adapter 的元数据（每个 Adapter 目录必须有）：

  ```
  extension/adapters/
  ├── index.json
  ├── jd.com/
  │   ├── manifest.json
  │   └── index.js
  └── mail.163.com/
      ├── manifest.json
      └── index.js
  ```

### 8.8 `manifest.json` 字段

**必填：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 唯一标识，同时是目录名。通常用主域名，如 `jd.com` |
| `name` | string | 显示名称 |
| `description` | string | 功能描述 |
| `match` | string[] | 域名匹配列表，只填 hostname（不含端口/路径）。支持子域名：`jd.com` 匹配 `www.jd.com`、`order.jd.com` |

**可选 —— adapter 能力定义：**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `homepage_url` | string | `http://{match[0]}/` | AI 打开网站用的完整 URL。需特殊端口/路径时必填，如 `https://benefits.example.com:8443/s_iv/#/`。默认 http（很多内网不支持 https）；支持 https 请显式填写 |
| `requires_auth` | boolean | `false` | 是否需要登录。`true` 时 AI 先检测登录状态 |
| `auth_check_tool` | string | - | 登录检测 fallback 工具名，用于 SSO 跨域场景（见 §8.10） |
| `except` | string[] | - | 排除的子域名。匹配 `match` 但在此列表中的域名不注入 |
| `support_files` | string[] | - | 在 `index.js` 之前注入的额外脚本，相对当前 adapter 目录（见 §8.11） |
| `author` | string | - | 作者 |
| `version` | string | - | 版本标识（通常用 ISO 时间戳） |

**可选 —— WeWorker 客户端展示字段**（不属于 adapter 能力定义，注意区分，见 §6.1）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `hidden` | boolean | `false` | 是否默认不在欢迎页展示（工具仍可用，用户可在设置覆盖） |
| `enabled` | boolean | `true` | 是否默认启用。`false` 时工具默认关闭，需用户手动开启 |
| `quick_prompts` | string[] | - | 推荐的快速尝试任务，显示在欢迎页 |
| `i18n` | object | - | 多语言名称/描述，如 `{ "zh": { "name": "京东", "description": "…" } }` |

**可选 —— 智能路由字段**（全部可缺省；缺省即不参与对应路由层，行为与不填完全一致。分层总览见 `docs/intelligent_routing_design.md` §2）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `scenarios[].route` | object | - | 卡片话术的直达决策，三形态**三选一**：`{ "tool": "工具名", "args": {…} }`（单工具直达）、`{ "plan": { "terminal": "终点工具名", "input": "参数名" } }`（多跳计划）、`{ "direct": false, "reason": "…" }`（显式声明不可直达）。含 `${}` 占位符的卡片**必须**显式给其一，否则编译报错——避免把「装饰性文案」误当成路由规则 |
| `route_templates` | array | - | Tier −2「模板直达」的逐字句式。`pattern` 与消息**锚定全等**（区分大小写）。槽位两种：`${A\|B\|C}` 是枚举槽，`enumArgs` 的 key 必须**正好等于各分支词**，值是该分支要并入 `args` 的参数片段；`${名}` 是自由槽，`slots` 里必须给 `{ arg, validate }`（`validate` 为闭合正则源，不可含 `^`/`$`、裸 `.+`/`.*`、`\s`/`\S` 接量词，也不可匹配空串）。单条模板 ≤4 槽、≤120 字符，且必须至少含一个槽；校验失败的条目整条跳过（warn + skip），不影响该 adapter 其余功能 |
| `gate_aliases` | string[] | `[]` | 第 3 层 siteGate 的补充信号词表（除域名 `match` 外，还能用哪些词判断「用户在说这个站点」）。拉丁词按 ASCII 字母数字判边界（避免 `…XXITSMYY…` 误命中 `itsm` 这类子串），CJK 词直接子串匹配。**缺省 = 只靠域名信号**，不做任何站点名推断 |
| `tool_execution` | object | - | **按工具名索引的对象**（`{ "<工具名>": {…} }`，**不是数组**）。当前只消费一个子字段：`navigate_before`（string）＝该工具调用前必须先打开的页面 URL。命中的直调工具会先 `open_browser(url)` 再等待、然后才真正调用；缺省 = 无页面依赖，客户端不做任何额外编排 |

上表 `scenarios[].route` 与 `route_templates` 里的工具必须同时满足**只读（`safety: "read"`）+ 可直调（`execution: { "type": "api", "runtime": "background" }`，或工具显式声明直调）**。这是准入硬门：写操作、变更类工具一律不得进入路由面，编译期即报错。

示例（工具名仅作示意，实际必须填本 adapter 自己的**只读 + 可直调**工具）：

```json
{
  "gate_aliases": ["example-portal"],
  "route_templates": [
    {
      "id": "my-records",
      "pattern": "查我的${工单|审批}记录",
      "tool": "list-my-records",
      "enumArgs": {
        "工单": { "kind": "ticket" },
        "审批": { "kind": "approval" }
      }
    },
    {
      "id": "record-detail",
      "pattern": "看记录${记录号}",
      "tool": "get-record-detail",
      "slots": {
        "记录号": { "arg": "record_id", "validate": "[A-Z]{2}-\\d{6}" }
      }
    }
  ],
  "tool_execution": {
    "list-my-records": {
      "type": "api",
      "runtime": "background",
      "navigate_before": "https://portal.example.com/workbench"
    }
  }
}
```

### 8.9 `match` 与 `homepage_url` 的区别

- `match`：给扩展用，决定在哪些页面注入 adapter 脚本，只看 hostname
- `homepage_url`：给 AI 用，`open_browser` 打开的完整 URL

大多数网站只填 `match` 即可，`homepage_url` 自动生成为 `http://{match[0]}/`。

### 8.10 `auth_check_tool`：SSO 跨域登录检测

**何时需要**：网站登录页与业务页不在同一域名时。如 `itsm.example.com` session 过期后跳转到 `passport.example.com`（SSO 统一登录页），两者域名不同，`itsm` 的 adapter 不会注入到 SSO 页。

登录页与业务页同域（如 `mail.163.com`）则不需要，直接在自己 adapter 里实现 `check_login_status` 即可。

**工作原理**：

1. 每个内部网站 adapter 提供自己的 `check_login_status`（如 `itsm.example.com.check_login_status`），靠 DOM 特征检测
2. session 过期跳转到 SSO 后，业务页工具无法执行（tab 域名变了）
3. 调用方检测到失败，读取 `auth_check_tool`，自动 fallback 调 SSO adapter 的工具（如 `passport.example.com.check_login_status`）
4. SSO adapter 在登录页执行，返回确定性的 `{ logged_in: false }`
5. 若 SSO 工具也失败（用户没打开该站），返回 `{ logged_in: false, hint: "请先打开网站" }`

**配置示例**：

SSO 登录页 adapter（`passport.example.com`）：
```json
{ "id": "passport.example.com", "name": "ExampleOrg SSO", "match": ["passport.example.com", "uat.sso.example.org"] }
```

内部网站引用 SSO 的检测工具：
```json
{
  "id": "itsm.example.com",
  "requires_auth": true,
  "auth_check_tool": "passport.example.com.check_login_status",
  "match": ["itsm.example.com"]
}
```

### 8.11 `support_files`：拆分 adapter 实现

需要保留精简 `index.js`、把实现放到额外 JS 文件时使用。注入顺序：`content/injector.js` → 各 `support_files`（按序）→ `index.js`。

可在 support file 中先挂全局注册表：

```js
window.__webmcpGeneratedSupport = window.__webmcpGeneratedSupport || {};
window.__webmcpGeneratedSupport['itsm.example.com'] = {
  tools: [
    { name: 'itsm.example.com.search_records', description: '...',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ ok: true }) },
  ],
};
```

再在 `index.js` 的 tools 数组里接入：

```js
...(window.__webmcpGeneratedSupport?.['itsm.example.com']?.tools || []),
```

对应 `manifest.json`：

```json
{
  "id": "itsm.example.com",
  "match": ["itsm.example.com"],
  "support_files": ["webcli-generated/itsm.example.com.site-memory.generated.js"]
}
```

### 8.12 完整 `manifest.json` 示例

```json
{
  "id": "jd.com",
  "name": "JD.com",
  "description": "JD.com: navigate, cart, orders, buy, pay",
  "match": ["jd.com", "pc-settlement-lite-pro.pf.jd.com"],
  "i18n": { "zh": { "name": "京东", "description": "京东：导航、购物车、订单、购买、支付" } },
  "quick_prompts": ["帮我看看购物车里有什么"]
}
```

```json
{
  "id": "benefits.example.com",
  "name": "Fannice",
  "description": "Invoice management system",
  "match": ["benefits.example.com"],
  "homepage_url": "https://benefits.example.com:8443/s_iv/#/",
  "requires_auth": true
}
```
