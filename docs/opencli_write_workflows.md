# W01–W04：声明式写控件、序列与结果回查

本阶段延续 B01 的保留 frame 身份机制。通用实现位于公开 WebCLI 和扩展，Python 网站探索agent不参与。所有真实副作用验收使用任务自有 loopback 服务、浏览器和 Bridge，不操作真实账户。

## W01／W02：UI 写 v2

旧 `uiWrite.version:1` 保持静默原生 setter 和一次 requestSubmit。新能力要求选定 profile 支持 `ui_write_controls_v2`；不能用其他在线 profile 替代。v2 显式声明事件、控件和提交方式：

```json
{
  "version": 2,
  "form": "#editor",
  "inputMode": "native-input-change",
  "inputs": [
    {"selector":"#title","name":"title","parameter":"title","kind":"text"},
    {"selector":"#marker","name":"marker","parameter":"marker"}
  ],
  "submit": {"selector":"#save","text":"Save","mode":"click"},
  "confirmation": {"selector":"#receipt","attribute":"data-marker","parameter":"marker"},
  "hiddenFields": [{"selector":"#csrf","name":"csrf","source":"page"}]
}
```

计划继续使用 `strategy:UI_SELECTOR`、`risk:write`、明确 action 来源和 `pagePathname`。url/method 来自声明或观察来源，仍固定 POST。来源 bodyKeys 描述公开业务字段；页面自带的 hidden 字段另行声明，不把它的值作为业务参数、默认值、fixture 或日志。

- `inputMode` 可选 `native-setter-no-events` 或 `native-input-change`。后者先填写所有控件，再按顺序分别派发一次 composed/bubbling input 和 change。事件可能引发自动保存或其他副作用，并不承诺只有一次实际写入。
- `kind` 支持原生 text/search/textarea、单选 select、checkbox，以及显式 `role=textbox`、`contenteditable`、`data-field` 匹配的自定义文本控件。checkbox 参数是精确字符串 `true`／`false`；select 只接受唯一、可用选项的精确 value。没有默认值或隐式类型转换。
- 事件后复核原控件身份和值；框架撤回值、替换节点或改变可用状态会停止后续事件/提交。不会重新查找继任控件继续写。
- `submit.mode` 支持 `requestSubmit`、DOM 原生 `click` 和 `enter`。Enter selector 指向已声明原生输入，text 精确匹配 aria-label；运行时固定焦点后发送 CDP Enter，并检查原节点。DOM click 不宣称是可信物理鼠标事件。
- 自动保存用 `submit:{"mode":"none"}`，必须配合 `native-input-change`；不会额外提交。仍等待与本次输入关联的新回执，并用独立 GET 核对全部参数、资源身份和关联值。
- `shadowRoots` 是最多八层显式开放 Shadow host selector；表单、输入和回执位于所选根。固定宿主和 shadow root 身份。闭合 Shadow 根和任意第三方控件脚本不属于本契约。
- `hiddenFields` 仅指定实际 hidden input 的 selector/name/source。它必须属于原表单、可提交且仍是原节点；值保持由页面拥有，不读出到宿主、不保存或打印。未声明的成功表单字段仍拒绝。

## 导航和 frame

整页提交必须声明 `navigation:{"url":"https://example.com/items/example"}`：精确、固定、同操作文档 origin，无 query/hash/凭据。监听原 frame 导航事件，校验新 loader 和目的地址，再读取新文档回执。错误目的地、后续导航、丢失回执、取消或超时都不重交。独立效果 GET 绑定已验证的新文档，恢复仅 GET。

`frames` 使用 B01 的 1–8 层 `{selector,origin,pathname}`。主 tab 路由保持独立；各祖先及叶 origin 必须在任务允许源和包页面权限内。每次请求核对完整文档链、owner backendNodeId、frameId、loader 和完整 URL；同 URL 的另一 owner 不能替代原对象。写前 GET、写和写后 GET 共享原身份快照。声明导航只迁移原叶文档；祖先/owner 必须保持。

超时、取消、断线、身份变化均停止后续派发。已经发出的事件/提交/网络请求可能产生效果，无法撤回，也不会自动重放。页面、浏览器或服务端可能重发；这些 UI 操作不提供事务或幂等保证。

## W03：多组用例、有限序列和部分恢复

`write-verification-write.fixture` 保持兼容单一 fixture，也可写入 `{"cases":[...]}`：2–10 个唯一 id，每个都包含完整代表参数、离线模型和独立效果断言。普通 validate 对全部用例做零真实写验证。单独审阅/执行时传 `caseId`；全部当前用例通过真实效果验证后才能安装。修改任一用例会使现有审阅失效。

`exploration.write-sequence-review` 与 `exploration.write-sequence-verify` 将当前任务内生成工具的用例组成 2–20 步显式序列，支持多个工具或同一工具不同用例的批量操作。它是 CLI 探索任务的编排能力，安装后的单个工具仍使用原来的确认调用入口；不把任务账本或验证 fixture 塞进安装包。

```json
{
  "taskId":"example-task",
  "steps":[
    {"id":"first","tool":"example.com.create-item","caseId":"first"},
    {"id":"second","tool":"example.com.update-item","caseId":"second"}
  ]
}
```

先提交上述参数到 `exploration.write-sequence-review`。已有授权覆盖这些具体副作用时，用相同 steps、返回的 reviewId 和 `confirmed:true` 调用 `exploration.write-sequence-verify`。审阅无网络请求；不自动展开循环、重试、回滚或并行写。

后续 fixture 的完整标量可使用 `{{result:first}}`；多个 ID 用 `{{result:first:0}}` 等明确下标。它只能引用先前已验证步骤持久保存的公开实际 ID，不能从 mock、作者 handler 映射或任意响应字段取值。禁止前向引用和嵌入字符串拼接，保留 ID 类型，不自动转成字符串。代表参数、精确请求、响应解释和效果断言中的对应占位标量一起绑定。未解析的占位用例不能通过普通 write-review 单独执行。

每步在跨越写边界前持久保存 `dispatching`；任何失败停止后续步骤。每步最多沿用 30 秒验证预算，最多 20 步，序列不无限运行。重复 sequence reviewId 返回已消费记录，取消和 Bridge 重启也不会重放。

`write-sequence-readback` 独立 GET 已派发步骤的效果，不升级 uncertain，不赋予安装资格。部分失败中，已验证步骤不再执行；只有失败步骤确实 `not_dispatched` 时，才能用相同 steps 和 `resumeFrom` 取得新审阅，再确认续跑。若任一步可能已经写入而结果不确定，拒绝自动续跑，应先独立核查业务状态。

任务账本只保存恢复所需的公开实际 ID；序列传值后的私有效果契约也可能包含这些同一 ID。get/list、审阅摘要、知识和安装包不输出实际绑定或完整响应。知识保存原始作者用例和占位声明，历史导入不继承实际执行/授权。

## W04：实际响应来源和精确 ID

`effect.resultReadback` 可以是一个声明，或 2–10 个明确声明的数组。每个都必须有固定同源、单 `:id` 路径模板、`publicId:true`、精确 identityPath 和独立内容断言。先验证并保存全部 ID，再读取资源；缺失任何 ID 时不猜测或重新写入。

ID 类型：

| idType | 语义 |
| --- | --- |
| string／省略 | 公开字符串，保留前导零、Unicode |
| integer | 原有非负安全整数，保持数字类型 |
| signed-integer | 包含负数的安全整数，拒绝负零、小数和越界 |
| decimal | 规范十进制文本，可含负号、最多 512 字符；支持远超安全整数的原始 JSON 整数 |

decimal 从声明 JSON 属性的原始 token 取得完整数字，不先转成舍入后的 Number。资源 GET 的 identityPath 同样按声明保留精度；其他数值字段保持原类型。没有原始精确 token 的运行环境明确失败，不用近似值查资源。字符串 `007` 不会转成整数；decimal 拒绝前导零、负零、指数和小数写法。

响应来源默认是 `responsePath`，也可使用：

```json
{"responseSource":{"kind":"header","name":"x-resource-id"}}
{"responseSource":{"kind":"header","name":"location","template":"https://example.com/items/:id"}}
{"responseSource":{"kind":"url","template":"https://example.com/items/:id"}}
```

Header／URL 原本是文本，只能声明 string 或 decimal；不隐式转换为数字。只允许明确公开 `x-*` ID header 或带精确同源模板的 Location。URL 模板提取一个完整路径段，拒绝其他源、凭据、query/hash 和越界路径；读取响应 URL／Location 不意味着跟随重定向或请求它。实际资源 GET 始终使用单独审阅的 readback 模板。敏感 header/path 仍拒绝，真实回查也保留既有读取语义检查。

HTTP／PAGE_FETCH fixture 的 successResponse 可以声明公开 mock headers/url；实际执行只取真实传输元数据。扩展中的新资源回查需要 `write_results_v2`，旧 profile 在派发前拒绝。

UI v2 除新 DOM 回执 ID 外，还可声明 `result:{source:"network",url,method,ids:[...]}`。ids 的每项明确 publicId、idType 与 responsePath／responseSource；网络 url/method 必须匹配原写动作。监听原文档/frame 的一次匹配 mutation，忽略其他 frame，多个匹配请求视为歧义并失败。只读该实际 requestId 的有界响应，不执行请求重放；仍要求页面关联回执与独立资源效果。返回单个 resultId 或多个 resultIds，fixture 的 responsePath 对应 `resultId`／`resultIds.0` 等。它覆盖明确声明的网络来源，不等于任意监听到的请求都可当成业务结果。

## 验证入口

- `verify-exploration-browser.mjs --ui-controls-only`：控件、自动保存、Shadow、hidden、Enter、整页导航、嵌套跨源 frame、实际网络结果、生成/安装/普通调用/知识。加 `--bundled-cli --bundled-bridge` 测试双 bundle。
- `verify-exploration-http.mjs --write-sequences-only`：多组用例、实际 ID 传值、部分续跑、uncertain 拒绝及真实 Bridge 终止恢复；加 `--bundled` 测试双 bundle。
- 主机测试覆盖 HTTP/PAGE_FETCH/UI 契约、全部用例安装门禁、精确结果来源与类型、GET 轮询、序列和续跑。扩展测试覆盖身份变化、事件后值撤回、歧义/丢响应/取消停止捕获和不重放。

这些证据不覆盖真实账户写、所有自定义控件、任意页面重定向策略、闭合 Shadow 根、其他浏览器/系统或实际客户端安装。E 系列验收仍独立保留。

## 2026-10-28 实现和验收记录

代码位置：`webcli/exploration-ui-write.js` 负责 v2 声明和生成；扩展 `ui-write.js`、`ui-write-action.js`、`frame-write.js` 与 `ui-write-network.js` 执行控件/导航/身份/网络关联。`webcli/write-cases.js` 和 `exploration-write-sequence.js` 管理多用例和逐步账本；`exploration-write-result.js`、`write-result-json.js`、`http-client.js` 与 `exploration-write-poll.js` 管理精确实际 ID 与独立 GET。生成包、安装门禁、选定 profile capability 和知识保存同步接入。

本轮 Node 24.20.0、Windows、Chrome 156.0.8078.48；全部实机写发生在自有隔离 loopback 服务。报告仅存本机系统临时目录，仓库不包含浏览器 profile、任务账本或构建产物。

| 验证 | 本轮结果与报告目录名 |
| --- | --- |
| WebCLI 全量 | 147 文件 / 1722 项通过，`.cache/write-full-webcli-delivery.log` |
| 扩展全量 | 360 项通过，`.cache/write-full-extension-delivery.log` |
| 最后审阅摘要/结果回归 | 2 文件 / 107 项通过，`.cache/write-final-review-focused.log`；包含历史执行摘要省略 effect/http 的断言 |
| 双打包完整 UI 专项 | 20 项通过（18 项功能加启动/连接），`webcli-browser-acceptance-D40vej/report.json`；两项 bundled 标志均为 true |
| 最终 frame/导航补测 | 6 项通过，`webcli-browser-acceptance-aTifhQ/report.json`；增加对同 URL 兄弟 frame 保持 Before 的实际 DOM 断言 |
| 最终网络结果补测 | 7 项通过，`webcli-browser-acceptance-clCxq5/report.json`；含 networkframe 兄弟隔离断言 |
| 源码序列 | 4 项通过，`webcli-http-discovery-xo0BPG/report.json` |
| 双打包序列 | 4 项通过，`webcli-http-discovery-QjFgqu/report.json`；实际 ID 传递、部分续跑、uncertain 拒绝、真实 Bridge 终止恢复 |
| 双打包完整 HTTP | 28 项通过，`webcli-http-discovery-YAfz00/report.json`；读取、写入、结果回查、序列、定向/共享修复、取消/重启和占位凭据不泄漏 |
| 最终随包 Skill | 4 项通过，`webcli-skills-acceptance-xLN7To/report.json`；真实 CLI 读取与源码字节一致、六格式及非法输入 |
| 打包/静态 | CLI/Bridge 构建成功，公开配置一致；npm dry-run 1090 文件含六项新增运行资源；六个改动扩展模块在源码、prepared、npm 副本字节一致；32 个 JS/MJS 语法与 diff whitespace 通过 |

以上专项有重叠，不合并为独立测试总数。全量测试后仅补充历史执行摘要不公开私有效果契约、审阅/错误说明和验收断言；相应聚焦回归单独记录，不把之前全量冒称最后文本的重跑。三个既有列映射资源缺失构建提示仍存在（wecli-columns、wecli-migrated-commands.json、wecli-column-aliases.json），未改为静默成功。

受控增量扫描对本轮新增代码/文档中的私网 IP、常见 Token/JWT 和私钥格式零命中；这不是整机或真实账户数据审计。

中间失败保留：首次 UI 使用旧 prepared 扩展缺 capability，重新准备后通过；合成自动保存路径和序列 ID 被既有只读语义守卫拒绝，改为无写语义歧义的公开占位词，没有放宽守卫。早期完整源码 HTTP 验收进入新序列时缺 `mode:http`，报 PROFILE_NOT_FOUND；修正夹具后源码和双打包序列各 4 项通过。首次 npm 清单解析被 prepack 的前置文字阻断，定位 JSON 数组后完成 1090 文件检查。这些失败不计为通过。

PR #186 首轮 Linux CI 在最后审阅文案上发现 3 个 UI 回执断言失败（1719 项通过）：新说明遗漏了 `fresh correlated page receipt`。恢复“新产生且关联的页面回执”这一明确约束，不修改断言或运行时守卫；本机完整 UI 写测试文件 21 项通过。首轮失败与后续提交的 CI 状态分开记录，以 PR 当前提交检查为准。
