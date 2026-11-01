# OpenCLI 页面上下文与工作流编排审计

2026-10-18。B01 跨 origin/frame 的源码核对与后续实现记录；源码审计本身不代表行为验收。跨源主文档最终完整双打包 109 项 9ccf6Q、连续 102 次调用与组合 12 项通过；frame 仅保存未接入基础且探针有失败。按用户要求在此暂停，完整证据见交接末尾。上游对照 npm 1.8.8 与固定 tag `8271afc67e8504bda94c147f446ee29775d08274`。扩展 `background.ts` Git blob `efcb9efa99225e4f6bc57e9f58b1e6f1990370e8`、`cdp.ts` `c2ce05149ce3cbabe35fa76df83fbe05cb1cc150` 已与固定 tree 按 Git blob 算法核对；不依赖最新分支推断。

| 能力 | 上游实际代码 | 本项目现状 |
| --- | --- | --- |
| 跨源主文档导航 | browser/page.js:86–122 的 goto 发送明确 URL、保留返回 targetId；background.ts:1723 起只校验 HTTP(S) 后对同 tab 更新 URL，可跨 origin。导航完成可接受重定向；相同 URL 完整页直接返回。 | browser.open 已有明确 URL 能力；生成的 navigate/workflow 现由 resultOrigin/step.origin、任务 allowedOrigins、完整 pageRoute 权限和 continuation 接通。不同来源不能交叉使用路径，保持新文档/完整 URL 与固定 tab；不沿用上游同 URL 直接返回旧结果的行为。 |
| frame 列举与读取 | page.js:324–330 frames/evaluateInFrame；background.ts:1678–1708 每次用当前树枚举跨源 frame，再按 frameIndex 找 frameId；cdp.ts:653 起按上下文执行，失效 context 可重新解析 target。 | browser.frames 返回 Chrome frameId/documentId；browser-frames.js 用 documentIds 和 uniqueContextId 固定页面，隔离标记关联 OOPIF，嵌套自动 attach。已验单条读取/点击/上传，但 page-source/page-query 固定 frameIds:[0]，工作流无 frame 声明。 |
| 分支与分页 | Gmail utils.js:479–543 先 search 后 next，有界页数、缺 next/短页结束、去重、重复页无新增拒绝部分结果。 | 本增量提供受权限绑定的 when/repeat/until/collect，真实公开分页已验；只读原生控件、固定同源主文档，不能外推任意站点或其他上下文。 |

下一实现必须同时处理以下边界：

1. 声明每步起始 origin 与明确目标 origin/path，限定导航步骤可以切换；所有目标进入包 match、精确 route 权限与预览授权，不能仅放开事件监听的同源判断。已选 tab/profile 固定，不追随其他 tab 或切换 profile。
2. 跨源后命令注册器所属文档会消失，须使用既有一次后台执行与 continuation 路径，并核对整包注入/最终结果映射仍在原授权下。任务身份检查只允许本操作已声明并实际完成的目的地，不扩大其他 observe/write/collect 的来源权限。
3. frame 生成契约不能持久化某次浏览器的临时 frameId/documentId，也不能按同 URL 随意换 frame。应以明确嵌套 frame 入口解析一次并保存本操作的真实身份；歧义、移除、导航和同 URL 替换都失败，不挑替代节点、不重派发。
4. 子 frame 内读取与动作复用已验证的文档/原生操作基础，保持父文档和每层 frame 身份；循环内不得重新选择另一个 frame。跨源与 frame 的结果关联、新鲜度、超时与取消仍分别有证据。
5. 自动化和隔离实机须覆盖两个公开 loopback origin、重复相同 URL frame、嵌套跨源、父/子导航、重定向、选择歧义、取消/重启、权限变化与提取修复。上游的 context 重解析/旧 target 重试策略不自动迁入本项目的不重放契约。

以上为源码审计时的起点。后续跨 origin 实现及 frame 基础状态见下文；B01 frame 仍开放，W01–04、B02–04、A01–02、U01–06 与 E01–04 全部范围保留；Python 网站探索agent、日常浏览器、真实账户与未知调试端口均未操作。

## 跨源主文档实现进展（2026-10-18）

已增加固定 navigate.resultOrigin、workflow step.origin 链、start.allowedOrigins 门禁、完整 manifest match/pageRoute 权限、精确源与路径组合选择、固定任务 tab 预览和 page_navigation_origin_v1 派发前检查。单步 query 和多步 A→B 的源码 Chromium 首轮通过（5GCrtt），包括生成/作者验证/安装/重复调用/知识/提取 repair/重定向拒绝/取消/重启不重放。跨源 hash、A→B→A、重启后验证和作者取消的源码/双打包专项各 11 项已通过（2zWcqF/r9KzgD），实现检查点 841a412。完整双打包 cmPIYq 暴露下述 tabs 快照竞态，修复后的最终完整双打包 9ccf6Q 109 项已通过。frame 工作流暂无接入。

## frame 身份方案探针（不是工作流验收）

隔离 Chromium 1217 的临时扩展副本，以本项目 ensureCdpAttached / withBrowserFrameContext 真实事件链运行：父文档中的唯一 iframe 节点通过 DOM.describeNode 得到 CDP frameId，再与扩展隔离上下文及 Chrome frameId/documentId 对应。5 个主/子/嵌套文档，包含两个完整 URL 相同的跨源 iframe，均唯一匹配，未用 URL 或树序号挑选。报告 `weworker-frame-identity-DAKfnA/report.json`，日志 `/tmp/weworker-frame-identity-probe-host.log`；临时浏览器/服务全部关闭。

首次探针在 ServiceWorker 内使用动态 import，被规范拒绝；改为仅临时副本静态导入。第二次直接 attach 没有进入本项目事件状态，因此找不到上下文；改为复用 ensureCdpAttached 后通过。没有修改生产文件绕过身份检查。这验证选择器到真实 owner/document 的可行性，不证明生成、动作、导航、新鲜度、权限或取消链路已完成。

后续声明按嵌套 owner 选择器逐层固定 origin/path，不保存临时 frameId/documentId。每次调用只解析一次，之后按真实 documentId/uniqueContextId 与 owner 身份复核；相同 URL 替换或歧义失败。主文档及所有祖先须保持，子文档显式导航采用独立身份迁移，不以重新选中 frame 冒充连续动作。frame 仍开放。


## 跨源导航事件与 tabs 快照竞态

完整双打包 `webcli-browser-acceptance-cmPIYq` 在 workflow 第 6 次普通调用的首步返回 `PAGE_QUERY_ORIGIN_CHANGED`，当时从目的源返回入口；失败日志 `/tmp/weworker-origins-bundled-full.log`。随后仅在隔离扩展副本中使用 841a412 旧导航代码增加失败诊断，连续调用在第 38 次复现（`webcli-browser-acceptance-Zl8HbX`，`/tmp/weworker-origins-race-proof-fixed.log`）：`navigated:true`、`oldSnapshot:true`，当前 origin 等于初始 origin 而不同于目的 origin。这直接证明 CDP 文档提交已先发生、tabs URL 仍是完整旧快照的时序；不依靠从错误码猜根因。早期 BcTHOC 没有保留实际 error，不能追溯证明该次也是同因。

普通与 hash 导航只等待精确初始 href 在既有预算内更新；等待时不提取数据。完整目的 href、新文档/loader、300ms 稳定结果、hash 关联/刷新、CDP 重定向拒绝和一次派发保持。单测覆盖滞后两次轮询、永久旧快照超时、旧快照期间错误 origin 事件立即拒绝，均零重放。最终完整/连续调用结果见交接末尾。

修复后 tBXyDE 已越过跨源并通过前 108 项，但最终共享修复夹具复用 localhost 被已有跨源包吸纳，严格三命令断言失败。包的 hostname/父子域归属不按端口分离；只改验收环境，使用精确映射到本地 loopback 的独立公开占位 host，保留完整影响范围与全部重验断言。不能把子域或不同端口的孤立通过当作组合验证；新 `--origins-shared-only` 先建立跨源包再验证共享修复，最终结果见交接。

## frame 基础保存点与已知失败（未接入）

暂停前已有 `webcli/page-workflow-frames.js`、`extension/background/page-workflow-frames.js`、`extension/background/page-frame-context.js`、对应 3 项主机单测和 `webcli/scripts/verify-page-frame-context.mjs`。两端声明规范化字节一致；没有生产导入、生成 schema、capability、权限、workflow 执行或修复接入。扩展的两个文件随目录复制进入构建资源，但没有加载它们的生产入口；主机 helper 不在 npm files 白名单中。不能把这些文件或基础探针当作 B01 frame 支持。

初期 `weworker-frame-identity-0L9shG` 的真实探针验证选定叶节点读取、歧义拒绝、无关 frame 替换保持、所选同 URL frame 替换拒绝；该报告只保存 rows，checks 属性未被数组 JSON 序列化，不能宣称报告包含检查细节。后续仓库探针 `1jewHF` 挂起，由核实 PID/PPID 和独立 profile 后只停止本任务 Chromium，Node 随 finally 退出。加宿主 45 秒截止、失败报告和阶段标记后的 `LufBqx/report.json` 明确 `passed:false`，停在 `resolve after selected replacement`；正常关闭自身浏览器和 loopback 服务。换用 tabs.reload 并未解决该阶段，父文档替换/取消新增断言尚未到达。

resolver 的 30 秒 active 检查尚未约束每个正在等待的 sendCommand/executeScript，不能把它当作可靠总超时。恢复后先定位替换后的上下文解析/释放挂起，并对等待与清理建立有界保证，再接入声明、读取、动作、导航、循环、权限、修复与隔离实机验收。本次依用户要求在跨源阶段收尾后暂停，不继续 frame 集成。

## 2026-10-28：恢复后的等待、取消与清理边界

基于公开 `dev-1.0.2@9a01e40`，恢复 B01 基础修复。以下为新的阶段证据，不关闭完整 B01 或其他 W/B/A/U/E 项。

- **原始失败复现**：原始构建的 `6acDMq`、`MBdufC` 探针在所选 owner 替换后的解析阶段超过 45 秒。后者记录未完成的 `executeScript`；增加持续加载的无关 frame 后，同一原始构建的 `vfNomH` 在枚举阶段超过宿主 35 秒预算。原实现只在派发前检查 deadline，不能结束已经挂起的 Chrome Promise。
- **实现边界**：`frame-operation.js` 为每次等待检查预算与取消，并锁存终止状态；迟到响应不能继续后续派发。frame 上下文匹配保留 2.5 秒匹配窗口，resolver 保留 30 秒总预算。枚举、文档身份预检和隔离标记立即注入，不等全 frame 的 `document_idle`；普通调用方提供的操作脚本仍使用原调度时机。清理单独限制为 1 秒，固定原 document/object，不清理继任文档。Chrome 已派发的调用无法撤回，超时不代表副作用未发生，也不自动重放。
- **探针修正**：使用同一份 prepared 扩展，不再向旧构建覆盖个别新源码。支持 `--extension` 选择对照构建、`--load-via-cdp` 在新 Chrome 的独立临时 profile 中加载扩展。测试驱动负责夹具替换，扩展执行真实解析与拒绝检查；以文档状态验证夹具就绪，取消固定 150/300 毫秒睡眠假设。每阶段有宿主截止，失败保存阶段、等待调用和有限诊断，不保存业务数据。
- **最终基础实机**：Windows Chrome `156.0.8078.48`，最终探针 `JtYvhP`、`zYByrT`、`uxOfaE` 连续三次通过。每次包含五个主/子/嵌套跨源文档、两个相同 URL 的不同 owner、叶节点读取、歧义拒绝、持续加载的无关 frame、无关替换保持、所选同 URL 替换拒绝、重新解析、父文档替换拒绝和取消。只运行任务拥有的浏览器/loopback 服务，不连接日常 Bridge。未验 Chromium 1194/1217、其他系统或完整安装包。
- **自动化与打包**：扩展全量 **344/344**；WebCLI frame/origin/workflow 与生成恢复聚焦 **13/13**。CLI/Bridge build、33 包 prepare、npm dry-run **1082 文件**通过；三个相关扩展模块的源码、prepared 与 npm 资源 SHA256 一致。保留既有三个列映射资源缺失警告。未运行完整浏览器双打包 109 项，不能用此基础探针替代。
- **WebCLI 全量边界**：本机全量 **1696 通过、5 失败**。四个固定失败在未经修改、重新 prepare 的基线中复现：两项 Windows symlink `EPERM`、上传 fixture 文件大小 `12/8192` 不符、输出测试 `ENOBUFS`。生成恢复用例在全量中等待超时，基线与当前代码单独运行均通过，仍保留其并发稳定性欠账；没有为变绿修改这些无关测试。
- **中间失败保留**：修复初版 `w9FSXG`、`smAIXR` 在替换后上下文匹配返回有界超时；探针改用 load 事件/Playwright frame locator 的中间版本 `IL5k97`、`WecSjo`、`5ZdiNi` 出现夹具等待失败。最终三次通过不是所有时序和浏览器的保证，不能追溯宣称这些旧失败全部根因已闭环。一次并行执行 build/prepack 竞争同一生成目录而失败，改为顺序执行后通过，不计产品缺陷或成功验收。

下一步仍是 frame 声明、生成 schema、capability、权限、读取/动作/导航/循环和 repair 的生产接入及全链路验收。目前没有生产路由引用 resolver，主机 frame helper 仍不在 npm files 白名单中；现有单条 browser frame 能力不等于生成工作流支持。内部 npm 重打包、内部 Adapter 逐包及安装包验收亦未完成。

## 2026-10-28：B01 生产接入与验收完成

本节接续并取代上一节的“下一步”状态。用户要求继续直到 B01 完成；实现位于公开 `dev-1.0.2@9a01e40` 的隔离分支 `codex/opencli-frame-resume`。内部 `dev-1.0.2@37070e9` 是差异覆盖仓库，本阶段通用运行时不复制到内部仓库，原有本地改动保持。

### 实现与契约

- `steps[].frames` 声明 1–8 层唯一 owner selector、精确初始 origin/pathname，不持久化临时浏览器 ID。每条 owner 链只解析一次，各上下文独立衔接路径/源；导航后保留原始 frames 声明，只更新原叶文档身份。主 tab 路由与所有 frame 权限目标分开，防止把子页面地址选作主页面。
- 接通被动 read、原生 search click/Enter、select/filter/pagination、跨源 navigate、hash 刷新/同目标叶文档 reload，以及既有有界 when/repeat/until/collect。Enter 派发前再次核对原输入节点和实际焦点；owner/祖先/文档或完整 URL 意外变化即停止。
- 新 `page_workflow_frames_v1` 覆盖 frame 和被动 read 步骤，在观察、作者验证和普通调用前核验选定 profile，不回退。start.allowedOrigins、manifest match 和 review 覆盖祖先、叶节点与目的源；完整 owner、路线与动作进入权限、知识和修复约束。结果提取可修复，擅改 owner 在导航前拒绝。
- 等待同时受单步和工作流总预算约束，取消/断线锁存终止状态，迟到回复不开始后续动作；清理固定原文档/对象且有独立短预算。OOPIF 跨进程时旧 Page.navigate 可能永不返回，改用同一 frame 的导航事件确认派发，再验证祖先、owner 和精确目的地。原生提交必须先收到该 frame 的导航事件，再读取新叶文档；两种场景均不补发动作。

编写方式见 [frame 工作流](opencli_frame_workflows.md) 和随包探索 Skill。本阶段不支持 frame 写、任意自定义控件或任意脚本，也没有改变 W/B02–04/A/U/E 的状态。

### 当前证据

- **Windows Chrome 156.0.8078.48，CLI＋Bridge 双打包**：`webcli-browser-acceptance-GOTyK7/report.json`，**16 项通过**。两个同 URL owner、跨源嵌套与多上下文切换、主文档保留；五类 frame 流程的观察→生成→作者 cases→validate→review/install→重复普通调用→knowledge；提取修复重验及擅改 owner 零导航拒绝；重定向拒绝；作者验证取消（下一轮/下一 case 零派发）、取消、任务 Bridge 重启、祖先/叶 owner 同 URL 替换和单步超时，迟到数据不落入证据。
- **源码链路**：`EZY30D` 通过 control/query/Enter/navigation 和修复，随后 hash 中文夹具失败，不计完整通过。修正后 `i2y5rz/report.json` **10 项通过**，覆盖 hash 重复目标精确叶 reload、中文值、生成安装知识及全部上述中断检查。较早 `G1OyHQ` 原生 click 专项及 `pvW55m` 跨源导航专项通过；最终完整组合以 GOTyK7 为准。
- **基础身份**：最终 `weworker-frame-identity-BRBCmv` 通过五文档身份、同 URL owner、嵌套跨源、歧义、无关持续加载/替换、所选/父文档替换、重新解析及取消。它补充完整链路，不能单独替代生成和普通调用验收。
- **自动化**：扩展全量 **353/353**，主机最终聚焦 **5 文件/81 项**。新增旧 CDP Promise 不返回但导航事件已到达、文档替换、无事件超时、取消、单步挂起锁存、非法目的地 refresh、权限与主 tab 分离、契约往返及旧 profile 零派发测试。WebCLI 全量 **143 文件通过/4 文件失败，1699 项通过/4 项失败**；失败为上一阶段已在原始基线复现的两个 Windows symlink EPERM、上传 fixture 12/8192 和 output-formats ENOBUFS，生成恢复本轮全量通过。最后两项 capability 测试纳入 81 项聚焦，未再次扩大全量数字。
- **打包**：CLI、Bridge 顺序构建通过；Skill 验收 4 项、30 个改动脚本语法、diff whitespace、npm dry-run **1084 文件**通过。43 个 background 模块与 prepared/npm 对齐，npm service-worker 仅有既定 3712 传输替换；共享声明模块字节一致，Skill 与 bundle 一致。新增内容私有绑定/凭据模式检查通过。既有三个列映射资源缺失警告保留。

### 失败记录与分发边界

`f6jgXr`/`IG72pk` 跨源导航超时，诊断确认旧子 CDP session 的 Page.navigate 未返回，而原 frame 已在父 session 完成精确导航；现有事件确认逻辑及单测覆盖。`Lj6ldL` 原生提交后读旧文档返回 FRAME_UNAVAILABLE，已改为等待原 frame 导航事件，后续 G1OyHQ/EZY30D/GOTyK7 覆盖 click/Enter。`EZY30D` 的 hash 中文请求被夹具二次编码，业务关联正确拒绝；修正夹具后 i2y5rz/GOTyK7 通过。

`fdaDmv` 与全量主机测试并行时，第二个 control 作者 case 仅留下输出断言失败，原始运行时错误未保存，根因未确认；后续补充失败诊断，后续源码及最终双打包该 case 通过，不能追溯宣称此单次失败已定位。资源比较初版把 npm 固有端口变换误判为不一致，使用现有 expectedPackagedWorker 契约复核后通过，没有修改产品端口。

所有浏览器、Bridge、loopback 服务与临时安装包均属于测试任务，不接管日常浏览器或用户 Bridge。未发布、未安装到用户客户端、未修改 CI/CD、密钥或依赖。内部 npm 重打包/Adapter 逐包、Chromium 1194、其他系统/浏览器及实际安装包仍归独立分发和 E 系列验收。B01 的约定只读生成契约已完成，不代表全部 OpenCLI 对齐完成。

后续按用户要求处理上述四项基线失败：最新全量 **147 文件/1708 项全部通过**；源码/双打包实际上传各 4 项通过。最终仅调整测试和公开合成夹具，保留产品校验。上传 12/8192 并非已证明的产品大小计算错误，实机确认 Node 与 Chrome 文件视图不同，放弃句柄大小替代；详见 [四项修复记录](webcli_windows_test_baseline.md)。本节前述失败保留为历史证据。
