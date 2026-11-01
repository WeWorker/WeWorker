# WebCLI 与 OpenCLI 能力对齐台账

2026-10-29 U06：新增 `exploration.export`，统一任务/普通调用 trace、network/console、状态、静态包/知识历史和显式截图的新目录产物；按 task/profile/时间窗限定、默认结构脱敏，缺失/截断/部分失败不冒充完整成功。固定 1.8.8 direct CDP 与 journal/artifact 函数补行为证据，本项目源码/双 bundle/实际临时 npm 验收见 [U06 专项](opencli_u06_diagnostics.md) 和交接。上游扩展/daemon 全链路、HTTP/Toolkit 普通 trace 汇总及 E02 实际客户端安装仍未关闭；没有新增请求重放。

2026-10-28 U01：补统一静态/历史 evidence 报告、legacy/Toolkit 无执行诊断，以及固定本地 Git commit 的 v2 子包发现/审阅摘要安装。真实作者验证和写效果继续复用原入口，不把历史证据升级为当前效果。准确范围、上游 1.8.8 行为与未覆盖的远程插件生命周期见 [U01 专项](opencli_u01_verification.md)。下一阶段仅推进 U06 已确认的统一诊断产物并先做 Worker/流式/replay 行为核查；E02 实际客户端安装保持开放。

2026-10-28 B02：完成原生日期／明确弹层选项的生成、效果验证和安装普通调用，补目录相对路径验证、原 frame 原生 chooser 与动态 input/multipart 流程。上游仍固定 1.8.8，并补实际 BasePage/CDP 行为核查。契约、证据与边界见 [B02 控件与上传](opencli_b02_controls.md)。WebCLI 148 文件/1727 项、扩展 363 项通过；最终实机与打包记录见交接。B03–B04、A/U 余项及 E 系列继续开放。

2026-10-28 W01–W04：声明式控件/页面写、CLI 任务有限序列、多用例和实际响应 ID 契约已实现并通过隔离实机验证。WebCLI **147 文件/1722 项**、扩展 **360 项**通过；双打包 UI **20 项**、双打包序列及重启恢复 **4 项**通过。准确范围、模块、最终补测和历史失败见 [写工作流契约与证据](opencli_write_workflows.md)。本阶段不代表整体 OpenCLI 对齐完成。

2026-10-28 前序：用户要求一并处理四项基线测试失败，现已完成。当时 WebCLI **147 文件/1708 项全部通过**，源码与双打包上传验收各 4 项通过；保留严格产品校验。根因、文件视图差异及测试改动见 [Windows 测试基线修复](webcli_windows_test_baseline.md)。下方 B01 条目中的 1699/4 为当时历史快照。

2026-10-28 恢复并完成 B01：用户要求基于内外仓库 `dev-1.0.2` 接续，随后明确推进直到 B01 完成。公开基线 `9a01e409aa28d2431ee356296a2bfcd003688c7c`。frame 的身份、声明、读取、动作、导航、循环、权限、生成和修复已接入；CLI＋Bridge 双打包隔离实机验收通过。其余 W/B/A/U/E 范围保持开放。上游对照仍固定为已审计的 OpenCLI 1.8.8，尚未审计新版本。契约见 [frame 工作流](opencli_frame_workflows.md)，证据与失败记录见 [上下文审计](opencli_workflow_context_audit.md) 末尾。

2026-10-18 历史优先级调整：当时先推进 [客户端自然语言演示目标](client_webcli_demo_goal.md)，全面对齐暂停。后续交接已记录本机简单只读演示完成；本表原先的 P01“待启动”状态过时，现予纠正。该独立演示不关闭下方 W/B/A/U/E，也不缩减其范围。

2026-10-18 最新专项：通用后台 API 探索流程与防退化见 [后台 API 探索](background_api_exploration.md)。GLM 旧页面版已按授权删除并重新探索，后台版 1.0.2 在全部 GLM 标签关闭时通过 4 组真实验证、4 次普通调用与 Bridge 重启后 4 次查询，零新页；首次登录或切换上下文需显式准备。另修复纯用户包卸载后的重新生成及旧命令回退边界，WebCLI 1465 项通过。详见 [GLM 验证](glm_quota_adapter_validation.md)。这只关闭该站点本次查询专项；W/B/A/U/E 原有余项、内部同步与跨环境验收保持，整体目标继续暂停。

更新：2026-10-18。用户要求依据最新台账补齐约定范围内与 OpenCLI 的实际差距；已有能力复用，部分实现只补明确缺口，尚未审计项目先核对。本文件保留完整目标，不把单个阶段或测试站点视为完成标准。分支历史与同步约束见 [CLI 跟进文档](api_exploration_cli_handoff.md)。Python 网站探索agent全程排除。

## 持续执行清单（从 6420583 接续）

历史暂停检查点：2026-10-18 本阶段完成，按用户要求暂停整体目标。B01 hash/有界循环分支 d0e8ea9、跨源 841a412、tabs 快照竞态修复 f2f54d8，验收夹具隔离 a4052b3/c26226a；最终 Chromium 1217 CLI＋Bridge 完整双打包 **109 项** 9ccf6Q、**6291 文件/28 私有绑定**隐私、连续 **102 次**跨源 workflow、跨源→共享修复组合 **12 项**通过。WebCLI 129 文件/1439 项、扩展 64 项、构建/配置/Skill/npm pack 634 文件通过。frame 基础另存 1c4d8a9，未接入生产，替换后解析探针 LufBqx 超时，不计已实现；完整 W/B/A/U/E 清单保持，整体未完成。

状态含义：已验证仅覆盖列出的契约；部分实现的剩余项保持开放；待审计须核对上游与本项目实现后再定差距；验收欠账不能用其他环境结果替代。阶段检查点不代表整体完成，2026-10-18 的暂停已由 2026-10-28 恢复指令解除。上游仍以已核查的 1.8.8 发布包为对照，历史本机版本记录为 1.8.6（此次未核验）；版本更新提示不是未经审计扩大或缩减范围的依据。

| ID | 状态 | 能力与剩余工作／关闭证据 |
| --- | --- | --- |
| V01 | 已验证 | profile 路由/独立 HTTP Runner/无浏览器 JSON 发现/只读 workflow；详见下方能力表和交接分阶段证据 |
| V02 | 已验证 | HTTP/PAGE_FETCH/原生 UI 单写、字符串/安全整数实际 ID、UI 新回执 ID、有界效果 GET；默认 validate 不写、持久消费与 uncertain 只读恢复保持 |
| V03 | 已验证 | HTTP 单请求写定向 repair；6420583 阶段全量 1355 项、HTTP 源码/双打包各 21 项、Chromium 1217 双打包 77 项，不覆盖后续改动 |
| R01 | 已验证 | PAGE_FETCH/UI 写契约定向修复，新计划/同源/方法/幂等保护、历史 fixture 重新规范化、派发前基线复核；源码专项 6 项、双打包完整 82 项与最终专项 6 项。managed 刷新竞争已修，详见交接末尾 |
| R02 | 已验证 | 显式已有 internal 文本共享范围、全包命令重验（含辅助命令）；历史授权不继承，编辑使审阅失效。126 文件/1406 测试、源码/双打包 HTTP 各 24、双打包 Chromium 完整 83 通过；3867 文件/28 私有绑定隐私检查通过。50 命令/50 文件/250000 字节边界保留 |
| R03 | 已验证 | knowledge-revise 绑定当前已验证读取 cases/独立写效果，CAS/旧映射/理由/证据摘要和完整历史；源码/打包 HTTP 各 22 项、双打包 UI 12 项和完整 82 项；不继承授权、不执行请求 |
| W01 | 已验证（声明式控件契约） | input/change、自动保存、select/checkbox/contenteditable，事件后固定节点和值；任意第三方控件脚本不在契约内。见 opencli_write_workflows.md |
| W02 | 已验证（显式页面契约） | 页面拥有的 hidden 字段、DOM click/CDP Enter、精确同源整页导航、开放 Shadow 与嵌套跨源 frame，含生成/安装/普通调用。见 opencli_write_workflows.md |
| W03 | 已验证（CLI 任务序列） | 多组 cases、有限多步/批量写、实际 ID 传递、逐步持久化、部分续跑和 Bridge 重启不重放。序列位于探索任务；安装后仍为单工具调用，无安装态复合命令。见 opencli_write_workflows.md |
| W04 | 已验证（显式实际响应契约） | 多 ID、公开 Header/Location/响应 URL、原 frame 唯一匹配 UI 网络响应、负安全整数及最多 512 字符的精确十进制 ID；不任取页面网络响应。见 opencli_write_workflows.md |
| B01 | 已验证（约定只读契约） | 既有 query/hash/有界 when/repeat/until/collect/显式跨源基础上，2026-10-28 完成 frame 声明、读取、原生 click/Enter/筛选/分页、子页面跨源与 hash 导航、生成/作者验证/安装/普通调用/知识/提取修复。固定 owner/祖先/主 tab，独立权限与 capability，取消/断线/替换/超时不重放。最终双打包 GOTyK7 16 项、源码 hash/中断 i2y5rz 10 项、基础 BRBCmv、扩展 353 项、主机聚焦 81 项通过。WebCLI 全量 1699 通过/4 个已在原始基线复现的环境或夹具失败；保留中间失败。W 系列 frame 写已由本轮 W02 接续验证；E 系列安装包/跨平台验收仍开放；B01 历史证据见 opencli_workflow_context_audit.md |
| B02 | 已验证（明确控件与原生 chooser 契约） | 原生日期、明确关联弹层的选项／日历，目录 name/size/relativePath 验证、原 frame 原生 chooser、动态 input 与自定义 multipart 页面流程。生成/验证/安装/普通调用适用于日期/选项工具，上传为 browser 原语；不含 File System Access/OS 窗口、任意第三方控件或自动生成安装态复合上传工具。详见 opencli_b02_controls.md |
| B03 | 部分实现 | 跨 frame/DataTransfer 拖拽 |
| B04 | 部分实现 | AX/Shadow/子 frame 截图、任意设备模拟恢复 |
| A01 | 部分实现 | YAML/API 文档发现与更广引用解析 |
| A02 | 部分实现 | 站点签名/OAuth；按上游和实际站点契约审计，不能把 HMAC 视为全部认证 |
| U01 | 本阶段通用验证与诊断已补；完整管理生命周期仍部分实现 | 保留已有 skills/status/validate/eject/convention-audit。新增 verify 静态＋显式知识源的历史证据汇总、legacy/Toolkit 静态诊断、本地固定 Git commit/monorepo v2 发现与精确摘要单包安装。默认零工具执行，不认证当前效果；远程 Git clone/update、OpenCLI TS 插件生命周期及 embedded Toolkit 实际运行仍未验证／未实现，不整体宣称 U01 全对齐。见 opencli_u01_verification.md 与交接最终证据 |
| U02 | 部分实现／继续核对入口 | 六格式/md/yml、JSONL 和 Bash/Zsh/Fish 补全已验；AdapterHub 复用 JSON 路径输出结果/help/错误，源码/打包管理各 5、输出各 5、补全各 4 项。其他 Adapter/服务管理格式、发布与凭据路径实际验收仍开放 |
| U03 | 初步映射／行为审计未完成 | 1.8.8 的 1366 命令/179 分组逐项台账见 opencli_command_map_1_8_8.json；当前 33 包，150 名称候选、36 同包未匹配、1180 历史无映射。候选不是对齐，无映射不是已证明不存在；全部留待源码/行为与实机证据复核 |
| U04 | 已审计／实际差距待实现 | 上游独立 CDPBridge＋外部应用注册/启动，现有 chrome.debugger/profile 传输不等价；见 opencli_cdp_audit.md。需隔离真实目标验证，不接管未知端口/应用；不开发 OpenCLI 桌面客户端 |
| U05 | 已审计／实际差距待实现 | 1.8.8 external.js 与 cli.js：13 个内置元数据、用户注册、PATH 查找、安装和原样 stdio/退出码透传；本项目无对应注册/执行入口，Toolkit Runner 不等价。审计见 opencli_external_audit.md；尚无本项目实现/实机证据 |
| U06 | 统一任务诊断产物已补／限定行为核查已验 | `exploration.export` 的有界来源、时间窗、脱敏、新目录、部分失败和零重放已有源码/双 bundle/临时 npm 证据。1.8.8 direct CDP 区分父页/SW 返回与 Worker 自发请求、未结束正文与完成读取；journal/artifact harness 验证结果复用和导出零请求。本项目真实扩展对应核查通过。上游扩展/daemon 全链路及 HTTP/Toolkit 普通 trace 汇总仍开放；不据此新增未证实的 Worker/流式正文/流量重发，见 opencli_u06_diagnostics.md |
| E01 | 验收欠账 | Chromium 1194 Shadow/frame 兼容，其他浏览器与系统 |
| E02 | 验收欠账 | macOS arm64/x64、Windows 实际安装包；发布/受限配置仍单独授权 |
| E03 | 验收欠账 | 全新 Codex/Claude 独立对话；当前未授权创建新聊天 |
| E04 | 验收欠账 | 代表站点与全部认证组合；本任务仅隔离公开 loopback 副作用，真实账户写未授权 |
| P01 | 独立产品事项／本机简单只读演示已验 | 依 client_webcli_demo_goal.md 与后续交接的完成记录校正；不计入 CLI 对齐完成条件，也不证明完整探索 UI、跨平台或内部逐包验收完成 |

R01 审计起点：上游 1.8.8 autofix 使用实际 trace 定位源码、定向修改并复验；本项目 `exploration-service.js` 明确拒绝非 HTTP 写 repair，`existing-site.js` 同时冻结 pageWrite/uiWrite，所以此项为真实实现差距。不能仅放开入口：声明式命令模块固定，实际修复对象是经新计划绑定的 manifest 契约，仍需新效果验证与安装权限审阅。

U02 审计与实现（2026-10-18）：实际读取上游 1.8.8 `dist/src/output.js`、`completion.js`，核对本项目实际入口；复用既有 markdown/JSON、TTY/pipeline、列映射与 JSONL。补齐 table/plain/CSV/YAML、md/yml、管理显式格式以及 Bash/Zsh/Fish 首级/二级命令和别名补全，保持 --output-format 与业务 --format 分离。补全不执行作者元数据，旧版动态计算名不猜测。全量 120 文件/1383 项；隔离源码/打包输出各 4 项（真实 HTTP＋独立 YAML/CSV 解析器）；源码/打包补全各 4 项（v2/legacy/Toolkit catalog，真实 Bash/Zsh Tab、Fish 4.9.3 complete -C）。报告和失败修正见交接末尾，未修改 shell 配置。

2026-10-18 当前增量（起点 `35cd7f8`）：已安装 HTTP 单请求写命令支持定向 repair，原 runtime/safety、完整 origins/auth/cookies、权限、共享文件和其他命令保持。历史 fixture 仅按摘要/kind/新来源校验后导入待复验数据，不继承真实 ID、执行或授权；新任务绑定精确审阅，默认 validate 零真实写，实际派发前再次检查安装基线。数字 ID、有界 pending GET、持久消费与 uncertain 只读恢复不放行保持。WebCLI 117 文件/1355 项、聚焦 139 项、扩展 20 项、源码/双打包 HTTP 各 21 项、Chromium 1217 双打包完整 77 项与最终隐私检查通过；完整证据见交接末尾。PAGE_FETCH/UI 写契约修复、共享文件修复、多步写和完整对齐仍未完成。

2026-10-18 前序增量（起点 `05b4b44`）：UI 单次提交可声明同节点公开新回执 ID，显式 string/integer、旧值拒绝、最小 ID 持久化、动态资源全部输入和严格身份核对已接通，并复用有界 pending GET 轮询。旧扩展拒绝新契约，取消/重启不重放，恢复不认证 uncertain，普通 call 仍 effectVerified:false。WebCLI 117 文件/1341 项、最终聚焦 152 项、扩展 16 项、源码 UI 11 项、双打包 HTTP 18 项、Chromium 1217 双打包完整 77 项和最终隐私检查通过；证据见交接最新记录。这不是任意 UI 网络响应拦截、复杂控件或多步写的完成声明。

2026-10-18 前序增量（起点 `1b123da`）：写结果回查扩展显式 `idType=integer`，只接受非负安全整数并保持实际响应/账本/资源身份的类型；默认字符串规则不变。HTTP、PAGE_FETCH 和原生 UI 效果验证可声明 `effect.poll`，仅对明确 pending 状态重复固定 GET/实际 ID GET；2–20 轮、250–5000 毫秒间隔、原总预算、文档身份与严格效果断言均保留。写不循环；取消/重启/耗尽后 uncertain 只允许独立只读恢复，匹配不放行安装。WebCLI 1330 项、最终聚焦 159 项、扩展 18 项、源码与双打包 HTTP 各 18 项、Chromium 1217 双打包完整 74 项通过；证据见交接末尾。本增量不能关闭多 ID/header/响应 URL/UI 响应 ID、复杂 UI、多步写及完整对齐欠账。

2026-10-18 前序 UI 增量：UI_SELECTOR 原生表单写已实现：固定同源主文档、显式输入/submit/新回执契约，原生 setter 不发 input/change，单次 requestSubmit 后以 GET 逐项核对资源身份、内容和改变的关联值；复用精确审阅/持久消费/取消与重启不重放/安装/知识。普通 call 明确 effectVerified:false，不把回执当效果。无服务端幂等假设；实测断响应可一次 submit 对应 3 次请求及 3 次服务端 mutation 执行，仍 uncertain、仅只读恢复。本阶段不是单次实际效果保证，也不解除 PAGE_FETCH 幂等要求。WebCLI 1284 项、聚焦 80 项、扩展 18 项、完整 Chromium 1217 70 项、最终打包 UI 7 项/HTTP 15 项/PAGE_FETCH 10 项通过，报告见交接末尾；复杂/受控控件、原生整页提交、hidden CSRF、多步写、数字/多 ID/header/响应 URL 回查及写 repair 仍待办。

2026-10-18 前序增量：HTTP 与 PAGE_FETCH 支持显式 effect.resultReadback。保留固定 before/after，按实际响应公开字符串 ID 构造已审阅同源单段路径，严格核对资源身份和内容；ID 先持久化，取消/重启后仅 GET 恢复，缺失/非法/丢响应不猜值、不重写，uncertain 不放行安装。真实 ID 不进入摘要/知识/安装包。WebCLI 115 文件/1275 项及最后聚焦 76 项通过；源码与最终打包 HTTP 各 15 项、页面写各 10 项通过；完整 Chromium 1217 为 65 项（早于最后断言别名加固，最终全量/打包覆盖），边界与证据见交接末尾。数字/多 ID/响应 URL、UI 控件写、多步写与写 repair 继续待办。

2026-10-18 前序增量：Extension PAGE_FETCH 声明式写已接通生成、零网络 mock、精确审阅、真实 before/write/after、安装、普通调用与知识。固定同源主文档/JSON 字符串映射，必须有明确服务端幂等契约；Chromium 可能重发网络请求，稳定 key 只在服务端正确去重时保证一次实际效果，不能声称一次网络发送。任务 reviewId 持久消耗且不重放；响应丢失仍 uncertain。WebCLI 1224 项、扩展相关 59 项、最终打包 CLI＋Bridge 页面写 7 项及 HTTP 回归 12 项通过。Chromium 1217 完整 62 项通过，1194 Shadow 失败在上轮源码复现，详细证据见交接末尾。无幂等支持的页面写、UI 点击提交、动态 CSRF、数字/多 ID、多步写和写 repair 仍未完成。

前序 HTTP 增量：HTTP 单请求写命令支持显式声明/观察来源、语义骨架、独立 mock、精确执行审阅和真实 GET before/write/GET after。reviewId 持久化消耗，取消/重启/响应丢失不重放，不确定结果只读回查；全部读/写验证通过才能安装。普通 HTTP write 也限一个请求、拒绝重定向并强制确认。WebCLI 1218 项和完整 Chromium 57 项通过，源码/打包 HTTP 验收明细见交接末尾；真实效果仅在隔离 PUBLIC/AUTH loopback 服务验证。UI 控件/多步写、数字/多 ID 回查和写工具 repair 仍未完成，详见 [写命令契约](api_exploration_write.md)。

前序 workflow：UI_SELECTOR 显式组合 2–8 个导航/搜索/当前页筛选/翻页步骤；逐步关联结果、统一参数预检、动作权限绑定、总预算、失败停止和观察/验证取消已接通。生成→多组作者断言→安装→重复调用→知识→结果提取修复已实测。循环/分支、自定义组件、跨源/跨 frame 流程仍未完成，不能把这一阶段当作任意多步网站任务已对齐。

参数化导航阶段：UI_SELECTOR navigate 支持按明确 pathParameters 导航同源详情并读取 DOM/公开状态；新主文档/准确 ID/稳定结果校验、两组作者断言、manifest 权限、预览/安装后调用和保留路由的修复已接通。WebCLI 1197 项、扩展聚焦 40 项、完整 Chromium 52 项、打包 CLI 导航专项 4 项通过，npm pack dry-run 611 文件。动态 query/hash 和跨源详情仍未覆盖。

范围澄清（2026-10-17）：用户明确不需要 OpenCLI 桌面客户端，本次只对齐 CLI、浏览器扩展与相关工具能力。此前“桌面 UI”指 WeWorker 的 API 探索页面、内置聊天和 profile 选择界面；这些属于单列产品集成，不计入 CLI 对齐的完成条件。下文“多步 UI”指 CLI 操作目标网站的流程；“CDP/Electron 接入”指 CLI 控制浏览器或第三方 Electron 应用，均不表示开发 OpenCLI 桌面客户端。

历史 HTTP 阶段：在多浏览器 profile 检查点 `81b4fd0` 上新增独立 HTTP Runner、PUBLIC_API/COOKIE_API 生成/严格验证/安装/调用与只读定向修复。WebCLI 1161 项、完整 Chromium 47 项通过，双真实 profile 的 HttpOnly Cookie/CSRF 隔离及最终 6 项 HTTP 检查通过；完整目标仍未完成。

最新鉴权增量：在 HTTP 检查点 `953d9e2` 上补 version 2、AUTH_API、宿主环境 Bearer/header/Basic/声明式 HMAC，以及 Cookie storeId/partitionKey。安装权限覆盖完整契约，旧插件能力不足时零凭据派发，AUTH 普通调用无需 profile。阶段证据见交接文档顶部与末尾；不是任意站点签名/OAuth 的完成声明。

最新无浏览器增量：mode=http 任务支持明确 OpenAPI 3.0/3.1、Swagger 2 JSON 发现，以及真实宿主读取请求→生成→作者断言→审阅安装→普通调用→知识/局部修复。需要 Bridge，无需插件或浏览器；文档声明不视为执行证据，任务/知识与 profile 历史隔离，取消和运行中重启不重放。WebCLI 1193 项及完整 Chromium 50 项回归通过，源码/打包验收见交接文档末尾。不是 YAML、任意 API 文档爬取或自动遍历端点的完成声明。

对照基线包括本机 OpenCLI 1.8.6 的实际命令帮助、本地技能与 npm 官方 1.8.8 发布包静态接口审计，见 [1.8.8 核查](opencli_1_8_8_audit.md)。静态接口不等于上游实机验收。按能力实现，保留本项目统一 `webcli call <namespace>.<command>` 入口和 Extension / Toolkit 分离边界，不复制上游业务实现。

| 能力族 | 目标与验收证据 | 当前状态 |
| --- | --- | --- |
| 任意 Agent 与发现 | 不依赖桌面或第二模型 Key；结构化帮助、Skill；Codex/Claude 独立对话 | 核心架构已实现；跨 Agent 独立验收待做 |
| 浏览器会话 | open/bind/unbind/close/tab、profile、多连接管理、doctor；用户页不误关闭、跨 CLI/重启恢复 | 命名会话、owned/bound 关闭规则、doctor、持久绑定、Chrome 会话身份守卫已实现；新增稳定 contextId、profile list/rename/use、flag/env/default、双连接隔离与断线不重放；双真实浏览器及重启/重载验收通过，旧历史只读保留；其他浏览器品牌及平台分发未验收；WeWorker profile UI 另列产品集成 |
| 页面操作 | state/find/get/extract、click/dblclick/fill/type/select/check/uncheck/focus/hover/scroll/keys/drag/upload/dialog；过期引用和模糊定位报错 | 主/子 frame 原生指针、同 frame 拖拽、输入/弹窗已真实验收；AX 引用支持开放/关闭/嵌套 Shadow DOM 控件及准确文档；DOM 显式 shadow 查询、树内标签及嵌套引用已实现；原生复合字段、HTML 树、明确选项匹配/保留校验已真实验收；隐藏/Shadow/AX/嵌套跨源原生文件输入上传与验证通过；B02 明确自定义控件／目录／原生 chooser 范围见专项；跨 frame/DataTransfer 拖拽待补 |
| 页面观察 | frames/screenshot/console/eval/wait、网络摘要/detail/filter/follow、有界响应读取、失效错误 | frame eval/身份、完整截图、下载续等、console/network JSONL 与游标已真实验收；state source=ax、DOM/AX 指标比较、跨 frame 引用及部分结果/超时通过；截图主文档 DOM 编号、临时 CSS 尺寸、新文件保存及恢复通过，AX/子 frame 编号与任意设备模拟恢复未覆盖 |
| 探索策略 | PUBLIC/COOKIE/PAGE_FETCH/INTERCEPT/DOM_STATE/UI_SELECTOR；接口/页面状态/脚本发现与策略理由 | PUBLIC_API/COOKIE_API/AUTH_API 已接入显式计划、作者 cases、安装、调用与只读 repair；mode=http 支持无浏览器 JSON OpenAPI 发现和真实请求证据。PAGE_FETCH、声明式页面来源、单步 INTERCEPT、跨文档查询和 2–8 步只读 workflow 已验证。YAML/任意 API 文档爬取、循环/分支/自定义控件等任意多步流程未覆盖；无静默回退 |
| 请求和鉴权 | POST 只读查询、GraphQL、动态路径、跨源、Cookie/CSRF/runtime 签名、写操作语义与确认 | 显式 origin、JSON/form POST、GraphQL query、API 路径参数、Cookie/CSRF、环境 Bearer/header/Basic/HMAC、store/分区已验证；HTTP 单请求写生成/mock/精确审阅/实际效果与不重放已接通。Extension PAGE_FETCH 固定同源写要求服务端幂等支持；原生同文档 UI 单次提交与独立效果验证已接入，不保证一次网络请求/副作用；声明式控件与任务内多步写见 W01–W04；任意站点签名/OAuth 仍待做；动态 query/hash 和显式跨源主文档导航的最终验证见顶部 B01；INTERCEPT 页面签名不能等同通用鉴权 |
| 生成与验证 | 任意目标数量、草稿文件编辑、字段映射、语义/样例验证、同站增量保留、审阅安装 | Agent 计划支持 1–50 工具，draft-add 支持新文件；读工具 1–10 组作者断言，workflow 逐 case 执行并支持中途取消；HTTP、PAGE_FETCH 与原生 UI 写工具每工具一个离线模型/真实效果 fixture，普通 validate 不写，精确审阅后一次应用层派发；PAGE_FETCH 明确要求服务端幂等键，UI 使用输入/回执/独立资源关联且不假设去重。真实 CLI 安装/确认/异常回查已验收；新增固定同源模板、真实响应公开字符串或显式非负安全整数 ID 与资源身份/内容验证，取消/重启仅只读恢复；已补显式非负安全整数 ID 与 pending 状态 GET 轮询；原生 UI 同文档公开新回执 ID 已接入；多组写用例、多 ID/header/响应 URL/任意 UI 网络响应捕获和多步副作用仍待做 |
| 维护与知识 | 站点 endpoints/field-map/notes/fixtures、有效期、trace、安装后自动修复、重试界限 | 已有任务历史、结构 trace、站点知识/过期标记；repair-info/repair 支持已安装读命令与 HTTP 单请求写命令；历史 cases/fixture 重新验证，写修复不继承授权，需精确审阅和实际效果。字段漂移后的读/HTTP 写修复已隔离验收；PAGE_FETCH/UI 写契约修复和显式知识字段修订已验；显式共享文件全包重验已验证（R02）；Agent 依 Skill 最多三轮草稿修复 |
| 分发与工具生态 | 对应 plugin / adapter 管理能力、输出格式、补全、现有 Adapter 能力对照 | 复用已有 v2/AdapterHub；逐项差异和覆盖率待核对 |
| 扩展运行目标 | Electron/CDP 接入、外部 CLI passthrough 等 OpenCLI 能力 | 未完成对齐审计；已有扩展内部 CDP，外部目标控制/CLI 透传的现有实现与约定范围待核对，不据当前浏览器验收宣称完成 |
| 产品复用（独立于 CLI 对齐） | WeWorker API 探索 UI、内置对话及 profile 选择复用同一命令服务 | 后续产品待办，不作为 CLI 对齐完成条件；不涉及 Python 模块，也不开发 OpenCLI 桌面客户端 |

当前范围和剩余工作（本表覆盖上文历史“未实现”描述）：

| 分类 | 准确状态 |
| --- | --- |
| 更广 UI 写 | W01/W02 声明式控件、事件、自动保存、hidden、DOM click/CDP Enter、精确导航与开放 Shadow/frame 已验；任意第三方控件脚本和闭合 Shadow 不在契约内。 |
| 写流程与维护 | 既有定向/共享修复保留；W03 已覆盖 CLI 任务多步/批量写、实际结果传递、部分成功恢复及多用例。安装态复合命令不在本次实现内。 |
| 写结果关联 | W04 已覆盖多 ID、公开 Header/Location/响应 URL、原文档唯一匹配的 UI 网络响应，以及 signed-integer/decimal；精确十进制最多 512 字符，不接受任意响应或舍入后的 ID。 |
| 复杂读取与浏览器 | 动态 query/hash、有界循环/分支和显式跨 origin 主文档导航的实现与证据见 B01；frame 编排已接入；B02 日期/选项及目录/chooser 明确范围见专项；剩余跨 frame/DataTransfer 拖拽、AX/Shadow/子 frame 截图与任意设备模拟恢复。 |
| API 文档与认证 | JSON OpenAPI/Swagger、HMAC/Cookie/CSRF 等已有；YAML、更广发现/引用解析、站点签名/OAuth 按实际契约扩展。 |
| 尚待审计 | Adapter/插件管理、shell completion、输出格式全覆盖、1366 命令/179 分组中的站点与应用映射、外部 CDP/Electron/CLI、Worker 网络/流式 body/持久回放；先映射现有与上游，不能一律认定未实现。 |
| 验收欠账 | Chromium 1194、其他浏览器/系统/实际安装包、全新 Codex/Claude 独立对话、代表站点及全部认证组合仍未完成；外部真实账户写未授权、未验收。 |

离线不静默回退、歧义拒绝、安全截图新路径和既有裸时间单位是明确保留的设计差异。轮询 intervalMs 是新契约的显式毫秒字段，不更改 browser 现有秒单位。整体审计、实现与验收仍未全部完成；本地阶段检查点不代表整体完成。

验收记录要求：每项提供代码位置、自动化用例、真实运行证据和剩余限制。没有证据的项保持未完成。真实站点使用用户指定的 B 站 `https://search.bilibili.com/all?keyword=excel`；仓库内只保存公开占位示例与验证摘要，不保存用户页面、登录信息或网络原始响应。

HTTP 增量（2026-10-17）：`http-contract/runner/worker/preview.js`、`exploration-http.js` 与 `extension/background/http-credentials.js`，运行时 `http` + version 1，原 Extension/Toolkit Runner 不变。测试覆盖真实宿主请求、字符串 ID、JSON POST、权限升级、精确 origin、受限重定向与逐跳凭据匹配、超时/取消不重放、Node 能力隔离、凭据回显脱敏、7 组断言末组失败阻止安装及局部修复。完整 Chromium 47 项含 PUBLIC 捕获→生成→宿主断言→安装→关闭目标页后普通调用，双浏览器 HttpOnly/CSRF 与缺失凭据不回退。最终 6 项聚焦另确认原始占位凭据未进入 Bridge 日志、任务或安装目录。HTTP 实测为 loopback 示例，不代表外部站点通用鉴权验收。详细协议与限制见 [HTTP Runtime](http_adapter_runtime.md)。

2026-10-17 本轮证据：`webcli/browser-service.js`、`extension/background/browser-*.js`、`webcli/exploration-service.js` 及共享 plan/scaffold；WebCLI 98 文件/1069 项，Extension 聚焦 42 项；`webcli/scripts/verify-exploration-browser.mjs` 17 项真实检查通过。外部搜索页三次普通 CLI 调用（两页及不同关键词）各返回 20 条、页码正确、ID 集合发生变化、标题/链接等字段有效。API 为内部接口，仍需维护，不能据此推断长期稳定性。

后续验证/知识增量：`exploration-verification.js`、`exploration-knowledge.js`、`strict-output-contract.js` 和共享 preview batching。发现并修复扩展每次只执行前五组导致大计划无法完成的限制；另修复安装后目录刷新重载页面与普通调用竞争。WebCLI 全量当前 100 文件/1077 项，真实浏览器新增六组断言与知识持久化检查。安装后自动修复还未实现，不能把草稿修复视为该项完成。

安装后修复增量：`exploration-repair.js` 与共享 retention/static/runtime/publisher 的显式 scope 支持。WebCLI 全量 100 文件/1080 项通过，隔离真实浏览器 20 项通过；实际改变示例站点响应字段，旧六组 cases 全部失败，Agent 通过 draft-write 修复映射后六组全部通过，安装后普通调用及其他已有命令通过。共享文件与其他命令保持原字节，安装基线变更拒绝覆盖；npm pack dry-run 581 文件含新模块。该能力依赖调用 Agent 分析和编辑，没有后台第二模型。

真实站点维护：新精确断言发现接口混入无 BV 标识的课程类型，局部修复生成命令的筛选/说明并重新验证、安装。三组真实查询通过：第一页 17 个视频并报告排除 3 个课程，第二页及另一关键词各 20 个视频；结果随页码和关键词变化。cases/字段含义保存为本地站点知识。此前“20 条且类型有效”记录是历史证据，不代表那一版的全部条目都是普通视频。

页面策略增量：`exploration-page.js` 与扩展 `page-source.js` 提供声明式 DOM/状态读取，page-source-v1 不伪造 API 证据。真实无 JSON API 示例页验证三个来源、安装后普通调用、空态与选择器漂移修复。普通调用增加精确 origin/pathname 路由，缺失/多页歧义报错；页面命令必须有作者 cases，知识逐条记录过期。WebCLI 101 文件/1086 项、扩展聚焦 40 项、隔离真实浏览器 22 项通过，npm pack dry-run 583 文件含新模块和 Skill。用户 Chrome 的新增 DOM 命令安装后读取 27 张已渲染视频卡片，标题/链接逐项匹配当前页面；已有 API 三组查询再次通过。该命令读取当前页面已有卡片，未实现参数驱动的多步 UI 工作流或完整列表采集。

API 动态路径增量：`generation-harness/path-parameters.js`、plan binding 和 scaffold 将 Agent 指定的路径段映射为必填字符串参数，保持固定域名/路径其余段，query/body 分开处理；至少两组不同路径组合实际验证。WebCLI 102 文件/1090 项、隔离真实浏览器 23 项通过，动态 GET/JSON POST 四组精确 ID/query/body 断言与安装后普通调用成功，非法路径没有发请求。CLI/Bridge 构建与 npm pack dry-run（584 文件）通过。该项验收使用 loopback 公共示例；动态页面路由、运行时 CSRF/签名仍待做。

INTERCEPT 增量：`exploration-intercept.js`、扩展 `intercept-read.js` 与临时 preview grants 支持已观察查询控件触发新响应；GET query / POST body 必须关联输入参数，参数命令至少两组不同值 cases。跨域授权来自草稿/已安装 manifest，观察仅存结构，预览 token 绑定 tab/route/有效期并清理。WebCLI 103 文件/1094 项、Extension 聚焦 63 项通过；隔离 Chromium 24 项检查覆盖页面一次性请求头、无请求头重放 403、跨域 GET/POST 两组参数、预览/安装/普通调用和超时/多响应/HTTP 错误。最终 24 项还包含同 pathname 整页导航失败断言，返回 INTERCEPT_DOCUMENT_CHANGED；最新插件实机复验第 1→2 页成功，38 视频/排除 4 非视频，已恢复第一页。

真实 Chrome 的后台标签页暴露原生点击未送达问题，已在原生鼠标/按键和 INTERCEPT 执行前调用 Page.bringToFront。B 站新增 `bilibili.com.explored-next-videos` 本地生成→严格预览（页 3→4）→增量安装→普通调用（页 4→5）通过，后者返回 35 视频/排除 7 非视频，页码与 URL 一致；旧 API 三组回归 17/20/20 视频，DOM 当前卡片 25 张。关键词搜索发生整页导航，不作为当前单步 INTERCEPT 成功证据；页面驱动翻页返回本次页，不是任意页查询。用户页已回到 excel 第一页，来源/断言与限制记录在本地站点知识。

跨文档查询增量：新增 exploration.query / page_query_v1，使用 UI_SELECTOR mode=query，声明固定同源结果路径、URL 参数关联和 DOM/状态读取。后台触发一次，重注入后通过独立 continuation 返回结果；pageWorkflow/additionalPaths 支持从结果页重复调用。WebCLI 104 文件/1100 项、Extension 聚焦 58 项、隔离 Chromium 25 项通过；本地 fixture 精确检查观察、两组预览、两次普通调用合计五次提交，没有重放。真实 B 站两关键词预览和普通调用通过，24/27 张卡片与当前 DOM 逐项一致；同词无新导航会明确超时。旧 API/DOM/下一页回归通过，已恢复 excel 第一页，知识 stale=false。CLI/Bridge 构建、配置及 npm pack dry-run 588 文件通过。目录刷新曾重载正在捕获的页面，调用栈确认后将探索/预览/browser 与 managed 调用纳入同一页面队列，弹窗处理例外以解除等待。动态路由、跨源查询导航、无 URL 关联筛选与多步 UI 仍未实现。

来源分析/方案历史增量：新增 `exploration-analysis.js` / `exploration-revisions.js`，analyze 仅处理结构与失败摘要，不发请求；字段启发式不证明业务目标或公开契约，广告/推荐 JSON 也可能被标为 likely_data，必须由调用 Agent 再判断。replan 按文件/计划/cases 摘要保留旧方案，允许重新观察来源；旧 review 失效、cases 必须重写。最多 20 次历史存储，Agent 修复仍最多三轮，不适用于 scoped repair 或已安装任务。

WebCLI 105 文件/1116 项、Extension 聚焦 53 项、隔离 Chromium 26 项通过。实际 loopback API 503 后分析没有重放请求，旧源码/失败结果保留，改用 DOM 后严格验证、安装与普通调用通过，Bridge 重启能读历史。首次 fixture 未消费 fetch 响应体，修正后可采到完成响应；独立采集显式保留 JSON 噪声用于分类，默认过滤不变。真实 Chrome 先保留正常 API 草稿，再按“当前卡片”目标改选 DOM；新普通命令返回 24 张可见卡片，与页面逐项一致。初次人工验收脚本误将 12 张隐藏卡片算入预期，修正可见性范围后通过，未修改生产读取或放宽断言。已保存来源理由与知识，stale=false；重启后历史读取与命令再调用通过。CLI/Bridge 构建、配置及 npm pack dry-run 590 文件通过。

跨 frame 增量：新增 `extension/background/browser-frames.js`，frames 提供 Chrome frameId/documentId，eval 可执行嵌套跨源 MAIN 上下文，页面定位/输入也可校验文档。相同 URL、多进程重复 context ID、导航、脚本异常和永不结束 Promise 均有覆盖；旧插件缺 browser_frames_v1 时明确拒绝。WebCLI 105 文件/1117 项、Extension 聚焦 52 项通过，隔离 Chromium 最终完整 27 项通过，包含超时与身份输出、页面重写内置函数时的隔离匹配。日常 Chrome 五 frame 公开临时 fixture 及 B 站主文档/24 卡片回归通过。子 frame click/hover 仍是 DOM 事件，生成的 exploration 页面来源仍限主 frame；本轮不代表 AX、Shadow DOM 或完整浏览器能力完成。

下载生命周期增量：新增 browser-downloads.js / browser_downloads_v1，35 个 browser 命令。Page 事件限定标签归属，递归子会话启用 Page 事件；最多 100 条内存记录，游标/ID、重复歧义、进度超时与取消均明确处理。等待绕过页面操作锁，支持先等待后点击；落盘路径只做限定 URL/时间的唯一匹配。WebCLI 105 文件/1118 项、扩展聚焦 64 项、隔离 Chromium 完整 28 项通过，含传输中重启 Bridge 后同 ID 继续、一次请求和准确文件字节。日常 Chrome 155 的主页面下载、慢速续等、跨源 frame focus + Enter 及落盘内容通过；DOM click 在该环境没有创建下载记录，未改变下载策略绕过。B 站 Excel 第一页原命令 24 卡片标题/规范化链接逐项一致，未混入示例下载。

原生 frame 指针增量：browser-pointer.js 与 browser_frame_pointer_v1 复用隔离文档身份，按调试目标根视口处理同进程逆变换与跨进程投影，逐层命中检查。悬停布局变化/文档导航失败，不回退 DOM click；保留原生 input 副作用的不确定性。WebCLI 1119 项、扩展聚焦 69 项，隔离完整 29 项及最终浏览器聚焦通过；日常 Chrome 六个同/跨源嵌套 frame 在缩放、旋转、透视与边框下 click/hover/dblclick/drag 均 isTrusted=true，祖先遮挡拒绝，原生子 frame click 下载成功并核对文件字节，修复上一阶段必须用 Enter 的限制。B 站 Excel 第一页 24 卡片回归通过。仍不代表 Shadow DOM、自定义 DataTransfer、跨 frame 拖拽或 exploration frame 来源生成已实现。

持续观察增量：browser-events.js / browser-follow.js 和 browser_events_v1 提供 36 个浏览器命令中的独立 events 接口、console/network follow JSONL。每标签/通道 200 条事件，序列 cursor 避免同毫秒事件丢失；多个读者不互相清空；pending 网络 1000 条，超限 gap 明确失败。时间窗口支持单位，裸数字保留秒，区别于 OpenCLI。网络元数据含完成/失败/重定向；详情按 root/child 会话读取，ID 重用、异步读期间变化、redirect 和过期不能读到后继正文。扩展主动 detach 没有 Chrome onDetach 通知时也能发现并清理。

WebCLI 106 文件/1128 项、扩展聚焦 76 项及 Adapter helper 回归 15 项通过；隔离 Chromium 完整 32 项通过，含持续观察、双订阅者、背压/信号/管道、游标失效和 Bridge 重启续接，旧探索/生成/安装/修复全部回归。日常 Chrome 同样完成双订阅、主/子 target 网络与 console、详情脱敏、信号/管道和重启；B 站 Excel 第一页 24 卡片与安装命令逐项一致。观察只从绑定开始、只保留有界内存，不是持久流量回放；一次性旧命令仍限主 target，Worker 流量未扩展。AX、截图高级选项和多 profile/连接等完整目标继续进行。

AX 页面状态增量：browser-ax.js、browser_accessibility_v1 与 state 的 source/compareSources。读取 Chrome 计算名称和语义树，默认汇总可访问 frame，明确身份可选择单文档；AX ref 保存实际节点，动作前核对当前 role/name，原生指针在悬停后再核对。ShadowRoot 和 iframe 祖先命中检查，使开放/关闭/嵌套 shadow 控件可读取、填写、原生点击；同名替换、名称漂移、禁用、祖先遮挡、错配文档拒绝。DOM/AX 指标比较不修改 refs，来源失败保留错误；有限输出、部分帧与超时明确标记，输入值省略。WebCLI 1129 项、扩展相关 98 项、隔离 Chromium 完整 34 项与最终 AX 聚焦通过；日常 Chrome 同类场景和 B 站主文档 AX/24 卡片回归通过。该项不等于深层 selector/role 查询、全部自定义组件、探索生成的 frame/Shadow 来源或历史状态 diff 已完成。

截图增量：browser-screenshot.js / browser_screenshot_v1 支持 annotate/width/height/path，真实 CSS 响应式视口、fullPage 忽略 height，按 DPR 限 4000 万像素。编号在图片上合成，主文档 DOM refs 最多 200；本地绝对新路径排他保存且不外发。截图时原 CDP 尺寸被 Chrome 重置造成的像素/标注偏移已修复：丢弃首图、固定测量视口、最多重拍一次，再核对几何；失败/导航清理实测通过。恢复报告区分 native 与 observed_desktop_override，不声称还原任意手机模拟。WebCLI 1130 项、扩展 105 项、隔离完整 35 项与最终截图聚焦通过；日常 Chrome DPR 2、图片人工检查、编号实际点击及 B 站 24 卡片回归通过。125% zoom 在隔离浏览器另验。AX/子 frame 编号、深层定位、多连接等仍待后续。

开放 Shadow DOM 查询增量：browser-page.js 的 shadow=true 扫描所选文档及开放根，树内 aria-labelledby 和宿主路径避免误读同 ID 标签；scope/open-root 数/closedShadowIncluded/textScope 与截断明确输出。shadow ref 使用实际节点，节点替换、名称/角色/URL 改变拒绝，悬停后复核；原生指针与同 frame drag 复用 frame 实现。输入事件 composed 到达宿主。查找超出 20000 元素/100 根/32 层即失败，不以部分候选执行动作。WebCLI 1131 项、扩展 109 项、隔离完整 36 项及日常 Chrome/B 站 24 卡片回归通过。普通 CSS 范围保留，闭合根使用 AX；state 文本仍限 light DOM，upload/截图编号未扩展，复合表单元数据和自定义控件仍待对齐。

复合字段增量：browser_compound_v1 使 DOM state/find/描述包含日期 ISO 值与约束/validity、select 选项及独立选中状态、file 名称/accept/multiple；显式 get compound 支持隐藏文件输入、AX ref 和跨源 frame。options 限 50 而 current 不依赖该列表，超扫描/字符/选中项限额显式标记省略或截断。select by=auto/value/label 拒绝歧义/禁用，option.label、禁用 optgroup 与同步选择撤回有实测。HTML JSON 树支持根节点/depth=0、各层和总节点/字符预算，包含 compound，省略密码 value 与脚本正文；raw HTML 原行为保留。WebCLI 1132 项、扩展 117 项、完整 Chromium 37 项及最终聚焦通过；日常 Chrome 真实隐藏文件上传/长列表选择、AX/Shadow/frame 读取和 B 站 24 卡片回归通过。复杂自定义日期/选项弹层、Shadow 文件上传等仍待下一阶段。

文件输入增量：browser-upload.js / browser_upload_target_v1 将 upload 统一到 selector/semantic/ref/frame/shadow 契约，支持隐藏 input、开放/关闭 Shadow DOM 和同 URL/嵌套跨源 frame。保留隔离世界实际节点，通过所属 target 的 objectId 设置文件；不在页面写 DOM 属性或文件路径。预检名称/角色/类型/multiple/disabled，后检同一 input 的文件名/顺序/大小；过期或变化不换节点、不重放，dispatched 表示副作用是否可能发生。WebCLI 1133 项、扩展 122 项、隔离完整 38 项与最终聚焦通过；日常 Chrome 核对本地占位文件字节和 multipart 接收，B 站 24 卡片回归通过。verified 不代表业务服务已收到或文件 hash 一致，目录输入/文件选择弹窗及通用自定义上传流程仍未覆盖。
