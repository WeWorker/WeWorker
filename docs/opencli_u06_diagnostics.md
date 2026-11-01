# U06：任务诊断产物与网络行为核查

2026-10-29。公开仓库独立分支 `codex/opencli-u06-diagnostics`，目标 `dev-1.0.2`。从 U01 `72b01a3` 接续，核验 #181/#186/#187/#188 均 OPEN，逐级祖先成立，`git cherry` 未发现目标分支已有等价 patch。合入最新目标 `c15dfe5`（登录立即返回修复），没有重复摘取前序提交或修改其他 checkout。依赖链为本 PR → #188 → #187 → #186 → #181。未来若前序 squash/rebase，仍须按 patch/祖先重新整理增量。

## 入口与范围

```text
webcli call exploration.export --profile <明确的profile> --args-file export.json
```

`export.json` 示例（父目录必须已存在）：

```json
{
  "taskId": "00000000-0000-0000-0000-000000000000",
  "directory": "C:\\Example\\diagnostics-new",
  "since": "2026-10-29T01:00:00.000Z",
  "until": "2026-10-29T01:05:00.000Z",
  "limit": 200
}
```

浏览器任务沿用 `--profile`/`WEBCLI_PROFILE` 和已有默认选择规则，歧义或指定 profile 失效时不切换到其他连接。建议显式指定 profile；任务 ID 只在该 profile 的任务库查找。`http-<uuid>` 自动选择既有 host HTTP 任务库，无浏览器。没有任务的 legacy/Toolkit 普通调用不在本入口范围；其静态诊断继续使用 U01 `adapter verify --runtime`，不启动 embedded Toolkit。

Bridge 必须已经运行。此命令不自动启动 Bridge/浏览器、不接管端口、不调用 Adapter 工具、不重发请求、不进行效果 GET、不修改写授权或消费账本。它导出已有任务记录并可读取绑定 tab 的当前观察；不新建 observation session 或 Runner。扩展需声明 `browser_diagnostics_v1`，否则浏览器来源明确缺失，不退回遍历标签页。

`since/until` 是 UTC ISO 时间，闭区间，必须在任务创建至本次导出开始之间；默认使用这个完整区间。时间窗用于任务事件、network、console、普通调用 trace。状态、静态包检查、知识和可选截图各自记录采集时间，不伪装成窗口结束时的页面快照。一次固定任务快照配合逐项采集，不承诺所有证据原子同时发生。

可选 `traceIds` 接受最多 10 个明确的 12–32 位十六进制普通调用 ID。host HTTP 任务也接受其普通调用实际返回的标准小写 UUID，原样输入；这只允许诊断报告明确说明该来源不可用，不代表关联、查询或保存了 HTTP trace。浏览器任务不接受 UUID。只读选定扩展 SW 和任务原 tab 的 trace buffer，不遍历其他标签页。ID 与任务关联由调用方明确选择，不据此认证调用属于某次作者用例。旧日志只有时分秒的记录无法可靠套用跨日窗口，计入 `recordsWithoutUsableTime`；新 SW/content trace 保留 UTC 日期。Bridge 文本日志和 host HTTP CLI 的 stderr 没有可按任务/profile 确认归属的持久 trace 接口，本命令不扫描全局日志或猜路径；HTTP 指定此项会明确部分失败。

可选 `screenshot:true` 明确请求任务原 tab **当前 viewport** 的 PNG，含可见子 frame；不做全页滚动、标注、尺寸改写或其他 tab 采集。图片像素无法保证脱敏，故默认不采集，显式开启时报告 `pixelsRedacted:false`。当前 origin 和保留 tab identity 在扩展内核对，失败不找替代页面。HTTP 请求截图为明确缺失。

## 导出契约与安全

新目录包含 `receipt.json`、`summary.md`、`timeline.jsonl`、`task-trace.jsonl`、`task-state.jsonl`、`network.jsonl`、`console.jsonl`、`state.jsonl`、`adapter.jsonl`、`knowledge.jsonl`、`call-trace.jsonl`、`screenshot.jsonl`，以及显式成功采集时的 `screenshot.png`。receipt 列出证据文件字节数和 SHA256，最后写入，作为目录写入完成标记；summary 为便于阅读的同一状态摘要。

每个来源都有 source、evidence 类别、采集时间、runtime/platform/Node/profile 引用、条数/字节预算、实际条数/字节、截断和状态/失败原因。状态区分 available、partial、missing、failed、not-selected、not-applicable。`ok:true` 仅代表成功保存报告；`data.complete:false` 与 receipt 的 `status:partial` 仍使 CLI 退出 **1**。静态缺陷或历史证据不足也保留在报告，不冒充当前运行成功。完整契约内导出退出 0，非法参数/路径或保存失败退出 1。

证据分层：

- `adapter` 复用 U01 对当前有效包、来源和摘要的静态检查，编译检查不执行作者代码。
- `knowledge` 只使用该任务服务的知识根，复用包/命令摘要、期限和 read cases / write effect 历史判定。不存在或不匹配时明确部分结果。
- task trace/state、浏览器缓冲与普通 trace 是历史数据。写 outcome 为 verified 也只标明历史独立效果验证，不认证此刻效果。
- DOM metrics 和可选 screenshot 是本次当前观察，不运行作者业务断言。所有产物保持 `currentEffectVerified:false`、`replayAllowed:false`。

每个 JSONL 来源最多 200 行、256 KiB，可用 `limit:1..200` 降低行数；timeline 也有独立同样预算，裁剪明确标记。原任务和浏览器各 channel 最多保留 200 项，环形缓冲淘汰、pending gap、hasMore 不被掩盖。普通 trace 每 ID 每 SW/tab 来源最多读 100 条，每输入行最多 8000 字符；无法证明 buffer 从未淘汰，故选取 trace 时始终标明部分证据及 `completenessKnown:false`。截图上限 2 MiB；过大/无效图片不输出截断 PNG。

JSON 采用字段白名单，省略 URL、headers、Cookie、Authorization、Token、响应正文、参数、实际业务 ID、账号、控制台/日志原文、页面标题/文本、源码和本机路径。site/profile/command/endpoint 使用每次导出随机密钥的引用，仅在同一产物内可关联；包摘要保留供来源核对。普通 trace 只输出时间、层和固定的开始/完成/失败类别。截图是唯一显式选择的原始内容例外。

目录必须是绝对新路径、父目录已存在。拒绝 `.`/`..`、UNC、链接/junction、已有文件/目录和受管 task/Adapter 存储内的目的地；逐级检查祖先，异步采集后再次检查。独占 mkdir 和 `wx` 写入，失败保留已生成文件，不合并、不覆盖、不删除旧产物。文件系统并发恶意修改不是跨平台事务保证；目录内容变动应停止并检查。

## 固定上游行为证据

仍为 npm `@jackwener/opencli@1.8.8`，tarball SHA256 `68fb69d6dcfbcb1f76da88278b499abe322dcca712f3b79fe01729cb63ae6d7a`。当前实际核对执行/审计模块与 tarball 字节一致。扩展 tag 固定 `8271afc67e8504bda94c147f446ee29775d08274`，重新从 Git blob 读取 cdp/journal 并核验摘要；没有检查新版或升级用户工具。

| 行为 | 本轮证据 | 结论边界 |
| --- | --- | --- |
| Worker | 未修改的上游 CDPBridge 连接任务浏览器；服务器独立确认 Dedicated/SW 自发 fetch；父页 page fetch 与经 SW 返回的请求可见，自发 Worker 请求不在捕获列表 | 本项目真实 CLI/Bridge/prepared 扩展复现相同区分；不实现未证实的完整 Worker 观察 |
| 流式 | 上游未结束 SSE/长响应只有请求/响应元数据，正文缺失；另一次保留至完成后两者正文可读 | 上游 readNetworkCapture 会取走列表，不是增量正文流。本项目只在完成/失败产生事件；完成 JSON 正文可读，非 JSON SSE 继续明确省略 |
| 失败 | 上游失败请求无完成正文；本项目有 failed 事件，诊断导出保留 phase/status | 请求发生和正文可用是不同证据，不能把事件 follow 当正文流 |
| replay | 固定 journal 函数在 harness storage 中验证 concurrent/done/restart 同 ID 只有一次实际 loopback 请求；started 返回 command_lost，过大结果返回 result_evicted | 是已记录命令结果续取；不是流量重发。未验证 upstream CLI/daemon/扩展跨进程断线全链路 |
| artifact | 实际调用 ObservationSession/exportObservationSession，得到 receipt/summary/trace/network/console/state/screenshot；服务器请求计数不变 | 是导出函数 harness，不能冒充上游完整 CLI/扩展观测；确认统一产物差距有实际依据 |

复现：`webcli/scripts/audit-opencli-u06.mjs --upstream=<1.8.8解包根> --journal=<固定blob源码> --playwright=<模块> --chromium=<程序>`。脚本执行上游原导出，journal 只移除 TS 类型并提供任务自有 storage。上游扩展网络路径仍只有固定源码审计，未完成真实 upstream 扩展传输验收；保留这个行为范围，不从 direct CDP 推断其所有细节。

## 验收与保留失败

全部实机副作用只发生于任务自有 loopback、临时浏览器/Bridge 和测试目录；没有实际客户端安装、全局 npm 修改、真实账户写、发布或 CI/CD 改动。

- `verify-exploration-browser.mjs --diagnostics-only`：真实 Worker/SW、SSE/长 JSON、失败响应，导出脱敏/零请求/拒绝覆盖/截图/截断/关闭 tab；双 bundle 追加第二个真实 profile 拒绝读取原任务。
- `--u06-trace-only`：复用已有后台 Adapter 验收流程，真实生成/作者验证/安装/普通调用/知识后按实际 trace ID 导出；没有为诊断能力另造安装包或 Runner。
- `verify-exploration-http.mjs --u06-only [--bundled]`：现有 HTTP 两组作者 cases、安装/普通调用/知识与诊断产物关联，零新请求。
- `verify-u06-npm.mjs --npm-dir=<实际临时安装> --http-fixture=<上述真实HTTP目录>`：复制保留的实际任务/包/知识至新隔离根，实际 npm CLI＋Bridge 读取，缺 Bridge 不启动，unsupported 请求明确部分结果；源码/prepared/npm 文件字节核对。它没有重新执行作者 cases或普通调用。
- 单测覆盖选择/窗口、任务与事件丢失、行数/字节预算、脱敏、旧 trace 无日期、来源缺失、目录/链接/采集期间竞争、磁盘失败保留、零动作及旧扩展/HTTP 限制。

首轮浏览器验收错误期待非 JSON SSE 完成正文原样返回，实际命中既有省略规则；修正验收区分 SSE 和 JSON 长响应，未放宽运行时脱敏。该失败报告 `webcli-browser-acceptance-OwuGGz` 保留。最终报告标识、完整测试数量与提交 CI 见交接，不把中间通过数加成独立案例总数。

U06 本轮关闭的是上述契约内统一任务诊断产物及其分发验收缺口，补了限定网络/replay 行为证据；没有实现完整 Worker 捕获、未结束增量正文、HTTP/Toolkit 全局普通 trace 汇总或真实流量重发。上游扩展/daemon 的完整行为核查仍可另行安排，不能把未证实能力列为必须实现。U04/U05、U03 站点行为及所有 E 系列继续独立；E02 Windows/macOS 实际客户端安装保持开放。

前序边界不变：W03 只在探索任务内编排，安装后单工具调用；W01/W02/B02 是明确页面/控件契约，不覆盖任意第三方控件或闭合 Shadow；W04 仅明确实际响应来源且精确 decimal ID 最多 512 字符；B02 上传为 browser 原语，不含 File System Access/OS 窗口或自动生成安装态复合上传；U01 历史 evidence 不认证当前效果、不授权写，远程 Git/TS 插件生命周期和 embedded Toolkit 真运行仍开放。
