# Adapter 移出 Chrome 扩展的架构评估

> 讨论日期：2026-07-24
> 评估对象：WeWorker / WebCLI / Chrome Extension 的 Adapter 存储与执行架构
> 参考对象：OpenCLI

## 1. 问题背景

当前 WeWorker 的 Adapter 位于 Chrome 扩展目录：

```text
extension/adapters/<site>/
```

Adapter 代码由扩展的 Service Worker 通过 `chrome.scripting.executeScript` 注入目标网页，并在页面的 isolated world 中注册和执行工具 handler。

本次讨论的核心问题是：

> 是否需要参考 OpenCLI，将 Adapter 从 Chrome 扩展中移出，使扩展只承担通用浏览器执行能力，而 Adapter 在 WebCLI / Node 侧独立存储、安装、加载、更新和执行？

这里讨论的不是把 OpenCLI 或 WebCLI 整体放进扩展，而是调整 Adapter 的归属和执行模型。

## 2. 当前 WeWorker 架构

当前调用链大致为：

```text
WebCLI / WeWorker
       │ call_tool
       ▼
Chrome Extension
       │ 加载 extension/adapters/<site>/index.js
       │ handler 在页面 isolated world 中执行
       ▼
网页
```

扩展通过内部资源路径注入 Adapter：

```js
chrome.scripting.executeScript({
  target: { tabId },
  world: "ISOLATED",
  files: [...supportFiles, `adapters/${adapterId}/index.js`],
});
```

因此当前 Adapter 必须存在于扩展可访问的资源目录中。Adapter 的发现、manifest 读取、工具注册、页面路由和执行都与扩展运行时深度绑定。

## 3. OpenCLI 参考架构

OpenCLI 的 Adapter 不在 Chrome 扩展中执行，而是由 Node Runtime 从内置目录或用户目录发现和加载，例如：

```text
~/.opencli/clis/<site>/*.js
```

其调用链更接近：

```text
OpenCLI Node Runtime
       │ 加载并执行 Adapter 业务逻辑
       ▼
通用 Page API / Daemon
       ▼
Chrome Extension
       │ evaluate、click、network、CDP 等浏览器原语
       ▼
网页
```

OpenCLI 的扩展是通用浏览器驱动，Adapter 运行在 Node 侧。Adapter 通过 `IPage` 一类浏览器代理调用页面能力，而不是作为扩展资源被注入和注册。

## 4. 核心判断

从 WeWorker 当前产品方向判断，建议参考 OpenCLI，将 Adapter 的真源、生命周期管理和业务执行逐步迁出 Chrome 扩展。

但这不能通过简单移动 `extension/adapters/` 目录完成，而需要将执行模型从“扩展注入 Adapter handler”改造成“Node 执行 Adapter，扩展提供通用浏览器原语”。

推荐结论：

> Adapter 的存储、安装、加载、更新和业务执行迁到 WebCLI / Node 侧；Chrome 扩展收敛为稳定的通用浏览器执行引擎。迁移期间保留扩展内 Adapter 兼容层。

## 5. 为什么需要迁移

### 5.1 自动生成 Adapter 与扩展程序目录存在生命周期冲突

项目已经支持网站探索、动作录制、Adapter 生成和 Agent 优化，但生成结果目前写入扩展程序目录。

程序目录不是稳定的用户数据目录，存在以下问题：

- npm 或桌面端升级可能覆盖用户生成 Adapter；
- 重装、替换扩展后 Adapter 可能丢失；
- 官方 Adapter、用户生成 Adapter 和 Agent 优化 Adapter 难以分层；
- 自动更新、回滚、导入和导出能力难以建立。

现有《Generated Adapter 生命周期与 Agent 优化交接》设计也已经识别该问题，并建议引入类似 `~/.webcli/adapters/` 的用户级 Adapter 目录。

### 5.2 Adapter 更新与扩展发布强耦合

当前修改 Adapter 通常需要重新加载扩展，并可能触发桌面端或 npm 包重新发布。

迁出后可独立支持：

- 安装和卸载 Adapter；
- 单独更新和回滚 Adapter；
- 用户版本覆盖官方版本；
- Agent 修改后的热重载；
- Adapter 市场或内部注册中心；
- Adapter 与扩展独立版本管理。

### 5.3 大量 Adapter 已经依赖 Node / Bridge 能力

当前约有 37 个 Adapter。粗略静态统计显示：

- 约 20 个 Adapter 已使用 `backend_fetch`、文件读写等 Bridge 能力；
- 约 15 个 Adapter 明显包含 DOM 操作；
- 很多生成式工具已经声明为 `runtime: "background"`；
- Adapter 的主 `index.js` 总量约为 1.88 MB，尚未包含全部 support files 和知识资产。

部分 Adapter 当前的实际链路已经是：

```text
扩展 Adapter → Service Worker → Bridge → Node → Service Worker → Adapter
```

对于 API、文件和数据处理型工具，将 Adapter 放在 Node 侧会更直接：

```text
Node Adapter → 必要时调用扩展浏览器原语
```

### 5.4 更适合工程化和生态建设

Node 侧 Adapter 可以更自然地支持：

- ES Modules 和公共依赖；
- 单元测试及 Mock；
- Schema 和静态检查；
- 独立版本及依赖管理；
- 热更新；
- Adapter 插件市场；
- 用户自定义和 Agent 持续优化。

## 6. 为什么不能只移动目录

`chrome.scripting.executeScript({ files })` 只能加载扩展包内的文件，不能直接加载 `~/.webcli/adapters/` 等本机任意路径。

让扩展从外部读取 JavaScript 后通过 `eval` 或 `new Function` 执行，还会涉及：

- Manifest V3 CSP 限制；
- Chrome Web Store 远程代码政策；
- 扩展权限与代码审查风险；
- 任意代码注入安全风险。

因此正确方向不是“Adapter 文件放在扩展外，但仍由扩展动态执行”，而是：

```text
Adapter 在 Node 侧执行
    +
扩展执行有限、明确的浏览器原语
```

## 7. 推荐目标架构

```text
~/.webcli/adapters/             用户安装、生成和 Agent 优化的 Adapter
  <adapterId>/
    adapter.json
    tools/
    generated/
    overrides/
    tests/
    SKILL.md
    WEBCLI_KNOWLEDGE.json

webcli/
  adapter-runtime/              Adapter 发现、加载、执行、热更新
  builtin-adapters/             官方内置 Adapter
  browser-client/               调用扩展浏览器能力

extension/
  browser-runtime/              通用浏览器执行引擎
    evaluate
    browser_fetch
    click / fill / select
    cookies / storage
    network capture
    screenshot
    set_file_input
  background/
  content/
```

Adapter 加载优先级建议为：

```text
用户或 Agent 优化版本
        ↓
用户生成或安装版本
        ↓
官方内置版本
```

## 8. Adapter 编程模型变化

当前 Adapter 直接注册页面 handler：

```js
window.__webmcpRegister({
  tools: [{
    name: "itsm.search",
    handler: async (args) => {
      return document.querySelector("...").textContent;
    },
  }],
});
```

目标模型可参考 OpenCLI：

```js
export default defineAdapter({
  tools: [{
    name: "itsm.search",
    async run(ctx, args) {
      return ctx.page.evaluate(`
        // 在目标页面中批量执行必要逻辑
      `);
    },
  }],
});
```

其中：

- Adapter 本身在 WebCLI / Node 中运行；
- `ctx.page` 是扩展浏览器能力的代理；
- `ctx.backend` 提供受控的后台请求能力；
- `ctx.files` 提供受控的文件读写能力；
- Adapter manifest 声明网络、文件、Cookie、写操作等权限。

为避免大量 IPC 往返，页面逻辑应支持批量 `evaluate` 或声明式操作流水线。

## 9. 推荐迁移策略

不建议一次性删除 `extension/adapters`，应采用双运行时兼容迁移。

### 第一阶段：建立外置 Adapter Runtime

- 建立 `~/.webcli/adapters/` 用户数据目录；
- 建立 Adapter manifest、加载器和工具注册协议；
- 定义 WebCLI ↔ Extension 的通用 Browser API；
- WeWorker 优先从 WebCLI 获取工具列表；
- 继续兼容扩展内旧 Adapter。

### 第二阶段：迁移 API / 后台型 Adapter

优先迁移：

- 已声明 `runtime: "background"` 的工具；
- 大量使用 `backend_fetch` 的 Adapter；
- 文件、Excel、数据处理型 Adapter；
- 不依赖复杂 DOM 状态的工具。

这部分与 OpenCLI 模型最接近，风险和改造成本相对较低。

### 第三阶段：迁移 DOM 型 Adapter

- 将简单 DOM 操作转换为批量 `page.evaluate`；
- 将通用点击、输入、选择、等待抽象为 Browser API；
- 对复杂页面流程保留临时扩展兼容模式；
- 完成覆盖率后，再从扩展产物中移除对应 Adapter 代码。

### 第四阶段：收敛扩展

当大部分 Adapter 已外置后：

- 扩展不再维护站点工具目录；
- 扩展只维护浏览器会话、页面路由、CDP 和通用执行原语；
- Adapter 与扩展可以独立更新和发布；
- 清理 `web_accessible_resources` 中的 Adapter 业务及知识文件。

## 10. 风险与约束

### 10.1 本地代码执行风险

外置 Adapter 在 Node 中运行，权限可能高于页面脚本，必须建立：

- Adapter 来源签名和哈希校验；
- 官方、用户、AI 生成 Adapter 的信任分级；
- 文件系统访问白名单；
- 网络域名权限；
- 读操作与写操作声明；
- 高风险操作确认；
- 默认禁止 `child_process` 等高危能力；
- 更新备份和版本回滚。

### 10.2 性能风险

如果每个 DOM 操作都经过 Node、Bridge、Extension 的单独 RPC，执行速度可能下降。

应提供：

- 批量 `evaluate`；
- 声明式 pipeline；
- 单次调用完成多步页面操作；
- 超时、重试和 trace 机制。

### 10.3 迁移兼容风险

现有 Adapter handler 与页面环境绑定较深，不能机械转换。迁移期需要同时维护：

- `extension` 旧执行模式；
- `node` 新执行模式；
- 统一工具名称、参数和返回结构；
- 统一权限及副作用策略。

## 11. 决策建议

如果产品未来只维护少量固定 Adapter，并且所有 Adapter 永远随桌面端和扩展统一发版，可以继续使用扩展内置模式。

但 WeWorker 当前已经具备：

- 自动探索；
- 自动生成 Adapter；
- Agent 二次优化；
- 用户安装和更新需求；
- 后台/API 型工具；
- Adapter Skill 和知识资产。

在这一产品方向下，继续把 Adapter 作为扩展内部资源会成为生命周期、升级、生态和工程效率方面的瓶颈。

最终建议：

> 立项推进 Adapter 外置架构。Adapter 的真源、安装、加载和业务执行迁到 WebCLI / Node；Chrome 扩展收敛为通用浏览器执行引擎。通过兼容层和分类迁移逐步落地，不进行一次性整体重写。
