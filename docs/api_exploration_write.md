# HTTP／Extension 写命令与副作用验证

2026-10-28 新增 W01–W04 契约：受控 input/change、自动保存、显式控件/hidden/Shadow/frame、click/Enter/整页导航、多组写用例、任务内有限写序列和部分恢复，以及多 ID/公开 Header/Location/响应 URL/UI 网络结果和精确负数/任意精度整数。完整字段、编排入口及边界见 [写工作流](opencli_write_workflows.md)。下文 2026-10-18 的单请求/v1 说明保留为基线，其“尚未覆盖”不表示新契约仍缺失；不支持的任意控件、真实账户和跨环境验证仍保持独立边界。

2026-10-18 边界补充：只读页面 navigate 的 `queryParameters` / `hashNavigation` / 显式 `resultOrigin` 与 workflow 的明确 `origin` 与有界 `when/repeat/collect` 属于 Extension 页面读取契约（见开发设计），不改变 HTTP 鉴权/请求权限、PAGE_FETCH/UI 写 URL 或 effect.resultReadback 限制，不赋予业务写授权。

## 共享文件修复与写授权

`repair.sharedFiles` 选择已有 internal 文本文件时，必须把包内全部读写命令放入计划；服务绑定完整影响范围。所有写命令的历史 fixture 仅供复验，不能导入旧 review、执行记录或真实 ID。validate 只跑 mock/读取 cases，必须逐个完成新精确审阅和独立真实效果后才能安装；修改任一共享文件使全包验证和旧审阅失效。取消、重启、丢响应不重放，uncertain 只读恢复不能安装。

最多 50 个已有 internal 文本文件，每个 250000 字节；不增删文件，不扩大权限。文件与范围规范见 [共享修复设计](api_exploration_cli_design.md)。未显式选择的共享文件保持冻结；下文历史阶段中的“不支持共享修复”由本节更新。

## PAGE_FETCH/UI 写契约定向修复（2026-10-18）

`repair` 可选择已安装的声明式 PAGE_FETCH 或 UI_SELECTOR 写命令。用原 canonical ID、同一种 strategy、新声明/观察来源和完整 pagePathname/bodyParameters/idempotency 或 uiWrite 计划描述当前契约。服务将新契约保存到 `repairScope.pageWriteContracts`，直接生成隔离 manifest；只接受该精确契约，草稿 source.json/manifest 不能扩大服务范围。

允许同 origin 内明确更新请求路径、页面路径、JSON 字段映射或原生表单控件/回执声明。保持原 runtime、safety、HTTP 方法、PAGE_FETCH 幂等 header/serverDeduplicates、包级权限、其他命令和共享文件；不能在 PAGE_FETCH/UI/HTTP 间切换。固定模块仍不得编写任意 JS。完整新契约作为 `page-write:`/`ui-write:` 权限差异进入安装审阅；与 HTTP 写修复保持权限完全不变的边界不同。

历史 fixture 须匹配原安装摘要和 kind（extension_single_write_v1/ui_single_submit_v1），并按新契约重新规范化。选择器变化可复用待复验数据；请求字段变化使旧 fixture 不再匹配时明确跳过，作者按实际契约补写，不继承实际 ID、执行或授权。普通 validate 仍零真实写。新精确审阅、before GET、派发前持久消费、实际效果/数字 ID/有界 GET 和安装门禁复用原实现；最后一次异步 tab 身份检查后再同步核对安装基线，变化时不派发。

取消/重启/丢响应不重放；只读恢复不能认证 uncertain。修复后重新走 review/install、授权内普通调用和 knowledge-save。自动化 `exploration-page-repair.test.js`；隔离实机 `verify-exploration-browser.mjs --page-repair-only`，双打包加 `--bundled-cli --bundled-bridge`。最新验证状态见交接末尾；显式共享文件修复见下节，复杂控件和多步写保持待办。下文早期阶段的“写 repair 未支持”属于历史范围。

2026-10-18：独立探索新增 HTTP 写命令闭环。PUBLIC_API/AUTH_API 可在 `mode=http` 中无浏览器运行；COOKIE_API 沿用所选浏览器 profile 的凭据通道。最新增加 PAGE_FETCH 声明式 Extension 写：固定同源主文档、JSON 字符串字段映射、浏览器会话与明确服务端幂等契约。HTTP、PAGE_FETCH 与声明了公开回执 ID 的原生 UI 现支持公开字符串或显式非负安全整数 ID 的资源回查，三种写验证均支持显式 pending 状态的有界 GET 轮询。最新增加 UI_SELECTOR 同文档原生表单单次提交与输入关联 GET 效果验证（见末节）；复杂控件和多步写流程尚未接入，Python 网站探索agent不参与。

## 来源与生成

可选择已成功观察、风险明确为 write 的 POST/PUT/PATCH/DELETE 接口；也可用 `exploration.declare-write` 明确声明任务 origin 范围内的写接口。声明不会执行网络请求，保存 `declared:true`、`status:null`、`observation.executed:false`，不能作为成功执行证据。OpenAPI discover 不自动执行或转换写端点。

```json
{"taskId":"example-task","url":"https://example.com/items/example","method":"PUT","bodyKeys":["title"],"reason":"明确的公开测试条目更新接口"}
```

用 evidence 的原始索引提交 generate 计划：

```json
{"tools":[{"name":"update_item","risk":"write","sourceApiKind":"action","sourceApiIndexes":[0],"strategy":"PUBLIC_API","writeReason":"更新公开测试条目的标题","strategyNote":{"reason":"明确的 HTTP 更新接口","limitations":"一次请求并以独立 GET 回查"}}]}
```

生成器只提供带确认保护的骨架。Agent 必须编辑模块与 schema，保留 `safety:write`、`x-webcli-requires-confirmation:true`，完成语义实现后设置 `x-webcli-agent-authored:true`。原始捕获值不能作为参数默认值。模块确认前返回 `{blocked:true,requiresConfirmation:true}`，确认后才调用 `api.request`，明确解释成功与失败结果。

```js
module.exports = async (args, api) => {
  if (args.__confirmed !== true) return {blocked: true, requiresConfirmation: true};
  try {
    return await api.request({url: 'https://example.com/items/example', method: 'PUT', json: {title: args.title}});
  } catch (error) {
    return {ok: false, errorCode: error.code};
  }
};
```

## 作者 fixture

通过 `write-verification-read` 读取当前 hash，再用 `write-verification-write` 的 `tool`、`fixture`、`expectedHash` 更新。fixture 独立于安装包，只有作者提供的公开测试数据；实际响应正文和鉴权值不会保存；启用下文 resultReadback 时，仅将明确声明为公开的返回 ID 保存到当前任务私有账本，以便重启后只读回查。

```json
{
  "id": "example-first",
  "representativeArgs": {"title": "After"},
  "expectedRequest": {"url": "https://example.com/items/example", "method": "PUT", "body": {"title": "After"}},
  "successResponse": {"status": 200, "body": {"ok": true, "title": "After"}},
  "successExpectation": {"ok": true, "title": "After"},
  "failureResponse": {"status": 409, "body": {}},
  "failureExpectation": {"ok": false, "errorCode": "HTTP_STATUS"},
  "effect": {
    "readback": {"url": "https://example.com/items/example"},
    "before": {"equals": {"title": "Before"}},
    "after": {"equals": {"title": "After"}}
  }
}
```

每个写工具当前只有一个 fixture；参数不接受 `__confirmed`。request 与声明/观察的方法及结构 URL 必须一致，body 为 JSON 结构或精确字符串，headers 仅允许显式 content-type；凭据由 HTTP 契约提供。回查只接受同一 HTTP origins 契约内的明确 GET URL，不跟随重定向，经过读取语义检查。before/after 使用现有严格输出断言，必须在同一非通配标量路径声明不同的 equals 值。该断言证明所检查字段的变化，不保证服务端事务性，也不能排除其他客户端同时更新。

## 验证、执行与安装

1. 普通 `validate` 做静态检查、写命令 mock 与真实只读命令验证。mock 在 HTTP Worker 内运行作者代码，替换全部传输；没有宿主鉴权和网络回退。检查省略/false 确认均为零请求，以及确认后的请求、成功/失败解释。骨架或 mock 失败不能进入真实写审阅。
2. 通过后返回 `write_review_ready`。`write-review` 返回完整 fixture、HTTP 鉴权声明、package/cases/fixtures 的综合摘要和 reviewId，不发送请求。
3. 在用户已有授权覆盖实际目标及测试副作用时，调用 `write-verify`，传精确 `tool`、`reviewId`、`confirmed:true`；没有覆盖时应展示这份具体审阅后取得同意。安装授权不自动等于远端测试写入授权。
4. 验证整体最多 30 秒：独立 GET 检查 before，通过后才执行一次精确写请求，再独立 GET 检查 after。预检失败不发送写请求，且消耗当前 reviewId；派发前先持久化 `dispatching`，存储失败不发请求。每任务最多 100 个消耗的审阅。
5. 同一 reviewId 重复调用、并发重入、取消、Bridge 重启或 CLI 丢失响应都只返回已有记录，不重放。取消不能撤回已经派发的请求；此时结果可能是 `uncertain`。`write-readback` 在任务结束/取消/中断后仍可重查 GET，只报告当前 after 是否满足，不将失败的命令自动标为验证通过。
6. 请求不匹配、额外请求、网络/状态错误、未等待请求完成就返回、响应断言失败或回查失败均不能通过；作者代码吞掉请求错误也不能绕过。全部当前写命令通过真实效果验证、全部读命令通过后，才进入 `review_ready`，复用安装审阅与 consent。安装时 mock 会再次运行，不会再次实际写入。

HTTP write 每次普通调用也强制 `__confirmed:true`、最多一个请求、不跟随任何重定向、不自动重试；宿主不能被 `requires_confirmation:false` 放宽。普通 call 是每次新的显式调用，没有探索任务的 reviewId 去重账本，调用方遇到超时必须先检查效果，不能盲目重试。只读 HTTP 保留最多 50 请求和五跳重定向。返回前有尚未结束的请求会明确失败。

## 当前限制与证据

HTTP 路径不支持任意 UI 写操作、批量/多步写工作流、多 ID/响应 URL 或 header 回查、自动回滚、服务端幂等键协商、PAGE_FETCH/UI 写工具局部 repair。单次 fixture 不能证明任意输入和任意站点的正确性。Cookie 写通道复用已有 profile/鉴权契约，但本阶段真实副作用验收使用独立 PUBLIC/AUTH loopback 服务，未对真实账户发写请求。

自动化见 `webcli/__tests__/exploration-write.test.js` 与 HTTP Runner 测试；真实 CLI/Bridge 验收见 `webcli/scripts/verify-exploration-http.mjs`（支持 `--bundled`），其中 write-acceptance 使用独立本地服务验证实际状态、响应丢失、无效果、重定向、取消和进程重启。具体本次结果见交接文档与 ROADMAP。


## Extension PAGE_FETCH 声明式写

浏览器任务可用 `strategy:"PAGE_FETCH"` 绑定单个声明/观察的 mutation；再提供固定 `pagePathname`、`bodyParameters`（JSON 字段 → 必填字符串参数）及服务端幂等声明。需要 `page_write_v1`。例如：

```json
{
  "tools": [{
    "name": "update_example", "risk": "write", "sourceApiKind": "action", "sourceApiIndexes": [0],
    "strategy": "PAGE_FETCH", "pagePathname": "/editor",
    "bodyParameters": {"title": "title"},
    "idempotency": {"header": "idempotency-key", "serverDeduplicates": true},
    "writeReason": "更新公开测试条目的标题",
    "strategyNote": {
      "reason": "目标接口需要当前浏览器会话",
      "alternatives": "公开接口不提供写能力，页面没有提交控件",
      "limitations": "依赖该接口明确保证幂等键去重，只支持一次 JSON mutation"
    }
  }]
}
```

`serverDeduplicates:true` 是作者根据服务端契约作出的声明，不能凭空填写来绕过校验。只接受 `idempotency-key` 或 `x-idempotency-key`；不自动探测或协商幂等支持。若目标没有这一保证，不能使用本路径。普通验证没有发送重复请求来证明服务端幂等，必须区分接口契约与实际测试证据。

本地实机发现 Chromium 在响应连接突然断开后会重发同一个请求，PUT 和 POST 均出现；CDP Fetch 拦截也不能阻止底层重发。因此本能力只保证**一次应用层派发与稳定幂等键**，不声称网络层只发送一次。服务端必须对同一键、同一操作在重发窗口内原子去重。任务审阅返回实际注入的 header/key；key 由 taskId 与 reviewId 派生，在写派发前随执行记录落盘。普通安装命令每次显式 call 创建新 key，不对两个独立 call 去重；遇到失败先回查，不能盲目重新调用。

生成产物为 manifest 的 `pageWrite` version 1 契约和固定注册模块。作者直接在计划/manifest 中声明请求，无需编写页面 JS；模块字节必须保持固定模板，任意自定义页面代码不属于此版本。包校验、安装权限 `page-write:` 与摘要绑定完整页面路由、方法、URL、字段/参数映射和幂等契约。支持 POST/PUT/PATCH/DELETE，固定同源 URL，不允许 query/hash、动态路径或跨源请求；0–30 个明确 JSON 字段，值为不超过 10000 字符的字符串，无默认值或类型转换。JSON 字段必须与来源结构一致。

复用同一 `write-verification-*`、`validate`、`write-review/verify/readback` 和安装账本。fixture 与 HTTP 相同，`failureExpectation` 使用 `{"ok":false,"errorCode":"PAGE_WRITE_HTTP_STATUS"}`；成功响应为原始 JSON，当前 fixture 要求非空对象成功解释，不覆盖仅返回 204/null 的接口，也无任意作者映射。代表请求只声明业务 body/content-type，幂等头由运行时提供并单独列入审阅。mock 不连接浏览器、不发送请求；独立 GET before/after 通过浏览器同源会话执行，返回结构断言结果，不持久化实际响应。

扩展在独立隔离 world 运行固定 fetch，携带浏览器 same-origin Cookie（包括 HttpOnly），`redirect:error`、`cache:no-store`，单响应 4 MiB、单请求最多 15 秒、整体验证最多 30 秒。复核主 frame/loader/完整 URL，隔离 world 随机文档标记防止同 URL 导航与 context ID 复用；before 后的写和 after 均绑定同一文档。使用现有页面队列、profile 连接身份及取消通知；断线/取消阻止后续步骤，已派发 fetch 及浏览器重发可能完成，由服务端幂等契约限制效果。`dispatched:true` 表示请求已交给扩展、可能已有副作用，不是服务端成功证明。

响应丢失、业务失败、效果不符、导航或超时仍保留 uncertain，不因幂等键而自动重试或允许安装。独立 readback 在原 profile/任务 tab 身份有效且页面仍符合路由时可运行，只证明当前 after 是否满足；不会把失败的命令变成通过。浏览器重启或扩展重载导致旧会话失效仍须新任务，不能改绑另一页读取。

真实验收脚本为 `webcli/scripts/extension-write-acceptance.mjs`，由 `verify-exploration-browser.mjs --page-write-only` 调用；`--bundled-cli --bundled-bridge` 验证两端 bundle。隔离 loopback 服务分别记录接收请求与实际 mutation 次数，覆盖 HttpOnly、正常效果、四种写方法响应丢失/同键重发仅一次效果、无效果、重定向、取消、重启、安装和普通调用。未对真实账户发写请求；任意服务端幂等实现、动态 CSRF/签名、嵌套/非字符串正文、UI 控件提交、跨 frame/跨源、多步写、多 ID/响应 URL 回查和写 repair 均未覆盖。最终运行结果见交接末尾。


## 写响应 ID 的资源回查

HTTP 与 Extension PAGE_FETCH 写 fixture 可在 effect 中增加 resultReadback；UI 回执 ID 的绑定方式见末节。保持原 readback 的 before/after 变化证明，再补一次读取实际资源的 GET。适合“先从固定统计接口验证创建前后变化，再核对新资源”的单次写场景，不能仅凭写响应成功或总数增加通过验证。

```json
{
  "readback": {"url": "https://example.com/items/count"},
  "before": {"equals": {"count": 0}},
  "after": {"equals": {"count": 1}},
  "resultReadback": {
    "url": "https://example.com/items/:id",
    "publicId": true,
    "responsePath": "item.id",
    "identityPath": "id",
    "expect": {"equals": {"title": "After"}}
  }
}
```

作者须在 successResponse.body 中提供公开 mock ID，例如 `{"ok":true,"item":{"id":"example-mock"}}`，用于离线检查声明。真实运行从实际传输响应的 `item.id` 提取，HTTP 在宿主脱敏后、作者 Worker 映射结果前读取，Extension 使用固定函数返回的原始 JSON；不取 mock、作者结果映射、响应提供的 URL 或 Location header。

url 必须与写接口同 origin，包含恰好一个完整的 `:id` 路径段，无 query/hash/凭据。responsePath 与 identityPath 使用最多八段精确自有属性路径，不接受通配符、凭据字段或原型属性。默认 ID 必须为 1–512 字符的公开字符串，只包含 Unicode 字母/数字、下划线、点或短横线；保留前导零，作为一个路径段编码，拒绝 `.`/`..`、百分号、斜杠、控制字符和未声明的数字类型。可显式加 `idType:"integer"`，此时 mock 和实际响应都必须是 0–9007199254740991 的 JSON 数字整数，拒绝负数、负零、小数、非有限数、越界值和数字字符串。ID 在账本与资源身份比较中保留原类型，只有构造 URL 时编码十进制文本；不会把字符串 `"007"` 转成 7。默认不写 idType 或明确 string 时保持原行为。模板与最终 URL 都经只读语义检查；重定向不跟随。当前不支持任意精度/负数数字 ID、多返回 ID、header ID、动态 query/hash；异步轮询见下一节。

write-review 展示完整 resultReadback 声明与 ID 持久化政策，纳入既有 package/cases/fixtures 摘要。`publicId:true` 是作者确认该字段为可保存公开标识的声明，不能用来保存个人数据、账号、凭据或不明字段。实际只保存 `{id}` 到当前任务执行账本，随既有 0600 原子存储；摘要/get/list/trace、write-review 执行记录、知识和安装包不输出该真实 ID，其余响应内容不落盘。

真实写成功收到 ID 后先持久化，再等待作者结果及执行 GET。固定 after 必须通过，随后资源的 identityPath 必须严格等于实际 ID，expect 还须包含至少一项非 ID、非通配标量 equals 内容断言。HTTP 延续宿主鉴权和脱敏；页面读取延续原 profile/tab 和同文档守卫，包括固定 after 到资源 GET 之间的导航变化。总执行预算仍为 30 秒，不增加写次数。resultReadback 属于作者验证 fixture，不装入普通命令；安装后的普通 call 延续单请求/确认行为，不自动执行额外回查或保存返回 ID。

丢失响应、缺 ID、非法 ID 或保存失败均不能通过或继续资源 GET；review 已消耗，不得为找回 ID 重发写。没有持久 ID 时 write-readback 在发送任何 GET 前返回 WRITE_RESULT_ID_UNAVAILABLE，调用方须通过独立已授权的只读工具检查服务状态，不能猜测资源地址。已保存 ID 后取消/重启/详情读取失败，可用原 reviewId 重新运行两个 GET，仍保留原 uncertain，不放行安装或把失败 handler 变成通过。

自动化入口为 `exploration-write-result.test.js`、HTTP/Extension 写测试，以及共享 `scripts/write-result-acceptance.mjs`；由原 HTTP 和页面写验收脚本在源码/打包模式调用。只验证隔离 loopback 公开夹具，不代表任意外部创建接口可用。最新数量与报告见交接末尾。

## 异步效果：显式 pending 状态与有界 GET 轮询

2026-10-18 增量。HTTP、PAGE_FETCH 和原生 UI 写 fixture 的 effect 可增加 poll；不声明时保留原单次 after。轮询只作用于独立效果 GET，before 检查仍只执行一次，写仍只派发一次，UI 页面回执也不重触发。

```json
{
  "readback": {"url":"https://example.com/items/count"},
  "before": {"equals":{"count":0}},
  "after": {"equals":{"count":1,"state":"ready"}},
  "resultReadback": {
    "url":"https://example.com/items/:id", "publicId":true, "idType":"integer",
    "responsePath":"item.id", "identityPath":"id",
    "expect":{"equals":{"title":"After","state":"ready"}}
  },
  "poll": {
    "intervalMs":250, "maxAttempts":10,
    "pending":{"equals":{"state":"pending"}},
    "resultPending":{"equals":{"state":"pending"}}
  }
}
```

poll 全部字段进入原 fixture 摘要与精确审阅，修改后旧 review 失效。intervalMs 明确使用毫秒，接受 250–5000 的整数；maxAttempts 接受 2–20，包含首次观察轮次。pending 对应固定 readback，resultPending 只在 resultReadback 已声明时使用，至少有一个。每个条件只接受 1–10 个精确公开属性路径的标量 equals，不支持通配符、敏感/原型字段或脚本；其中至少一项必须与对应 after/expect 的最终 equals 不同，避免把成功状态误声明为等待。

每轮先 GET 固定回查；after 通过后，才 GET 已持久化实际 ID 的资源。只有当前未通过响应完整匹配其已声明 pending 条件，才等待下一轮。每轮重新检查固定 after；资源 identityPath 必须始终与实际 ID 类型和值一致，UI 的稳定 identityPath 也必须保持原值，身份错误立即停止，即使状态为 pending。网络/HTTP 错误（包括 404/429/5xx）、重定向、未声明状态、错误最终内容、页面文档或 profile 变化均不重试。作者须依据实际业务契约声明 pending；本功能不猜测等待状态，不读取 Retry-After，也不轮询其他 URL。

验证仍共用原 30 秒总预算，包含 before、写、等待和全部 GET；独立 write-readback 的总预算为 15 秒，实际轮数也受剩余时间约束。停止等待不会增加写次数；浏览器自己的网络重发风险与 PAGE_FETCH 服务端幂等要求不变。页面轮询始终固定初始文档身份，独立恢复则在本次第一个 GET 固定当前合法文档，之后不接受同 URL 重载。完成的轮数输出在 effectAttempts 或 readback.attempts；一轮最多包含两个逻辑 GET，此数不表示网络请求数/副作用数，异常中断可能不返回轮数。不存储轮询响应或实际字段历史。

耗尽次数、超时、取消或重启保持 uncertain，不自动继续或重写。明确的 write-readback 可以重新开始一次只读轮询；即使匹配，也不改原执行状态、effectVerified 或安装门禁。同一任务只允许一个独立回查，期间修改任务返回 TASK_BUSY。`exploration.cancel` 可停止独立回查（包括原任务已 cancelled/installed 的情况），仅中断读取并保持原任务状态。普通安装命令不携带 fixture，不附加 ID 存储或轮询；原生 UI 普通调用仍返回 effectVerified:false。

聚焦测试：exploration-write-result、exploration-write-poll、exploration-write、exploration-extension-write、exploration-ui-write。真实验收复用 write-result-acceptance 与 ui-write-acceptance，在隔离 loopback 服务验证延迟可见状态、严格数字身份、次数耗尽、取消/重启、页面文档变化及恢复不放行安装。具体结果见交接末尾；未授权外部账户写、长期后台轮询和任意异步服务契约仍不在已验收范围。

## UI_SELECTOR 原生表单单次提交

新增 `ui_write_v1` 与 manifest `uiWrite` version 1。沿用浏览器任务的 `declare-write`、生成、离线验证、精确审阅、持久执行记录、安装与知识流程，策略明确为 `UI_SELECTOR`；不能将本能力解释为任意 UI 自动写或无幂等服务上的一次实际效果保证。PAGE_FETCH 原有服务端幂等要求保持。

先根据目标页面的实际控件、提交处理器和业务契约核实：该表单在提交时读取原生字段值，单次提交语义明确，填写阶段没有自动保存；独立 GET 能读取准确目标资源、业务内容与公开关联值。未知页面行为、外部账号副作用没有用户授权时不能实际验证。本阶段只验证隔离公开夹具。

```json
{
  "name": "update_example", "risk": "write", "strategy": "UI_SELECTOR",
  "sourceApiKind": "action", "sourceApiIndexes": [0], "pagePathname": "/editor",
  "uiWrite": {
    "form": "#editor", "inputMode": "native-setter-no-events",
    "inputs": [
      {"selector":"#item", "name":"item", "parameter":"item"},
      {"selector":"#title", "name":"title", "parameter":"title"},
      {"selector":"#marker", "name":"marker", "parameter":"marker"}
    ],
    "submit": {"selector":"#save", "text":"Save"},
    "confirmation": {"selector":"#receipt", "attribute":"data-marker", "parameter":"marker"}
  },
  "writeReason": "修改已授权的公开示例条目",
  "strategyNote": {"reason":"原生表单在提交时读取字段，页面提供关联回执", "limitations":"同源同文档、无输入事件、不保证服务端幂等"}
}
```

来源声明仍为固定同源 POST URL 和对应 bodyKeys；它是表单 action 与字段的声明，不是实际请求成功证据。生成时将来源 URL/method 写入 uiWrite；不支持 UI 写的动态路径、query/hash 或其他方法。模块为固定注册模板，完整 route/uiWrite 纳入 `ui-write:` 安装权限和摘要，不能用作者任意页面 JS 替换。

输入、提交与确认契约：

- 同源主文档中唯一且可见的 HTML form、1–10 个唯一原生 text/search input 或 textarea、一个唯一的无 name 的 submit button；逐项核对真实 name、表单归属、按钮精确文本、enabled/readonly、额外成功字段、form action/method/enctype/target 和 submit override。当前不接受额外 hidden/CSRF 字段、密码/文件/选择框、自定义或 Shadow/frame 控件。
- 必填参数为单行字符串，最多 10000 字符，无默认值和类型转换。使用隔离 world 的原生 value setter 填写，不触发 focus、input、change、键盘或 click。然后重新核对同一节点与精确值、原生 validity；失败不提交，也不自动还原已填写值。
- 只调用一次 `HTMLFormElement.prototype.requestSubmit.call(form, submitter)`。它触发原生验证和 submit 事件，不执行 click 处理器，不宣称真实鼠标手势。页面自己的提交处理器必须保持当前文档；普通整页表单跳转会成为不确定失败，不自动跟随为成功。
- confirmation 必须为已存在且可见的同一 DOM 节点，其明确 `data-*` 属性在提交前不同于本次关联参数，提交后精确等于该参数。节点替换、同 URL 新文档、路由变化、超时均失败。回执只代表页面确认，业务效果仍须独立 GET。
- 沿用完整 URL/main frame/loader 与隔离 world 随机文档标记，过期注入不能迟发。一次操作最多 15 秒，总验证最多 30 秒；使用现有 profile、tab 锁及取消/断线机制。

UI fixture 专门使用 `expectedSubmission`，不填写 HTTP successResponse/failureResponse，也不伪造请求次数或网络正文。离线 validate 检查未确认零派发、参数/字段契约和模拟确认成功/失败；不连接浏览器，不提交表单，不能代替真实验证。

```json
{
  "id": "example-ui",
  "representativeArgs": {"item":"example-item", "title":"After", "marker":"example-operation"},
  "expectedSubmission": {
    "url":"https://example.com/items/example", "method":"POST",
    "body":{"item":"example-item", "title":"After", "marker":"example-operation"}
  },
  "effect": {
    "readback":{"url":"https://example.com/items/example"},
    "identityPath":"item",
    "argumentPaths":{"item":"item", "title":"title", "marker":"marker"},
    "before":{"equals":{"item":"example-item", "title":"Before", "marker":"before"}},
    "after":{"equals":{"item":"example-item", "title":"After", "marker":"example-operation"}}
  }
}
```

`argumentPaths` 必须将每个输入参数绑定到独立读取的不同精确公开属性路径；after.equals 必须逐项等于本次参数。`identityPath` 在 before/after 中必须为相同、非空公开字符串，证明所检查的是同一资源；关联参数对应的字段必须在 before/after 改变。只检查提示、数量或任意相同值不足以通过。该证据证明所检查资源的身份和字段状态，不证明因果唯一性、事务性、没有其他副作用或没有其他客户端同时修改。关联值应由调用者为本次操作明确提供，不能作为自动幂等键或重复执行许可证。

精确审阅展示全部字段、提交方式、回执、代表参数和 GET 断言。确认后先 GET before，再在派发给扩展前持久化消费 reviewId，提交/页面确认通过后才 GET after。错误效果、错误资源或确认丢失均不能安装。`dispatched:true` 是已交给扩展、可能有副作用的保守标记；即使扩展后来因控件错误零提交，也不自动重用审阅。UI 记录使用 confirmationVerified 区分页面确认和 effectVerified 业务状态。

**一次 requestSubmit 不等于一次网络请求，更不等于一次实际修改。** 页面代码、浏览器和服务端可各自产生重复行为，本路径不注入幂等键，不假设服务端支持去重。真实夹具分别统计 submit 事件、网络请求和 mutation；响应连接丢失时可能观察到一次 submit 对应多次请求。所有失败/超时/取消/重启/响应丢失均不得自动重放，同 reviewId 返回已有记录；只能先 `write-readback` 独立 GET 检查当前效果，uncertain 不升级为 verified、不放行安装。已发生的页面动作或网络请求不能被取消撤回。

安装后的普通 call 也必须 `__confirmed:true`，返回 `{ok:true,submitted:true,confirmationMatched:true,effectVerified:false}` 只说明页面回执匹配。验证 fixture 不进入安装包，所以普通 call 不附加效果 GET 或持久 review 账本；必须由调用方独立检查实际效果，失败后不得盲目重调。同值旧回执会拒绝，但不是持久幂等机制。

仍未覆盖：触发 input/change 才生效的受控组件、自动保存、click/Enter 手势、原生整页提交导航、hidden CSRF、多步写、任意 UI 网络响应拦截、复杂控件/跨 frame、写 repair。既有 HTTP/PAGE_FETCH 的多 ID/header/响应 URL 等回查差距保持；数字 ID 仅覆盖显式非负安全整数。自动化入口为 `exploration-ui-write.test.js`、`extension/test/ui-write.test.mjs`；真实验收 `verify-exploration-browser.mjs --ui-write-only`，加 `--bundled-cli --bundled-bridge` 验证两端 bundle，结果见交接末尾。


## UI 新回执 ID 与资源回查

2026-10-18 增量。原生 UI 单次提交可声明 `uiWrite.result:{attribute:"data-result-id",publicId:true,idType:"integer"}`，要求新能力 `ui_write_result_v1`。它读取同一 confirmation 节点上的明确公开 `data-*` 属性，不能指定另一个选择器、网络响应路径或动态 URL。ID 属性不得与关联属性相同，完整 result 契约计入包摘要和 `ui-write:` 安装权限；旧扩展在验证和普通调用前拒绝，不静默忽略。

提交前记录旧属性值；填写后、提交前再次检查其未变化。新关联回执出现时，同步读取 ID，必须不同于旧属性值。回执更新应一次性提供关联值与 ID；ID 缺失、陈旧、非法或节点/文档变化立即失败，不再次提交，也不等待另一回执来补值。适用于页面明确返回新资源 ID 的提交；同资源更新应继续使用原来的固定资源效果契约。同值拒绝不是服务端幂等或跨调用去重。

DOM 属性本身是文本，因此 result.idType 必须显式指定：string 沿用公开 ID 字符和长度限制，保留前导零/Unicode；integer 只解析规范十进制 `0` 或无前导零正整数，且不超过 Number.MAX_SAFE_INTEGER，拒绝空白、符号、小数、指数和越界值。解析后的 ID 在 Bridge、账本与资源身份比较中保持数值类型。普通调用返回 `resultId`，仍为 `effectVerified:false`。

UI fixture 仍不提供 HTTP successResponse。声明 result 后必须配套 `effect.resultReadback`，responsePath 固定为 `resultId`，idType 与 result 声明一致；使用已有同源单段模板、公开 ID 规则和严格资源身份校验。例如：

```json
{
  "url":"https://example.com/items/:id", "publicId":true, "idType":"integer",
  "responsePath":"resultId", "identityPath":"id",
  "expect":{"equals":{"item":"example-item","title":"After","marker":"example-operation","state":"ready"}}
}
```

保留固定 GET 的 identityPath、before/after、全部 argumentPaths 与改变的关联值证明；固定 GET 可以是稳定标识的结果摘要。动态资源的 expect.equals 还必须按相同 argumentPaths 逐项匹配全部输入，不能仅凭数量、提示或 ID 通过。离线模型仅用内部公开占位 ID 验证契约，实际运行绝不从模型取 ID。新回执仅是页面数据，独立 GET 证明资源的身份、内容与关联值；它不证明网络响应来源、因果唯一性或事务性。

回执成功后、任何效果 GET 前仅将 `{id}` 保存到当前任务私有执行账本。get/list/trace、write-review 执行摘要、知识和安装包不包含真实 ID；普通调用按其输出契约向调用者返回 ID。复用 effect.poll 的 pending/resultPending、原 30 秒总验证和 15 秒恢复预算、同文档身份；资源 ID 类型/值错误即使处于 pending 也立即停止。存储失败不能继续效果 GET。缺失持久 ID 的恢复零 GET、返回 WRITE_RESULT_ID_UNAVAILABLE；已有 ID 的取消/重启只允许独立 GET 恢复，uncertain 不升级、不放行安装。原生输入无 input/change、一次 requestSubmit、不保证一次网络/实际修改均保持。

自动化与隔离源码/双打包入口继续使用 exploration-ui-write 与 ui-write-acceptance。任意网络响应 ID、多个 ID、header/响应 URL、复杂控件、多步写和写 repair 仍待办；验证数量与报告见交接末尾。


## 已安装 HTTP 写命令的定向修复

`repair-info` 返回当前安装摘要，新的任务明确 declare-write 或选择已观察写来源，再以原 canonical kebab-case ID 提交 `repair`，risk=write、sourceApiKind=action。只支持既有 HTTP 单请求写命令；PUBLIC_API/COOKIE_API/AUTH_API 的完整 `http` 契约必须与当前安装包相同。Cookie 仍依赖选定 profile，mode=http 仍只运行 PUBLIC/AUTH。允许修改所选命令模块、schema/description，其他命令、共享文件、metadata、路由、权限和运行时原样保留。扩展声明式 PAGE_FETCH/UI 写契约修复仍待办。

服务持久保存 `repairScope.writeCommandIds`，草稿 source.json 不能自行扩大修复权限。历史命令知识只有 packageDigest 与当前包一致、kind=http_single_write_v1 且 fixture 可针对新声明重新规范化时才导入；返回 importedWriteTools/skippedWriteTools 及跳过原因，累计大小仍有任务上限。导入的是作者 fixture，不导入执行记录、真实响应 ID、审阅或授权。缺失/摘要不匹配/非法 fixture 需作者补写；历史数据不是当前行为或授权证据。

`validate` 重跑独立 mock 和选中读命令 cases，绝不执行 retained 写命令或实际修复写；通过后仅进入 write_review_ready。新的 write-review 包含 repair 范围、authorizationInherited:false，reviewId 绑定修复任务及摘要；跨任务同内容也不能复用。只有当前精确审阅与明确 confirmed:true 才走 before GET → 一次写 → after GET/实际 ID GET，复用数字 ID、严格资源身份、有界 pending 轮询及派发前持久消费。安装基线在审阅、before GET 完成后、实际 HTTP 派发前和安装时重新核对，变化拒绝继续。

这不是自动重试失败业务请求：应先核对原写效果和当前测试副作用授权。取消、重启、响应丢失仍不重放；恢复仅 GET，uncertain 即使匹配也不能安装。全部读写验证通过后按原 review/install 与 knowledge-save 流程完成更新。普通 call 仍是新的单次显式写调用，没有自动效果认证或探索 reviewId 去重。

聚焦测试在 `exploration-write.test.js`；真实源码与双打包 CLI/Bridge 验收由 `verify-exploration-http.mjs` 调用 `write-repair-acceptance.mjs`，使用隔离 AUTH loopback，覆盖真实字段漂移、mock 零网络、重新授权、数字 ID/轮询、安装、保留读写命令及取消/重启/丢响应。最新运行证据见交接末尾，不代表真实账户、Cookie 修复全组合、多步写或共享文件修复已验收。
