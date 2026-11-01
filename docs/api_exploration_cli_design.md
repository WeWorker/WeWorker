# API 自动探索 CLI 开发设计与首版实现

## 2026-10-28 W01–W04 写工作流

声明式 UI v2、精确导航与 frame 身份、CLI 任务写序列和实际结果回查的当前契约见 [W01–W04](opencli_write_workflows.md)。该文档优先于下文历史写能力限制；安装态单工具入口保持不变，任务序列账本不进入安装包。

## 2026-10-28 frame 只读工作流

workflow 逐步声明初始 `frames:[{selector,origin,pathname}]`，每个上下文固定 owner/祖先，独立衔接路线；显式导航只允许更新原叶文档。支持被动 read、既有原生搜索/筛选/翻页、跨源/hash、有界分支循环和结果收集。主 tab 路由与 frame 权限目标分离，完整契约进入生成/作者验证/审阅安装/普通调用/知识/提取修复；新 capability 在旧 profile 派发前拒绝。取消/断线/超时后不重放。详见 [声明和身份契约](opencli_frame_workflows.md) 与 [验收记录](opencli_workflow_context_audit.md)。

## 2026-10-26 可靠性增量

- 显式包含 WebCLI / exploration.* / browser.open 的请求由聊天 Agent 处理，Tier4 不抢占；`WEWORKER_TIER4=0` 仍优先关闭分流，其他未知站点路由保持原规则。未知页面使用带 session 的 `browser.open`，已有 Adapter 的 `open_browser` 不承担任意 URL 入口。
- `call` 固定第二个 token 为工具名，拒绝多余位置参数；多行 `content` 保持字符串。新增 `--args-file`，读取最多 2 MiB 的 UTF-8 JSON 对象（支持 BOM），不与 `--args` 混用；结构化参数覆盖同名 flag。CLI 不按业务 schema 转型，HTTP Runner 仅转换明确的 number/integer 字段，保留字符串 ID、允许 string 的 union 及空白/非法值。
- HTTP 非安全上下文缺少 `crypto.randomUUID` 时，页面快照使用 `crypto.getRandomValues` 生成标识，保持旧 ref 失效规则。
- generate 保存规范化请求摘要。同计划复用返回 `generation.reused=true, applied=false`；改变计划返回 `PLAN_CONFLICT`，通过 `draft-read → replan → generate` 保留旧方案。replan 清空本轮摘要和验证警告，历史版本保留断言及警告。旧草稿缺摘要时，显式重新提交计划也需要 replan。
- draft-read 提供 PAGE_FETCH helper 契约，`fetchGet.data` 是已解析响应体；HTTP 状态与业务状态不可混用。任务摘要附固定错误阶段/下一步提示，不暴露任意异常正文。
- review 展示作者 cases、结构类断言提示、断言删除/变更提示及临时命令名提示。这些是审阅提示，不阻断合法修正，也不等于已证明业务语义。plannedExecution 是声明；普通调用的 runtime/source/version/digest、页依赖与回退须另行验收。

实际客户端、打包验收与剩余边界见 [交接记录](api_exploration_cli_handoff.md)。此增量不表示全部 OpenCLI 对齐完成。

2026-10-18 通用流程修正：新增 EXTENSION_API 探索策略，复用既有 Extension 后台 Runner；生成保留 execution，验证按实际运行时分流，后台 repair 禁止退化到页面策略。登录态与业务页依赖分开判断，详见 [后台 API 探索](background_api_exploration.md)。最终证据见交接末尾，整体对齐仍暂停。

## 显式共享文件修复（2026-10-18）

`repair` 可带 `sharedFiles`，仅选择当前包已有 `extension/internal/...` 或 `http/internal/...` 文本文件（最多 50 个、每个 250000 字节、合法 UTF-8 且无 NUL）。选中共享文件后，该包全部命令必须进入新计划，服务保存 `impact:all-package-commands` 和精确文件/命令集合；不接受作者声明的依赖子集。不能新增、删除文件或改变包权限/运行时，未选文件逐字节保留。仍适用每任务最多 50 命令的限制；更大包不会被部分通过。

所有读命令必须有新执行的作者 cases，含脚手架辅助命令；辅助命令只有服务修复范围、明确 read 计划、匹配新来源证据和作者断言同时存在才执行，普通生成仍跳过。所有写命令重新通过 mock、新精确审阅和实际独立效果，默认 validate 零写。共享文件摘要绑定所有验证与审阅，随后编辑即失效，历史执行/ID/授权不导入。静态验证、预览、实际派发和安装继续检查当前基线及服务 scope。

验收入口：HTTP `verify-exploration-http.mjs`（两读一写的共享映射漂移），浏览器 `verify-exploration-browser.mjs --shared-repair-only`（两个 PAGE_FETCH 读命令与辅助命令全量复验）；支持源码与双打包。最新通过/失败证据见交接末尾。此节更新下文历史阶段的“共享文件冻结”限制；普通不带 sharedFiles 的局部修复仍冻结共享文件。


2026-10-18 知识修订增量：新增 `knowledge-revise`，保留旧映射/原因/当前包与断言证据摘要，CAS 和验证状态均复用；实际读取 cases 或已验证独立写效果才能作为依据，uncertain 不可修订，不发生新请求或安装。详细结构与限制见 [知识修订](api_exploration_knowledge.md)。源码/打包 HTTP 已完成真实字段漂移、修复、历史持久化与零重放验收；UI/最终扩展刷新回归仍进行中，以交接为准。

2026-10-18 持续推进（起点 6420583）：新增 PAGE_FETCH/UI 写契约定向修复。新完整契约由计划生成并绑定服务 repairScope，只允许选定命令的同源声明变更；原策略/方法/幂等要求、包级权限、共享文件和其他命令保持。安装审阅明确新 page-write/ui-write 权限差异，历史 fixture 按 kind/摘要/新来源复验，授权与真实 ID 不继承。最后异步 tab 检查后再复核基线，复用独立效果验证、不重放及 uncertain 恢复边界。契约见写命令文档顶部；最新验证以交接末尾为准，下文未覆盖此项的旧状态属历史。

更新：2026-10-18。已实现多浏览器 profile、独立 HTTP Runner、PUBLIC_API/COOKIE_API/AUTH_API、mode=http 的无浏览器 OpenAPI JSON 发现与宿主请求证据、读命令局部修复和显式 2–8 步只读 workflow；HTTP/PAGE_FETCH/原生 UI 单写、实际 ID 与有界 GET 已接通，最新增加 HTTP 单请求写命令定向修复。具体契约见 [HTTP Runtime](http_adapter_runtime.md) 和 [写命令验证](api_exploration_write.md)，历史与验证结果见 [交接文档](api_exploration_cli_handoff.md)。

前序增量从 `05b4b44` 继续，UI 同文档原生表单支持公开新回执 ID，复用数字/字符串 ID、持久账本和有界 GET 轮询。WebCLI 1341 项、最终聚焦 152 项、扩展 16 项、源码 UI 11 项、双打包 HTTP 18 项与 Chromium 1217 双打包完整 77 项通过，详细证据见交接最新记录。复杂 UI、多步写、多 ID/header/响应 URL、任意 UI 网络响应拦截、签名/OAuth 与完整对齐仍未完成；1194 既有 Shadow/frame 兼容及平台欠账保留。

## HTTP 写命令定向修复

从 `35cd7f8` 接续，repair 的服务 scope 可显式包含 HTTP writeCommandIds。保持所选命令 safety/runtime、完整 http 契约、权限、共享文件与其他命令；仅模块/schema/description 可改。历史 fixture 按命令 packageDigest、kind 和新来源重新规范化，跳过原因可读；执行、实际 ID、审阅和授权不导入。普通 validate 仍只跑 mock 与选中读 cases，实际写必须重新精确审阅和确认。

修复 reviewId 绑定任务/范围，安装基线在审阅、before GET 后及 HTTP beforeDispatch 再检查，安装时仍重验。复用既有持久消费、数字 ID、严格效果身份、有界轮询、取消/重启不重放与 uncertain 只读恢复限制。PAGE_FETCH/UI 契约修复、共享文件、多步写和知识冲突修订仍待办。具体流程与验收入口见写契约末节；WebCLI 1355 项、聚焦 139 项、扩展 20 项、源码/双打包 HTTP 各 21 项、Chromium 1217 双打包完整 77 项通过，最终证据与保留限制见交接。

## UI 公开新回执 ID

uiWrite.result 声明同一 confirmation 节点的公开 data-* ID 属性和显式 string/integer 类型，新增 ui_write_result_v1 阻止旧扩展忽略。新回执匹配时同步取得与提交前不同的 ID；string 保留前导零，integer 仅解析规范十进制非负安全整数。缺失/陈旧/非法、节点替换或换文档失败，不重提交。它是页面回执 ID，不声称捕获实际 HTTP 响应。

fixture 配套 resultReadback.responsePath=resultId 和一致 idType；固定 before/after 的稳定资源身份、每项输入和改变关联值保持，动态资源还必须按相同 argumentPaths 匹配所有输入。离线模型只校验公开占位 ID 契约。实际 ID 在任何效果 GET 前先以 {id} 保存到原任务私有账本，复用同源单段模板、原类型身份比较、pending/resultPending、总预算和同文档检查。恢复匹配不认证 uncertain。安装权限覆盖完整 result 契约，普通 call 返回 resultId/effectVerified:false，不增加 GET。见 [写命令验证](api_exploration_write.md) 末节。

## 写结果关联增量：数字 ID 与异步效果

从 `1b123da` 继续，HTTP/PAGE_FETCH 的 resultReadback 可显式 idType=integer，保留非负安全整数的类型与数值（包括 0）；默认字符串契约不扩大。固定 before/after、实际响应取值、最小 ID 账本及严格资源身份比较沿用现有机制。多 ID、Header/响应 URL、任意 UI 网络响应拦截仍待办；同文档公开新回执 ID 见上节。

新增宿主 exploration-write-poll，共享于 HTTP、PAGE_FETCH 和原生 UI 的独立效果 GET。effect.poll 显式指定 2–20 轮、250–5000 毫秒间隔及 pending/resultPending 精确 equals；只有声明的 pending 才等待，HTTP/网络错误、身份错配、未声明状态或文档变化立即停止。前置检查和写不循环，原 30 秒验证/15 秒恢复预算不变，普通安装命令无附加轮询。页面每轮保持原文档身份，恢复首轮固定当前合法文档。取消独立回查保留原写状态；恢复匹配也不将 uncertain 升级或解除安装限制。完整字段与边界见写契约，验证证据见交接最新记录。

## UI 控件写：原生表单阶段

UI_SELECTOR 写计划生成固定 uiWrite 契约。原生 setter 填写 1–10 个公开单行文本字段，不触发 input/change/click；校验唯一表单/按钮/字段后一次 requestSubmit，等待同文档、同节点、关联参数匹配的新回执。expectedSubmission 描述提交字段而不是实际网络请求；独立 GET before/after 必须绑定全部输入、稳定资源身份和改变的关联字段。复用原审阅、派发前持久消费、取消/重启不重放与安装门禁。普通 call 明确 effectVerified:false，需调用方另行读取。

页面/浏览器可自行重发，本能力不假设服务端幂等，也不保证一次网络请求或一次实际修改。未知自动保存、受控组件、整页提交、多步写及任意 UI 网络响应拦截未覆盖；独立效果 GET 已可显式轮询 pending 状态；完整契约和验收边界见 [写命令验证](api_exploration_write.md) 末节。Python 网站探索agent不参与。

## 写响应资源 ID 回查

最新增加 effect.resultReadback，HTTP 与 PAGE_FETCH 共用宿主规范化、最小公开 ID 账本和效果验证。保留固定 GET before/after，另按实际响应的精确字段填入同写接口 origin 的单段 :id 模板，资源 ID 与内容均须匹配。HTTP ID 在宿主脱敏后、Worker 映射前提取；页面原有幂等/文档/取消边界不变。收到 ID 后先落盘，缺失/非法/丢响应不猜值、不重放；重启或取消后可只读回查，不能将 uncertain 升级为通过。实际 ID 不进入摘要、知识和安装包。完整字段、限制与恢复语义见 [写命令验证](api_exploration_write.md)。

## Extension 页面写：声明式单请求阶段

已增加 `PAGE_FETCH + pageWrite version 1`，固定同源主文档与 POST/PUT/PATCH/DELETE JSON 请求，显式字符串字段映射和服务端幂等键契约。复用现有写 fixture、mock、审阅、派发前落盘、before/after、安装和知识流程。模块固定为注册模板，扩展执行固定请求函数；任意作者页面 JS/UI 提交不属于此阶段。

Chromium 在响应丢失时会自动重发请求，不能以一次 fetch 声称一次网络写。因此必须明确 `idempotency.serverDeduplicates:true`，审阅/账本保存实际稳定 key；本地验收分别统计网络请求和实际副作用。没有服务端幂等保证的页面写继续待办。能力、限制和示例见 [写命令契约](api_exploration_write.md)，最终验证以交接文档末尾为准。

## HTTP 探索任务：已实现

`exploration.start {mode:"http",origin,goal,requestId,allowedOrigins?,auth?}` 创建 `http-` 前缀任务，直接 evidence_ready，不发请求。Bridge 在 profile 选择前识别宿主模式，任务/知识存于独立 http-exploration 根；后续 taskId 自动路由，list/knowledge-read/repair-info/capabilities 明确 mode=http。该流程需要 Bridge，不需要浏览器、插件或桌面客户端。

`discover` 从显式 URL 获取 OpenAPI 3.0/3.1 或 Swagger 2 JSON，保留有界声明结构与 warnings，不执行端点。`request` 发送明确的 GET/只读 JSON/form POST，逐跳检查 origin 和动作语义，以 host_http 来源保存实际 JSON 结构；未获取成功证据时禁止生成。每任务 100 次、单次 30 秒/4 MiB，取消/重启不重放，请求预算在派发前持久化。JSON 文档仅支持本地引用，不猜变量、不展开组合 schema、不自动爬取。

生成必须显式选择 PUBLIC_API/AUTH_API 并绑定观察索引，每命令有作者断言；validate、review/install、知识及 scoped repair 复用现有流程，宿主任务禁止浏览器依赖的命令。HTTP 传输抽取为 http-client.js，由观察和 Worker Runner 共用，鉴权值只留宿主内存。浏览器模式的页面身份、锁、profile 和 Cookie 路径保持独立。

## 多步只读页面流程：已实现，验收记录见交接末尾

`exploration.query source.mode=workflow` 声明 2–8 个 `{pathname, query}` 步骤。query 复用现有跨文档查询/参数化导航，并新增仅工作流内可用的固定路径 filter；步骤必须按前一步 resultPathname 串联；有界分支/循环见下段，不支持任意 JS。工作流内的 navigate 可用无参数静态路径作为可重复入口；只有首步是 navigate 时，才允许从其他步骤的目标页显式从头运行。

filter 只操作已有 search/filter/pagination 读控件，保持同 origin/path/document。参数筛选通过 matchResult 将 result.data 的标量路径与调用参数精确关联，观察 300ms 稳定结果；无参数翻页要求数据变化。同值参数允许已满足关联的结果，作者必须选能证明业务结果的公开字段。所有参数在首步前校验，每个参数至少两组不同值的作者 cases。每次仅派发一次动作，最后一步返回数据；失败带 stepIndex/completedSteps，后续不执行，已完成动作不撤销。每步成功时保留完整 URL/main frame/loader 的内部快照，下一步核对同一文档，不能以同一路由模板接受另一 ID 或同 URL 新文档；快照不进入调用输出或持久证据。

page_workflow_v1 在观察/验证/调用前检查；manifest.pageRoute.workflow 固定动作顺序、选择器、参数、关联条件和路由，总预算最多 30 秒，纳入 page-workflow 权限。结果提取声明不属于动作授权，可在 scoped repair 中修复并重跑历史断言；改动作、参数或顺序须重新生成和审阅。预览与普通调用复用同一后台序列及 manifest 检查，仍只续接一次映射结果。

观察与作者验证分配临时 operationId；cancel 发往绑定 profile，扩展记录取消并在下一动作/读取前检查。验证一次发送一个 workflow case，避免五个长流程共用一次传输时限；取消不会开始下一 case。Bridge 断线使当前工作流失效，重启任务保留 interrupted，不自动续跑。已派发动作可能完成；普通调用暂无独立取消入口。持久化仅存结构与作者明确提交的 cases，观察 values 不保存。仍限主 frame 原生读控件；显式跨 origin 见下节，frame、自定义组件和多步写待做。显式 hash 见下节。

## 显式跨源主文档读取（page_navigation_origin_v1）

navigate 可声明固定 `resultOrigin`；省略时保持步骤原 origin。workflow 每步可声明 `origin`，省略时指任务入口 origin；首步必须是入口，后一步 origin 必须等于前一步明确目的源。只有 navigate 能跨源；when/repeat 步骤必须保持 origin 和 pathname。所有 origin 必须是无凭据、路径、查询或片段的 canonical HTTP(S) origin，端口属于精确身份。不能传动态目标、从重定向推导目的源或拼接任意 URL。

任务在 `start.allowedOrigins` 预声明所有额外目的源；source 声明不能扩大任务权限。生成包 match 增加明确目的 hostname，pageRoute 权限绑定精确 origin/端口与对应 pathname，不能把不同源的路径交叉使用。作者 cases 对每个参数仍需至少两个不同值；生成、安装、知识和结果提取 repair 保留完整目的源，修复不改变动作或权限。

观察从任务原源开始；成功后及作者验证只允许当前已选择读取来源的明确目的路由。跨源预览只使用任务原 tab，不从其他标签补位；普通调用按精确 origin/path 选择，歧义仍拒绝。首步为 navigate 的 workflow 可从任一声明结果页重新开始，显式回到入口，支持 A→B→A；其他 observe/collect/write 不因此获准跨源。

导航保留完整 href、新文档/loader 与稳定结果守卫；hash 保留独立业务关联、刷新标记和同目标一次 reload。重定向到未声明目标失败，不补导航、不重放。旧选定 profile 在观察、验证、普通调用前拒绝新 capability，不切换 profile。作者验证每次一个 case，取消/断线不派发后续动作或 case；已发导航可能完成，迟到结果不保存。实现与验收证据以交接末尾为准，frame 不在本增量内。

CDP 提交新文档后，Chrome tabs URL 快照可能短暂滞后。运行时只在原超时预算内等待精确的导航前完整 URL，不读取该快照的结果；必须等到完整目的 href 才进入结果读取。CDP 的错误来源事件仍立即拒绝，任何第三个来源或错误目标不因等待而被授权；快照始终不更新则超时，不再次导航。普通与 hash 导航均遵循此规则。

## 有界读取控制（B01，2026-10-18）

workflow 步骤可声明 when（上个已执行结果的公开 path/精确 scalar equals）与 repeat（2–8 次 maxIterations、每轮完成后的 until）。条件/循环步骤只能保持同 pathname，条件不能是首步；静态数据声明无脚本、无动态动作、无隐式重试。参数在所有步骤派发前验证，仍共享 30 秒预算、每轮精确 href/frame/loader 和底层新鲜结果守卫。

repeat.collect 可声明公开数组 path、string/number identityPath、1–1000 maxItems、includePrevious 初始页。输出 collections 保留每步集合和轮数，data 保持末个执行结果；条件跳过时可保留初始页。相同 ID 不同字段、无新增页、未到 until 的轮数耗尽、数量或所有集合总计 1000000 UTF-8 字节上限均失败且不返回部分结果。错误包含 stepIndex/iteration/completedSteps；受控流程另含 skippedSteps/executedActions。普通线性流程输出保持兼容。

共享两端规范化 helper 校验声明，page_workflow_control_v1 在观察、验证与普通调用前检查固定 profile。完整控制字段进入 manifest 权限、知识及修复边界，结果提取修复不修改动作/条件/停止/收集规则。metadataOnly 仅返回形状和计数，不保存分支读取值、观察参数或集合。作者验收覆盖两种分支、逐轮请求、重复调用、上限/冲突/无进展、取消/重启不重放与修复闭环；证据以交接末尾为准。

## 显式 hash 导航（B01，2026-10-18）

`mode=navigate` 可增加 `hashNavigation`；外层 resultPathname/pathParameters/queryParameters 保留原契约。片段单独声明 `template`（例如 `items/:id` 或 `/items/:id`）、`pathParameters`（segmentIndex/name/description）、可选 `queryParameters`（name/queryKey/description）、`matchResult`、`freshnessPath` 和明确的 `sameTarget:"reload"`。每个片段至少一个参数；所有外层和片段参数名称唯一，必须逐个映射到不同的公开业务结果路径（相对于 result.data）。freshnessPath 是独立的公开刷新字段，不得与关联字段相同；必须是非空字符串或有限数字。不要把输入框、URL 回显或无关计数当业务数据刷新证明。

目标 URL 包含完整外层路径、查询串与编码后的片段，不沿用未声明查询串。片段固定段为公开 ASCII 路由，路径值保持前导零/Unicode并逐段编码；片段查询值按 URLSearchParams 编码，字面分隔符不成为其他参数。拒绝凭据/动作键和明显写路由，具体只读业务语义仍须依据实际站点确认。每个参数需要至少两个不同作者值及业务断言；观察值不保存为默认值或 cases。

运行时使用独立 hash 执行器，原 path/query 的新文档守卫不变。不同片段同文档导航前读取 freshnessPath 基线，只派发一次 Page.navigate；随后必须收到精确片段事件、全部业务字段关联匹配、刷新字段变化，且完整结果至少稳定 300ms。没有基线则在派发前拒绝；缺新标记/旧结果/错参数超时失败。首次跨文档进入 hash 页面要求新 loader 和业务关联。目标完整 href 已等于当前页时，按作者明确声明只派发一次 Page.reload(ignoreCache:true)，必须取得新文档及不同于重载前的刷新标记；不切去其他页面、不合成 hashchange、不回放导航。新文档证明本次页面加载，不能保证站点后端没有业务缓存。

完整 href、主 frame/loader 和导航事件版本在读取前后复核，额外导航、重定向、下载、取消、断线和超时均停止且不重放。workflow 复用总预算及步骤间精确页面身份。`page_navigation_hash_v1` 在观察/验证/普通调用前检查固定选定 profile，旧插件不派发也不换 profile。全部片段、关联、刷新及重载策略绑定 manifest 安装权限；scoped repair 只改结果提取并重验历史 cases。源码专项与最终双打包结果见交接末尾；未记录通过前不宣称验收完成。有界循环/分支见上节，显式跨源见下节，frame 仍开放。

## 动态查询参数导航（B01 增量）

navigate 可声明 `queryParameters`，每项 name/queryKey/description，1–16 个公开唯一键；与 pathParameters 合并生成必填字符串 Schema、workflow 参数和 pageRoute.navigation 权限。宿主与扩展使用字节一致的参数规范化模块，禁止凭据/动作/重定向键；非空有效 Unicode 字符串至多 512 字符，由 URLSearchParams 逐值编码，保留前导零和字面分隔符。观察 values 不保存，也不作为默认值。

`page_navigation_query_v1` 在观察、作者验证、普通调用前检查所选 profile。每个 query 参数需至少两个不同作者值；workflow 复用逐参数要求。扩展仍一次 Page.navigate、等待新文档、完整 href 相等与稳定数据；查询串被改写即失败，不重放。manifest/权限绑定完整映射，repair 只允许结果提取修复。hash 导航的独立新鲜度与重复重载契约见上节；循环/分支和跨源/frame 不由本增量解决。

## 参数化页面导航：已实现

`exploration.query` 新增 source.mode=navigate，显式 resultPathname 的每个 :id 用 pathParameters（segmentIndex/name/description）绑定，values 仅供本次观察，不保存为默认值。目标固定同源主文档，result 可用 UI_SELECTOR 或 DOM_STATE。产物为 UI_SELECTOR pageWorkflow，`pageRoute.navigation` 声明目标模板/绑定并纳入安装权限；静态 observe 和原查询控件模式保留各自行为。

扩展 page_navigation_v1 在背景中只派发一次 Page.navigate，保留初始 frame/loader 身份，等待新主文档、准确目标 URL 与 300ms 稳定结果，读取后再次核对。无响应、跨源或错误 ID 重定向、下载、超时、读取中文档改变均失败，不重放；同一 URL 也显式导航并读取新文档。值保留前导零与 Unicode，拒绝路径穿越、编码分隔符和明显写操作路径。实际业务读取语义仍由作者根据站点契约确认。

普通调用从入口或目标模板匹配页中选择唯一页/唯一活动页，缺失/歧义不换页或新开。preview 与普通调用复用同一 manifest 路由检查和续接机制，结果映射只在续接后执行。旧插件缺能力时在派发前拒绝；每命令至少两组不同路径参数的作者 cases，保留失败不安装。知识保存来源；scoped repair 保留既有路由/绑定/权限并重新运行历史断言。

限制：主文档单次导航读取；跨源需下述显式声明，任意路径正则尚未覆盖，显式 hash 见上节。动态 query 见上节，多步只读操作复用 workflow；写契约另行审阅验证。取消后丢弃迟到结果，已派发导航可能继续完成。验收覆盖实际公开占位详情、前导零/中文 ID、同 URL 重复调用、错误 ID 重定向和结构漂移修复；详见交接末尾。

## 多浏览器 profile：已实现

扩展通过 chrome.storage.local 的 `webcliBrowserContextId` 保存随机 UUID v4，独立于 Adapter/build profile。重连与重载保持；每个 socket 另分配 connectionId。同 ID 的第二个在线连接被明确拒绝，绝不覆盖首个连接；复制浏览器目录后须由操作者明确处理重复身份。旧插件单连接获得临时 ID，可执行原有调用；不能持久设置 alias/default，升级后需重新绑定。

### 选择与路由

- `webcli call profile.list/rename/use` 管理连接、唯一别名与默认；use name=auto 清除默认。全局 `--profile` > `WEBCLI_PROFILE` > 持久默认 > 唯一在线连接。多连接不明确时 PROFILE_AMBIGUOUS，未知 PROFILE_NOT_FOUND，显式/default 离线 PROFILE_OFFLINE，不降级到其他浏览器。
- browserProfile/browserConnectionId 放在传输信封，剥离后才发给扩展；Adapter 业务参数原样保留。Toolkit 在 CLI 和 Bridge 两条路径都不依赖浏览器选择。
- 每次操作在开始时固定 contextId 和 socket，通过 AsyncLocalStorage 传递；生成 Worker 的 IPC 回调显式绑定 AsyncResource。服务、任务/知识/草稿、命名会话与共享 tab 锁按 contextId 隔离，宿主安装的 Adapter 包仍共享。
- pending 记录目标 socket、随机 UUID 请求 ID 和 timer；异 socket/迟到回复不能完成请求，断线立即清理并失败。随机 ID 跨 Bridge 重启不复用。动作没有自动重放，open_browser 在选定连接失败后也不通过系统命令另开浏览器。
- browser、exploration、普通 Extension Adapter、旧桌面转发、截图/打开标签/重载、动作分析上下文、生成 Worker 以及 trace 使用同一路由。响应和 Worker 进度只返回请求者；Adapter 目录变化仍是全局事件。扩展资源请求回复原 socket。
- follow 首次结果固定 contextId/connectionId，后续轮询不跟随默认值或别名变化；连接变化失败，调用者检查后显式以原 profile/cursor 续接。DOM/AX refs 和事件游标自带随机快照身份，跨 profile 使用被拒绝。
- 新探索任务保存扩展的标签会话身份，每次实时阶段前后复核。浏览器重启/扩展重载造成 SESSION_EXPIRED 时需明确新建任务；不按同 origin/tabId 继续。

### 存储兼容与限制

`<Adapter workspace>/browser-profiles/profiles.json` 原子保存已知 ID、alias、默认；浏览器数据位于其 contextId 子目录。配置错误、符号链接和非法别名明确失败，不覆盖已有配置。

升级前的 browser/exploration 根完整保留，使用 `--profile=legacy` 读取 sessions、任务、证据、草稿、cases 和知识；旧生成 Harness 的 get/trace 同样只读。读取不会把旧活跃任务改为 interrupted，也不会把旧 tabId 分配给首个连接。此版本不提供自动迁移或直接续跑旧任务：调用 Agent 可参考旧知识/cases，在明确选定的新 profile 中 bind/start 并重新验证。旧文件不移动、不删除、不覆盖。

已知离线 profile 支持历史读取和 sessions/doctor；需要浏览器的操作明确离线失败。浏览器关闭可能先由 Chrome 返回调试操作取消，再由 socket 关闭返回 PROFILE_DISCONNECTED，均不重放。旧桌面消费者可用单连接/保存的默认值；尚未提供桌面 profile 选择 UI，多连接无选择时报错。

### 验证证据

- WebCLI 全量 108 文件/1145 项通过，新增 profile 配置、双 WebSocket、Worker IPC、任务/锁、旧数据只读与 Toolkit 无浏览器测试；扩展相关 85 项通过。
- 两个独立 Chromium user-data-dir + 真扩展 + CLI，验证同站点/同名会话、别名/default/env/flag、跨 profile refs/cursor 拒绝、双方探索/验证/安装、普通调用、follow 固定连接、Bridge 重启、扩展重载、浏览器退出/重启及旧身份拒绝；完整浏览器回归 44 项通过。最后 trace 聚焦结果见交接日志。
- 用户指定 B 站 Excel 第一页，主文档 AX 和 24 张可见视频的标题/规范化 URL 逐项回归通过；旧探索历史读取通过。真实数据没有提交。
- Python 网站探索agent全程排除；CI/发布/schema/.env/依赖未改。PUBLIC_API/COOKIE_API runner、通用自定义控件、多步 UI/写命令、UI/内置聊天复用与平台分发仍待实现/验收，不能据多 profile 完成关闭完整 OpenCLI 对齐目标。

## 需求修正

用户明确要求：只安装 WebCLI + 浏览器插件，Codex、Claude 等可执行 CLI 的 Agent 就能对话探索 API、编写和验证 Adapter，无需启动 WeWorker 客户端，不配置第二套模型 Key。此前“首版依赖客户端 Backend”的设计已撤销。

Python 网站探索agent完全排除在任务范围之外。本轮没有修改其源码、测试、运行环境或界面。API 探索界面后续再迁入公共契约，本轮保留现有界面和聊天工具行为。

## 架构

```text
Codex / Claude / 其他 CLI Agent + Skill
            ↓ webcli call exploration.<command>
     现有 WebCLI Bridge（本地后台服务）
            ↓ ExplorationService（无模型依赖）
     任务持久化 / 证据结构化 / 草稿 / 验证 / 安装
            ↓ 预览验证器和 Adapter 安装器
       浏览器任务 → WeWorker 浏览器插件
       HTTP 任务 → 独立宿主 HTTP 传输/Worker
```

外部 Agent 负责理解目标、选策略、命名工具、编写/修复代码和向用户提问。WebCLI 负责确定性操作；`generate` 是依据已观察证据生成隔离草稿，不是调用模型自主创作。Agent 用 `draft-read` / `draft-write` 完成语义改造。

借鉴 OpenCLI 的会话绑定、证据先行、渐进帮助与验证闭环。参考包括本机 1.8.6 help、本地技能与 npm 官方 1.8.8 发布包静态审计，见 [版本核查](opencli_1_8_8_audit.md)。当前增加 browser.* 页面操作、eval 和有界网络 JSON 读取，复用既有 Bridge；探索任务仍只持久化结构。完整对照见 [能力台账](opencli_parity.md)。

## 实际命令

命令以 `webcli call exploration.help` 为事实来源，所有结果为 JSON。

| 命令 | 含义 |
| --- | --- |
| capabilities / tabs | 插件状态和可探索标签页，不需要桌面 Backend |
| start | tabId、goal、requestId 创建任务；可用 allowedOrigins 显式增加精确 API origin；重载指定页面采集证据 |
| list / get / events / evidence / trace | 找回任务、查看状态、游标事件、结构化接口证据和修复诊断 |
| analyze | 按结构分析 API/页面来源、噪声、访问阻塞与验证错误，给出下一步提示；不执行请求或自动切换来源 |
| replan / revisions / revision-read | 按当前 draftHash 留存未安装草稿、计划、cases 和验证记录；重做计划后可读取旧方案及源码 |
| collect | 用户操作页面后补采，不重载 |
| actions / probe | 复用插件安全搜索、筛选和分页候选，每任务最多三次探测 |
| intercept | 触发已观察的搜索/筛选/下一页控件，按参数关联本次 JSON 响应；结构证据与页面路由绑定 |
| observe | 观察声明式 UI_SELECTOR / DOM_STATE 来源，只保存路由、字段类型结构和选择理由 |
| query | 单次只读控件触发后跨文档等待，以同源结果路径和 URL 参数关联 DOM/状态；观察仅存结构 |
| cancel | 停止后续阶段，丢弃迟到结果；已经派发的浏览器操作可能完成 |
| generate | 默认最多两个 GET；Agent plan 支持 1–50 个读取工具、JSON/form POST、GraphQL query、动态路径绑定与页面来源；POST/动态路径必须有 readReason |
| repair-info / repair | 查看当前安装包摘要/历史 cases，从新证据建立所选已有读命令或 HTTP 单请求写命令的修复草稿；其他文件与命令保留 |
| draft-read / draft-write / draft-add | 列文件、读取内容和 hash、按 expectedHash 修改现有文件，或新增 helper/command/guidance 文件 |
| verification-read / verification-write | 按工具读写带 hash 的 1–10 组真实参数及精确输出断言；修改后重新验证 |
| knowledge-read / knowledge-save | 按 Adapter 名读取历史知识；从验证成功的任务保存选中端点、字段含义、作者测试用例和备注 |
| validate | 静态检查及真实浏览器只读预览验证 |
| review / install | 展示当前权限/工具/版本差异；以当前 reviewId 和用户确认安装本地 Adapter |

复杂 plan/content 使用现有 `--args` JSON 通道，普通参数使用 `--key=value`。不增加 WebCLI 通用业务类型转换。

## Agent 使用流程

1. capabilities → tabs，确认页面与目标。start 会重载，用户有未保存输入时先处理。
2. start 返回 collecting，持续 get/events 观察；CLI 进程退出不终止 Bridge 任务。
3. evidence/analyze 检查端点、参数名和响应结构；必要时 actions/probe、页面观察或人工操作后 collect。
4. 明确来源与理由后 generate；Agent 检查和修改参数、分页、结果映射和业务错误。
5. validate，失败先 analyze 与诊断，再修复代码；确需换来源时 replan 保留旧方案并重新采集/生成/验证。不把注册成功或跳过执行当验收。
6. review 展示安装变更，用户同意后 install，再以普通 `webcli call <adapter>.<command>` 使用。

`webcli install --skills --target <目标目录>` 会安装新增的 webcli-api-exploration Skill，不限于某个模型供应商。即使 Agent 没有 Skill 机制，也能通过完整命令帮助调用。

## 协议与状态

- 固定消息 `exploration_command` / `exploration_command_result`，使用唯一 request ID。结果仅回发起连接，不广播证据。新命令只接受无浏览器 Origin 的 loopback 连接；拒绝扩展/网页与远端连接。
- 保留命名空间 exploration，CLI 在业务 Adapter 查找前处理，用户包不能覆盖此入口。不改变 Extension / Toolkit Runner 分工。
- 服务在 Bridge 中按需初始化，存储于既有 profile workspace 的 exploration 子目录；与桌面 API 探索旧任务分开，避免未经设计的数据迁移。
- 状态为 created → collecting → evidence_ready → draft → validating → review_ready → installing → installed，另有 failed/interrupted/cancelled。
- start 的 requestId 在重连和重启后保持幂等；同 key 不同参数拒绝。generate 不覆盖已存在草稿。
- Bridge 重启将进行中的任务标为 interrupted，不自动重放操作；同一 tab 的 browser 操作与采集/验证共用锁，取消后等待已派发请求收尾才释放。dialog 回复可在点击等待弹窗时单独执行。
- 修改草稿使验证和 review 失效；安装核对包摘要、基线与当前 review。安装开始后不能取消，重复查询安装结果不会再次安装。
- 不增加数据库 schema、模型 SDK 或依赖，不访问客户端设置和模型 Key。

## 证据与验证边界

持久化与输出只含请求/响应结构、字段名称、状态及端点。省略响应值和请求头，移除凭据查询字段，其余查询值变为占位；常见数字 ID、UUID 和邮箱路径段结构化为 :id。跨源流量不自动增加权限。

当前生成范围：已观察成功且被判定为读取的 GET 与 Agent 明确编写读取理由的 POST（JSON/form/GraphQL query），每个计划最多 50 个新命令。未知/持久 GraphQL 操作、mutation、subscription 不自动生成；写命令尚未开放。额外 API origin 在 start 显式授权，生成包只从选中证据派生 runtime_allowed_hosts，安装前审阅权限差异。已有包的命令按原有增量机制保留；只执行新生成的查询验证，不运行保留的写命令。

API 动态路径由显式 plan.pathParameters 绑定，包含 segmentIndex/name/description；索引是 pathname 去掉开头 `/` 后按 `/` 切分的零基位置。必须覆盖每个脱敏 :id，也可由作者参数化已观察的 slug 段。名称不能与 query/body 或其他路径参数冲突，必须说明读取理由；自动计划不猜测这些参数。生成 schema 使用必填 string，保留前导零，无捕获值默认参数。每个命令内联路径解析函数，按单段编码，保持固定 origin/其余路径；拒绝斜杠、百分号、控制字符和 dot traversal。已观察 query 键从参数提取到 URL，其余留给 GET query/POST body，路径键不会重复进入请求体。

动态命令至少两组不同路径参数组合的作者 cases，仍要求真实执行、零失败/跳过；Agent 用精确返回字段确认参数生效。知识保存命令的路径映射，定向 repair 使用相同要求。当前不从页面自动提取鉴权参数或签名，也不为尚未观察的 URL 建立证据；动态页面 pageRoute 另行设计。

## 来源分析与方案历史

analyze 只读取已保存结构，区分 likely_data、maybe_data、noise、blocked、unavailable、not_json、excluded。字段名只能提示可能含业务数据，不能证明与用户目标相关，也不能证明官方接口或长期稳定性。独立 start/collect 显式保留非静态 JSON 噪声用于分类，其他入口默认过滤保持原样。成功响应但缺 JSON 结构不能生成 JSON 查询；仅有模糊 JSON 或已经观察到页面替代来源时必须提供显式 plan。

API 草稿的执行策略明确为 PAGE_FETCH，不允许将其标成尚未实现的 PUBLIC_API/COOKIE_API。strategyNote 包括 reason 和可选 alternatives/limitations；PAGE_FETCH/INTERCEPT 若提供 note，必须说明替代来源。旧计划为兼容可省略，但 analyze 会返回 needsRationale，Skill 要求 Agent 主动补充。策略与说明进入 trace 和验证后的站点知识。已识别的鉴权错误先提示恢复访问；未知 HTTP/字段错误先诊断，不自动换来源。

replan 只允许非活动、未终结的新工具草稿，不适用于定向 repair。draftHash 覆盖文件原始字节、计划和作者 cases，即使 manifest 损坏也可留存；旧目录原样保留，每任务最多 20 次。读取时重新核对摘要，外部修改返回 REVISION_CHANGED。新方案清空验证、review、cases 与当前草稿，但保留采集结构和已消耗的探测次数；重新观察、生成后必须重新编写 cases、验证及审阅。已安装包不会随 replan 修改，历史成功不能当作当前审批。存储上限不是 Agent 自动尝试次数，Skill 仍限制最多三轮修复。

## 页面触发查询与响应捕获

INTERCEPT 由显式只读 API 候选、单步搜索/原生筛选/下一页控件及请求字段关联组成。背景监听器在触发前注册，仅接收开始后的 Fetch/XHR，准确匹配 origin/pathname/method 与传入的 query/body 参数；旧响应、不相关参数不算证据。复用已有 CDP，会话结束移除本监听器，不断开其他调试用户。返回完整 JSON，限制大小/复杂度并脱敏凭据字段；超时、多响应、HTTP、非 JSON、目标/路由变化明确失败，不回退旧结果。

观察不保存参数值，页面来源绑定 plan 和生成包 pageStrategy=INTERCEPT；参数命令至少两组不同值与作者输出断言。临时预览令牌绑定 tab/route/有效期和草稿 manifest 的主机授权，只用于 intercept_read，finally 清理；普通调用从匹配页面主机的唯一安装包解析授权，拒绝合并多个包的权限。页面可在同一 document 内更新查询串，整页导航触发 INTERCEPT_DOCUMENT_CHANGED。原生输入前将明确选择的页面带到前台，避免后台标签页吞掉 CDP 点击。

整页导航使用独立 exploration.query：来源仍为 UI_SELECTOR，mode=query，声明一个读控件、result（UI_SELECTOR/DOM_STATE）、同源固定 resultPathname 和公开 URL 参数关联。后台执行一次，跟踪主 frame 导航，等待路径/参数/加载完成与数据稳定；SPA 必须有不同于操作前的数据，不把旧 DOM 当新结果。观察只保存结构，参数命令至少两组不同作者 cases。

生成 handler 首次返回声明式 __webcli_page_query，后台执行后重新注入包，再以独立第二参数传入 page_query_result。只允许一次续接，错误/写操作/重复请求不重放；CLI 业务参数不能伪造续接。pageWorkflow 和 pageRoute.additionalPaths 允许普通调用从固定起始/结果页执行。预览使用同样流程，重建临时 registry/grant，结束清理。协议能力 page_query_v1 防止旧插件忽略。动态路径、跨源导航、无 URL 关联的筛选和多步流程仍未支持。

Adapter 目录刷新、普通调用、探索读取/捕获/探测、预览验证及已有标签页的 browser 操作共用扩展页面执行队列，避免异步刷新重载打断查询；dialog 独立执行以解除等待。不依赖固定延时解决竞争，也不重试业务动作。

这允许页面自行生成签名/临时请求头，未提供通用签名算法、凭据提取或自动策略回退。当前不支持多步 UI、复杂自定义筛选、子 frame 或动态 API pathname。

## 页面来源策略

observe 接受 UI_SELECTOR（行 selector、字段 selector/attribute/optional、emptySelector 和 limit）或 DOM_STATE（window 自有属性 path，或 JSON script selector + path）。扩展在 MAIN world 执行固定读取函数，观察阶段只返回类型结构；独立 page-source-v1 证据通过 fingerprint 与任务中的页面来源及 plan 绑定，不借用无关 API。支持纯页面或 API/页面混合草稿；纯页面生成不引入 API shared runtime，增量保留已有包。

生成命令经 page_read helper 读取当前页面。UI_SELECTOR 返回 items/matchedCount/truncated；必需字段缺失、隐藏、歧义或无已观察空态均报错。DOM_STATE 不调用 getter、不读 prototype/存储/凭据字段；只接受有限 JSON，最多 1000 数组项、100 对象字段、10 层、20000 节点和 500000 字符，超限报错。页面观察省略标量值，作者必须另写精确 cases，真实验证全通过才可安装。插件能力标记为 page_sources_v1。

manifest 增加可选 pageRoute `{origin, pathname}`，仅允许已声明页面主机的准确 HTTP(S) origin/pathname 和 Extension 前台只读命令。普通调用匹配已有页面；多个匹配页时只选唯一活动页，否则 PAGE_SOURCE_AMBIGUOUS；无匹配页返回 PAGE_SOURCE_ROUTE_MISSING，不导航其他页面。helper 再检查 origin/pathname，防止调用前页面变化。查询串/hash 不作为绑定条件，初始命令无参数，只读取当前结果；动态页面路径与多步页面流程仍待实现。

知识增加 pages 与逐条 stalePages，修复可引用新的页面来源，仍保留原路由和其他命令。隔离真实浏览器覆盖无 JSON API 的三个来源、安装后普通调用、空态、缺字段、选择器漂移后的定向修复以及重启恢复。精确测试证据和真实站点复验见跟进文档。

## 通用浏览器层

`webcli call browser.help` 列出 36 个命令，覆盖命名会话、页面定位/输入、原生主/子 frame 指针与同 frame 拖拽、文件输入、网络、eval、截图、控制台、弹窗、下载和持续观察。session 的 tabId 与 Chrome storage.session 身份共同校验，浏览器重启后必须重新绑定，避免 ID 复用。用户绑定页面 close 只释放绑定；独立 open 页面才会被关闭。

browser 命令返回任务需要的页面数据，不保存到探索记录；网络详情只返回有界 JSON 并按凭据字段脱敏，非 JSON/截断正文省略。Bridge 不记录浏览器参数、脚本或输入值。完整页面截图上限 4000 万像素，支持编号、临时尺寸与本地新文件保存。AX 引用已支持开放/关闭/嵌套 Shadow DOM，DOM 查询可显式包含开放根；通用复杂控件待补；多连接/profile 已实现，见本文开头。

frames 返回可访问页面的 frameId/documentId。eval 支持显式 frame/document，在 MAIN world 执行并等待 Promise；定位、读取、填写和等待也可绑定 documentId。需要 browser_frames_v1，旧插件会被 Bridge 拒绝，避免忽略参数后执行到主页面。frameId 是 Chrome ID，不是 frame 数组索引；同 URL 页面不被合并。指定 documentId 时先校验它与 frameId 配对，再向该文档注入，导航或移除后明确失败。

跨源独立渲染 frame 使用递归 iframe 调试子会话，上下文按 session 分开存储，已有主页面网络/预览缓存不接收子会话的同名 ID。临时文档标记只放在扩展隔离环境；匹配后用 Chrome 的 frame 身份定位唯一 MAIN 上下文，不执行页面定义的 getter 或重写函数。标记在执行前清除，finally 仅按原 documentId 清理；用户表达式只派发一次，并绑定 uniqueContextId，不能落入导航后复用的 contextId。脚本异常、文档失效与中断分开报告；30 秒截止同时覆盖同步运行和不结束的 Promise，不终止共享渲染器，不自动重放。超时不证明副作用没有发生，Agent 应先检查状态。子 frame 的 click/dblclick/hover/drag 现由 browser_frame_pointer_v1 提供原生指针，生成的 exploration 页面来源仍限主 frame。

验证复用现有 static validator、preview runtime validator 和 publisher。所有目标工具必须真实执行且通过，不能跳过。独立探索开启 `restrictToExpectedTools`，仅生成目标进入执行计数；脚手架登录检查和保留的已有工具不计入目标跳过数。共享验证器默认行为不变。任务仅保存验证计数/错误码，不保存预览结果值。安装是本地行为，不上架市场，也不等于授权执行业务写操作。

Agent 可以为最终命令输出声明 requiredPaths、types、notEmpty、patterns、equals 和带明确路径的 rowCount。断言从输出根开始，按每一行精确检查，不回退到相似字段；空列表的行级类型检查为空集，存在性和非空需求单独声明。测试输入必须由作者明确提供，不从流量复制凭据或用户值。修改 cases 同样使验证/审阅失效。扩展须声明 strict_output_contract_v1，旧插件明确拒绝；超过五组用例分批执行并汇总，某批失败不能被其他批掩盖。

站点知识存于当前 profile 的 exploration/knowledge 中，与旧 UI 的记忆分开。只提升该计划选中的结构证据和作者 cases，附可选字段解释及备注，不保存捕获正文。记录使用内容 hash 防止覆盖并发更新，同字段的不同含义拒绝覆盖。30 天有效期按每条记录检查，安装包摘要变化另行标记 stale；知识只作线索，复用前仍要检查当前页面。验证过但未安装的包会显示当前安装摘要不匹配，这不表示验证失败。

目录变化触发的页面刷新与 managed page 调用共用扩展侧队列，等待在途调用完成后才清除注册和重载，后续调用等待刷新结束。它不重试已经执行的业务 handler。

下载由 `browser.downloads` / `browser.wait kind=download` 提供，插件能力为 browser_downloads_v1。绑定时订阅主页面及递归跨源子页面的 Page 下载事件，以事件证明 tab 归属，最多保留每标签 100 条；不从全局下载历史猜标签。cursor 标记开始序号，默认等待最近 browser 动作后的下载，等待开始时冻结边界；显式 after 或 downloadId 用于跨动作、Bridge 重启和长下载续等。被动观察绕过 Bridge 会话/tab 锁和扩展页面队列，不阻塞触发动作。

完成事件返回 complete，取消/中断为 DOWNLOAD_INTERRUPTED；超时区分 not_seen/in_progress，后者附可续等 ID；多个匹配、过期游标和失效上下文明确报错。单次最多 30 秒，不重放下载。落盘路径仅在已观察 URL 和 ±2 秒开始时间范围的唯一 Chrome 元数据匹配中返回，并声明 fileResolution；无法匹配不猜路径。URL 常见凭据参数脱敏，data URL 正文省略；不读文件内容，不修改 Chrome 下载设置。扩展/调试断开或标签关闭清理内存，Bridge 重启可继续；重新绑定后使用新 cursor。子 frame 原生 click 与 focus + 原生 keys Enter 均已在日常 Chrome 完成示例下载，但浏览器仍可能要求站点/下载权限，不把所有网站的自动下载策略视为已解决。

原生子 frame 指针复用文档身份解析，在隔离环境保留选中 DOM 节点和远程对象。DOM.getContentQuads 的坐标属于当前调试目标根视口：同进程子 frame 先逆变换到其本地视口，跨进程边界再通过 iframe 内容四边形逐层投影到主视口，处理边框、滚动、缩放、旋转和透视。逐层使用隔离环境 elementFromPoint 检查目标和 iframe owner，不能越过父层遮挡；不按 URL 或 frame 数组位置选择页面。悬停后重新测量，移动超过半个 CSS 像素、文档改变、遮挡等情况停止，不自动点击重试。30 秒准备截止防止延迟派发，异常拖拽尝试在最后已发送位置释放按钮，finally 清理隔离标记与远程对象。返回 trusted 与 frame/document 身份只表示原生输入已发送，不保证业务动作完成。拖拽限同 frame 的可见元素，不构造 HTML5 DataTransfer。

console/network 的 CLI follow 通过同一 browser.events 轮询接口输出 JSON Lines，不另建 Agent 或 UI 专用服务。events 不占 Bridge 会话/tab 锁或扩展页面队列；扩展每 tab/channel 保留 200 条内存记录，epoch/channel/sequence 游标区分同毫秒事件与不同观察。筛选后也推进 checkpoint，until 年轻事件保留至未来轮询；过期/淘汰游标明确失败，多订阅者互不消费对方数据。

捕获主/子调试会话的 console 与网络终态，pending 以 sessionId/requestId 区分，最多 1000 条，超限明确 gap；子 target 启用 Network。流式网络仅输出有界元数据，详情才请求对应 target 的 JSON 正文并脱敏。redirect、重用 request ID、详情读取期间变化及 pending 淘汰均不能读到后继请求正文。一次性 console/network 保留旧主 target 输出；新 events/follow 覆盖已订阅子 target，不声称捕获绑定前流量或 Worker 流量。

follow 处理 ready/entry/checkpoint/end/error、输出背压、durationMs/maxEvents、SIGINT/SIGTERM 和关闭管道；断线不自动重试。Bridge 重启可显式按 cursor 续接，插件/调试状态失效则重新选择页面并开始新观察。Chrome 主动 detach 不保证触发 onDetach，因此观察轮询用不执行页面代码的 Runtime.getIsolateId 检查所属调试连接，失败清理状态且不自动重附；自有临时调试连接释放也统一清理。since/until 支持 ms/s/m/h，裸数字沿用本项目秒数，区别于 OpenCLI 的毫秒。能力标记 browser_events_v1 阻止旧插件静默忽略新参数。

state 默认保留 DOM 读取；source=ax 通过 Chrome Accessibility.getFullAXTree 取得计算后的 role/name、状态属性与语义树，省略输入 value。默认按可访问 frame 逐一绑定 Chrome frameId/documentId，重复 URL 不合并；显式 frame/document 参数限制到一个文档。refs 总量 1–200（默认 100）、语义节点 1000、文本 12000 字符，最多 50 frame，整体准备期限 30 秒；不能读取的子 frame、达到上限、未映射节点均标明 partial/truncated 与明细，不视作完整页面。

每个 ref 带不可猜测快照 ID 和 frame/document，真实 DOM 节点仅保存在扩展隔离世界 Map。CDP backendNodeId 按所属 target 解析，并验证 ownerDocument，不能把数字 ID 在另一个进程重用。使用时核对当前 Map、URL、连接状态及新 AX role/name；不按相似名称寻找替代节点。AX 原生指针在悬停后/按下前再检查名称与禁用状态；同名节点替换、名称漂移、文档错配和禁用均明确失败。ShadowRoot 与 iframe 祖先逐层检查命中，开放、关闭与嵌套 shadow 控件可通过 ref 读取/输入/原生点击；普通深层 selector 查询和所有自定义控件语义尚未补齐。

compareSources 是 DOM/AX 控件数、命名覆盖、角色分布与耗时的来源比较，按同一文档顺序测量，不是网页历史差异，也不自动决定哪种来源更好。比较不会替换当前引用；来源失败给出错误，不静默回退。快照和引用验证有独立截止，超时不派发后续输入；远程对象按 group 在 finally 释放，页面 Map 只保留该文档当前可用引用。新能力 browser_accessibility_v1 防止旧插件忽略来源或 AX ref。真实证明与边界见跟进记录。

截图高级选项由 browser_screenshot_v1 提供。width/height 是 1–8192 CSS 像素，使用真实桌面视口模拟触发响应式布局，fullPage 忽略 height；按 Chrome zoom/DPR 计算像素边界，预检查和 PNG 尺寸检查均限制为 4000 万像素。annotate 刷新主文档 DOM refs，测量截图前后几何，在 OffscreenCanvas 中合成编号/框线，不向页面插入节点；返回 label/ref、角色/名称、frame/document 与 CSS bounds。限 200 refs，超限显式声明，尚不标注 AX/Shadow DOM/子 frame 节点。

截图必须与测量视口和元素几何一致。Chrome 若在截图时重置其他 CDP 客户端的尺寸 override，首张图片丢弃，固定当前测量尺寸后只重拍一次；不拉伸错误图片掩盖位置偏差。再次不一致、布局变化或文档导航明确失败。完整页面临时回到顶部，finally 恢复视口和原文档滚动；导航后只恢复视口，不把旧滚动应用到新文档。恢复失败优先返回 SCREENSHOT_RESTORE_FAILED，包含原错误码。

restoration.mode 区分 unchanged/native/observed_desktop_override，最后一种表示清除 override 后原观测尺寸未恢复，重新设置了明确的桌面 override；verified 只证明原观测 width/height/DPR/scale 及原文档滚动恢复。CDP 无法读取另一客户端完整 emulation 配置，任意手机/方向模拟配置不在恢复保证内。resize 引起的网站业务副作用也不能撤销。临时尺寸和截图按桌面 Chrome 验收，不能把该结果推广到所有模拟模式。

path 只在 Bridge 解析，须为已有目录下的绝对新文件路径；截图结果验证 PNG 后以 wx、0600 排他写入，绝不覆盖，路径不发送给扩展。保存时返回路径、字节数与元数据，不再返回 base64；失败不改变既有文件。截图及网页数据由调用 Agent 按任务范围留在本地，不进入探索持久证据。

DOM 定位可传 shadow=true，在所选文档及开放 shadow roots 内分别执行 CSS/role/name/text 查询。CSS 组合关系不跨树，重复目标保留并拒绝模糊动作；结果附外到内 shadowHosts 元数据和不透明 shadow refs。树内 aria-labelledby 不误读主文档同 ID，角色/名称/节点/URL 变化使引用失效；主文档 shadow 指针也走已有 frame 指针路径，保留节点并逐层命中测试，悬停后复核 ref。input/change 以 composed 事件通知宿主组件，行为与验证责任写入 Skill。

shadow 查询上限为 20000 元素、100 个开放根、32 层边界，超过即 SHADOW_QUERY_LIMIT，不把不完整候选集当作唯一匹配。输出最多 200 refs，总数和截断明确声明；state 文本仍为 light_dom，深层文本需目标 get/extract。关闭根使用 AX，不支持 shadow 与 AX/compareSources 混用。支持 selector 等待、同 frame drag 与显式 frame/document 操作；子 frame DOM refs 不自动附带路由，调用方继续传身份。upload 已支持该定位契约（见后）；截图编号尚未扩展，通用自定义控件协议仍待实现。新能力 browser_shadow_query_v1 防止旧插件忽略选项或引用。

browser_compound_v1 提供原生复合字段和有界 HTML 树。DOM state/find/元素描述默认附 date/time/datetime-local/month/week、select、file 的 compound；显式读取 property=compound 可查询隐藏文件输入，也可对 AX ref 或指定 frame/document 读取，AX state 仍不自动返回值。日期包括 ISO 值格式、范围/步长、required/readOnly 与原生 validity；fill 成功只表示值保留，范围或步长无效会在 validity 中体现。文件只返回名称、数量、accept/multiple，不读取内容或本地路径。

select 的选项列表限 50，current/currentValues 独立扫描选中项，保证常见长列表第 50 项后的选择仍可见。label 使用原生 option.label，disabled 包含 optgroup 继承。by=auto/value/label 明确匹配语义，重复值/标签或 value/label 碰撞不得选择第一项；缺失/禁用在修改前拒绝。派发 input/change 后核对原节点与选择状态，撤回/替换返回 SELECTION_REJECTED，不重放；异步业务完成仍需调用方另验。最多扫描 20000 选项、请求 1000 项，超限明确失败/省略。选中列表最多 1000、文件名最多 100，字段字符串截断显式标记，复合信息单次 100000 字符预算，用尽输出 omitted，不能当成空值。

get property=html as=json 返回 tag/attrs/直接文本/children/compound，未指定目标时从 documentElement 读取，有目标保持唯一匹配约束。默认 depth/childrenMax/textMax/maxNodes 为 3/50/200/500，可分别调到 0–20/0–200/0–2000/1–2000。普通属性/文本合计 100000 字符，attrs 只保留语义及 aria/data 属性，省略事件处理器；密码 value、script/style/noscript/template 正文不序列化。truncated 明确说明各项限制；不保留文本和元素的交错顺序。开放 shadow root 给出未包含标记，选中内部节点后可单独读取；原 raw HTML 行为保留，不复用 JSON 省略规则。

browser_upload_target_v1 统一上传到主/子 frame 的实际原生文件节点。Bridge 检查 1–20 个绝对普通文件路径并生成名称/大小元数据；扩展通过 withBrowserFrameContext 选择准确文档和 target，在隔离世界保留节点/URL/名称/角色/multiple 校验闭包。CSS、语义、普通/Shadow ref 与 AX ref 共用目标契约，隐藏文件输入允许选中；普通 file 的 DOM role 为 button。关闭根使用 AX，可处理同 URL 和递归跨源 frame。

路径仅传入所属调试 session 的 DOM.setFileInputFiles，不写入脚本参数、DOM 属性或页面标记。派发前核对保留节点仍连接、类型/合同未变且非 disabled，AX ref 另复核计算名称；不重新选择同名替代节点。派发后核对同一 input 的文件名/顺序/大小，页面清空、替换或导航明确失败。verified 不保证文件内容未变或服务器收到，不读取内容/hash；真实验收用本轮公开占位文件额外核对字节与 multipart 接收。

操作有 30 秒期限，页面准备也检查同一截止，防止迟到注入继续保留目标；已派发的 CDP 命令不保证可撤销。错误携带 dispatched（进入本次操作后），已派发失败可能产生页面事件或自动上传，不重放。finally 仅清理本次旧文档隔离标记/远程对象，不接触后继文档。目录输入暂不支持，accept 只返回提示，不推断 MIME 或改变网站校验规则。

## 已安装命令修复

已安装命令维护使用 repair-info/repair：先读取当前包摘要并采集新证据，再将已有只读命令复制到隔离草稿，绑定当前任务的修复范围。只允许改所选模块、schema 和 description，其他文件/命令、身份、路由、权限不变，禁止新增共享代码。静态检查、运行验证及发布三处均核对当前包摘要和服务保存的修复范围；草稿文件内的声明不能扩大范围。历史 cases 会带入并标记过期信息，每个目标至少一组，全部重新运行通过才能安装。当前支持 Extension/HTTP 包；HTTP 单请求写命令流程见上节，PAGE_FETCH/UI 写契约和共享文件重构仍待后续。

## HTTP 写命令阶段

独立探索现已接入 HTTP 写骨架、独立 mock fixture、精确执行审阅、写前/写后 GET、持久化单次派发与不确定结果回查，详见 [写命令与副作用验证](api_exploration_write.md)。这扩展 PUBLIC_API/COOKIE_API/AUTH_API；默认 validate 不实际写入。声明式 PAGE_FETCH 幂等写与公开字符串返回 ID 回查已接入；复杂 UI 控件/多步写操作、PAGE_FETCH/UI 写工具 repair 与多 ID/响应 URL 回查继续留在能力台账。下面的旧验收数字是历史记录，最新证据以交接文档顶部及末尾为准。

## 后续 UI 统一

这里的 UI 指 WeWorker 自有界面。用户明确不需要 OpenCLI 桌面客户端；本节属于后续产品集成，不作为 CLI 对齐的完成条件。目标网站的多步 UI 操作和 CDP/Electron 外部目标控制仍按 CLI 能力分别核对。

本轮独立命令不经过 TypeScript Backend。后续由 Backend 的薄适配层调用相同 Bridge 命令，使 API 探索页面、内置聊天工具与外部 Agent 共用任务状态和校验。UI 不需要启动 shell；不得借此改动 Python 网站探索agent。

## 验证与未完成范围

具体命令和数量见交接日志。WebCLI 全量 106 文件、1133 项通过；扩展相关 122 项通过。真实 Chromium + 未打包插件 + 独立 CLI/Bridge + loopback 示例站点完整 38 项通过，包含原生文件输入跨 frame/Shadow/AX 上传与本地表单接收、复合字段/结构化 HTML/严格选项选择、开放 Shadow DOM 定位/输入/等待、截图编号/尺寸/恢复、AX/DOM 对比与跨 frame/Shadow DOM 引用、首次自动启动 JSONL、持续观察/游标/信号/断线续接、浏览器操作、下载生命周期与续等、同 URL/嵌套跨源 frame、POST/GraphQL 工具、六组精确断言、知识持久化、API/DOM 定向修复、三个页面来源、动态 GET/POST 路径参数、跨域 INTERCEPT、跨文档页面查询，以及 API 503 后保留历史并切换 DOM 的闭环。frame 的 Promise 超时、输出身份及页面重写内置函数时的隔离匹配仍通过。用户指定的真实公共视频搜索页已完成采集、生成、修复、验证、增量安装和普通 CLI 搜索/分页，DOM 命令也与当前页面逐项核对；原始页面/响应未进入仓库。动态路径使用公开占位 loopback 示例站点验收，不代表已在该外部搜索站点验证动态详情接口。

验收脚本为 `webcli/scripts/verify-exploration-browser.mjs`；使用临时副本改变连接端口及 CLI 配置目录，生产协议和默认端口未改。只启动/停止脚本自己创建的服务和浏览器，Adapter 安装、任务和浏览器配置均隔离。Playwright 用于测试浏览器启动、示例导航及下载取消刺激/诊断；下载观察、探索/生成/验证/安装和业务调用均经过真实 CLI 与插件，不 mock 扩展传输、fetch 或验证器。隔离浏览器显式允许下载并使用临时目录；日常 Chrome 另行验收，不把该测试设置当成用户浏览器的默认策略。

早期 38 项快照的后续缺口已按阶段补齐，最新已验证与待办以能力台账及交接末尾为准。当前仍待：复杂 UI/多步写、frame 工作流、任意站点签名/OAuth、YAML/更广文档解析；Codex/Claude 各一次全新独立对话验收、各平台安装包；API 探索 UI/旧聊天入口统一，以及能力台账中的其他差距。当前由调用 Agent 通过 analyze/replan 明确切换策略，没有运行时静默回退。当前证据不代表任意 Agent 在任意站点上的生成质量已验证。

跨文档查询真实增量：用户 Chrome 的新页面搜索命令以 excel/spreadsheet 两组严格预览通过；安装后普通调用分别读取 24/27 张视频卡片，标题与链接逐项等于当前页面，结果随关键词变化。旧 API 三组返回 17/20/20 视频、DOM 24 张、INTERCEPT 下一页返回 38 视频，均通过。B 站相同关键词不会触发新查询，命令明确 PAGE_QUERY_TIMEOUT，不能用同词搜索重置页码；已通过切换词恢复 excel 第一页。该限制写入本地知识，不作通用多步流程完成结论。
