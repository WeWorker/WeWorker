# WeWorker Roadmap

- 2026-10-28（关于页下载入口）：设置「关于」页的下载链接改为 GitHub 最新发布页面 `https://github.com/WeWorker/WeWorker/releases/latest`，自动更新配置保持独立。验证：Renderer 生产构建与差异检查通过。

- 2026-10-28（浏览器设置下拉样式）：移除“网站操作浏览器”通用下拉外层的宽胶囊边框，直接使用 `AppDropdownSelect` 标准外观；选项与即刻保存行为不变。验证：Renderer 生产构建与差异检查通过。

- 2026-10-31（对话日志导出与链路日志补全）：新增按对话导出诊断日志能力——Renderer 对话工具栏新增「导出日志」按钮，调用后端 `GET /works/:id/logs.txt` 下载包含环境头信息、对话时间线摘要（不含完整模型流量）与 `[work:前8位]` 标记的调用链路日志的 txt；后端 agent（turn_start/tool_call 决策日志，注入 `WEWORKER_WORK_ID`）、webcli CLI→Bridge→扩展全链路透传对话 id 并在收单/分段/成功/失败/登录判定/登录后重试日志行打标。验证：backend `work-log-export.test.ts`、`agent-sdk-config.test.ts` 断言更新、`agent-tool-policy.test.ts`、webcli `bridge-call-timing.test.js`（新增 workId 用例）等 bridge 子集与 Renderer `npm run build` 通过，backend typecheck 通过；`chat-session-sdk`/`chat-session-steering-sdk` 两个真实 CLI 测试在未改动基线上同样失败（预存环境问题）。端到端导出按钮在桌面端的实际下载未验证。

