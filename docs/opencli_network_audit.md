# OpenCLI 网络观察、流式正文与回放审计

2026-10-29：已完成固定 1.8.8 direct CDP 的隔离 Worker/SW、SSE/长响应/失败核查，以及原 journal/artifact 导出函数 harness；本项目真实 CLI/Bridge/prepared 扩展和双 bundle 补对应证据。统一产物 `exploration.export` 已实现，契约和剩余限制见 [U06 专项](opencli_u06_diagnostics.md)。下表是源码审计起点，不能把旧“尚未开始”解释为当前状态；上游真实扩展/daemon 传输仍未验，未据函数 harness 宣称其全链路完成。

2026-10-28 排期：U01 只汇总静态和已有历史验证记录，没有完成本页统一产物导出。下一阶段 U06 的明确实施范围见 [U01 专项末节](opencli_u01_verification.md#下一阶段-u06)：优先有界、脱敏、来源明确的新目录导出；Worker/未结束流式正文/replay 先做固定 1.8.8 隔离行为核查，不展开 U04/U05。

2026-10-18。对照 npm 官方 1.8.8 的 `dist/src/browser/cdp.js`、`browser/daemon-client.js`、`observation/{session,artifact}.js`，以及公开仓库 v1.8.8 固定提交 `8271afc67e8504bda94c147f446ee29775d08274` 的扩展源码。该 tag 来自 GitHub refs API，完整 tree 返回 truncated=false；`extension/src/cdp.ts` Git blob 为 `c2ce05149ce3cbabe35fa76df83fbe05cb1cc150`，`journal.ts` 为 `b394b59aa236066003c041f926cea9248019e8d6`，下载内容已按 Git blob 算法核对。仅源码审计，没有运行外部账户或接管浏览器。

| 子项 | 上游实际实现 | 本项目现状与剩余证据 |
| --- | --- | --- |
| Worker 独立网络 | direct CDP 的目标评分排除 service_worker/background_page；扩展 `ensureFrameTarget` 仅解析 iframe，autoAttach filter 指定 iframe。网络捕获按 tab/requestId，读取正文发往 tab，没有 Worker 子会话的专门路由。不能把父页经 Service Worker 返回的请求等同 Worker 自发 fetch。 | 本项目 `browser-frames.js` autoAttach 明确仅 iframe；`browser-events.js` 可按已连接 frame session 读取正文，但未启用 Worker。当前不能宣称上游或本项目拥有完整 Worker 观察；仍保留隔离 Worker/SW 行为核对欠账，不由关键字搜索关闭。 |
| 流式正文 | direct CDP `loadingFinished → Network.getResponseBody`；扩展 cdp.ts:913 同样在完成事件后读取，8 MiB 字符上限并声明截断。两条路径未发现 `dataReceived`/`streamResourceContent` 的增量正文实现。 | 本项目连续 follow 是完成/失败/跳转事件，detail 使用 getResponseBody，限 500000 字符并显式省略。不能把事件 JSONL 视为 SSE/未结束响应的正文流。需隔离长响应行为核对，保持开放；上游 8 MiB 与本项目预算差异也需明确验收，不静默扩大。 |
| 请求重放 | observation/artifact 导出脱敏 trace/network/console JSONL、状态和截图，读取已有事件，没有重新发送流量。daemon-client 的 replay 是相同命令 ID 请求已记录结果；扩展 journal 保存 started/done，未结束返回 command_lost，过大结果返回 result_evicted，不重新执行。 | 本项目写消费账本和 uncertain 只读恢复保持；browser follow 游标只读保留事件。没有证据证明上游提供流量重发能力，不能据“replay”一词开发自动重写。历史记录读取、命令结果续取和流量重放分别核对，U06 未关闭。 |
| 统一诊断产物 | observation session 有时间/条数窗口；artifact 导出 receipt、summary、时间线、network、console、状态与截图文件，附保留策略。 | 本项目有任务 trace、知识、普通调用 trace 日志和独立 browser events/screenshot；`webcli trace` 查日志不等价于完整统一产物。确认存在需补的诊断导出差距，复用既有观察/脱敏/新路径保存，禁止自动删除既有文件或自动重放动作。实现与实机验收尚未开始。 |

这些结论不把尚未证实的上游能力认定为本项目缺失，也不移除台账范围。下一步以公开 loopback 的页面 fetch、Dedicated Worker、Service Worker、未结束流及失败动作分别核对可见事件、正文和诊断文件；有实现证据才能推进，没有实机证据继续留账。上游扩展源码不随 npm 包提供，因此此次额外核对固定 tag，不能仅依据 host 代码推断扩展全部行为。

下载初次出现连接重置/超时，已改用固定 Git blob 读取 journal 并验证摘要；没有执行上游安装器、没有写入本项目依赖。网络获取失败不计审计通过。
