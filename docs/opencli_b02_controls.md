# B02：日期、选项、目录与文件选择器

本轮基于公开仓库 `af85115`（PR #186），目标 `dev-1.0.2`。2026-10-28 开始时远程开发分支为 `9a01e40`，#181、#186 均未合并；B02 使用独立分支，不重写前序分支。仅使用任务自有 loopback 服务、Chrome 临时 profile 和临时 Bridge，未安装到用户客户端。

## 固定上游对照

对照仍是 npm 官方 `@jackwener/opencli@1.8.8`，没有改用新版。发布 tarball SHA256 为 `68fb69d6dcfbcb1f76da88278b499abe322dcca712f3b79fe01729cb63ae6d7a`。读取发布包 `base-page.js`、`target-resolver.js`、`page.js`、`compound.js` 与 browser Skill，并实际执行未修改的 BasePage／select helper，传输由隔离 CDP harness 提供。这不是上游 daemon 或扩展全链路验收。

| 行为 | 1.8.8 实际结果 | 本项目处理 |
| --- | --- | --- |
| 原生日期 | `fillText` 报 not_editable；`typeText` 的 DOM 回退保留 ISO 日期 | 复用 browser.fill/type，生成 UI 写新增显式 date，验证原生 validity 和保留值 |
| 原生 select | 按 label 选择成功 | 复用已有 value/label/歧义检查 |
| 自定义 combobox | select helper 返回 Not a select | 复用 browser.find/click/get；生成 UI 写新增明确 popup/option 契约 |
| 原生 input 文件 | BasePage 的 CDP fallback 上传成功 | 复用原有 retained input／frame／Shadow／AX 上传 |
| 目录 | 一个目录传给 CDP 后，webkitRelativePath 保留 | 补宿主有界目录清单、显式模式和完整相对路径校验 |
| chooser 按钮 | uploadFiles 拒绝非 input | 补原 frame 原生 chooser 事件关联，不依据按钮名字猜文件输入 |

复现入口：`node webcli/scripts/audit-opencli-b02.mjs --upstream=<解包目录> --playwright=<模块> --chromium=<程序>`。harness 只读本地上游源码，在独立浏览器中访问自己的 loopback 页面。它不安装上游 CLI，也不调用真实站点。

## 声明式日期和自定义选项

`uiWrite.version:2` 可新增以下 inputs，选定 profile 必须支持 `ui_write_choices_v1`：

```json
[
  {"selector":"#date","name":"date","parameter":"date","kind":"date"},
  {"selector":"#category","name":"category","parameter":"category","kind":"choice","popup":"#choices","option":"[role=option]"}
]
```

- date 是属于原表单的原生 `input[type=date]`，准确保留 ISO 字符串；浏览器的 min/max/step/validity 仍必须通过。无隐式日期格式转换。
- choice 是原表单中 `type=button`、`role=combobox`、`data-field=<name>`、无提交 name 的控件；公开当前值为 `data-value`。必须使用 `native-input-change`。
- 点击原控件一次后，明确 popup selector 必须唯一、可见，id 与原控件 `aria-controls` 一致，`aria-expanded=true`；popup role 是 listbox 或 grid。
- 在 popup 内按 option selector 查找，最多 500 项；精确匹配一个 `data-value`，role 必须为 option 或 gridcell，并且可见、可用。日历以公开 ISO 日期为 data-value；不自动翻月、猜文字或执行第三方脚本。
- 点击该选项一次，由页面负责更新控件状态和事件；不额外向 choice 派发 input/change。原节点和全部最终值须保持。重复、禁用、替换、回退和不关联弹层停止后续提交。
- 开放 Shadow／frame 使用既有 W02 明确上下文契约；点击使用 DOM 原生 click，不承诺可信物理事件或任意框架兼容。当前契约要求点击后弹层就绪，不自动等待远程选项加载。

每次点击／input/change 本身都可能写入。沿用零真实写 mock、精确审阅、持久消费、独立 GET 效果、知识与安装门禁；失败不重放，不承诺事务。安装后仍为单工具调用，未加入安装态复合命令。

## 目录和 chooser 上传

入口继续是 `webcli call browser.upload`，使用结构化 `--args-file`：

```json
{"session":"example","selector":"#folder","paths":["C:\\Example\\folder"],"directory":true}
```

```json
{"session":"example","selector":"#choose-files","paths":["C:\\Example\\report.json"],"chooser":true}
```

`directory` 与 `chooser` 可以组合；它们要求选定 profile 的 `browser_upload_extended_v1`。已有普通文件上传只需原能力。保持 session、tab identity、frameId/documentId、selector／semantic／ref 和开放 Shadow 范围。

目录模式恰好一个具名目录，最多 200 个文件、500 个条目、16 层。预检拒绝空目录、非普通文件、符号链接和 junction；宿主清单包含 name/size/relativePath。CDP 接收原目录，浏览器异步枚举后在原 input 上有界轮询，仅复核完整相对路径、名字、大小和数量，不依赖枚举顺序，也不重发选择。普通文件仍最多 20 个且保持顺序。普通文件模式不能填目录 input，反向也拒绝。

chooser 模式先监听所选 CDP session 和精确 frame 的 `Page.fileChooserOpened`，再对明确触发控件执行一次原生指针点击；只在实际按下前启用事件关联，准备期间事件不取用。仅使用该事件的 backendNodeId，在原 isolated world 解析和保留 input；不扫描 DOM 猜后继节点。错误 frame 不被取用，多次事件失败；动态创建的 input 必须连接在原文档，原生类型／多选／目录模式／可用性需匹配。超时、导航、断线或后检失败均不重放。事件监听、拦截与对象组在独立短清理预算内释放；没有事件时无法保证页面没有发生其他点击副作用。

`verified:true` 只证明浏览器保留文件元数据，不证明内容 hash 或服务端收件。宿主快照不是文件系统事务；调用期间不要修改目录。文件路径只用于宿主和 CDP，不写 DOM 属性、不持久化到生成包。实机验收另以公开占位文件精确字节和 loopback multipart 收件核对业务效果。

上传属于显式 browser 原语；它本身没有 Adapter 安装步骤。本轮对它验证源码和 CLI＋Bridge 打包普通调用，并验证自定义页面的动态 input／multipart 流程。生成、作者验证、安装与安装后普通调用适用于上述声明式日期／选项工具。没有增加“把任意上传页面自动生成为安装态复合工具”的能力。

不覆盖 File System Access 的 `showOpenFilePicker`／`showDirectoryPicker`、操作系统原生窗口自动化、闭合 Shadow 控件契约、任意第三方控件、DataTransfer 拖放上传或真实账户写；这些不冒充原生 chooser／声明式控件的成功证据。B03/B04、A/U 余项及 E 系列保持开放。

## 验证和中间失败

验收入口：`verify-exploration-browser.mjs --b02-controls-only`、`--uploads-only`；追加 `--bundled-cli --bundled-bridge` 使用双 bundle，当前 Chrome 配合 `--cdp-extension`，只加载临时扩展/profile。单测覆盖目录边界、链接拒绝、relativePath、节点与文档变更、后检失败、超时不迟发、popup 歧义／禁用／替换及权限绑定。

中间失败保留：

1. 首次上传新 multipart 断言重复声明 browser.eval 的顶层 const，CDP 报错；夹具改用局部 IIFE 后源码通过，未改运行时校验。
2. 本机测试命令重复 `--run` 被 Vitest 拒绝；移除重复参数后执行。
3. `statSync` 改为拒绝链接的 `lstatSync` 后，旧元数据单测仍 mock statSync，导致一项失败；改为 mock 实际检查 API，仍要求精确大小且不读内容。
4. 打包首轮找不到 esbuild，后续误用已有旧 bundle 导致新契约生成被拒绝。显式使用本工作目录已有 `.cache/build-tools/node_modules` 后重新构建，再执行双打包验收；旧 bundle 失败不计通过。
5. 上游审计最初假设 fillText 支持日期，实际被拒绝，已改为记录该行为并单独执行 typeText；另一 harness 断言误把 uploaded 当数量，实际为 boolean，修正后另断言实际 file_names。

6. 首轮 WebCLI 全量 1718 通过／8 失败：两项 profile 测试暴露能力检查未兼容精简旧元数据，加入可选 inputs 检查，保留原门禁。其余六项涉及进程超时和并行构建中 prepared 目录暂不可用；固定两 worker、目录稳定后六文件 91 项复查通过，随后全量 148 文件／1727 项通过，未放宽断言或超时。

最终结果在交接与台账同步记录；不把旧 bundle、源码结果或历史 W 验收冒称最终打包通过。


## 最终交付证据（2026-10-28）

Windows、Node 24.20.0、Chrome 156.0.8078.48。报告保留在本机系统临时目录；仓库不含 profile、文件内容、任务账本或构建产物。

| 检查 | 结果与本机报告 |
| --- | --- |
| WebCLI 完整 | 148 文件／1727 项，.cache/b02-webcli-full-final.log；固定两 worker，无构建目录并发变更 |
| 扩展最终完整 | 363 项，.cache/b02-extension-full-final.log；包含最后预检和 chooser 按下时序补强 |
| 最终双打包控件 | 9 项，webcli-browser-acceptance-CdnxMZ；日期／选项／日历完整生成安装调用、非法日期／歧义／禁用／替换不提交不重放 |
| 最终双打包上传 | 4 项，webcli-browser-acceptance-OO3WMp；目录＋chooser、错误 frame 事件忽略与超时清理、精确字节／multipart、同 URL 兄弟隔离及全部原上传回归 |
| 最终随包 Skill | 4 项，webcli-skills-acceptance-mCxpE4；与源码逐字节匹配、六格式与非法输入 |
| 上游真实方法 | 7 个行为记录，opencli-b02-audit-m1SoB5；源码未修改、仅自有 CDP 传输 |
| 构建／包资源 | CLI、Bridge 成功；npm dry-run 1091 文件，包含 upload-files.js；5 个扩展模块在源码／prepared／npm 一致，npm worker 按既有规则变换 Bridge 地址；公开配置一致 |
| 静态／受控增量检查 | 22 个 JS/MJS 语法通过、diff whitespace 通过；新增内容常见私网 IP／Token／私钥模式零命中，不代表整机审计 |

各专项有重叠，不合并为独立案例总数。WebCLI 完整后最后修改限于扩展普通输入预检、chooser 时序以及验收/文档；相应扩展完整和最终双打包重新通过。构建仍提示三个既有列映射资源缺失，没有改为静默成功。

资源核查辅助脚本曾错误处理 npm 日志 CRLF、误以为桌面 CLI 目录含完整扩展，并直接比较 npm worker 地址；按实际打包脚本修正检查路径及既有地址变换后通过，未改产品资源或验收标准。
