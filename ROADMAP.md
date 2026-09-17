# WeWorker Roadmap

## 当前阶段

WeWorker 已完成公开仓库初始化，当前在全新的 `develop` 基线上按模块迁移旧开发分支中未进入 `main` 的通用能力。迁移不引入旧 Git 历史，且保持现有 Profile/Overlay 配置架构不变。

## 已完成

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
