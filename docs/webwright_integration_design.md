# Webwright embedded 集成设计

## 状态

- 版本：`2.3`
- 日期：2026-08-06
- 状态：WeWorker 侧 embedded Server、标准 Skill Runtime、macOS arm64 真实 Toolkit、Toolkit 磁盘直装与共享模型配置代码基线已完成；真实厂商请求、新安装包真实按钮闭环及跨平台验收待完成
- 组件设计：[`../components/webwright/docs/weworker_embedded_integration_design.md`](../components/webwright/docs/weworker_embedded_integration_design.md)
- Skill Runtime 设计：[`skill_runtime_design.md`](skill_runtime_design.md)
- 共享模型配置设计：[`shared_model_configuration_design.md`](shared_model_configuration_design.md)
- 进度源：[`../ROADMAP.md`](../ROADMAP.md)

## 目标与边界

WeWorker 将 Webwright 作为内置伴生服务和标准 Skill 的 Python/Playwright runtime 交付。应用启动后自动在 `127.0.0.1:8766` 启动 Webwright；“打开 Webwright”入口只用系统默认浏览器打开固定地址。退出和安装更新前，WeWorker 等待自己启动的 Webwright Server 进程结束。`full` 模式下，网站探索导出的 Toolkit Adapter Skill 通过 `webcli call` 统一入口调用同一 embedded runtime 的 `--internal-script`，不依赖 Server 是否运行。完整合同见 [`webcli_toolkit_adapter_design.md`](webcli_toolkit_adapter_design.md)。

本次不合并 Backend API、不增加反向代理或 iframe、不修改 WebCLI Bridge 和 extension adapters。Webwright 不再作为独立产品使用，持久数据统一进入 WeWorker 数据根目录下的独立命名空间 `~/.weworker/webwright/`。Toolkit 安装由 Webwright 在复核既有 export 资格后直接原子覆盖项目级 Skill 目录，不改变 Tool 发布与 formal Debug 规则。标准 Skill 权限、包装器和 Toolkit 运行合同以 `skill_runtime_design.md` 为准。

## 源码与构建

- `components/webwright` 是 WeWorker 主仓库直接管理的内部源码目录，不再作为独立仓库或 Git submodule 迭代。
- 开发态由 Electron 通过 `uv run --project components/webwright webwright-server` 从源码启动。
- 发布态由 `weworker/scripts/build-webwright.cjs` 调用 Webwright embedded builder，输出到 `weworker/build/webwright-dist/dist/Webwright/`。
- Webwright 按普通内部模块参与当前工作区构建，不要求组件目录或仓库处于 clean 状态，也不维护独立 commit／dirty 身份。
- 正式构建必须校验 runtime manifest、入口、平台和架构。
- Electron `extraResources` 只将当前构建生成的 `Webwright/` 放入安装包资源目录 `webwright/`。
- Webwright `onedir` 必须包含 `THIRD_PARTY_NOTICES.txt` 和 `licenses/`。构建从锁定环境提取实际冻结组件的准确版本、许可证和 NOTICE；Webwright MIT、CPython PSF、Playwright Apache 2.0／NOTICE、PyInstaller Bootloader Exception 及 certifi MPL 2.0／准确版本源码获取说明缺失时直接失败。

## 生命周期

`WebwrightManager` 使用以下状态：

| 状态 | 含义 |
|---|---|
| `stopped` | 尚未启动或已正常停止 |
| `starting` | 已创建子进程，等待 health |
| `running` | health 与预期身份一致 |
| `error` | 启动、health 或进程运行失败 |
| `port_in_use` | 启动前发现 `8766` 已被占用 |
| `version_mismatch` | 发布态 manifest 与 health 身份不一致 |

启动约束：

- 使用 `spawn` 且 `shell: false`。
- stdin 必须为 pipe，并传入 `--exit-on-stdin-close`。
- 统一传入 `--host 127.0.0.1 --port 8766 --parent-pid <Electron PID>`。
- health 等待不阻塞主窗口创建。
- 意外退出采用有限退避重启；停止期间不得重启。

停止约束：

- 正常停止先关闭 stdin，等待 Webwright 自身 shutdown。
- 超时后只终止当前 Manager 持有的子进程，不按端口清理未知进程。
- 应用退出和安装更新前均等待 `WebwrightManager.stop()`。
- Electron 异常消失由 Webwright 的父 PID watchdog 兜底。

## IPC 与界面

- `get-status` 增加 `webwright` 字段。
- preload 只暴露无参数 `openWebwright()`。
- IPC handler 内固定调用 `shell.openExternal('http://127.0.0.1:8766')`。
- Renderer 根据状态显示“Webwright 启动中”“打开 Webwright”“Webwright 启动失败”“端口 8766 被占用”或“Webwright 版本不匹配”。
- 点击入口不会启动、重启、初始化或构建 Webwright。
- embedded Webwright 收到合法 `WEWORKER_USER_FILES_DIR` 时显示「安装到 WeWorker」；只有当前 Toolkit `export_eligible=true` 时启用。
- 浏览器只调用 `8766` 同源安装接口，不能传入或读取安装目录。

## Toolkit 磁盘直装

- Electron 将当前配置的绝对 `user_directory` 作为 `WEWORKER_USER_FILES_DIR` 只注入自己启动的 Webwright。
- Webwright 将安装目标固定解析为 `<user_directory>/.claude/skills/<skill-name>/`，浏览器请求不得提供路径。
- 安装路由复核 `export_eligible`，并只复制 Webwright 当前正式 Skill 的四个固定文件，不下载或解压 ZIP。
- 同名 Skill 无条件整体覆盖，不判断来源、不维护索引；写入使用同一文件系统内 staging、旧目录临时改名和失败回滚，成功后删除临时备份。
- 缺少或非法 `WEWORKER_USER_FILES_DIR` 时 capability 为 false、安装路由不注册；安装失败不阻断 Webwright 或 WeWorker。

## 数据与安全

- embedded 程序随 WeWorker 更新和卸载。
- Webwright 持久数据固定保存在 `~/.weworker/webwright/`，内部目录使用 `tasks/`、`toolkits/`、`browser/profile/`、`toolkit-state/` 和 `logs/`；Webwright 不再持久化模型配置。
- Electron 计算该绝对路径，并通过 `WEBWRIGHT_HOME` 同时注入网站探索服务和 Backend；Claude Code、WebCLI Toolkit Runner 及其内部 Runtime 继承 Backend 的同一环境，禁止任一入口回落到旧目录。
- Webwright 持久状态只写 `~/.weworker/webwright/`；额外只允许为安装 Toolkit 写入 Electron 指定的 `<user_directory>/.claude/skills/`，不得读取或修改 WeWorker 的 `works.db`、`settings.json`、`claude-config/` 等其他数据。
- 旧 `~/.webwright` 不探测、不迁移、不兼容回退，也不删除。
- WeWorker 更新和默认卸载保留整个 `~/.weworker/`；未来若提供“重置 Webwright”，只能以 `~/.weworker/webwright/` 为独立且明确的破坏性目标。
- Webwright 只作为 WeWorker embedded 组件运行，通过独立临时 token 从固定 loopback 内部接口读取 WeWorker 当前模型配置快照；不提供独立模型配置 UI／API，不读取或迁移历史 `models.json`，也不把 Key 写入 Task、日志或浏览器响应。完整合同见 `shared_model_configuration_design.md`。
- Webwright 自身负责 loopback、Host 和 Origin 安全边界。
- `full` 模式的 Claude Code 原生 Bash 不受用户目录白名单、黑名单或绝对路径限制；该权限合同只适用于 `full`，详见 Skill Runtime 设计。

## macOS 内测分发

- 在接入 Apple Developer Program 之前，macOS 安装包使用完整 ad-hoc 签名，目标是让应用 bundle 的代码完整性校验通过，不提供开发者身份信任。
- 当前 electron-builder `24.13.3` 不支持以 `mac.identity: "-"` 触发 ad-hoc 签名；构建配置固定跳过证书自动发现，并通过 `afterPack` hook 在 `.app` 生成后、DMG／ZIP 生成前调用系统 `codesign --sign -`。同时关闭 hardened runtime，避免 ad-hoc Team ID 与 Electron 预签名 Framework 冲突。
- ad-hoc 签名不替代 Developer ID 和 Apple notarization。从浏览器下载后，Gatekeeper 仍应拦截，用户需要在“隐私与安全性”中手动选择“仍要打开”；不同 macOS 版本的提示文案不作为稳定合同。
- DMG／ZIP 必须在 `.app` 完成签名后生成，禁止通过删除 quarantine 或全局关闭 Gatekeeper 作为分发方案。
- macOS CI 必须对最终 `.app` 执行 `codesign --verify --deep --strict`，并确认签名为 ad-hoc、没有 Apple Team ID。

## 验证

- 组件目录缺失时构建失败，存在未提交修改时仍构建当前工作区源码。
- runtime manifest 的版本、平台、架构和入口。
- runtime 中的第三方 notices、许可证全文、NOTICE 和 MPL 源码获取说明。
- 开发态自动启动、health、状态读取和固定浏览器入口。
- `8766` 占用时不创建子进程、不终止占用者。
- 正常退出关闭 stdin并释放端口。
- Webwright 意外退出后的有限重启及应用退出时取消重启。
- Renderer 状态文案和禁用逻辑。
- macOS 最终 `.app` 的完整 ad-hoc 签名和无 Team ID 身份。
- WebCLI Toolkit Runner 对 `--internal-script` 的参数、cwd、stdio、环境、退出码和终止信号转发。
- 最终安装包中的标准 Skill 发现及真实 Webwright Toolkit 执行。
- embedded capability、token 隔离、中转鉴权、export ZIP 校验、首次安装、幂等更新和冲突保护。
- Renderer 构建、Node 自动化测试和 `git diff --check`。

## CI/CD

发布 workflow 使用三个原生构建目标：

| 目标 | GitHub-hosted runner | Electron／Webwright 架构 |
|---|---|---|
| Windows x64 | `windows-latest` | `x64` |
| macOS arm64 | `macos-15` | `arm64` |
| macOS x64 | `macos-15-intel` | `x64` |

构建约束：

- checkout 一次取得 WeWorker 与 `components/webwright` 全部源码，不配置额外 PAT 或仓库 secret。
- `uv` 使用官方 `astral-sh/setup-uv` action，固定 action commit 和 uv 版本；各 job 原生安装 CPython 3.14.6。
- 每个 job 执行 Webwright 集成测试后，再从当前 checkout 直接执行对应平台正式构建。
- macOS 两个架构分别上传构建产物；release job 将两份 `latest-mac.yml` 合并为一个包含 arm64／x64 文件的元数据。`electron-updater` 根据文件 URL 中的当前 `process.arch` 选择对应 ZIP。
- 任一架构构建、manifest 校验或元数据合并失败，release job 不得创建或更新 `latest` release。
- release job 只使用 `GITHUB_TOKEN` 的 `contents: write` 更新 `latest` tag 与 prerelease；构建 job 权限保持 `contents: read`。

## 待验证与后续范围

- GitHub Actions 首次云端执行。
- Windows x64、macOS x64 实机验证。
- 实现并验收 `full` 原生命令、标准 Skill 发现与 `webcli call` 统一 Adapter 入口复用 embedded Runtime。
- 面向普通用户公开发布所需的 Developer ID 签名、Apple notarization 和自动更新规则变更。

## 共享浏览器合同补充（2026-10-27）

以 [共享浏览器实施方案](shared_browser_implementation_plan.md) 为本次浏览器资源与生命周期的实施基线。Bridge 唯一启动 WeWorker 浏览器，保留 CDP Pipe 并提供本机动态 CDP WebSocket；探索、调试、回放与独立 Toolkit Runtime 获取实例和占用后直连。托管模式禁止 Python 自行拉起另一浏览器；只读状态查询不启动浏览器。两类 Adapter 保持独立 Runner。

「我自己的 Chrome」模式保留 Extension 能力，需要 CDP 的调用提示切换模式。共用现有 WeWorker Profile，旧探索 Profile 保留且不迁移；任务结束仅释放自身资源，应用退出先停止任务，再清理自身拥有的 Bridge／浏览器。Python 通过宿主注入的内部 WebCLI 控制通道获取地址，不读取浏览器 Profile 或宿主设置。
