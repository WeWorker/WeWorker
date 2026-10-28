# Webwright Roadmap

- 2026-10-27：共享浏览器实现已接入探索、继续探索、开发中／正式调试、回放和公共 Toolkit Runtime；宿主控制通道获取 Bridge 实例与占用，托管模式禁止自启浏览器。原方案与详细验收见仓库 [实施记录](../../docs/shared_browser_implementation_status.md) 。Python unit／distribution 全量 282 项通过、4 项跳过；既有 OpenAI 完整 URL 拼接测试仍失败 1 项。macOS arm64 embedded 与打包 CLI 的真实探索／正式调试／回放及普通 Toolkit 调用通过；完整桌面安装包、macOS x64、Windows x64／Edge 仍待验收，旧 Profile 不迁移。
  - 已验证长任务取消和 Bridge 强制退出时调用失败、占用释放与受管浏览器退出；后续调用获取新实例，已提交的测试操作未被重放。

## 当前阶段

- 2026-10-28：共享浏览器 PR 在官方 `dev-1.1.0` 上复验，Python 聚焦 66 项通过、1 项既有完整 URL 测试失败。启动时显示浏览器窗口的原因及完整桌面验收待确认，PR 保持 Draft。

推进 Python harness 的 `local_browser` + `local_cdp` 产品升级。Toolkit 阶段一至阶段七均已完成；下一阶段为阶段八「多 Tool 组合与系统验收」。总进度见 [`docs/toolkit_roadmap.md`](docs/toolkit_roadmap.md)。

## 已完成

- 2026-10-28：探索启动改为按 Adapter 显式允许域名选择页面，不再要求完整 URL 与 Tool 起始网址一致。服务端返回候选并复核所选页面，Worker 接收域名快照重新校验，保留当前页面且不注入首次导航；模型提示改为先观察当前状态。两套界面支持多页选择，启动失败保留补充指令。产品／技术规范同步更新。Python 聚焦 101 项通过，1 项既有 OpenAI 完整 URL 拼接测试失败；Backend 19 项与 Renderer 6 项测试、类型检查、Renderer 构建、JS 语法与配置解析通过。Chrome 模拟接口验证两套界面交互；真实模型、业务站点全流程和安装包待验收。

- 2026-10-28：修复正式 Adapter 调试异常丢失：Debug Worker 将未预期异常写入结果文件，进程管理器在结果缺失时从日志恢复原始错误，保留结果错误与超时错误的优先级；WebCLI 等待 Toolkit 大 JSON 管道输出完成。Python 调试与进程管理测试 40 项通过，1 项模型完整 URL 测试在未修改的官方 dev-1.1.0 基线上同样失败；WebCLI 聚焦测试 15 项、JS 语法与差异检查通过。未验证真实站点、冻结运行时、安装包及 Windows。

- 2026-10-24：为 WeWorker 统一 Adapter 树删除流程增加 Tool／开发中目录暂存、恢复与完成接口；安装器失败可恢复原 Tool，安装成功后从可见目录移除。Python 存储与 Server API 聚焦测试 40 项、Python 编译通过；与宿主安装器的联合场景由根目录 Roadmap 记录。跨进程崩溃后的暂存需人工检查。

- 2026-10-24：Developer Slot 移除页面前置／后置状态文字数组；槽位直接读取，不保留旧字段过滤逻辑。删除当前持久目录中带旧字段的 4 个槽位文件，同步生成契约、旧 Skill 文本、开发界面、夹具及设计。本轮槽位、发布和调试聚焦测试 61 项通过；此前聚焦测试 80 项通过、1 项真实 CDP 跳过，单元全量 269 项通过、3 项跳过、1 项因既有 OpenAI 完整 URL 拼接问题失败。Renderer 4 项单测、生产构建及 Web JS 语法检查通过。

- 2026-10-24：Developer Slot 移除 `side_effects` 字段，新生成的 v2 Adapter 命令暂时固定 `safety: "read"`；同步槽位校验、Skill 内容、页面展示、示例与设计。Python 聚焦测试 84 项通过、1 项真实 CDP 测试跳过；Web JS 语法检查通过。后续安全分类规则待定。

- 2026-09-22：健康接口返回 Electron 注入的探索实例 ID，与 Backend 托管实例校验对齐。独立运行返回空 ID，不绕过宿主校验；健康接口与生命周期聚焦测试 35/35 通过。用户随后确认客户端问题已修复，详见根目录 Roadmap。

- 2026-08-09：在现有三工作区前端完成开发中 Tool 代码的手动编辑与保存。开发代码卡在代码下方显示「编辑代码」，进入编辑态后原位切换为「取消修改／保存修改」，编辑期间禁用发布、重新开始和 Developer Agent 提交；所有界面隐藏 `code_hash`／`artifact_hash` 原始值，版本关系改用首次开发、已发布版本、当前产物和旧产物表达。保存接口只替换代码正文，保留 Exploration／正式基线／Debug Run 证据等槽位元数据，使用预期 `code_hash` 防止覆盖并受全局活动互斥保护。保存继续复用 Tool Slot 的 Python 语法、唯一异步函数、业务参数与 Schema 校验，成功后生成新哈希，使旧 Debug Run 自然失去发布资格；正式代码、Schema 和运行契约保持只读。
- 2026-08-09：完成探索工作区步骤流 UI 高级感重构与交互微调。步骤内容封装为独立容器卡片 (`step-card`)；将 Agent 思考区升级为紫蓝渐变左边条 AI 推理气泡 (`step-thinking`)；执行动作简化为主题一致的轻量级折叠面板 (`step-code`)；执行后页面升级为支持 `100%` 铺满无留白、标题与解码 URL 紧凑同行对齐的 Chrome Window 预览卡片 (`step-observation`)。
- 2026-08-09：将 Exploration 的 Agent 步骤卡片固定为「Agent 思考 → 执行动作 → 执行后页面」。`thought` 显式标注为 Agent 思考，`python_code` 作为默认折叠的执行动作置于 observation 之前，白名单页面标题、URL 与截图改称执行后页面；设计与技术合同明确页面数据在整段代码执行结束并等待稳定后采集，初始页面观察不进入步骤流。执行循环和 Timeline 数据结构不变。
- 2026-08-09：修复探索工作区切出切回后追加指令输入框草稿消失的问题。根治 `app.js` 中切回窗口时 `focus` 事件无参调用全局 `setState({})` 导致工作区 DOM 全量销毁重建的过度渲染问题；将 `focus` 事件收口为仅刷新顶栏浏览器状态与导出按钮状态，完全避免工作区重绘与草稿清空。
- 2026-08-09：将 Exploration 角色化历史流进入 WeWorker macOS arm64 app-only E2E 产物。重新冻结当前组件源码与 Web UI，并随宿主 Renderer、Backend、Bridge 和 WebCLI 通过 Electron Builder 目录模式组装 `WeWorker.app`；包内确认存在 Timeline、独立 User 信息块、分段 Agent 步骤线与顶层当前异常状态实现，未生成新的 DMG、ZIP 或 blockmap。
- 2026-08-09：完成 Exploration 角色化历史流。`initial_supplement` 与后续追加指令独立保存为 User Turn，新增 `/api/explorations/{id}/timeline`，按 `user`、`agent_step`、`agent_final` 聚合步骤、白名单页面观察和唯一最终结果；前端把 User 消息作为靠右独立信息块切断 Agent 步骤连接线。Timeline 不读取诊断消息，不返回异常摘要，格式修复、自检、无效响应和已恢复重试不再进入历史；当前接管要求或终止失败只由详情顶层 `active_issue` 表达，恢复后为 `null`。不实现旧 Exploration 迁移或兼容。
- 2026-08-08：完成网站探索前端 UI 与交互重构。全局界面改为品牌状态顶栏、Toolkit／Tool 两级导航树、固定 Tool 上下文与 Toolkit 发布区；探索工作区删除独立活动流，改为目标置顶、步骤／消息历史流和固定底部追加指令；开发工作区补齐 Tool 基础定义、返回 Schema 与代码槽位只读标识；调试工作区使用明确标注为非原始终端的深色结构化事件面板。现有 Exploration、Development、Debug、发布与安装接口保持不变，仅为 Exploration 详情补回已有 `instruction` 字段。
- 2026-08-08：按经典 Agent 会话模式修订前端重构设计中的探索工作区。删除独立「活动」栏，详情使用固定 Header、单列可滚动历史流和固定底部 Prompt；目标置于历史流首项，用户补充指令、Agent 步骤／观察和最终结果按时序展示，必要内部事件折叠合并到相邻步骤。同步更新整体布局与探索工作区两张原型图及响应式规则，不改变 Exploration 状态机或 API。
- 2026-08-08：完成网站探索前端 UI 与交互重构的实施前设计。设计确定全局顶栏、Toolkit／Tool 两级导航树和探索／开发／调试三工作区布局，明确当前活动、Agent 浏览器、Tool 上下文和 Toolkit 发布动作的作用域；开发区继续由 Developer Agent 驱动，只读展示开发中／正式槽位代码及契约；调试区使用结构化运行事件和 Run 日志入口，不引入手工代码编辑、文件树或伪实时终端。同步补齐导航状态、空态、响应式断点、可访问性、准确 REST／SSE 矩阵、代码影响面、实施顺序和验证标准，并增加整体布局及三个工作区共四张 `1440 × 900` 中保真原型图，不修改现有产品规则或接口。
- 2026-08-08：修复探索首步浏览器调用阻塞后暂停／取消无法收敛的问题。暂停仍只在完整步骤边界生效，`pause_requested` 允许通过现有强制取消终止 Worker；强制取消先落请求状态，避免 Watcher 将主动取消覆盖为失败。首次模型调用前新增已绑定页面的轻量观察，当前 URL 已匹配时不再自动注入首次导航；模型动作执行前原子保存 trajectory 与 run-scoped 检查点。ProcessManager 依据检查点执行 45 秒进程外硬超时，超时步骤保存错误证据并以 `step_timeout` 失败；浏览器断开以 `browser_disconnected` 失败且优先于暂停请求，不恢复已关闭浏览器的探索。
- 2026-08-07：将所有模型输出预算统一为 `40000` tokens。模型基类、Anthropic 类默认值、三份运行 YAML、Image QA 与 Self Reflection 调用级覆盖全部使用 40K，Developer、Exploration、普通 Task 和辅助模型工具不再各自回落到 32K／8K／4K／1K；Provider 不支持 40K 时直接保留其接口错误。
- 2026-08-07：完成 Developer Agent 结构化输出第二阶段。Developer Slot 使用独立结构化请求；Anthropic 原生 JSON Schema 固定顶层字段，两个动态 Schema 在线路上编码为 JSON 字符串后本地解码；智谱、DeepSeek 与自定义 Chat Completions 使用 JSON Object。输出严格检查字段和类型并复用 Toolkit Store 的函数／参数／Schema 校验，首次空输出、非法 JSON 或 Slot 不合法只做一次内存修复。DeepSeek 空输出修复轮按官方字段关闭 Thinking，其他自定义 Provider 不携带该参数；修复过程不把模型原文写入日志。
- 2026-08-07：完成运行日志第一阶段。模型调用按请求开始、HTTP 响应收到、响应 JSON 解码分阶段记录脱敏元数据；空输出、非法 JSON、响应解码失败及 Worker 崩溃同时进入 `process.log` 摘要和 `runtime_errors.jsonl` 详情。Developer Worker 返回稳定 `error_code`／`stage`，ProcessManager 将真实错误写入 `run.json`，页面按异常详情文件是否存在显示入口。未修改 Developer Agent 请求模式、Thinking、结构化 Schema 或重试行为，相关正确性修复留待第二阶段。
- 2026-08-06：补齐每次运行的可观察生命周期。`process.log` 记录 Worker 启动／退出、模型请求开始／成功／失败／重试，以及 Development Run 创建、启动、整体超时、终止和最终状态；详细模型异常继续写入 `runtime_errors.jsonl`。Development 模型配置／准备失败现创建失败 Run 并保留日志，无法归属 Run 的模型快照失败写入全局 `logs/server.log`；日志不包含 Key、endpoint 或请求正文。
- 2026-08-06：修复 WeWorker 自定义模型使用 HTTP Base URL 时托管快照被错误拒绝的问题。快照校验与 WeWorker 的 Base URL 合同统一接受 HTTP／HTTPS，继续拒绝缺少 host、携带凭据、query 或 fragment 的地址；Task 与 Development Run 共用的模型解析链路同步生效。
- 2026-08-06：将 Webwright 作为 WeWorker 普通内部模块参与构建。分发 builder 与 runtime identity 删除组件级 `webwright_commit`／`dirty`，health 不再返回 commit；当前工作区存在未提交修改时仍可构建 embedded runtime，版本、平台、架构、模式和入口继续作为运行合同。
- 2026-08-06：删除已失去产品边界的 `installer/` 独立分发子项目，包括单文件 `webcli-py` Runtime、安装脚本、Inno Setup 配置、独立锁文件、测试和专用 Roadmap；WeWorker 继续保留随包轻量 `webcli-py`／`.cmd` wrapper，统一调用 embedded runtime，不引入第二套 Python／Playwright。同步将现行分发规范、Toolkit 产品／技术设计及 embedded 集成合同收口到该单一运行时边界；不读取或删除用户机器上可能已安装的 `~/.local/bin/webcli-py`。
- 2026-08-06：将 embedded 网站探索页面的顶部品牌与浏览器标签页标题从 `Webwright Toolkit`／`Webwright Toolkit 控制台` 统一改为「WeWorker 网站探索」，不再向用户暴露内部组件名称；页面端点回归同时锁定新标题、新品牌及旧品牌不得出现。
- 2026-08-06：补齐 embedded frozen runtime 的开源许可分发链。构建从锁定环境自动收集实际冻结依赖的准确版本、源码地址和许可证／NOTICE，最终 `onedir` 固定携带 `THIRD_PARTY_NOTICES.txt` 与 `licenses/`；Webwright MIT、CPython PSF、Playwright Apache 2.0／NOTICE、PyInstaller Bootloader Exception、certifi MPL 2.0 及准确版本源码获取说明纳入强制构建合同。macOS arm64 真实产物登记 36 个组件、收集 64 个许可证／NOTICE 文件。
- 2026-08-05：从当前版本删除未被源码、配置或文档引用的 `assets/demo.mp4`，减少 5.53 MB 跟踪内容；不重写 Git 历史，既有提交仍可恢复该文件。
- 2026-08-04：修复 WeWorker 的智谱配置被协议分支错误路由到通用 `openai_chat` Adapter。托管模型快照新增受校验的 `model_class`；智谱 coding plan 的 Task／Development Run 改用既有 `ZhipuModel`、`model_zhipu.yaml`、`ZHIPUAI_API_KEY` 和 WeWorker 提供的 Coding Plan Base URL，保留智谱特有的空响应修复逻辑。Anthropic 与通用 Chat Completions 路由保持独立。
- 2026-08-04：修复 embedded 增量构建可能打入陈旧 Web UI 的问题。PyInstaller 不再通过虚拟环境中的已安装 wheel 收集 Webwright package data，配置 YAML 与 `server/web` 固定从当前仓库 `src/` 显式加入；分发合同回归锁定当前源码路径。Webwright 全量 `243 passed, 3 skipped`、分发合同 `7 passed`。
- 2026-08-04：完成 WeWorker 托管模型配置代码基线。Server 的模型 Task／Development Run 每次从 WeWorker 固定 loopback 鉴权接口获取不可变快照，Key 只进入 Worker 环境；配置接口 URL 和 token 不下传 Worker。生产 UI／API 不再提供独立模型配置，路径模型不再声明 `models.json`，也不读取历史配置。新增厂商无关的 OpenAI Chat Completions Adapter 与 JSON Object，本地动作协议改为严格完整 JSON 和固定字段／类型校验；Anthropic Messages 增加原生 `output_config.format=json_schema`；冻结构建显式收集新 Chat Completions Adapter。全量回归 `243 passed, 3 skipped`、分发合同测试、`compileall` 和 Web 前端语法检查通过；真实厂商请求与旧模型文件物理清理待完成。
- 2026-08-03：将 embedded「安装到 WeWorker」改为项目 Skill 磁盘直装。Server 从 `WEWORKER_USER_FILES_DIR` 获取 Electron 授权的绝对用户目录，复核 `export_eligible` 后将 Publisher 当前正式四文件 Skill 原子覆盖到 `<user_directory>/.claude/skills/<skill-name>/`；不下载自身 ZIP、不调用 Backend、不维护索引，同名手动 Skill也整体覆盖。staging 写入或目录切换失败时保留／恢复旧目录；旧 `weworker_bridge.py`、临时 token 中转和专用测试已删除。
- 2026-08-03：完成 embedded WeWorker 数据根目录统一。WebwrightHome 默认值由 `~/.webwright` 改为 `~/.weworker/webwright`，Task、Toolkit、模型配置、浏览器 Profile、外部分发 Runtime 状态和日志的内部布局不变；Server、local CDP 和 Published Toolkit Runtime 统一遵守 `WEBWRIGHT_HOME`，旧目录不探测、不迁移、不兼容回退或删除。WeWorker Electron 同时向 Server 与 Backend 注入固定绝对路径，使 Claude Code／`webcli-py` 内部执行链继承同一数据根；除后续明确授权的项目 Skill 安装目录外，Webwright 不访问其他 WeWorker 数据。
- 2026-07-27：完成 embedded WeWorker Toolkit 安装 Bridge。Webwright 只有在固定 loopback Bridge URL 与临时 token 同时合法时才公开 capability 和注册条件路由，standalone 保持隐藏且服务端不可调用；Toolkit 顶栏新增「安装到 WeWorker」，与 export 共用 `export_eligible`。Webwright 复核资格后只中转 `toolkit_id`／`artifact_hash`，不读取或写入 WeWorker 目录；export status 新增两个分发文件 checksum，供 WeWorker 独立复核四文件 ZIP。Bridge token 不返回浏览器、不落盘、不进 URL。
- 2026-07-26：WeWorker 使用实际导出的 `wuhan-fangguan` 四文件 Skill 完成 macOS arm64 真实运行验收：Claude SDK 原生发现并激活 Skill，经 WeWorker `webcli-py` 调用当前 embedded Webwright `--internal-script`，Playwright/CDP 未登录失败和登录态成功执行均符合合同，成功路径验证 HTTP 200、PDF 文件头和非空内容；SDK 中途取消及 Backend 退出后无 Bash、Webwright 内部脚本或 Playwright driver 残留。Webwright 本体无需修改，持久 CDP 浏览器继续按现有 Toolkit 合同管理。
- 2026-07-25：WeWorker 已完成轻量 `webcli-py` 包装器和本地真实 embedded Runtime 探针，不修改 Webwright 本体即可通过既有 `--internal-script` 保持参数、cwd、stdin、stdout、stderr、退出码和 Python 环境隔离合同；WeWorker 权限、Skill 目录、打包资源及聚焦回归同步落地。实际四文件 Toolkit、真实 CDP、取消／退出进程回收和跨平台安装包仍待验收。
- 2026-07-25：完成 WeWorker 复用 embedded Webwright 运行导出 Toolkit 的双方合同设计：WeWorker 轻量 `webcli-py` 包装器透明调用既有 `--internal-script`，Webwright 继续负责冻结 CPython、Playwright driver 和 canonical Runtime；不修改独立 `webcli-py` 分发、不增加 MCP、不改变 Toolkit export 格式，也不处理 UI／Debug／Toolkit 并发。本项只更新设计与 Roadmap，Webwright 本体代码未修改，跨平台安装包验收待完成。
- 2026-07-22：完成 WeWorker 集成所需的 Webwright embedded runtime：完整分发新增 standalone／embedded 双模式，embedded 只输出带 `webwright-runtime.json` 和许可证的 `onedir`；PyInstaller 显式从仓库 `src/` 收集代码，修复 distribution 非 editable 路径依赖可能冻结陈旧 wheel 的问题；Server health 新增 commit／平台／架构／模式身份，限制 loopback host 并校验 Host、端口和 Origin；所有活动 Worker 统一使用独立进程组，新增 `ProcessManager.shutdown()`、可控 Werkzeug Server、信号关闭、`--parent-pid` 异常退出 watchdog 和 `--exit-on-stdin-close` 跨平台正常关闭。macOS arm64 166 MB embedded `onedir` 已实际构建，冻结 CLI、包内资源、内部 Worker 错误路径、真实 `8766` health、Host 拦截、stdin 关闭、父 PID 消失退出和端口释放均通过；Windows x64、macOS x64、WeWorker 接入和完整业务链不计入本项。
- 2026-07-22：完成 Webwright 集成进 WeWorker 的详细设计并落盘到 `docs/weworker_embedded_integration_design.md`，确定以 `components/webwright` Git submodule 固定源码版本，开发态从源码自动启动、发布态构建 embedded `onedir`，WeWorker 统一管理 `127.0.0.1:8766` Server 的启动、退出、更新和卸载；“打开 Webwright”入口仅调用默认浏览器，不参与启动；同时明确程序／用户数据边界、父进程 watchdog、Worker shutdown、安全边界、三架构构建矩阵、改动范围、影响面、风险和验收标准。本项只完成设计与分发规范更新，代码实现和平台验证尚未开始。
- 2026-07-21：完成完整 Webwright 分发的运行时基础与 macOS arm64 冻结基线：统一 `~/.webwright`／`WEBWRIGHT_HOME` 路径合同，移除旧配置变量和 Store 相对默认值；新增 RuntimeLauncher、冻结内部 Worker／脚本入口、显式 Run `cwd`、BundledResources、canonical Runtime 资源收集及系统浏览器外部环境清理；新增独立 `distribution/`，锁定 CPython 3.14.6、Playwright 1.60.0、PyInstaller 6.21.0，构建脚本最终输出 `Webwright-macos-arm64.dmg`，`onedir` 与 `.app` 仅作为中间产物保留。Windows 实机构建、签名、公证和完整业务链验收未完成，不计入本项。
- 2026-07-21：完成 Webwright 完整分发的存量设计改造方案，明确源码运行假设、InstallRoot 与 `~/.webwright` 数据边界、`onedir` 分发形态、RuntimeLauncher、包内资源、外部浏览器进程环境、影响面、风险、验证范围和实施顺序；现有 `installer/` 继续只维护 `webcli-py`，完整产品分发待按独立子项目实施。
- 2026-07-21：正式 Toolkit 交付从五文件收敛为四文件，删除导出包 `scripts/toolkit.json`；运行规格内嵌于 `toolkit.py`，Published Runtime 不再读取 manifest，formal Debug 改由 stdin 传递原始参数 JSON
- 2026-07-20：完成控制台体验优化：修复顶部／工作区溢出、开发流程状态与重新开发指令入口，并将模型管理调整为列表优先。
- 2026-07-19：正式 Skill frontmatter `description` 改为「当需要操作以下域名的网页时可使用」并列出 Toolkit 允许域名，不再列举 Tool 名称；当前天津 Skill 已重建。
- 2026-07-19：正式 Toolkit 的 `SKILL.md` 调用说明切换为 `webcli-py scripts/toolkit.py <tool>`，不再要求用户安装 Python／Playwright 或执行 pip；五文件结构、正式执行文件和 `artifact_hash` 保持不变，当前天津正式 Skill 已确定性重建并验证 CLI。
- 2026-07-19：完成 `webcli-py` 基础环境打包：已支持 macOS／Windows 安装交付，macOS arm64 已验证；Windows x64、universal2／Intel 和正式签名待后续。
- 2026-07-18：修复 Windows 正式版 Debug 子进程编码链路：外层 Debug 进程与内层已发布 CLI 统一通过 `PYTHONIOENCODING=utf-8` 输出，捕获端显式按 UTF-8 解码，不再将 GBK 中文误解码为 `U+FFFD`，避免 Tool 已成功却因结果日志打印失败被判定为 Debug 失败。
- 2026-07-18：修复首次开发误用“从探索重新开发”交互：从未发布且无开发中版本的 Tool 选择成功 Exploration 后，开发工作区改为显示「开始开发」、所选 Exploration 和必填首次开发指令，提交走普通 `/development/start`；已有正式版本的独立重新开发入口和清空语义保持不变。
- 2026-07-18：完成「从探索重新开发」专项：已发布 Tool 可从当前 Tool 的一次成功 Exploration 清空开发中槽位并重新开发；Developer 输入通过显式 `exploration_only` 隔离正式／开发中代码和历史 Debug 证据，Development Run 固定空 `based_on_formal_hash`／`debug_run_evidence_id`；独立 API、开发工作区双入口和显式确认弹窗已接通，运行失败保持正式版本有效且开发槽位为空，发布前正式 Skill、`artifact_hash`、formal Debug 证据和导出资格保持不变。
- 2026-07-18：修复旧版 Developer Agent 文本数组元数据被拆成字符的问题：当时通过提示词约束和槽位归一化避免 `SKILL.md` 逐字符插入分号；该元数据契约后来已移除。
- 2026-07-18：完成 Toolkit 正式交付闭环：标准五文件 Skill、Runtime 状态外置、formal Debug、当前产物验证、五文件只读导出、旧生成物迁移清理及系统验收全部通过，进展已归并至 `docs/toolkit_roadmap.md`。
- 2026-07-17：探索循环发送模型历史时，仅在临时请求副本中将最近一次 assistant 动作还原为包含 `thought`、完整 `python_code`／`bash_command`、`done`、`final_response` 的 JSON；更早动作继续只传 thought，持久化 trajectory 和 UI 展示结构不变。正常探索、20 步历史压缩与 Follow-up 恢复统一遵守该规则。
- 2026-07-16：修复 Toolkit 发布正确性与 Tool 代码边界：发布恢复不再只依赖 journal 阶段，而是按目标 `code_hash` 核对正式槽位，补齐 `prepared` 后已转正但产物未构建的崩溃窗口；开发／正式槽位变更统一加锁，发布通过期望哈希条件转正和清理，开发代码在发布期间变化时中止或保留新版本，不再误删；Tool 槽位限制为唯一同名顶层异步函数，并校验业务参数、必填性与参数 Schema 完全一致，阻止多 Tool 拼接时的顶层符号污染。
- 2026-07-16：为活动面板补齐消息元数据：`DefaultAgent.add_messages` 落盘时自动向 `extra.timestamp` 注入 UTC 时间戳；`resume()` 追加 Follow-up 时在 `extra.user_input` 保留主人原始输入，展示层直接读，不再靠剥离固定模板前缀。`read_messages` 透出 `timestamp`／`user_input`，前端 followup 摘要显示原文，事件时间列不再全空。前端 `flattenMessageContent` 白名单同时识别 `input_text`／`text`／`output_text` 文本 part 与 `input_image`／`image` 图片 part，避免非 canonical 形态被静默丢弃。
- 2026-07-16：为探索工作区活动面板做语义区分，不再一刀切按 role 打「followup」：后端 `read_messages` 补齐 `has_observation` 字段（透出 `extra.observation` 存在性），前端按 `kind`／`has_observation` 分类为「追加指令 / 页面观察 / 格式重试 / 自检拦截 / 无效响应」，观察行默认折叠展示首行摘要、点击后展开正文与「[截图 ×N]」占位；补充 `read_messages`／`/messages` 端到端单测。
- 2026-07-16：修复全局弹窗误关闭：所有表单／管理弹窗不再响应遮罩点击或 `Escape`，仅显式取消／关闭控件和成功业务操作可退出；截图灯箱补充顶部关闭按钮，并同样禁止遮罩与 `Escape` 关闭。
- 2026-07-15：创建 Toolkit 产品升级专有 Roadmap，并完成阶段一至三：领域模型、Runtime、Exploration 接入、真实 HTTP／CDP E2E 和天津 fixture。
- 2026-07-15：完成 Toolkit 产品升级阶段四至六：Debug Run、Developer Agent、开发中槽位、Publisher、正式交付物和异常恢复。
- 2026-07-15：完成 Toolkit 产品升级阶段七：三工作区真实 UI 接入、主要流程补齐、旧 Task UI 边界收敛，完整回归与真实浏览器验收通过。
- 2026-07-15：完成阶段七后前端修复：继续开发证据保留、探索步骤状态、长 ID 换行、登录提示和「新建探索」入口。
- 2026-07-13～07-14：完成 Toolkit 三工作区前端交互 demo（`src/webwright/server/web/`，无框架 ES modules，mock 数据驱动，已提交 commit `1c451d6`）。覆盖 Toolkit/Tool 创建（名称即标识、域名与合法字符校验）、探索工作区（交互对齐原 `ui.py` 任务工作区：主从列表+详情、弹窗新建、暂停/继续/取消/回放/刷新工具栏、步骤时间线、追问 composer、活动日志、选为开发输入）、开发工作区（开始开发/继续开发/重新开始/发布，界面文案去槽位术语，支持选择一次 Debug Run 作为本轮开发证据）、调试工作区（正式/开发中渠道切换、按参数 Schema 渲染表单、Debug Run 历史）。全部写操作走内存 mock（非持久化，刷新页面即重置），并同步复核修订了产品设计文档（→v1.4）与技术设计文档（→v1.1），消除两份文档之间及文档与 demo 之间的表述矛盾与遗漏。Playwright headless 端到端验证覆盖全部工作区和交互路径，全程 console/pageerror 零报错，过程中发现并修复两处真实 bug（探索详情「继续」按钮漏绑点击事件、新建 Toolkit 后顶栏下拉选中值时序错误）。已知未实现、明确留待后续的项见「待办」。
- 2026-07-14：完成 Toolkit 技术设计并落盘到 `docs/toolkit_technical_design.md`，涵盖目标架构、领域模型、文件存储、Tool Developer Agent、Toolkit Runtime Store、Debug Run、双槽位发布、API、ProcessManager、UI 拆分、可行性与影响面、测试设计和技术依赖顺序；同时记录从初始方案到当前决策的调整轨迹。
- 2026-07-13：将 `local_browser + local_cdp` 的 `target_id` 页面绑定从 URL／title 猜测升级为真实 CDP identity 映射。`LocalBrowserEnvironment` 现在为每个 Playwright `Page` 建立临时 CDP session，通过 `Target.getTargetInfo` 读取实际 `targetId` 并精确匹配；指定 target 已失效或无法映射时直接失败，不再降级到同 URL 页面，Follow-up 与 replay 启动竞态也遵守该约束；运行时 target 回写改为读取所选 Page 的真实 ID。新增双标签页 URL、title 完全相同仍准确选中指定 target，以及 target 不匹配不降级、运行时 ID 覆盖陈旧值的回归测试。
- 2026-07-13：完成 Toolkit 产品功能设计并落盘到 `docs/toolkit_product_design.md`。确定先创建 Toolkit 和 Tool，再围绕明确 Tool 开展「探索、开发、调试」三类活动；一次开发最多使用一次完整 Exploration；每个 Tool 只保留正式版本和开发中版本，不保留代码修改历史；正式工具由 CLI、工具清单和 Skill 对外提供。
- 2026-07-11：新增 server 模式全局模型配置模块（多服务商 CRUD、激活、`GET/POST/PUT/DELETE /api/models`），支持 UI 免改配置文件选服务商/换 endpoint/填 key；随后修复编辑时不回显 key、以及无可用 key 时 follow-up 被误判为「已完成」两个问题。
- 2026-07-12：统一任务、Follow-up 与 replay 的 Agent 浏览器标签页状态：任务 metadata 维护唯一 `active_target_id`；内置 UI 回放默认 `new_tab=false`，按 `active_target_id`、trajectory target 顺序复用，失败时自动新建并将实际 target 回写为新的活动 target；Follow-up 显式使用该活动 target，保证「任务 → 回放 → Follow-up → 再回放」持续操作同一标签页。API 保留 `new_tab=true` 强制新建标签页的能力。
- 2026-07-11：搭建「新建任务前 Agent 浏览器准备」流程——内置 UI 检测/绑定已打开的目标页面、首次任务可携带 `target_id` 严格接管、抽出共享 local CDP 工具与 `POST /api/browser/open`／`GET /api/browser/match`；同时修复接管页面首次执行的回放空白页问题。target 绑定精度后于 07-13 升级为真实 CDP identity 映射（见上）。
- 2026-07-11：补齐 Windows 平台适配：修复配置文件按 GBK 误解码导致的子进程编码报错，补齐 Agent 浏览器 executable 发现（PATH／Registry／常见安装目录）与独立进程组/detached 启动。
- 2026-07-10：为 agent action 的 JSON 协议增加连续格式错误熔断（默认 3 次后以 `FormatError` 终态失败，不再无限重试），修复请求格式改为保留无效输出后追加纠正消息，单次修复重试从 3 次降为 1 次。智谱 action 请求默认保留模型 Thinking，仅在首轮空响应的同轮 JSON 修复请求中关闭，非空格式错误不受影响。
- 2026-07-10：新增智谱 Chat Completions backend（`model_zhipu.yaml`），action 请求使用原生 JSON object 格式；CLI 与 server 默认配置切换为智谱。
- 2026-07-09：重构内置 UI（`ui.py`）视觉与交互——新建任务改顶部按钮+浮层、步骤流改竖向时间线（截图可放大、代码可折叠）、事件流着色、任务列表加搜索与进度条、亮暗主题切换；取消 5 秒定时轮询，保留手动刷新与 SSE 触发刷新。产品能力不变。

## 进行中

- Webwright embedded runtime 作为 WeWorker 内部模块的构建、生命周期、打包及标准 Skill Runtime 已完成 macOS arm64 实际四文件 Toolkit、真实 CDP 和进程回收验收；Windows x64、macOS x64 embedded 实机构建及 WeWorker 安装／升级／卸载验收尚未完成。
- WeWorker 安装 Bridge 已完成源码与自动化验收；尚需由包含本次实现的新 WeWorker macOS arm64 安装包完成真实按钮安装、更新、幂等和冲突提示闭环。
- WeWorker 托管模型配置代码和自动化已完成，尚需真实 Anthropic／GLM／DeepSeek／自定义网关请求与模型切换快照验收。

## 待办

- 配合 WeWorker 按 `docs/weworker_embedded_integration_design.md` 完成 Windows x64、macOS x64 embedded 实机构建及三架构安装、升级、卸载和完整业务链验收。现有入口不满足合同时再修改 Webwright。
- 配合 WeWorker 用新 macOS arm64 安装包完成 export-eligible Toolkit 的「安装到 WeWorker」真实 UI 闭环。
- 获得删除授权后物理清理旧模型 Store、Provider 注册表、模型管理前端和 Responses Adapter 文件；不读取或迁移历史 `models.json`。
- 按 `docs/toolkit_roadmap.md` 继续阶段八：实现同一 Toolkit 下多 Tool 固定顺序调试，并完成共享 Runtime Store、失败中止、重启恢复和系统级真实 CDP 验收。
- 文档复核中还提到但用户明确不再处理的两类差异，定性为「demo 本身不追求完全对齐技术设计」，不再单独跟踪：技术设计 §14「状态管理」列的「当前活动运行」「当前 SSE 连接」在 `state.js` 里没有对应字段（demo 用 mock 定时器代替真实 SSE，各视图用局部变量顶替）；产品文档 §6.2「每个 Tool 必须包含」的「是否要求登录／成功判定／稳定错误码／支持的域名和 URL 范围」在 `develop.js` 的代码卡片里没有展示；调试工作区「运行前校验」提示文案未配真实校验逻辑；Exploration 状态 `failed` 在交互中无法被用户操作触发（仅种子数据里静态存在）；Tool「起始页面或页面范围」demo 只实现了单个 URL。

## 阻塞

- 当前激活的智谱 `glm-4.7` 在 Google Flights 外部模型实跑中出现 `ReadTimeout`；API 与本地受控模型执行链 E2E 已通过，外部模型稳定性仍需后续复验。详情见 `docs/toolkit_roadmap.md`。

## 最近验证

- 2026-08-09：人工保存代码、槽位元数据保留、哈希重算、旧哈希冲突、全局活动互斥、结构校验、发布资格失效和 UI 控件聚焦回归通过；组件全量测试 `269 passed, 4 skipped`，Python 编译、前端 JavaScript 语法和 `git diff --check` 通过。隔离数据根的真实 Server 页面在独立 `18768` 端口完成有效保存、无效签名错误、失败后按钮恢复和取消编辑验收，页面无业务 Console Error；WeWorker 集成回归 `22 passed`，未操作既有 `8766` 进程。
- 2026-08-09：步骤展示顺序与三个固定标签有源码回归覆盖；组件全量测试 `257 passed, 3 skipped`，修改 JavaScript 语法检查通过。隔离数据根的真实 Server 页面确认首个步骤的区块索引连续为 `[2, 3, 4]`，对应 `[Agent 思考, 执行动作, 执行后页面]`，动作区 `open=false`；WeWorker Renderer 正式构建与集成回归 `22 passed`。验收使用独立 `18767` 端口，未操作既有 `8766` 进程，本轮未重打 `.app`。
- 2026-08-09：新 app-only 产物中的 embedded Runtime manifest 为 `0.1.0`／`darwin`／`arm64`／`embedded`，冻结可执行文件为 arm64 且 `--help` 通过；包内 Web UI 已检出 Timeline、User 信息块、Agent 步骤分段与 `active_issue` 标记。宿主 `WeWorker.app` 为 `0.2.5`、约 `679 MB`，主程序为 arm64，深度 ad-hoc 签名有效；网站探索集成回归 `22 passed`。既有 DMG、ZIP 和 blockmap 未改变。
- 2026-08-09：Timeline 顺序、User Turn 步骤锚点、初始补充指令、唯一最终结果、当前阻塞清除和内部异常过滤均有回归覆盖；组件单元测试 `257 passed, 3 skipped`，修改文件 Python 编译和前端 JavaScript 语法检查通过。隔离数据根的真实 Server 页面确认两个 User 块形成两段 Agent 步骤线、已恢复异常不可见、最终结果唯一；`760 × 800` 窄窗口无横向溢出且底部 Prompt 不遮挡结果。WeWorker Renderer 正式构建与集成回归 `22 passed`，验收使用独立 `18766` 端口，未操作既有 `8766` 进程。
- 2026-08-08：本轮前端重构已进入 macOS arm64 app-only E2E 产物；embedded runtime manifest 为 `0.1.0`／`darwin`／`arm64`／`embedded`，可执行文件为 arm64 且 `--help` 通过。包内静态资源确认包含 Toolkit／Tool 两级导航、Agent 历史／固定底部 Prompt、开发只读标识和结构化 Console；宿主 `.app` 深度 ad-hoc 签名验证通过，网站探索集成回归 `22 passed`，未生成新的 DMG／ZIP。
- 2026-08-08：网站探索前端重构通过 Server 聚焦回归 `24 passed`、Webwright 单元测试 `254 passed, 3 skipped`、全部修改 JavaScript 的 `node --check` 和 `git diff --check`。隔离临时数据根启动真实本地 Server 后，桌面页面确认两级导航、固定工作区头部和完整探索历史／底部 Prompt 正常；`760 × 800` 窄窗口确认页面无横向溢出。验收使用独立 `18765` 端口，未接管或终止既有 `8766` 进程。
- 2026-08-08：修订后的整体布局与探索工作区原型均以 `1440 × 900` 原始尺寸复核，确认「目标置顶—历史流—底部 Prompt」结构完整、独立活动栏已移除、最后一条结果未被输入区遮挡；设计稿图片链接、代码围栏和空白错误检查通过。本轮只修改设计、图片与 Roadmap，未执行产品代码测试。
- 2026-08-08：前端重构设计逐项对照当前 Flask 路由、`web/api.js`、Toolkit 产品设计和三工作区实现；确认 Run 专属 SSE 只承担状态通知、系统无全局 `/api/events`、安装路由按 embedded capability 注册。相对链接、Markdown 代码围栏和新增文档空白错误检查通过；整体、探索、开发、调试四张原型图均完成 `1440 × 900` 原始尺寸视觉检查，中文、只读开发边界和结构化运行事件标识正常。本轮只修改设计、图片与 Roadmap，未执行产品代码测试。
- 2026-08-08：使用 Electron Builder `--dir` 重新生成 Apple Silicon `.app`（WeWorker `0.2.5`，应用本体与内置网站探索 agent 均为 arm64）；内置运行时 `--help`、包内探索界面修复内容和 `codesign --verify --deep --strict` 验证通过，未重新生成 DMG／ZIP。
- 2026-08-08：检查点、首次页面观察、重复首航规避、浏览器断开失败优先级、进程外步骤超时、强制取消竞态和 `pause_requested` 取消入口聚焦回归 `70 passed`；全量 `262 passed, 4 skipped`，Python `compileall`、Web 前端 JavaScript 语法和 `git diff --check` 通过；WeWorker 集成回归 `22 passed`。
- 2026-08-07：40K 输出预算已进入新 macOS arm64 app-only 产物；`.app` 深度代码完整性有效，主程序与 embedded runtime 均为 arm64，embedded `--help` 可运行；既有 DMG／ZIP 未重新生成。
- 2026-08-07：模型类、三份运行 YAML、Image QA 和 Self Reflection 的 40K 输出预算聚焦回归连同 Developer 链路共 `61 passed`；Webwright 全量 `255 passed, 4 skipped`。
- 2026-08-07：Developer Agent 第二阶段已进入新 macOS arm64 app-only 产物；`.app` 深度代码完整性有效，主程序与 embedded runtime 均为 arm64，embedded `--help` 可运行，既有 DMG／ZIP 未重新生成。WeWorker 网站探索集成回归 `22 passed`。
- 2026-08-07：Developer Agent 的 Anthropic 原生 Schema、Chat Completions JSON Object、DeepSeek 空输出关闭 Thinking 修复、单次修复上限、Schema 字符串解码、本地 Slot 校验及 Provider 身份传递回归通过；Webwright 全量 `252 passed, 4 skipped`，修改文件 Python 编译通过。
- 2026-08-07：日志分阶段事件、脱敏响应元数据、HTTP 响应解码失败、空／非法 Developer 输出、结构化子进程错误回写、异常详情入口及生命周期聚焦回归 `93 passed`；Webwright 测试集 `233 passed, 3 skipped`，Python 编译、前端 JavaScript 语法和 `git diff --check` 通过。
- 2026-08-06：生命周期日志、模型请求、空文本 `ReadTimeout`、Development Run 配置失败／整体超时、Worker 进程管理聚焦回归 `68 passed`；Webwright 测试集 `229 passed, 3 skipped`，`py_compile` 和 `git diff --check` 通过。
- 2026-08-06：HTTP 托管模型快照回归及模型路由／进程管理／开发发布聚焦测试 `60 passed`；Webwright 测试集 `225 passed, 3 skipped`。
- 2026-08-06：WeWorker macOS arm64 正式构建链完整通过，`.app` 与 embedded runtime 均为 arm64，深度代码完整性校验通过；包内 Webwright manifest 只含版本、平台、架构、模式和入口，不含组件 commit／dirty。
- 2026-08-06：包含未提交组件修改的当前工作区直接完成 macOS arm64 embedded 真实构建，新 manifest 不含 commit／dirty；Webwright 全量 `232 passed, 4 skipped`、锁定分发环境合同 `9 passed`，WeWorker 集成回归 `22 passed`，相关语法检查和 `git diff --check` 通过。
- 2026-08-06：独立 installer 删除后，分发合同 `9 passed`、Webwright 全量 `223 passed, 3 skipped`、WeWorker 集成回归 `29 passed`；仓库检索确认当前构建无已删除目录依赖，标准命名的 `ROADMAP.md` 只剩主项目与 Webwright 两份，另保留一份 Toolkit 专题 Roadmap，`git diff --check` 通过。
- 2026-08-06：网站探索页面品牌修改后，Server 页面端点聚焦回归 `24 passed`、WeWorker 集成回归 `29 passed`，Web 前端全量 JavaScript 语法检查和 `git diff --check` 通过。
- 2026-08-06：第三方许可分发合同在锁定 distribution 环境 `9 passed`，Webwright 全量 `223 passed, 3 skipped`，WeWorker 集成回归 `29 passed`；macOS arm64 embedded runtime 真实构建通过，CPython／Webwright 许可证逐字核对、Playwright NOTICE／ThirdPartyNotices、PyInstaller COPYING、certifi MPL 许可证及精确版本源码链接均存在，冻结入口 `--help` 通过，`git diff --check` 通过。
- 2026-08-04：智谱 coding plan 托管模型路由聚焦回归 `51 passed`，全量回归 `244 passed, 3 skipped`，`git diff --check` 通过；Task 与 Development Run 均断言 `model_class=zhipu`、Coding Plan Chat Completions endpoint 和 `ZHIPUAI_API_KEY`。
- 2026-08-03：磁盘直装聚焦回归覆盖 capability、导出资格、同名整体覆盖、幂等、四文件白名单、staging 失败保护和原子切换回滚；WeWorker Electron 集成、Backend TypeScript／bundle、Webwright 全量回归及双方 `git diff --check` 通过。当前 `8766` 被既有进程占用，未接管、终止或复用。
- 2026-08-03：Webwright 路径、浏览器 Profile 和 Toolkit Runtime 聚焦回归 `34 passed`，全量回归 `238 passed, 3 skipped`；WeWorker 集成回归 `25 passed`，真实 embedded Runtime 探针确认 `webcli-py` 保留固定 `WEBWRIGHT_HOME`，双方 `git diff --check` 通过。当前 `8766` 被既有进程占用，未接管、终止或复用。
- 2026-07-27：WeWorker 安装 Bridge 聚焦测试 `52 passed`，Webwright 全量 `237 passed, 3 skipped`，Python `compileall`、Web 前端 `node --check` 和 `git diff --check` 通过；WeWorker 侧安装器 `7 passed`、Backend 全量 `254 passed, 1 skipped`、TypeScript 类型检查、正式 bundle 和 Webwright 集成回归 `24 passed`。真实双服务验收因已有旧 WeWorker 安装态进程占用 `8765`／`8766` 未启动，未接管或终止未知范围进程。
- 2026-07-26：实际 `wuhan-fangguan` 四文件 Skill 在 WeWorker Claude SDK 中成功发现、激活并调用 embedded Runtime；未登录失败和登录态生成并验证 PDF 均通过，真实 SDK 取消及 Backend 退出无内部脚本和 Playwright driver 残留。WeWorker 权限与生命周期聚焦回归 `56 passed`、Webwright 集成回归 `23 passed`。
- 2026-07-25：WeWorker `webcli-py` 通过当前 macOS arm64 embedded Runtime 的真实 `--internal-script` 探针，参数、cwd、stdio、退出码和 Python 环境隔离符合双方合同；WeWorker Webwright 集成回归 `23 passed`。Webwright 本体代码未修改，实际四文件 Toolkit 和跨平台安装包未验证。
- 2026-07-25：WeWorker Toolkit Runtime 复用合同已完成文档链接、边界和关键命令路径核对；本轮只修改设计与 Roadmap，未运行代码测试。
- 2026-07-22：WeWorker embedded Webwright 完整回归 `233 passed, 3 skipped`，`compileall`、前端 `node --check` 和 `git diff --check` 通过；以 CPython 3.14.6、Playwright 1.60.0、PyInstaller 6.21.0 构建 166 MB macOS arm64 embedded `onedir`，确认 PyInstaller 模块路径包含当前仓库 `src/`；冻结入口 `--help` 包含 `--parent-pid`／`--exit-on-stdin-close`，包内 Web UI、Playwright driver、许可证和 runtime manifest 存在，真实 `127.0.0.1:8766` 返回 embedded identity，错误 Host／端口被拒绝，stdin EOF 和父 PID 消失均能退出并释放端口。Windows x64、macOS x64 和完整业务链未验证。
- 2026-07-22：WeWorker embedded 集成设计完成文档结构、相对链接、Markdown 代码围栏和 `git diff --check` 核对；本轮只修改分发规范、设计文档和 Roadmap，未运行代码测试。
- 2026-07-21：Windows 最终安装包合同与自动化测试完成：`build.py` 在 Windows x64 上自动发现并调用 Inno Setup 6，向 `.iss` 注入本次 `onedir` 和输出目录，最终要求生成 `Webwright-windows-x64-Setup.exe`；分发合同聚焦测试 `11 passed`，完整回归 `224 passed, 3 skipped`，`compileall`、前端 `node --check` 和 `git diff --check` 通过。当前 macOS 环境无法执行 ISCC，Windows 实机结果保持待验证。
- 2026-07-21：完整分发运行时改造全量回归 `222 passed, 3 skipped`，`compileall`、前端 `node --check` 和 `git diff --check` 通过；以 CPython 3.14.6、Playwright 1.60.0、PyInstaller 6.21.0 成功构建 69 MB 的 macOS arm64 unsigned `Webwright-macos-arm64.dmg`，镜像校验、只读挂载、单一 `Webwright.app` 内容和复制出镜像后的冻结入口 `--help` 均通过；内部 Worker 分发、内部正式 Toolkit 脚本 `--help`、包内 YAML／Web UI／Playwright driver／canonical Runtime 字节一致性，以及冻结 Server `/api/health`／`/ui` 也已通过。Windows 和真实完整业务链未在本机验证。
- 2026-07-21：完整分发存量设计改造方案完成本地链接、Markdown 代码围栏、四文件 Skill 基线和 `git diff --check` 核对；本轮只修改设计与 Roadmap，未运行代码测试。
- 2026-07-21：四文件 Skill 改造完整回归 `213 passed, 3 skipped`，自包含 Runtime 恢复真实 CDP E2E `1 passed`，`compileall` 和 `git diff --check` 通过；北京、廊坊、天津、武汉现有正式 Toolkit 的根 CLI `--help` 全部通过且正式 Skill 中已无 `scripts/toolkit.json`；通用分发与天津真实 CDP E2E 缺少精确预备标签页，保持环境门控跳过。
- 2026-07-20：控制台体验优化经真实前端回归验证通过；`tests/unit/test_server_app.py` 21 passed、前端 `node --check` 和 `git diff --check` 通过。
- 2026-07-19：Skill 域名描述改造的 Publisher 聚焦回归 `26 passed`，完整回归 `206 passed, 3 skipped`；天津正式 Skill frontmatter 已核对只包含允许域名、不包含 Tool 名称，`compileall` 和 `git diff --check` 通过。
- 2026-07-19：`webcli-py` Skill 调用说明改造的 Publisher 聚焦回归 `26 passed`，仓库完整回归 `206 passed, 3 skipped`；当前 `tianjin-property/SKILL.md` 已重建并通过 `webcli-py scripts/toolkit.py download-tianjin-fangcha-pdf --help` 验证，`compileall` 和 `git diff --check` 通过。
- 2026-07-19：基础环境打包验证通过：源码／安装器测试、macOS arm64 实机安装和完整回归通过；Windows 安装向导待实机验收。
