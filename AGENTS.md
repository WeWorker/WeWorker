# WeWorker 项目规范

## 项目概览

WeWorker 是桌面端 AI 工作助手项目，包含 Electron 桌面端、TypeScript Backend、React Renderer、浏览器扩展、WebCLI、网站探索agent、官网与公开文档。

修改前先阅读本文件和 `ROADMAP.md`。本文件用于约束 AI agent 和开发人员的默认行为；如果任务要求与本文件冲突，以用户在当前任务中的明确要求为准。

示例、测试和文档必须使用公开占位信息，不得包含真实账号、密钥、Cookie、私有网络、非公开系统名称或真实会话数据。

## 模块地图

- `weworker/`：Electron 桌面端主体，包含主进程、Renderer、Backend、构建脚本和桌面端配置。
- `weworker/backend-ts/`：本地 TypeScript Backend，负责设置、模型调用、聊天流、任务执行、文件访问控制、Adapter 调用桥接、记忆与上下文能力。
- `weworker/renderer/`：React Renderer，负责桌面端用户界面和交互。
- `weworker/electron/`：Electron 主进程、窗口生命周期、IPC、资源路径和应用退出清理。
- `weworker/scripts/`：构建、打包、配置生成、校验和开发辅助脚本。
- `extension/`：浏览器扩展、页面注入、Bridge 和扩展权限配置。
- `adapters/`：仓库根目录的内置 Adapter v2 包（host-managed）定义与站点能力描述；新增或修改 Adapter 时必须同步构建 profile、权限、文档和对应验证。构建时由 `weworker/scripts/prepare-build.cjs` 打包为 host-managed 包，经 Bridge 下发，不随扩展内置。
- `webcli/`：WebCLI 命令入口与 Adapter 调用层；统一对外提供 `webcli call <adapter-id>.<tool-id>`。
- `components/webwright/`：网站探索agent实现源码目录。源码中可以沿用既有包名和路径，用户侧文案、UI、文档统一使用「网站探索agent」。
- `officialWeb/`：产品官网、文档站与下载页（Vite + React）。
- `docs/`：设计、构建、贡献、工作流和维护文档。
- `.github/`：Issue/PR 模板与公开自动化流程。

## 关键配置与依赖关系

- `weworker/build-profile.json` 是桌面端构建 profile 基线；新增 Provider、Adapter 打包范围或构建元数据时必须同步验证。
- `weworker/default-site.json` 独立控制首页站点默认顺序，应与本仓库内置 Adapter 清单同步；首页初始展示前五个可用站点，用户保存的顺序和数量优先。
- `extension/manifest.json` 是浏览器扩展 manifest 基线；新增权限、host 权限或扩展能力时必须确认不会引入私有域名、私网 IP 或过宽权限。
- 扩展内置的 `adapters/index.json` 与 `adapters/registry.json` 由 `weworker/scripts/prepare-build.cjs` 构建时生成（当前恒为空清单），不得手工维护或提交生成产物；新增、删除或重命名 Adapter 时只需更新 `adapters/<id>/manifest.json` 与 `weworker/build-profile.json` 的打包范围。
- `weworker/scripts/build-profile-overlay.cjs` 负责按 profile/overlay 生成构建配置；修改构建配置时必须验证生成结果和最终构建入口一致。
- 构建产物、本地配置、缓存、真实用户数据和运行时临时文件不得提交。
- 修改依赖时必须同步 lockfile，并说明新增依赖的用途。

## 开发约定

- 保持现有模块边界：UI 改动优先放在 Renderer；窗口、生命周期、资源路径和 IPC 放在 Electron；模型调用、文件访问、安全校验和 Adapter 桥接放在 Backend。
- `webcli/` 与 `extension/` 维持独立边界；除任务明确要求外，不改其协议和运行逻辑。
- WebCLI 统一对外提供 Adapter 概念与 `webcli call` 命令入口；Extension Adapter 通过 Bridge/Chrome 扩展执行，Toolkit Adapter 通过同一安装包内的 embedded Toolkit Runtime 执行，两类 Adapter 不共享底层 Runner。
- 开源与内部仓库保持通用架构、运行时和探索流程一致，差异限于 Adapter 内容与对应打包范围。通用改进不得引入内部业务信息或另建内部专用执行链路。
- 探索、生成和修复前核对已有 Adapter 的 runtime、execution、鉴权来源及真实页面依赖；需要浏览器登录态不等于需要打开业务页。保留已有后台 API 能力，禁止因生成、修复或同步将其退化为页面调用。声称无需业务页时，必须验证后台运行器和关闭任务自有业务页后的普通调用；不得为验收关闭用户已有页面。
- Node.js 代码使用现有 ESM/CommonJS 风格，不为一次性逻辑新增框架或大型依赖。
- 网站探索agent Python 环境由 `uv` 管理，不使用系统 `pip` 修改环境。
- 开发态从 `components/webwright/` 源码启动网站探索agent；正式构建只打包该目录提供的 embedded `onedir`。
- `8766` 被占用时不得终止、接管或复用未知进程。
- WeWorker 只能清理由本次 `webwrightManager` 启动的进程。
- Renderer 不得向主进程传入网站探索agent URL；只允许调用固定的 `openwebwright()` IPC 能力。
- macOS 关闭最后一个窗口不等于退出应用；网站探索agent继续运行到应用真正退出。
- Toolkit Skill 只使用 `webcli call <adapter-id>.<tool-id>`，不得生成或打包 `webcli-py`/`webcli-py.cmd`；WebCLI 不按业务 Schema 转换参数类型。
- 共享浏览器遵守 `docs/shared_browser_implementation_plan.md`：Bridge 唯一启动受管浏览器，Python 托管入口通过宿主 WebCLI 获取实例和占用，再以本机 CDP 连接；禁止连接失败时另起浏览器。Toolkit 普通调用不依赖探索服务，Extension 与 Toolkit 保持独立 Runner。Python 不读取浏览器 Profile 或宿主设置；旧探索 Profile 不迁移、不清理。

## 敏感信息约束

- 不得提交真实密码、Token、API Key、Cookie、个人账号、真实用户数据、真实会话数据、非公开系统名称、私有域名或私网 IP。
- 示例地址使用 `example.com`、`example.org`、`localhost` 或 `127.0.0.1`。
- 测试中的密钥、Token、账号必须使用明显占位值。
- 不在日志记录模型 Key、Token、密钥或用户数据路径。
- 敏感信息扫描不放入公开自动化流程；合并前在受控环境进行检查。
- 特殊情况：内置模型的真实api key允许写死进入代码，但不提供UI展示，该部分api key默认可服务端进行控制，与客户端完全隔离。

## 验证要求

- 脚本、Electron 主进程和 Backend 逻辑必须有聚焦自动化测试。
- Renderer 改动至少通过对应单测、`npm run build` 和语法检查。
- 生命周期改动至少验证启动、端口冲突、健康检查、正常停止、异常退出重启和应用退出清理。
- 构建 profile、manifest、Adapter 清单或 WebCLI 调用路径改动必须验证生成配置、打包入口和调用路径一致。
- 完成开发或文档工作后同步更新 `ROADMAP.md`；未验证事项不得写入“已完成”。

## 红线

- 网站探索agent持久数据固定写入 `~/.weworker/webwright/`；不得读取、迁移或清理旧 `~/.webwright`。
- 网站探索agent除持久数据根外，只允许按 Electron 注入的 `weworker_USER_FILES_DIR` 读写 `<user_directory>/.claude/skills/`；embedded 模式可通过独立临时 token 调用固定 loopback 接口读取当前模型配置快照，但不得读取设置文件、数据库或修改其他 WeWorker 数据。
- 修改 CI/CD、发布、数据库 schema、`.env`、密钥、删除文件和 Git 回滚前必须获得用户单独确认。
- UI、公开文档和用户可见文案中，严禁出现「webwright」文案，统一使用「网站探索agent」。
