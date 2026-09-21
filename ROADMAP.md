# WeWorker Roadmap

## 当前阶段

WeWorker 已完成公开仓库初始化，当前在全新的 `develop` 基线上按模块迁移旧开发分支中未进入 `main` 的通用能力。迁移不引入旧 Git 历史，且保持现有 Profile/Overlay 配置架构不变。

## 已完成

- 2026-09-21：将计划完整性与写工具验证修复拆为独立 PR：按计划索引绑定 API、隔离空草稿、核对实际注册工具集合、支持安全新增修订文件并在恢复时重新验证；mock 确认状态由验证器控制，成功／失败预期必须为非空 JSON 对象。本地 WebCLI 全量 58 文件、333/333 通过；真实站点完整生成与写操作验证仍待实测，不以 mock 代替。

- 2026-09-18：迁入自动探索捕获值隔离修复，保留公开仓库的匿名化、Profile/Overlay 与运行时权限边界。模型上下文与生成知识包使用响应字段／类型证据，站点记忆不再保存响应原文，生成前清除请求／响应样本；补齐历史记录读取与后续生成的聚焦回归。参考 OpenCLI `8271afc67e8504bda94c147f446ee29775d08274` 的默认结构摘要与长期记忆边界，本实现限制更严格，不代表照搬其允许显式读取原始响应的全部行为。同步迁入客户端模型配置经 IPC 注入生成 Worker 的修复，以及 Anthropic 兼容响应中多个文本块的提取修复。未引入内部站点 Adapter、真实捕获数据或旧工作区配置。

- 移除仅面向内部系统的 Adapter、测试、快捷查询路由、发布脚本、部署说明和演示材料。
- 扩展 Adapter 注册表与构建配置已收敛到仓库中实际保留的公开网站 Adapter。
- 移除源码中的固定指标服务地址和固定访问令牌；指标上报改为显式环境配置并默认关闭。
- 内部域名、私网 IP 和组织名称已从保留的代码与文档中匿名化或移除。
- 首次开源版本已统一为 `1.0.0`，公开仓库身份统一为 `WeWorker/WeWorker`。
- 根更新日志与应用内更新日志已重置为仅记录首次公开版本 `1.0.0`。
- 浏览器扩展的公开名称统一为 `WeWorker Browser Adapter`，公开链接不再指向旧项目地址。
- 根 README 已按当前真实架构、启动命令、安全边界和发布状态重写。
- 20 个目标网站清单已保留并增加“已实现／开发中／规划中”状态；Gmail 和诺诺网发票作为补充集成单独记录。
- 贡献指南已改为基于 `main` 的 GitHub Flow，并补充真实检查命令、Adapter 贡献要求和本地敏感信息自检规则。
- 已新增 Git 工作流文档，明确 PR、受保护分支、受控敏感信息检查、Squash Merge、Tag 和紧急修复流程。
- Issue 与 PR 模板已完善，覆盖 Bug、功能、文档和 Adapter 提议，并区分贡献者自检与维护者受控敏感信息检查。
- 已新增公开 PR CI，覆盖配置一致性、WebCLI、Backend、Renderer、官网、Electron 集成和 Extension 检查；敏感信息扫描和真实账号 E2E 不进入公开自动化。
- 已补齐行为准则、支持指引、第三方声明、`.gitattributes`，并完善新仓库文件边界。
- 发布工作流已改为仅手动触发，并只创建指定版本的草稿 Release，不再强制移动 Tag 或删除既有 Release。
- 构建配置支持通过外部 Profile Overlay 叠加 Adapter、Provider 与扩展权限；安装包只读取生成的 `build/extension-dist/`，构建不再回写公共源配置。
- 官网站点清单支持外部 Overlay，源码只保留公开站点基线，开发与构建前自动生成最终清单。
- Backend 提供可注册的 Profile 查询路由入口；默认公开构建保持空实现，定制能力可由独立入口参与开发和打包。
- Extension 页面运行时跨域访问改由内置 Adapter manifest 的 `runtime_allowed_hosts` 显式声明，公共 Service Worker 不再包含产品域名映射。
- WebCLI 包清单使用公共超集，定制仓库可按需提供命令目录资产而无需修改公共依赖或 package 配置。
- Windows 解密工具改由 `uv` 创建隔离、固定版本的构建环境，不再依赖系统 Python 预装 PyInstaller/pywin32。
- 已从清理后的公开 `main` 创建全新本地 `develop`，旧仓库 `develop` 仅作为只读迁移来源。
- 首个低风险增量已迁入：Backend 显式固定 `@emnapi/runtime` 构建依赖，不涉及业务配置或内部资产。
- 旧 `develop` 中的通用上下文与记忆能力已迁入公开 `develop`：Prompt 外置、长期记忆存储/召回、记忆准入与执行证据、对话上下文压缩、上下文用量面板、已加载 Skill 指令连续性。
- Backend 关键运行依赖已从浮动版本调整为固定版本，并补齐 `@emnapi/runtime` optional lock 元数据，提升 Windows 构建可复现性。
- 已迁入通用网站/API 探索与 Adapter 生成链路：Extension 提供被动网络采集、安全只读探测、capture-bound 回放与动作捕获，Backend 提供探索 Agent、Bridge RPC、站点记忆和生成编排，Renderer 提供任务恢复与生成工作台。
- 已新增可复用的 API Adapter 认证框架与 Codex Skill，覆盖清单、mock 成功/失败、安全确认门、live 分类、增量指纹、多开发者本地 profile、打包校验和自包含 HTML 报告；开发者权限、登录态、fixture 与 live 证据不进入仓库。
- 公开构建当前不包含 API/background Adapter，认证清单为 0 个 Adapter、0 个工具；框架可由外部 Profile Overlay 或内部仓库直接复用，不能据此宣称任何未打包 Adapter 已完成 live 认证。

## 验证结果

- 2026-09-21：拆分提交 Windows 托管启动修复。父进程存活探测改用 Windows 只读同步句柄，避免 os.kill(pid, 0) 误终止进程；移除 Backend 启动时未定义的环境变量赋值，并记录启动异常状态。隔离分支 Windows Python 生命周期测试 7/7、Electron 启动／端口归属／健康检查／停止／异常重启聚焦测试 32/32 通过，确认 Python 测试加载本分支源码。测试仅启动自有临时进程，未操作现有客户端或未知端口进程；安装包及真实客户端重启复验未执行。

- 2026-09-21：补齐响应验证器模块拆分后的扩展测试加载适配。tool-route 与 wecli-runtime-helper 测试改用既有 runServiceWorkerInContext，注入真实验证器导出，不再把含 ESM import 的 Service Worker 作为普通脚本直接执行。修复前 CI 四文件扩展测试为 11 通过／15 失败，错误均为 Cannot use import statement outside a module；修复后在 Windows 的 Node.js 24.18.0 和 CI 同主版本 Node.js 22.23.2 上执行相同四文件命令均为 26/26 通过。WebCLI 全量 57 文件、321/321，以及两个测试文件语法检查、差异格式检查通过。未修改生产运行逻辑、捕获值隔离、依赖或 CI 配置，未跳过断言；Ubuntu 远端完整 CI 仍以新 PR 的实际结果为准，未执行真实站点端到端。

- 2026-09-21：修复生成链路测试基线的两处过期断言：列表 API 候选验证响应结构 hints 的生成／合并，并禁止持久化响应原文；Bridge 协议测试跟随已拆分的响应验证模块，同时检查实际调用连接。新增纯虚构响应的行为回归，覆盖首次保存及重复候选合并，确认字段结构保留、响应实值不进入站点记忆。本次只改测试与记录，不恢复 responsePreview 持久化、不修改运行逻辑或 CI 配置。基于最新 develop 的隔离分支在 Windows 执行 WebCLI 全量 57 文件、321/321，相关三文件聚焦测试 16/16，扩展探索协议／站点状态测试 12/12，测试文件语法检查及差异格式检查均通过。真实模型／浏览器端到端、其他平台及完整桌面端构建未执行；本记录不代表探索／生成链路已完成端到端验收。

- 2026-09-20：同步上游 develop，解决 WebCLI package scripts 的唯一文本冲突：保留上游 `test:e2e:real --profile public` 及本分支 API 测试／认证命令。自动合并 Windows 文件锁重试与持久化脱敏改动后，草稿工作区、Worker、Harness、发布基线、捕获值隔离和认证清单六文件测试 32/32，公共配置一致性检查通过。上游带入的四个生成文件存在 EOF 空行提示，未改写这些既有产物；计划工具遗漏等已知功能问题仍未修复。

- 2026-09-20：用户恢复目标页后，使用已重启的 Backend／Bridge 和已重载扩展重新完成真实探索：36 条请求筛出 3 个只读候选，3 次重放均为 HTTP 200、非空响应，模型分析无错误。保存后分别审计内存站点记忆、磁盘记录和生成上下文，未发现非空请求／响应 preview、responseSample 或 URL 查询实值，3 个候选均保留响应 hints。真实生成要求两个指定只读工具；确定性映射探针再次证明第三候选虽被计划选中，却未进入 scaffold 的两个打分槽位而被静默跳过。Agent 移除历史写骨架及未计划工具后，静态验证通过但缺少计划中的计数工具；补写新工具文件遭到 `draft file not found`，随后生成以 `AI_WORKER_TIMEOUT` 失败，未完成运行验证、未发布。草稿扫描未命中响应样本字段、绝对用户路径或签名查询参数值。结论：本轮新采集与持久化隔离检查通过，计划驱动生成和完整端到端验收仍不通过；需处理候选选择、计划／产物集合强校验与新增草稿文件能力，不能用静态绿灯替代功能完整性验收。

- 2026-09-20：按用户要求从当前工作区启动 Backend 与 Bridge（启动前对应端口均空闲），确认扩展重载后重新连接，被动探索／安全探测／重放／生成能力均已注册。通过真实站点记忆接口触发旧记录清理，并核对磁盘：4 个列表候选均保留响应 hints，请求／响应 preview 与 responseSample 非空字段为 0。新一轮目标页探索在采集阶段被浏览器错误页阻断（`Frame with ID 0 is showing error page`）；独立 HTTPS 探测返回证书链校验失败，未绕过校验，不能据此确定浏览器错误页的唯一原因。复核上次待发布草稿发现计划／产物不一致：计划中的一个只读计数工具缺失，产物包含未计划的列表工具；生成映射仅给打分进入两个 scaffold 槽位的候选改名，其余计划候选被静默跳过。上次静态与运行验证通过只证明实际生成工具通过验证，不代表计划完整实现。未发布草稿；新采集到生成的完整验收待页面恢复及工具集合一致性问题处理后继续。

- 2026-09-18：迁移后 WebCLI 捕获值隔离／scaffold 聚焦测试 30/30、Worker／模型聚焦测试 16/16、Backend 站点记忆／scaffold 19/19、扩展探索协议 9/9 通过；Backend `tsc --noEmit` 和相关 JavaScript 语法检查通过。generation 扩展回归先得到 106/107，一条测试仍期待公开快照暴露完整路径；调整为断言路径脱敏后，该文件 8/8 通过。新增行与新增测试的内部标识扫描未发现回迁，既有未跟踪文档保持原样。真实只读生成重试已越过模型配置失败，静态检查和浏览器运行验证均通过（3 个工具注册、2 个只读用例执行通过、登录检查跳过），finish_run 返回 ready，未发布。实测另观察到历史动作骨架被带入只读草稿，Agent 在静态验证拦截后移除；计划与最终工具集合一致性需继续核对。Backend 与扩展长期进程尚未重载，不能据此宣称持久化边界已完成新版本端到端验收。

- 敏感信息复扫未发现新的硬编码密钥、Token、内部域名或私网 IP；命中项均为变量名、脱敏测试样例或公开占位地址。
- WebCLI 聚焦测试通过（31 项），Backend 用户场景测试通过（5 项）。
- Backend TypeScript 类型检查通过，Renderer 与官网生产构建通过。
- Extension 公开范围测试通过（19 项），内部功能清理前遗留的运行时测试不作为公开门禁。
- Electron 集成测试通过（22 项），公开配置校验及校验器测试通过。
- Windows 本地全量测试基线：WebCLI 234/243、Backend 283/288 通过；剩余失败为 Windows 文件系统/符号链接差异、已变更的 PowerShell 平台文案和过期测试 mock，需在后续开发中修复或在 Ubuntu CI 复核。
- Git 差异格式检查通过。
- 官网清单 Overlay 单测与公开生产构建通过（2 个公开分组、3 个站点）。
- Backend Profile 聚焦测试、Adapter scaffold/用户场景测试、类型检查与公开 bundle 验证通过；公开 bundle 标记为 `public`。
- Extension manifest 跨域授权聚焦测试通过；公开 Profile 成功生成 4 个实际打包 Adapter。
- Windows 解密工具在隔离环境中成功生成 `sd_decrypt.exe`。
- `@emnapi/runtime` 固定版本迁移后，Backend TypeScript 生产构建通过，Git 差异格式检查通过。
- 上下文与记忆迁移后，Backend TypeScript 生产构建通过，Renderer 生产构建通过。
- 记忆、上下文压缩、上下文快照、Skill 连续性与 Windows 原生命令文案聚焦测试通过；Backend 全量测试为 414/421 通过，剩余 3 个失败为既有 mock/Windows 超时问题。
- 网站/API 探索与认证迁移后，WebCLI 聚焦测试 100/100、Backend 探索测试 44/44、Renderer 探索测试 15/15、Extension/认证 Skill/Electron/打包测试 38/38 通过。
- API Adapter 认证的 inventory、evidence 与 mock 门禁通过；公开 Profile 的结果为 0 个 Adapter、0 个工具，4 个证据测试文件全部通过。
- Backend TypeScript 类型检查、Renderer 生产构建、50 个相关 JavaScript 文件语法检查及认证 Skill 结构校验通过。

## 进行中

- 按“公共通用能力／内部专用能力／不迁移资产”清单逐模块迁移旧 `develop`，每批进入公开分支前执行人工敏感信息检查。

## 待办

- 继续在公开 Profile 与内部 Overlay 的实际 Adapter 上分别执行 live 认证，并仅在各自仓库存放对应的非敏感共享基线。
- 为公开发布配置新的下载地址、指标服务和发布流程。
- 在目标平台完成 Windows x64、macOS arm64 与 macOS x64 安装包验收。

## 约束

- 仓库不得包含真实密钥、Token、密码、账号、内部域名、私网 IP 或内部系统资料。
- 示例网络地址使用 `example.com`、`example.org`、`localhost` 或 `127.0.0.1`。
- 对外界面只使用“网站探索agent”，不暴露内部组件名称。
