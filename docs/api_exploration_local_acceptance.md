# API 自动探索本地验收

适用于基于 develop 整理的 `codex/api-exploration-optimization`。演示集成分支的真实样例见 [验证记录](api_exploration_reliability_plan.md)，不代表本分支完整客户端已通过。开发测试使用 glm-5.3，不在记录中提供 Key、Cookie 或账号。

## 启动与环境

正常退出已有 WeWorker，macOS 需退出应用；不要终止未知端口进程。新 checkout 在仓库根目录依次执行，任何命令失败先记录错误：

```powershell
npm --prefix .\webcli ci
npm --prefix .\weworker ci
npm --prefix .\weworker\backend-ts ci
npm --prefix .\weworker\renderer ci
uv sync --frozen --project .\components\webwright
node .\weworker\scripts\prepare-build.cjs --profile public
$env:WEWORKER_USER_ADAPTERS_DIR = Join-Path $env:LOCALAPPDATA 'WeWorker-API-Acceptance\adapters'
$env:WEBCLI_ADAPTERS_DIR = $env:WEWORKER_USER_ADAPTERS_DIR
npm --prefix .\weworker run dev
```

专用目录只隔离 Adapter 安装、草稿和包状态，客户端仍使用现有模型设置及探索记录，不代表整机干净。macOS 设置对应环境变量并使用独立本地测试目录。构建和源码必须来自同一 checkout。

在 Chrome 的 `chrome://extensions/` 加载本分支 `weworker/build/extension-dist/`，已有相同目录时重新加载。测试 Profile 仅启用这一份产品扩展，避免多个扩展争用 Bridge。客户端模型设置中确认主模型为 glm-5.3 并验证连通。

正常重启客户端以加载新的 Backend、Bridge 和 Renderer。仅刷新 Renderer 不会更新后台进程。旧 Bridge 会丢弃 auto 模式，不能用旧进程评价新版默认路径。3711 冲突时先只读确认进程归属，保留日志；不要直接结束未知 PID。日志应出现 `[bridge] running on port 3711` 且扩展已连接。

## 从零探索与默认生成

1. 在连接扩展的 Chrome 打开 `https://search.bilibili.com/all?keyword=excel`，确认能看到视频结果。
2. 在客户端左侧点击“API 探索”，刷新页面列表并选择该标签页。其他集成版本的入口可能位于“展开更多功能”。
3. 输入目标：“生成只读工具，按任意关键词搜索学习视频；返回标题、视频标识和可打开链接；验证 python 和 javascript，只使用真实捕获并回放成功的搜索接口。”
4. 点击“开始 API 探索”，保持页面打开。核对目标视频搜索接口已回放成功且被选中，仅有建议、推荐或配置接口不算成功。
5. 保存结果，点击主按钮“生成并验证”。核对目标工具清单、静态验证和全部目标真实页面执行均通过，无跳过。
6. 核对本机安装评审中的名称、来源、版本、权限及新增命令，确认后“安装并启用”。已有工具包应保留原命令和文件。

默认正常路径生成模型调用应为 0。触发修复时查看 `automaticRepair`：`modelCalls=1`、`timeoutMs≤60000`；原失败保留于 `initialValidationFailure`，旧草稿保留于 `draftHistory`。60 秒只限模型调用，后续页面验证另计。超时不能安装，迟到响应不能改写草稿。页面/登录/网络/证据问题不得通过模型修改掩盖。

模型探索分析最多 180 秒，不含被动捕获。未调用 `finish_api_exploration` 确认已验证目标时，默认生成必须拒绝；部分已选目标不能安全生成时也必须拒绝，不能只生成其他目标就算成功。

自动流程未发现目标时先记失败。另起一轮可以补充录制或显式“智能生成”，记录人工介入；辅助恢复不能替代从零自动成功。显式智能流程超时后经验证恢复的任务仍记超时恢复，不记模型正常完成。

## 安装后调用

在同一仓库根目录、使用相同专用目录的终端查询本轮新增工具的真实名称与参数：

```powershell
$env:WEWORKER_USER_ADAPTERS_DIR = Join-Path $env:LOCALAPPDATA 'WeWorker-API-Acceptance\adapters'
$env:WEBCLI_ADAPTERS_DIR = $env:WEWORKER_USER_ADAPTERS_DIR
node .\webcli\index.js adapter list --json
node .\webcli\index.js adapter '<本次生成的Adapter名称>' -help -f json
```

按实际工具名和关键词参数名调用，不用内置搜索命令替代：

```text
node .\webcli\index.js call <adapter-id>.<tool-id> --<关键词参数名>=python
node .\webcli\index.js call <adapter-id>.<tool-id> --<关键词参数名>=javascript
```

检查成功业务响应、非空视频结果、标识和视频链接，换词产生相应查询，任选链接打开核对。HTTP 200、任务完成或工具数量大于零均不能单独证明业务成功。

再新建客户端对话，明确要求使用本轮新增工具搜索同样的关键词，核对调用记录与参数。直调成功但自然语言未调用新工具应单独记为工具发现或调用问题。首轮通过后正常退出、重新启动客户端和浏览器，另建探索任务复验；分别记录 Windows/macOS、模型、首试与恢复、失败阶段、耗时及真实结果。

## 出错时保留现场

先保留当前任务、网页和终端；`main.log` 每次启动可能覆盖，重启前复制到本地诊断目录，不覆盖旧失败记录。设置 → 日志中查看准确路径。

- Windows 主日志位于 Electron userData 的 `logs/main.log`；macOS 通常为 `~/Library/Logs/WeWorker/main.log`，以客户端实际显示为准。
- 探索记录位于 `~/.weworker/client-exploration-runs.json`。
- 专用目录下生成记录通常位于 `adapters/.host-data/adapter-workspaces/public/runs/<run-id>/`；额外环境变量可改变位置。

记录失败时间、taskId/runId、错误原文、步骤、重试及补录情况。由排查人员在本机只读检查相关日志，不把完整日志、设置、真实响应、账号或凭据提交到仓库。
