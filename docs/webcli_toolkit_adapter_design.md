# WebCLI 统一 Adapter 与 Toolkit Runtime 设计

## 文档状态

- 版本：`1.0`
- 日期：2026-08-06
- 状态：代码基线已实现；macOS arm64 真实 embedded 闭环、macOS x64 与 Windows x64 安装包待验收
- 适用范围：WeWorker 内置 WebCLI、Extension Adapter、网站探索导出的 Toolkit Adapter
- 进度源：[`../ROADMAP.md`](../ROADMAP.md)

## 一、结论

WebCLI 统一 Adapter 的产品概念、发现、描述和命令入口，但不统一两类 Adapter 的执行实现：

```text
Claude Code 原生 Bash／PowerShell
→ webcli call <adapter-id>.<tool-id> --key=value
→ WebCLI Adapter Registry
   ├─ adapter_type=extension
   │  → WebCLI Bridge → Chrome 扩展
   └─ adapter_type=toolkit
      → Toolkit Runner → embedded Toolkit Runtime → toolkit.py → Playwright/CDP
```

本次删除面向 Agent 的 `webcli_call` MCP，以及 `webcli-py`／`webcli-py.cmd` 包装器。所有 Adapter 调用只通过 Claude Code 原生 Bash／PowerShell 执行 `webcli`。`qa_only` 与 `no_bash` 暂时不具备 Adapter 执行能力，`full` 允许两类 Adapter。

Backend 内部快捷逻辑仍可复用 `runWebcliCall()`；`webcli_result`、大结果落盘和结果投影不在本次迁移范围。后续将其下沉到 WebCLI 并提供 CLI 结果读取命令，单独在 Roadmap 跟踪。

## 二、Adapter 合同

### 2.1 统一类型

- `adapter_type=extension`：由 Bridge 转发至 Chrome 扩展执行。
- `adapter_type=toolkit`：由 WebCLI 直接启动 embedded Toolkit Runtime 执行。
- 现有 Extension Adapter manifest 缺少 `adapter_type` 时按 `extension` 解释；新生成 manifest 必须显式声明。

### 2.2 统一工具名

用户调用使用 manifest 注册的完整 Tool 名 `<adapter-id>.<tool-id>`。WebCLI 按完整名称精确解析，不按域名或第一个句点拆分。重复注册同一完整名称时失败关闭，不允许 Toolkit 静默覆盖 Extension Adapter。

### 2.3 Toolkit 五文件产物

Toolkit 正式交付从四文件调整为五文件：

```text
<adapter-id>/
├── manifest.json
├── SKILL.md
└── scripts/
    ├── toolkit.py
    ├── toolkit_runtime.py
    └── requirements.txt
```

Toolkit manifest 至少包含 `schema_version`、`id`、`name`、`description`、`adapter_type=toolkit`、固定入口 `scripts/toolkit.py`、允许域名、`artifact_hash`，以及每个 Tool 的 `id`、完整 `name`、描述、参数 Schema 和返回 Schema。

Publisher 必须从同一正式事实源确定性生成 `manifest.json`、`SKILL.md` 和正式 CLI。`artifact_hash` 继续只覆盖两个正式执行文件；现有 `distribution_checksums` 扩展为覆盖 `manifest.json`、`SKILL.md` 和 `scripts/requirements.txt`，不新增第三种 hash。

## 三、发现与安装

Extension Adapter 同时从安装包内置目录和 `~/.weworker/adapters/` 用户目录发现；用户安装与内置同名时使用 `.user` 后缀共存。内置目录保持只读，WebCLI 只允许移除用户 Adapter。Bridge 注入和扩展热重载协议保持不变。

网站探索只在当前 Toolkit 满足 `export_eligible=true` 后，将五文件 Adapter Skill 原子覆盖到 `<user_directory>/.claude/skills/<adapter-id>/`。不增加任意 ZIP、URL 或本地路径导入，不维护第二套安装索引。

WeWorker 启动 Claude Code 时向 WebCLI 提供固定且不得记录日志的 `WEWORKER_ADAPTERS_DIR=<user_directory>/.claude/skills`。WebCLI 优先扫描该目录；普通 CLI 未设置该变量时扫描 `<cwd>/.claude/skills`。只接受直接子目录中的 Toolkit manifest，拒绝绝对入口、目录逃逸、符号链接和缺失文件。

## 四、调用与参数

新 Skill 使用非 JSON flag 为主：

```bash
webcli call wuhan-property.download-fangcha-pdf \
  --name="张三" \
  --year=2026 \
  --force=true
```

WebCLI 保持现有基础解析行为：普通值保持字符串，数字不自动推断；`true`／`false` 保持现有布尔转换；对象／数组解析局部 JSON；重复 flag 聚合为数组；保留现有 `--args`。WebCLI 不读取业务 Schema 做类型转换、默认值或合法性校验。

Toolkit Runner 只把完成基础解析的参数对象通过内部 JSON stdin 传给 `toolkit.py`。生成的 Toolkit Adapter 自己负责外部参数名映射、按自身 Schema 转换数字、应用默认值、校验参数并返回结构化 JSON。

## 五、Runner 边界

Extension Runner 保持当前行为：需要时确保 Bridge 可用，通过 WebSocket `call_tool` 执行，保留当前 timeout、trace 和结果格式。

Toolkit Runner 在确认 Tool 属于 Toolkit Adapter 后直接执行：

```text
<embedded-runtime> --internal-script <adapter-root>/scripts/toolkit.py <tool-id>
```

Runner 必须使用 `spawn` 且 `shell=false`，使用 Adapter 根目录作为 `cwd`，清除 `PYTHONHOME`／`PYTHONPATH`，设置 `PYTHONNOUSERSITE=1` 与 `PYTHONDONTWRITEBYTECODE=1`，继承固定 Toolkit 数据根，转发 stdin、stdout、stderr、真实退出码和终止信号。它保持前台子进程关系，不连接 `8766` Server；按需启动或连接 Bridge，由 Bridge 提供唯一受管浏览器及任务占用，业务仍由独立 embedded Runtime 执行。完整合同见 [共享浏览器实施方案](shared_browser_implementation_plan.md) 。

Toolkit Runner 使用现有 WebCLI metrics 格式记录工具名、成功、耗时、trace 和脱敏错误，不记录参数、结果、密钥或用户路径。两类命令纳入共享浏览器任务占用；业务 metrics 保持原执行入口计数，避免重复计数。

## 六、Skill Runtime 与权限

Toolkit `SKILL.md` 不再出现脚本路径或 `webcli-py`，只描述完整 Tool 名、参数和 `webcli call` 命令。基础 WebCLI Skill和 WeWorker 系统提示词统一要求网站 Adapter 使用 Claude Code 原生 Bash／PowerShell，不得使用 WeWorker Shell。

| 能力 | `qa_only` | `no_bash` | `full` |
|---|---:|---:|---:|
| 标准 Skill | 禁止 | 允许 | 允许 |
| 原生 Bash／PowerShell | 禁止 | 禁止 | 允许 |
| Extension Adapter | 禁止 | 禁止 | 允许 |
| Toolkit Adapter | 禁止 | 禁止 | 允许 |

本次不恢复 `no_bash` 的 Adapter 能力。

## 七、删除与保留

删除面向 Agent 注册的 `webcli_call` MCP、描述、权限白名单和相关测试；删除 `webcli-py`／`webcli-py.cmd` 生成、打包资源、提示词、守卫和测试；不提供旧 Skill 兼容和迁移，旧 Skill 必须重新安装。

保留 Backend 内部 `runWebcliCall()` 及内部快捷调用；保留 `webcli_result`、大结果缓存与结果投影，后续另行下沉；Extension Bridge 增加共享浏览器控制和占用协议，业务执行协议保持不变；保留 Toolkit formal Debug、`artifact_hash`、`export_eligible`、Runtime Store 和 Playwright/CDP；不恢复独立 installer 或第二套 Runtime。

## 八、交付边界

本次保证 WeWorker 开发态和安装包内 WebCLI 可运行 Toolkit Adapter。独立 npm WebCLI 没有 Toolkit Runtime 时必须明确失败，不回退系统 Python、`uv`、`pip` 或 WeWorker 私有安装路径。独立 WebCLI 应用的 Runtime 打包另行设计。

## 九、验收

- Extension Adapter 继续通过 `webcli call` 和 Bridge 运行。
- 当前使用宿主公共 Runtime 的 v2 Toolkit 产物无需重新生成业务代码即可共用浏览器；已识别的自带旧浏览器启动逻辑的历史 Runtime 明确要求重新生成安装，禁止默默启动第二个浏览器。
- Toolkit 调用按需启动 Bridge 并复用受管浏览器，不启动或依赖 `8766` Server。
- WebCLI 参数基础行为保持不变，Toolkit 自行完成 Schema 类型处理。
- Toolkit 的 cwd、stdin、stdout、stderr、退出码和信号转发正确。
- Agent 取消和应用退出后无 Toolkit Runtime 或 Playwright 子进程残留。
- `qa_only`／`no_bash` 不能执行 Adapter，`full` 通过原生 Bash／PowerShell执行。
- 安装包不包含 `webcli-py`／`webcli-py.cmd`，Backend 不注册 `webcli_call`。
- `webcli adapter list／info／skill` 同时发现两类 Adapter，冲突和非法 manifest 失败关闭。
- macOS arm64 自动化及真实 embedded 探针通过；macOS x64、Windows x64 按平台完成最终安装包验收。
