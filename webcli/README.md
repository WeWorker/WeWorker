# WebCLI

连接 AI 工具与网站 Adapter 的统一命令行入口。

Extension Adapter 通过本地 WebSocket Bridge 连接 Chrome 扩展；Toolkit Adapter 通过 WeWorker 内嵌 Toolkit Runtime 执行。CLI 和桌面端统一使用 `webcli call` 调用网站工具。

**两类入口使用独立的 Bridge**：WeWorker 桌面端内置的 CLI 与扩展固定使用 `ws://localhost:3711`；npm 安装的独立 `webcli` 固定使用 `ws://127.0.0.1:3712`，并拥有独立的 PID/日志、浏览器 Profile 和 Adapter 数据目录。两者可以同时运行，登录态和浏览器实例不共享；如果 3712 被其他进程占用，npm CLI 会明确失败，不会连接桌面端的 3711。

**指标上报**：公开 npm 包默认关闭（包内 `metrics-client.json` 为 `{enabled:false}`）。发布方可在构建时通过 `weworker/model.json` 的 `environment.WEBCLI_METRICS_ENDPOINT`/`WEBCLI_METRICS_UPLOAD` 加构建环境变量 `WEBCLI_METRICS_CLIENT_TOKEN` 生成启用配置；用户进程环境变量始终优先，可用 `WEBCLI_METRICS_UPLOAD=off` 关闭。

## Adapter 定义

Adapter 是一组可被 WebCLI 发现、描述、安装和调用的网站工具。Adapter 是统一的产品概念，底层可以使用不同的执行 Runtime：

- **Extension Adapter**：通过 WebCLI Bridge 转发到 Chrome 扩展，在浏览器页面或扩展后台执行。
- **Toolkit Adapter**：通过本地 Toolkit Runtime 运行已导出的 Toolkit 脚本，再通过 Playwright/CDP 操作浏览器。

WebCLI 使用同一个 `webcli call <adapter-id>.<tool-id>` 入口，根据 Adapter 类型选择对应 Runtime：

```text
webcli call <adapter-id>.<tool-id> --key=value
                │
                ├─ Extension Adapter
                │  → WebCLI Bridge → Chrome 扩展
                │
                └─ Toolkit Adapter
                   → Toolkit Runtime → toolkit.py → Playwright/CDP
```

统一 Adapter 概念只统一发现、描述、安装和调用协议，不要求不同 Runtime 使用相同的执行实现。下文“工作原理”和“工具调用流程”描述 Extension Adapter 链路；Toolkit Adapter 不启动 Bridge，直接使用 WeWorker 内嵌 Toolkit Runtime。

现有 Extension Adapter 的 `manifest.json` 未声明 `adapter_type` 时按 `extension` 处理。Toolkit Adapter 必须声明 `schema_version: 1`、`adapter_type: "toolkit"`、固定入口与完整 Tool 列表；WeWorker 通过 `WEWORKER_ADAPTERS_DIR` 指向项目 Skill 根目录，普通 CLI 未设置时回退扫描 `<cwd>/.claude/skills/`。独立 npm WebCLI 缺少 Toolkit Runtime 时会明确失败，不回退系统 Python。

## 当前公开 Adapter

首次公开版本内置一批常用网站 Adapter，覆盖：

- 邮件、电商、代码托管、内容社区、社交媒体、阅读、金融信息、招聘、出行、资讯、百科、论文和发票等场景。
- 典型网站包括 QQ 邮箱、163 邮箱、Gmail、京东、小红书、B 站、知乎、GitHub、Gitee、豆瓣、微博、携程、12306、Wikipedia、arXiv 等。

以当前安装环境为准查看可用项：

```bash
webcli adapter list
webcli adapter info <adapter-id>
```

完整状态、能力边界和维护规则见 [`../docs/ADAPTERS.md`](../docs/ADAPTERS.md)。

## 工作原理

### 自然语言选择命令

```text
webcli route --help
webcli route github.com "List repository issues" --json
```

`route` 从当前生效的托管 Adapter 目录推荐规范命令，不执行命令。调用进程通过 `WEBCLI_D3_URL` 配置决策服务，未配置时不会使用固定地址。完整流程、结果与配置见 [自然语言路由说明](../docs/webcli-route.md)。

```
桌面端 3711 / npm 3712      WebCLI Bridge              Chrome 扩展（同端口）
    │                      ws://…                     │
    │  call_tool ─────────►│──────── 转发 ────────►│  Service Worker
    │                      │                         │      │
    │                      │◄──────── 结果 ─────────│  Injector → DOM
    │  ◄─── 结果 ──────────│                         │
```

Bridge 是消息中转站。扩展的 Service Worker 主动连接 Bridge（浏览器允许扩展发起 WebSocket），CLI 和桌面端也连接同一个 Bridge，Bridge 在两端之间透明转发消息。

除了消息转发，Bridge 还承担扩展无法直接完成的操作：

- **文件写入**：扩展无法写磁盘，由 Bridge 代为写入适配器文件
- **AI 生成适配器**：由 Bridge 调用 AI 生成适配器代码
- **扩展状态广播**：扩展连接/断开时广播事件，让桌面端感知扩展是否在线

## 工具调用流程

以一条完整调用为例：

```bash
webcli call mail.example.com.search_messages --keyword=invoice
```

```
① CLI 连接 Bridge，发送 call_tool 消息
       │
       ▼
② Bridge 转发给 Chrome 扩展
       │
       ▼
③ Chrome 扩展内部处理（详见 extension/README.md）
   - 根据工具名中的域名路由到对应的 tab
   - 如果没有匹配的 tab，返回错误（需先打开对应网站）
   - 执行操作时会自动激活目标 tab，用户可以看到操作过程
   - 如果 handler 还没就绪（适配器仍在注入中），会等待最多 8 秒
       │
       ▼
④ 结果沿原路返回：扩展 → Bridge → CLI
```

## 命令参考

```bash
# 服务管理
webcli service start [-d]          启动 Bridge（-d 后台运行）
webcli service stop                停止后台服务
webcli service status              查看服务状态

# WeWorker 浏览器（默认）：Bridge 按需启动独立 profile 的 Chrome/Edge，窗口在屏幕外，不打扰你。
# 与 WeWorker 桌面端共用同一个浏览器、登录状态和模式设置（~/.weworker/browser/）。
webcli browser status [--json]     查看状态
webcli browser show                把窗口移到屏幕内（登录网站、查看页面）
webcli browser hide                把窗口移回屏幕外
webcli browser start|stop|restart  启动 / 停止 / 重启（调用工具时自动启动；无客户端时空闲 30 分钟自动停止）
webcli browser mode [dedicated|system]  查看或切换模式（system = 使用你自己的 Chrome 和手动安装的扩展）

# 工具调用
webcli call <tool_name> [--key=value]   调用适配器工具

# 调用频次统计
webcli stats                            各 domain 调用频次（本地）
webcli stats --by tool                  按具体工具聚合
webcli stats --since 7d                 近 7 天（d/h/m，默认 30d）
webcli stats --kind adapter             只看 adapter（或 builtin）
webcli stats --top 10 --json            top N / JSON 输出
webcli stats --remote                   查询服务端全团队汇总

# 适配器查询
webcli adapter list [--json]            列出已安装适配器
webcli adapter info <id>                查看适配器工具列表
webcli adapter skill <id>               输出适配器的 SKILL.md
webcli adapter skill <id> --generated   输出适配器的 SKILL.generated.md
webcli adapter skill <id> --regenerate  重新生成 skill（生成式 adapter 默认写 SKILL.generated.md）
webcli adapter skill <id> --regenerate --overwrite  覆盖写入 SKILL.md
webcli adapter knowledge <id>           输出适配器的 WEBCLI_KNOWLEDGE.md
webcli adapter knowledge <id> --json    输出适配器的 WEBCLI_KNOWLEDGE.json

# Skill 安装
webcli install --skills [id]            安装 skill 到 ~/.claude/skills/
webcli install --skills --target <dir>  安装到指定目录

# 其他
webcli extension-path                   输出扩展目录路径
```

`adapter list --json`、`adapter info <id>` 和 `adapter skill <id> --regenerate` 会同时读取传统 `index.js` 工具，以及生成式 adapter 在 `manifest.json` 的 `support_files` 中声明的 `webcli-generated/tools/*.js` 工具。因此通过插件“探索 -> 录制操作 -> 生成工具”生成的 modular adapter 也能在 CLI 侧正确展示工具。

## Skill 系统

`webcli install --skills` 会把已安装适配器安装成 Claude Code skill 文件。对于生成式 adapter，优先直接复制 adapter 目录下已有的 `SKILL.md`；再次 scaffold 时如果目录里已经存在手工优化过的 `SKILL.md`，自动生成的新草稿会写入 `SKILL.generated.md`，避免覆盖成熟说明。安装时还会一并复制 `SKILL.generated.md`、`WEBCLI_KNOWLEDGE.md`、`WEBCLI_KNOWLEDGE.json` 等优化上下文文件，方便后续 Agent 多轮优化。对于传统单文件 adapter，则从 `index.js` 解析工具并生成 skill，让 Claude 知道如何通过 `webcli call` 操作对应网站：

生成式 adapter 还会在 adapter 目录下维护 `WEBCLI_KNOWLEDGE.md` 和 `WEBCLI_KNOWLEDGE.json`。这些文件保存自动探索、动作录制和生成工具时沉淀的接口结构、业务字段映射、样例摘要和已知问题，适合后续用 WeWorker、Claude Code、OpenClaw 或用户自己的 Agent 做多轮优化时读取：

```bash
webcli adapter knowledge mail.example.com
webcli adapter knowledge mail.example.com --json
```

```
~/.claude/skills/
├── webcli/                  # 基础 skill：webcli 命令语法
│   └── SKILL.md
├── webcli-jd.com/           # 京东适配器 skill
│   └── SKILL.md
├── webcli-mail.163.com/     # 163邮箱适配器 skill
│   └── SKILL.md
└── ...
```

## 安装

两种装法，二选一：

```bash
# 1) 只装命令行工具
npm install -g weworker-webcli

# 2) 连同「操作指令」一起装进 AI 客户端（Claude Code / Codex / Cursor 等）
npx skills add https://unpkg.com/weworker-webcli/skills/webcli/SKILL.md
```

第 2 种会把 `skills/webcli/SKILL.md` 装进你的 AI 客户端；之后直接用自然语言驱动即可（如「帮我搜下京东的手机」），
助手会调用 `webcli`，缺命令时按 SKILL.md 里的说明从 npm 装上。

装完后对 AI 说一句 **「帮我完成 webcli 首次准备」**，它会把扩展目录和需要你手动做的步骤直接列出来。

> 桌面端用户无需单独安装——WeWorker 已内置 WebCLI。

## 发布

两条发布线相互独立：npm 包是完整运行时（含 Chrome 扩展），skill 市场只发纯 skill（SKILL.md）。

### 更新 npm 命令行工具

发布前应将仓库根的 `extension/` 拷入 npm 包的临时构建目录；`extension/` 在仓库中保持单一事实源。

- npm registry 和发布凭证必须由发布环境显式配置，不得写入仓库。
- 发布版本号会写入 `package.json`。
- `--dry-run` 会额外列出生成式 adapter 关键文件，例如 `SKILL.generated.md`、`WEBCLI_KNOWLEDGE.*` 和 `webcli-generated/tools/*.js`，用于确认自动探索产物会随 npm 包带出。
- `--dry-run` 过程中即使指定版本号，也会在退出时恢复原 `package.json`，避免预览发布污染工作区。

### 更新 skill 市场

Skill 发布只包含 `skills/webcli/SKILL.md`。Extension、运行时和 Adapter 由 `webcli` 命令负责，不随 Skill 下发；各 Adapter Skill 由用户安装 WebCLI 后执行 `webcli install --skills` 本地生成。

- Skill 市场地址和访问令牌必须由发布环境显式配置，不得写入仓库。
- 发布版本号会写入 `version.json`，并同步到 `SKILL.md` 的 frontmatter `version` 字段；如果同一轮同时发布 npm 包，应保持与 npm 包版本一致。
- 注意：市场展示的版本号由服务端每次发布自动递增，仓库内的版本号仅作台账。

## 调用频次统计

每次工具调用都在 Bridge（`bridge.js` 的 `callTool`）收口处记一条元数据到 `~/.webcli/metrics.jsonl`（只记 `tool`/`domain`/`kind`/`ok`/`ms`/`traceID`/`err`，**绝不记 `args` 与 `result`**）。

- 本地查询：`webcli stats`（离线可用）
- 关闭埋点：`WEBCLI_METRICS=off`

### 回调上报到服务端（可选）

配置以下三项（齐备才上报）后，`webcli service` daemon 会每 60s 把本地新增记录批量上报到服务端，供 `webcli stats --remote` 查询全团队汇总：

| 环境变量 | 说明 |
|---|---|
| `WEBCLI_METRICS_UPLOAD=on` | 启用上报（默认关） |
| `WEBCLI_METRICS_ENDPOINT` | 服务端地址，如 `https://metrics.internal/v1/metrics/batch` |
| `WEBCLI_METRICS_TOKEN` | Bearer 鉴权 token |
| `WEBCLI_METRICS_USER` | 可选，团队账号；不设则只带匿名 clientId |

服务端部署见 [`../metrics-server/README.md`](../metrics-server/README.md)。

## 相关文档

- [extension/README.md](../extension/README.md) — 浏览器扩展的工作原理、适配器注册流程、适配器开发指南
- [metrics-server/README.md](../metrics-server/README.md) — 埋点服务端：上报接收、聚合查询、部署

### 分层帮助

`webcli <site> -h` 仅展示命令摘要；使用 `webcli <site> <command> --help` 或 `webcli call <site>.<command> --help` 查看完整参数。业务必填参数作为命名选项标注 `(required)`。

站点帮助 JSON 省略业务参数；命令帮助 JSON 提供参数，完整元数据仍可通过 `webcli adapter info <site> --json` 获取。显式 JSON、YAML、Markdown 输出继续沿用统一格式化接口。
