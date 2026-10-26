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

1. 在仓库根 `adapters/<domain>/` 下建 v2 包：`manifest.json`（schema_version 2）+ `extension/commands/<tool-id>.js`
2. 在 `weworker/build-profile.json` 的 `adapters` 数组里追加域名
3. 运行 `node weworker/scripts/prepare-build.cjs --profile public` → 重新加载扩展 → Adapter 经 Bridge 下发
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

- `adapters/<id>/manifest.json` — 每个 Adapter 的元数据（每个 Adapter 目录必须有）。内置 Adapter 源码位于仓库根 `adapters/`，以 host-managed v2 包形式经 Bridge 下发：

  ```
  adapters/                      # 仓库根目录
  ├── jd.com/
  │   ├── manifest.json          # v2 包清单（schema_version 2）
  │   └── extension/
  │       ├── commands/          # 工具命令模块
  │       └── internal/          # 包内共享运行时
  └── mail.163.com/
      ├── manifest.json
      └── extension/
          └── commands/
  ```

  扩展内不内置 Adapter；构建时 `prepare-build` 生成的 `adapters/index.json` 恒为空清单，仅用于扩展启动初始化。

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
| `gate_aliases` | string[] | `[]` | 第 3 层 siteGate 的补充信号词表（除域名 `match` 外，还能用哪些词判断「用户在说这个站点」）。拉丁词按 ASCII 字母数字判边界（避免 `…XXTICKETSYY…` 误命中 `tickets` 这类子串），CJK 词直接子串匹配。**缺省 = 只靠域名信号**，不做任何站点名推断 |
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

### 8.9 网站范围：`match`、`domains` 与 `homepage_url`

v2 包的页面命令只能在声明的网站范围内运行和跳转；跳到范围外会报 `ADAPTER_HOST_NOT_ALLOWED`（Adapter 配置问题，重试无效）。

- `match`：精确的页面主机。第一项是主主机（默认路由、无 `homepage_url` 时的首页）。`*.example.com` 表示 example.com 及其全部子域名。
- `domains`：站点域名，例如 `["jd.com", "jd.hk"]`。每一项覆盖该域名本身和它的全部子域名，**不用再逐个列** `order.*`、`search.*`、`item.*`。同一网站的地区或品牌域名（如 `jd.hk`）要显式写出，宿主不会根据跳转自动推断归属。不允许公共后缀（`com`、`co.uk`、`com.cn`、`github.io` 等）、通配符或 IP。
- `routeDomain` / `tabDomain` / `excludeTabDomain` 可以是 `match` 中的主机，也可以是 `domains` 覆盖的任意主机。
- `homepage_url`：给 AI 用，`open_browser` 打开的完整 URL。`open_browser` 允许 `match` 主机、`homepage_url`，以及每个 `domains` 的根域名和 `www.` 主机。

推荐写法：`match` 只写主页主机，其余交给 `domains`：

```json
"match": ["www.jd.com"],
"domains": ["jd.com", "jd.hk"]
```

宿主会记住范围内的跳转（例如 `order.jd.com` 被网站跳到 `order.jd.hk`），之后的调用直接复用该标签页。`domains` 覆盖的主机上，`passport.*`、`sso.*`、`/login` 等通用登录页仍会被识别为登录页；需要用户完成的验证页（如京东的 `aq.jd.com`）请写进 `auth.login_hosts`。新增 `domains` 对用户安装的 Adapter 属于权限变更，更新时需要用户同意。匹配规则只有一份实现：`extension/background/host-scope.js`（WebCLI 中的 `webcli/host-scope.js` 是逐字节相同的副本）。

### 8.10 网站登录：声明 `auth`，由宿主处理

登录是宿主能力，不是 Adapter 代码。Adapter 只声明「登录页在哪」和「怎样判断已登录」；识别未登录、打开登录页、显示/隐藏 WeWorker 浏览器、等待用户完成、自动重试都由 Bridge 完成（`webcli/site-login.js`），桌面端和 `webcli` 行为一致，AI 不需要也不应该预先检测登录。

```json
"auth": {
  "login_url": "https://passport.example.com/login",
  "login_hosts": ["passport.example.com"],
  "check": {
    "cookies": { "url": "https://www.example.com/", "all": ["session_id"] },
    "command": "whoami"
  },
  "autologin": {
    "mode": "auto",
    "switch": "#tab-password",
    "submit": "button[type=submit]"
  }
}
```

| 字段 | 说明 |
|------|------|
| `login_url` | 必填。打开登录时使用的 HTTP(S) 页面；主机必须在 `match`、`domains`、`runtime_allowed_hosts` 或 `login_hosts` 中。HTTP 仅适用于用户受信任的内网登录页；账号密码自动填写仍只允许 HTTPS 页面 |
| `login_hosts` | 可选。只用于登录的主机，例如 SSO 认证中心 `sso.example.com`、`passport.example.com`。命令页面被重定向到这些主机即判定为「需要登录」 |
| `check.cookies` | 可选，最快。`url` 下的 Cookie 满足 `all`（全部存在）/ `any`（任一存在）/ `equals`（值相等）/ `not`（值不等）即视为已登录 |
| `check.command` | 可选。本包的一个只读 Extension 命令（例如 `whoami`）。返回 `logged_in: false` 或抛出 `AUTH_REQUIRED` 表示未登录，其他成功结果表示已登录 |
| `auth.qr.mode` | 可选，`auto` / `off`，默认 `auto`。`auto` 由宿主尝试通用二维码发现；`off` 完全跳过二维码逻辑，直接进入人工登录 |
| `autologin.mode` | 可选，`auto` / `off`，默认 `auto`。`auto` 表示站点允许用户保存密码并由 WeWorker 自动填写；`off` 表示动态密码、一次性口令或站点策略不允许自动登录，桌面端和 CLI 均不提供保存/启用入口 |
| `autologin.switch/username/password/submit` | 可选。`auto` 模式下通用表单识别不准时，提供 CSS 选择器：`switch`（先点击切换到账号密码登录）、`username`、`password`、`submit` |
| `display_name` | 可选。登录提示中显示的名称，默认取 `i18n.zh.name` |
| 命令级 `auth` | 可选，`required`（默认）/ `optional` / `none`。`none` 的命令失败时不触发登录检查 |

**Adapter 代码只需要做一件事**：在自己的接口返回「未登录」时报告它：

```js
// 页面命令与后台命令都可用
window.__webmcpWecliRuntime.authRequired('会话已过期');
// 或抛出 code 为 'AUTH_REQUIRED' 的错误（OpenCLI 移植包中的 AuthRequiredError 已经如此）
```

**宿主识别「需要登录」的方式**（命中任意一条即进入登录流程）：

1. 只读命令的页面停在登录页：`login_hosts`、`login_url` 的路径，或未声明的 `passport.*` / `login.*` / `sso.*` 主机与 `/login`、`/signin`、`/cas/login` 等路径（SSO 重定向无需额外声明）；
2. Adapter 抛出 `AUTH_REQUIRED`，或运行时 helper 收到 HTTP 401；
3. 命令失败且声明了 `check`：宿主运行一次检查，确认未登录。

**登录流程**：打开（或复用被重定向的）登录页 → 约 2 秒内若会话仍有效会自动跳走，直接继续 → 若开启了自动登录则先尝试 → 否则在后台准备二维码/登录页并向桌面端提示，用户点击“显示浏览器”时才将对应登录 Tab 切到前台 → 宿主根据 `check` 与「离开登录页」判断完成 → 自动隐藏用户曾显示的专用浏览器并**重试一次**。重试规则：只读命令总会重试；写命令只有在业务代码运行前被拦下（页面重定向到登录页）才会重试，否则返回 `AUTH_RETRY_REQUIRED`，由用户确认后重新执行，绝不重放写操作。

**扫码与短信验证码**：二维码发现默认开启，普通 Adapter 无需声明 `auth.qr`。宿主只在该 Adapter 已验证的登录页内尝试一次通用发现：先查找可见二维码，再尝试点击唯一、明确的扫码登录方式切换控件，并优先提取二维码独立图片。通用规则覆盖可见文本、无障碍名称、`id/class` 和常见结构（包括 `#switcher_qlogin`、`.qrcode_switch`、`img.qrcode`）；不会填写表单或点击确认、授权、提交等按钮。找到二维码后桌面端显示并定期刷新；找不到时不展示整页截图，只提示用户打开浏览器手动登录。明确不支持二维码或不适合自动探测的网站可声明 `"qr": { "mode": "off" }`。复杂网站未来可通过 `auth.qr.command` 提供精确获取逻辑；该扩展点尚未实现，当前校验器不会接受 `command`。

**自动登录**：`auth.autologin.mode` 是站点能力策略，不是用户开关。未配置或 `auto` 表示该站允许自动登录，但用户仍须主动保存密码并开启；`off` 表示该站使用动态密码、一次性口令或明确禁止凭据自动填写。`off` 时宿主不会读取/填写保存的密码，不会推荐开启，Bridge 和 CLI 拒绝保存或启用，桌面设置隐藏更新密码和开关；手动登录、二维码、短信验证码、`auth.check` 与任务恢复完全不受影响。`auto` 模式下密码用系统密钥加密保存在本机（目前支持 Windows DPAPI），只有 Bridge 在填写前解密，并且只在该网站声明的 HTTPS 登录页通过 CDP 可信输入；Adapter、扩展、Backend 与模型都拿不到明文。

**验证**：`webcli auth check <adapter>` 运行你声明的检查；`webcli login <adapter>` 走一遍完整登录流程；`webcli adapter validate <dir>` 校验 `auth` 字段。

**兼容**：`requires_auth`、`auth_check_tool`，以及 `login` / `check-login-status` / `whoami` 命令继续可用，但不再需要为登录编写新命令；AI 提示词与 Skill 中都不会再要求预先检测登录。

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
