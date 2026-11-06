# WeWorker Roadmap

- 2026-11-05（客户端深色模式）：设置卡片、资源后缀、风格弹窗、通道选中态、聊天队列、命令块和执行提示改用主题配色，补齐关闭态开关与浅色原生控件声明。跨首页、聊天、全部设置分类、任务、Bot、技能与探索工作区检查深浅主题，并复核生产 CSS。移植至 dev-1.0.2 后 Renderer 全量 508/513 通过，5 项为已核验的既有失败；生产构建与差异检查通过。未重新打包安装，范围与验收边界见 `docs/dark-mode-qa.md`。

- 2026-11-04：WebCLI 通用代码统一在 WeWorker 维护；发行配置支持决策服务地址、认证和可选模型，内部仓库仅维护配置与 Adapter。
- 2026-11-04（命令工具优先级）：桌面 `full` / `workspace` / `ask` 提示词恢复平台原生命令工具优先级，Windows 优先 Claude Code 内置 PowerShell，Linux/macOS 优先 Bash；只有原生工具不可用或权限模式不开放时，才回退到 WeWorker Shell。用户拒绝授权或原生调用被拒绝时不得换工具重试。权限模式允许使用的工具集合不变。Backend 提示词测试 31 项、类型检查和差异检查通过。

- 2026-11-04（WebCLI 路由同步官方更新）：基线前进至官方 `dev-1.0.2` 的 `15ae5a4c`，合并保留对话日志、路由诊断和完整命令提示；WebCLI 路由默认关闭，需在设置中显式开启用于验证。路由异常提供安全诊断信息交给 Agent 并继续正常执行；缺少 `WEBCLI_D3_URL` 时仍会回退，默认服务地址尚未配置。验证：Backend 全量 169 个测试文件中 1517 例通过、2 文件跳过；Backend 类型检查、Renderer 构建及相关 5 例测试通过；完整 CLI 测试因默认 15 秒时限低于该本地 Shell 调用约 17 秒而单例超时，将全局测试时限提高后全部通过（1517/1517）；`git diff --check` 通过。

- 2026-11-03（对话执行日志持续落盘）：每个对话使用独立日志文件，执行时追加模型输入、输出事件、工具参数与结果、错误及带回合上下文的诊断记录；覆盖普通模型、路由、网站探索agent和运行中追加消息。复制与下载共用直接读文件的接口，取消正文 100 字和工具结果 160 字的导出截断，跨进程继续追加；凭据脱敏，图片二进制明确省略。旧对话首次导出仅补入已保存消息并注明无法恢复缺失过程；写入失败提示缺口，读取失败返回错误。验证：日志、模型、路由、消息追加及相关任务/渠道回归共 178 例通过（基于官方 dev-1.0.2 的 9a926a0a），独立进程续写和本地 HTTP 导出逐字一致检查通过，Backend 构建通过；完整桌面客户端与真实站点执行尚未验收，未发布。

- 2026-11-03（WebCLI 路由执行记录）：实际调用路由时，在现有命令列表中展示 `webcli route`，记录开始、完成、失败或取消状态，推荐详情与耗时随会话保存；关闭、跳过或开始前取消不生成记录。验证：Backend 9 文件 120 例、Renderer 15 例、前后端构建及差异检查通过；独立无界面浏览器验证命令顺序、状态切换、详情展开、刷新回读与深浅主题。尚未重启当前桌面实例进行真实模型联调。

- 2026-11-03（WebCLI 路由接入）：基于官方 `dev-1.0.2` 的 `9a926a0a`，设置新增「扩展 → WebCLI 路由」单开关，初始为默认关闭，后续先改为默认关闭，验证通过后再考虑默认开启。直接路由未命中后可先获取 WebCLI 命令推荐，再把结果与前置状态交给 Agent；路由异常回退、取消终止、输出限额与站点/WeWorker Bot 权限边界保持受控。新建与复用会话均接收当轮记录，用户原文不改写，预热与通知总结不路由。验证：Backend 14 文件 158 例及构建、WebCLI 45 例、Renderer 26 例及构建通过；真实 CLI 源码/打包入口均通过隔离本地服务验证；无界面浏览器验证开关保存、刷新回显、保存失败及深浅主题。真实外部决策服务、真实模型和完整安装包尚未联调。

- 2026-11-03（界面与定时任务改动提交前回归）：官方 `dev-1.0.2` 基线核对为 `22214354`。Backend 相关 10 个测试文件共 79 例、类型检查、Renderer 生产构建、33 个修改文件语法检查和执行记录分页浏览器回归通过；Renderer 全量 497 例中 492 例通过，`desktop-d10-d12-regressions.test.js` 的 5 例失败在未修改的同一官方基线隔离副本中同样复现（测试提取遗漏 `weekdayField`、引用不存在的 `renameResourceHints`），本次未扩展修改这些既有测试。企业微信真实收件端、完整安装包和 macOS 仍待验收。

- 2026-11-03（定时任务执行记录分页）：执行记录每页显示 10 条，提供上一页/下一页、页码、总数和当前范围；记录区采用高度受限的独立滚动容器，新增记录不再撑长整页。翻页重置列表滚动位置，切换任务回到第一页，历史记录减少时自动收敛到有效页。保留状态、通知失败提示与查看对应对话能力。验证：Renderer 相关单测 18 例、生产构建、JSX/JS 语法检查、差异检查通过；独立无界面浏览器使用占位数据验证翻页、滚轮隔离、记录增加/减少、切换任务、空态、对话跳转及 1280/520px 宽度和深浅主题，未操作用户桌面或真实任务。

- 2026-11-03（定时任务企微通知链路）：任务执行进入 `completed` 或 `failed` 终态后，顺序触发且仅触发一次独立、无工具的结果总结请求，再派发通道通知；总结失败时回退到执行文本或错误信息。企业微信主动发送等待 `aibot_send_msg` 响应，超时或非零错误码记入执行记录，执行记录列表在任务已完成但通知失败时显示原因提示。验证：Backend 聚焦测试 16 例、TypeScript 类型检查、Renderer 生产构建和 `git diff --check` 通过；企业微信真实收件端投递待用户复测。

- 2026-11-03：按 Codex 字号密度统一 WeWorker Renderer 字号层级，覆盖聊天、侧栏、定时任务、设置/模型配置、工具页、欢迎页、文件面板、引导和通用弹窗；图标与代码内容保留专用尺寸。验证：基于官方 `dev-1.0.2` 最新提交 `22214354`，Renderer 生产构建和差异检查通过；开发 Electron 已连接当前 Vite Renderer（5174），HMR 正常。独立 Chrome 预览因本地 Backend 返回 HTTP 401 未能验证登录态聊天画面，需在当前桌面客户端确认最终观感。

- 2026-11-03：定时任务页移除重复的「任务标题」表单项，页头显示任务名称并提供靠近标题的编辑按钮；编辑框复用模型配置名称输入框的 180×28 尺寸、边框与圆角，失焦或 Enter 自动单独保存并同步侧栏，Escape 取消，空标题或保存失败时保留编辑态并提示。Renderer 生产构建和差异检查通过。

- 2026-11-03：定时任务侧栏按对话侧栏层级调整为顶部「新建定时任务」、其下「定时任务」标题/搜索行及下方单任务列表；搜索支持匹配任务名称和频率摘要，Escape 关闭并清空搜索。Renderer 生产构建和差异检查通过。

- 2026-11-03：定时任务侧栏标题/搜索行复用对话侧栏「工作区」行的同一 DOM class 与布局，统一标题文字、内边距、行高和图标按钮对齐。Renderer 生产构建和差异检查通过。

- 2026-11-03：WeWorker Bot 侧栏统一为顶部新建按钮、复用对话侧栏样式的标题/搜索行和下方 Agent 列表；新建按钮明确对齐对话侧栏的高度、内边距、图标尺寸和上下间距，标题行与列表容器移除额外偏差；搜索支持按 Agent 名称或网站名称过滤，Escape 关闭并清空搜索。侧栏背景和标题颜色匹配对话侧栏主题，宽度拖拽复用主侧栏的 180–480px 持久化行为。Renderer 生产构建和差异检查通过。

- 2026-11-03：WeWorker Bot 页面窗口标题栏显示与主工作区相同的侧栏折叠按钮；按钮切换WeWorker Bot 列表栏的显示状态，折叠与展开可逆。Renderer 生产构建和差异检查通过。

- 2026-11-03：定时任务与WeWorker Bot 页面顶部工作区工具栏仅保留深色/浅色切换；WeWorker Bot 显示与其他工作区相同的工具栏行，文件夹和能力面板按钮不显示。Renderer 生产构建和差异检查通过。

- 2026-11-03：设置页左侧分类导航与内容区之间新增可拖拽分隔线，宽度范围 150–320px，保存到本地设置；支持方向键微调。Renderer 生产构建和差异检查通过。

- 2026-11-03：关于页「后台运行」改为标题在卡片外、托盘行为与开机启动各自独立成行的设置卡片，开关右对齐，说明和退出提示分层展示，避免控件在窄宽度下挤成一排。Renderer 生产构建和差异检查通过。

- 2026-11-03：定时任务的通知通道选择控件改为统一的 `AppSwitch` 开关，通道选择及任务保存字段保持不变。Renderer 生产构建和差异检查通过。

- 2026-11-02（格式化正文输入）：粘贴富文本转 Markdown，仅在草稿含格式时显示格式菜单，提供预览和可编辑正文卡片，用户消息支持 Markdown 显示；正文可保存为 HTML/Markdown 参数附件，支持无损移回输入框、修改取消及跨对话异步隔离，通过现有 args-file 原样传给兼容工具。输入、格式转换、快照存储及既有键盘/链接回归测试通过，浏览器交互回归、Renderer 构建和 Windows 开发客户端重启已验证；目标站点最终展示、完整安装包及 macOS 待验收，未发布。详见 docs/formatted-chat-input.md。

- 2026-11-01（受限宿主 CLI）：内置 Adapter 可通过固定 provider 调用受审宿主命令；身份与参数绑定原始调用，凭据仅留在宿主，写入派发后超时/断连不重放。新增 Windows DPAPI/macOS Keychain 存储、账号锁、条件后台执行与离线资源核验。Windows 内部集成客户端由用户验证通过；macOS 原生、完整安装包和远端构建尚待验收。

- 2026-10-28（关于页下载入口）：设置「关于」页的下载链接改为 GitHub 最新发布页面 `https://github.com/WeWorker/WeWorker/releases/latest`，自动更新配置保持独立。验证：Renderer 生产构建与差异检查通过。

- 2026-10-28（浏览器设置下拉样式）：移除“网站操作浏览器”通用下拉外层的宽胶囊边框，直接使用 `AppDropdownSelect` 标准外观；选项与即刻保存行为不变。验证：Renderer 生产构建与差异检查通过。

- 2026-10-31（对话日志导出与链路日志补全）：新增按对话导出诊断日志能力——Renderer 对话工具栏新增「导出日志」按钮，调用后端 `GET /works/:id/logs.txt` 下载包含环境头信息、对话时间线摘要（不含完整模型流量）与 `[work:前8位]` 标记的调用链路日志的 txt；后端 agent（turn_start/tool_call 决策日志，注入 `WEWORKER_WORK_ID`）、webcli CLI→Bridge→扩展全链路透传对话 id 并在收单/分段/成功/失败/登录判定/登录后重试日志行打标。验证：backend `work-log-export.test.ts`、`agent-sdk-config.test.ts` 断言更新、`agent-tool-policy.test.ts`、webcli `bridge-call-timing.test.js`（新增 workId 用例）等 bridge 子集与 Renderer `npm run build` 通过，backend typecheck 通过；`chat-session-sdk`/`chat-session-steering-sdk` 两个真实 CLI 测试在未改动基线上同样失败（预存环境问题）。端到端导出按钮在桌面端的实际下载未验证。

- 2026-11-01（managed 自动开页优先 homepage_url）：扩展 managed v2 页面命令自动开 tab 时，优先打开 manifest 声明的 `homepage_url`（唯一能表达端口/路径的入口字段，经 `classifyNavigationTarget` 校验在 match/domains 范围内才使用），回退保持 `http://<主host>/`；与旧路由路径 `getHomepageUrlForDomain` 的优先级对齐。修复入口不在域名根路径的站点（如带端口与路径的内部系统）被自动开到错误页面的问题。验证：webcli 新增 `extension-managed-homepage-entry.test.js` 及 extension/adapter 相关子集共 117 例通过，service-worker 语法检查通过；桌面端实际开页行为未验证。内部 Adapter 同步声明对应 `homepage_url` 并升版（该目录未提交，不进公开仓库）。

- 2026-11-01（登录页识别限定同域族）：`isLoginPageUrl` 的通用登录页启发式（`passport.*`、`/login` 等）收紧为仅认与本 Adapter 同域族的 host——落在 `domains` 伞内，或与声明的 `login_hosts`/`login_url` 同注册域；跨域 SSO host 需在 `login_hosts` 显式声明。修复浏览器中残留其他站点登录标签页（如调用京东期间残留的大众点评扫码页，`account.<别站>` 命中通用启发式）被误认成本站"正在登录"的标签页，导致命令不再自动打开正确登录页、登录流程复用错误标签页并向用户返回错误站点二维码截图的问题。host-scope 新增 `sameDomainFamily`（共享注册域且非公共后缀才算同族），webcli 侧字节一致副本同步。验证：extension 测试套件 366 例通过（新增同域族判定与 `sameDomainFamily` 用例，按新契约更新原跨域 SSO 识别用例），webcli adapter/auth/package/login 相关子集 71 例通过；浏览器端真实登录流未实测。

- 2026-11-01（auth.qr.command 精确二维码扩展点）：落地 `docs/website-login-analysis` §5.1 设计——manifest `auth.qr` 允许声明 `command`（必须引用本包 `runtime: extension`、`safety: read` 命令；`mode: off` 时禁止并存），登录 flow 的 `auth_prepare_qr` 在 flow 绑定的登录 Tab 内优先执行该命令做精确二维码提取（复用宿主页面运行时注入；`waitForManagedPageReady` 的登录页禁令对此宿主路径以 `options.loginPage` 显式豁免，业务命令仍全线禁止登录页执行），返回 `{found, image_data_url, expires_at?}`；`found:false`/超时/失败自动回退通用发现，`mode: off` 两者皆不执行。被引用命令为 host-only：不进入 Adapter Skill 工具清单，模型不可见。Bridge 侧 `qr.method` 如实记录 `command`/`heuristic` 并透传 `expires_at`。同时实现 §5.1 的 rect 协议形态：跨域登录 iframe（二维码不在顶层 DOM）时命令返回页面矩形，`runManagedQrCommand` 校验矩形后透传，Bridge 经 `dedicated-browser.screenshot(url, {clip})`（CDP `captureScreenshot` + `captureBeyondViewport`）裁剪登录 Tab 截图为 `<site>.qr.jpg` 特写。内置实现两个：`adapters/jd.com` v1.0.12 `get-login-qrcode`（图片协议：passport/aq.jd.com 域守卫、真实 DOM 核对的容器选择器、qr.m.jd.com 服务器 URL 在页面内 credentialed fetch 转 data URL、过期遮罩点页面自带刷新、仅点击唯一的「扫码登录」切换项、不填写任何凭据）；`adapters/goofish.com` v0.1.2 `get-login-qrcode`（rect 协议：闲鱼登录面板是 havana 内嵌的跨域 login.taobao.com iframe，重调 generate.do 会与 iframe 内持有的轮询 token 失步而弄坏登录，故只测量 iframe 页面矩形并按实测比例收窄到二维码列（占面板宽 58%，宽高比异常回退整面板），纯读取零点击）。真机迭代：首次闲鱼 flow 失败暴露冷启动时序（登录面板挂载 >12s 而 Bridge `auth_prepare_qr` 预算 10s/模块等待 8s），`auth_prepare_qr` 预算扩至 30s、模块等待 20s 并穿透 shadow DOM，命令失败原因经 `commandReason` 透传到登录日志；复测成功（available=true、`goofish.com.qr.jpg` 落盘），再按用户反馈把裁剪从整面板收紧为二维码列。验证：webcli 新增 `extension-qr-command-login.test.js`（含真实 DOM 校准断言），adapter-auth-manifest/adapter-views/site-login/bridge-dedicated-browser 及 adapter 相关子集共 260+ 例通过，extension 套件 366 例通过，改动文件语法检查通过；闲鱼端到端已真机验证，京东 passport 页仍待真机（选择器已按公开页面静态结构核对）。
