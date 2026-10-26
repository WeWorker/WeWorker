# WeWorker 标准 Skill 与 Adapter Runtime 设计

## 文档状态

- 版本：`3.0`
- 日期：2026-08-06
- 状态：统一 WebCLI 入口代码基线已实现；macOS x64、Windows x64 与最终安装包仍待验收
- 适用范围：WeWorker 内置 Claude Code SDK 的 `qa_only`、`no_bash`、`full` 三种权限模式
- 关联设计：[`webcli_toolkit_adapter_design.md`](webcli_toolkit_adapter_design.md)、[`webwright_integration_design.md`](webwright_integration_design.md)
- 进度源：[`../ROADMAP.md`](../ROADMAP.md)

## 一、结论

标准 Skill 仍由 Claude Code SDK 原生加载。网站操作统一使用 Adapter 概念与一个命令入口：

```text
Skill 指令
→ full 模式的 Claude Code 原生 Bash／PowerShell
→ webcli call <adapter-id>.<tool-id> --key=value
→ WebCLI Adapter Registry
   ├─ Extension Adapter → Bridge → Chrome 扩展
   └─ Toolkit Adapter → embedded Toolkit Runtime → toolkit.py → Playwright/CDP
```

统一的是 Agent 调用入口、发现和描述协议，不是两类 Adapter 的底层 Runner。`webcli_call` MCP 与 `webcli-py`／`webcli-py.cmd` 不再属于产品合同。

## 二、Skill 来源与安装目录

Claude Code SDK 继续使用隔离配置目录：

```text
CLAUDE_CONFIG_DIR=~/.weworker/claude-config
```

非 `qa_only` 模式启用 `user` 与 `project` setting sources：

- 普通用户 Skill 可从 `<CLAUDE_CONFIG_DIR>/skills/` 加载。
- 网站探索达到 `export_eligible=true` 后，将五文件 Toolkit Adapter Skill 原子安装到 `<user_directory>/.claude/skills/<adapter-id>/`。
- Claude Code 的工作目录固定为 `<user_directory>`，因此该目录作为 project Skill 被 SDK 发现。
- WebCLI 通过 `WEWORKER_ADAPTERS_DIR=<user_directory>/.claude/skills` 发现 Toolkit Adapter，不自行扫描或修改其他 WeWorker 数据。
- WeWorker 不解析 Toolkit 的业务实现，也不把 Skill 转换为 MCP schema。

Toolkit Adapter Skill 固定为：

```text
<adapter-id>/
├── manifest.json
├── SKILL.md
└── scripts/
    ├── toolkit.py
    ├── toolkit_runtime.py
    └── requirements.txt
```

## 三、权限合同

| 能力 | `qa_only` | `no_bash` | `full` |
|---|---:|---:|---:|
| 标准 Skill | 禁止 | 允许 | 允许 |
| 原生 Bash／PowerShell | 禁止 | 禁止 | 允许 |
| Extension Adapter | 禁止 | 禁止 | 允许 |
| Toolkit Adapter | 禁止 | 禁止 | 允许 |
| WeWorker Shell | 禁止 | 允许 | 允许 |
| `webcli_result` | 禁止 | 允许 | 允许 |

约束如下：

- `full` 使用当前平台的 Claude Code 原生命令工具；macOS／Linux 为 Bash，Windows 为 PowerShell。
- Adapter 命令必须由原生命令工具执行，WeWorker Shell 对所有 `webcli` 命令失败关闭。
- `qa_only` 禁止 Skill 与所有工具。
- `no_bash` 可读取标准 Skill，但不能执行 Adapter；本阶段不提供替代入口，也不通过 MCP 恢复。
- 聊天输入框的 `!command` 是用户主动执行通道，不经过模型的 Adapter 权限判断。

## 四、统一命令与参数边界

Toolkit Skill 与 Extension Skill 均使用：

```bash
webcli call <adapter-id>.<tool-id> --key=value
```

WebCLI 只做基础 CLI 解析：

- 普通值保持字符串，数字不自动推断。
- `true`／`false` 保持现有布尔转换。
- 对象和数组可使用 JSON 字面量。
- 重复 flag 聚合为数组。
- 现有 `--args` 继续保留。
- WebCLI 不按业务 Schema 做类型转换、默认值和合法性校验。

Toolkit Adapter 自己负责连字符参数名映射、数字和数字数组转换、默认值、枚举与业务 Schema 校验。Extension Adapter 继续使用自身既有参数处理路径。

## 五、Toolkit 发现与执行

WeWorker 启动 Claude Code 时：

1. 把内置 WebCLI 目录加入 `PATH`。
2. 注入固定且不记录日志的 `WEWORKER_ADAPTERS_DIR`。
3. 保持 `WEBWRIGHT_HOME` 的固定数据根合同。

WebCLI 只扫描 Adapter 根目录的直接子目录，校验：

- `schema_version=1` 与 `adapter_type=toolkit`。
- manifest `id` 必须等于目录名。
- `entry` 固定为 `scripts/toolkit.py`。
- 五个文件必须存在且不是符号链接。
- 两个执行文件必须匹配 `artifact_hash`。
- Tool 完整名称必须精确等于 `<adapter-id>.<tool-id>`。
- Toolkit 与 Extension 的 Adapter ID 或完整 Tool 名冲突时失败关闭。

命中 Toolkit Tool 后，WebCLI 不启动 Bridge，直接执行：

```text
<embedded-runtime> --internal-script <adapter-root>/scripts/toolkit.py <tool-id>
```

Runner 使用 `spawn` 与 `shell=false`，以 Adapter 根目录为 `cwd`，通过 JSON stdin 传入基础解析后的参数，清除 `PYTHONHOME`／`PYTHONPATH`，设置 `PYTHONNOUSERSITE=1`、`PYTHONDONTWRITEBYTECODE=1` 与内部参数 stdin 标记，并转发 stderr、退出码和终止信号。

独立 npm WebCLI 没有 embedded Toolkit Runtime 时必须明确失败，不回退系统 Python、`uv`、`pip` 或私有安装路径。

## 六、MCP 与结果缓存

面向 Agent 的 `webcli_call` MCP 已移除。Backend 内部 ITSM 快捷路径继续复用 `runWebcliCall()`，这不是 Agent 的 Adapter 入口。

`webcli_result`、大结果落盘和结果投影暂时保留。后续将这些能力下沉到 WebCLI CLI，作为独立 Roadmap 事项，不与 Toolkit Adapter 改造混合。

## 七、打包与进程生命周期

WeWorker WebCLI 产物只包含：

```text
resources/webcli/
├── webcli
├── webcli.cmd
├── webcli.cjs
└── skills/
```

安装包不包含 `webcli-py` 或 `webcli-py.cmd`。WebCLI 相对定位同一安装包的 embedded Toolkit Runtime；开发态定位 `build:webwright` 产物。

Claude Code CLI 始终运行在独立进程组中。会话取消或 Backend 退出时复用现有进程树回收机制；WebCLI 同时把 `SIGINT`／`SIGTERM` 转发给前台 Toolkit Runtime，避免 Toolkit 与 Playwright 子进程脱离调用生命周期。

## 八、验收状态

代码基线已覆盖：

- Publisher 确定性生成五文件 Toolkit Adapter 与 manifest。
- WebCLI Registry、Toolkit Runner、`adapter list／info／skill` 和冲突失败关闭。
- Toolkit 参数由 Adapter 自己转换，WebCLI 保持基础参数行为。
- Backend 不注册 `webcli_call`，WeWorker Shell 拒绝 `webcli`。
- `qa_only`／`no_bash`／`full` 权限提示与策略一致。
- WebCLI bundle 与安装资源不再生成或收录 `webcli-py`。

仍需按平台完成最终安装包验收：macOS arm64 真实 embedded Toolkit 调用、macOS x64、Windows x64，以及真实 SDK 取消后的进程残留检查。
