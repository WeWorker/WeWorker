# Webwright 集成进 WeWorker 设计方案

> 当前 Toolkit Adapter 调用合同已更新为 `webcli call` → embedded runtime `--internal-script`，不再提供 `webcli-py` wrapper。完整设计见 [`../../../docs/webcli_toolkit_adapter_design.md`](../../../docs/webcli_toolkit_adapter_design.md)；本文后续冲突的旧 wrapper 描述只保留历史背景。

## 文档状态

- 当前版本：`1.9`
- 更新时间：2026-08-06
- 状态：Webwright 侧 embedded 构建、运行身份、生命周期、本地 HTTP 安全边界、WeWorker Toolkit 运行合同、磁盘直装与共享模型配置自动化验收已完成；真实厂商请求、新安装包真实按钮闭环及跨平台验收待完成
- Webwright 源码：WeWorker 主仓库内的 `components/webwright/`
- WeWorker 仓库：`git@github.com:WeWorker/WeWorker.git`
- 适用范围：Python harness 的 `local_browser + local_cdp` 模式
- 关联设计：[`full_distribution_existing_design_changes.md`](full_distribution_existing_design_changes.md)、[`local_cdp_http_server_design.md`](local_cdp_http_server_design.md)、[`../../../docs/skill_runtime_design.md`](../../../docs/skill_runtime_design.md)
- 关联 Roadmap：[`../ROADMAP.md`](../ROADMAP.md)

## 一、目标

Webwright 作为 WeWorker 的内置伴生能力交付。用户只安装、启动、更新和卸载 WeWorker，不单独管理 Webwright：

```text
安装 WeWorker
→ 启动 WeWorker
→ Webwright 自动监听 127.0.0.1:8766
→ 用户访问 http://127.0.0.1:8766
→ 退出 WeWorker 后 Webwright 停止
→ 更新 WeWorker 后 embedded Webwright 同步更新
→ 卸载 WeWorker 后 embedded Webwright 程序一并删除
```

Webwright 由 WeWorker 主仓库直接管理，不再作为独立仓库或 Git submodule 迭代。开发态从 `components/webwright/` 源码运行，发布态构建 PyInstaller `onedir` 并由 Electron `extraResources` 打入 WeWorker 安装包。

### 1.1 范围变更

自 2026-08-04 起，Webwright 不再作为独立产品部署。本文中既有 standalone／完整独立分发章节仅保留历史背景，不再作为当前产品合同。当前唯一运行形态是 WeWorker 启动的 embedded Webwright；模型配置只来自 WeWorker 的受鉴权运行时快照，不提供独立模型 UI／API，不读取或迁移历史 `models.json`。快照同时声明协议和 `model_class`：Anthropic 使用 `anthropic`，智谱 coding plan 使用现有 `zhipu` Adapter 和 Coding Plan Base URL，DeepSeek 与自定义模型使用通用 `openai_chat` Adapter。

## 二、非目标

- 不把 Webwright Python 代码改写成 TypeScript。
- 不把 Webwright API 合并进 WeWorker Backend。
- 不使用 `/webwright` 子路由或反向代理。
- 不把 Webwright UI iframe 内嵌到 WeWorker。
- 不提供 Webwright 独立桌面图标、启动项、安装器或更新器。
- 不允许 embedded Webwright 独立于 WeWorker 自行升级。
- 不修改 Toolkit、Tool、Exploration、Development、Debug 和 Publish 的产品规则。
- 不提供 `webcli-py` Runtime 或包装器；WeWorker 内置 WebCLI 的 Toolkit Runner 直接调用 embedded runtime 既有 `--internal-script` 入口。
- 不处理 Browserbase、`local_launch`、`local_persistent` 或 Linux。
- 不探测、迁移或删除旧 `~/.webwright`。

## 三、核心决策

### 3.1 Webwright 是 WeWorker 普通内部模块

WeWorker 目录结构：

```text
WeWorker/
├── components/
│   └── webwright/                 # 主仓库直接管理的内部源码
├── weworker/
│   ├── electron/
│   ├── renderer/
│   ├── scripts/
│   └── build/
└── .github/workflows/
```

约束：

- `components/webwright/` 与其他 WeWorker 源码一样由主仓库直接管理。
- Webwright 不再维护独立仓库、gitlink、submodule 状态或组件级 commit 身份。
- Webwright 负责“如何构建可运行的 embedded runtime”。
- WeWorker 负责“何时构建、如何打包以及如何管理运行生命周期”。
- Webwright 的 PyInstaller 资源列表、隐藏模块和冻结入口继续在组件目录维护。

### 3.2 构建当前工作区源码

`build:webwright` 直接构建 `components/webwright/` 当前工作区源码。未提交修改属于正常开发输入，不阻止构建，也不在 embedded runtime manifest 中记录组件级 commit 或 dirty 状态。runtime 只校验版本、平台、架构、模式和入口；WeWorker 整体版本与构建 commit 由顶层应用统一提供。

### 3.3 运行时使用独立端口

```text
WeWorker Backend：127.0.0.1:8765
Webwright Server：127.0.0.1:8766
```

Webwright 继续使用现有根路径 `/ui`、`/web/*` 和 `/api/*`，不增加 base path，也不经过 WeWorker Backend 代理。

端口约束：

- Webwright 只绑定 `127.0.0.1`，不得绑定 `0.0.0.0`。
- WeWorker 启动 Webwright 前检查 `8766` 是否已被占用。
- 端口被占用时不得杀死、接管或复用未知进程。
- 端口冲突只使 Webwright 状态进入 `port_in_use`，不得阻止 WeWorker 其他功能启动。

### 3.4 入口只打开浏览器

WeWorker 启动时自动启动 Webwright，不等待用户点击入口。

WeWorker 内的入口名称为“打开 Webwright”，唯一行为是通过 Electron 主进程调用系统默认浏览器打开：

```text
http://127.0.0.1:8766
```

入口不得启动、重启、初始化或构建 Webwright，不调用 Webwright 业务 API。Renderer 不得向主进程传入任意 URL；preload 只暴露固定的 `openWebwright()` 能力，主进程 IPC handler 内固定目标地址。

Webwright 状态只影响入口展示：

| 状态 | 入口表现 |
|---|---|
| `starting` | 显示“Webwright 启动中”，暂不可点击 |
| `running` | 显示“打开 Webwright” |
| `error` | 显示“Webwright 启动失败” |
| `port_in_use` | 显示“端口 8766 被占用” |
| `version_mismatch` | 显示“Webwright 版本不匹配” |
| `stopped` | 退出过程中不可用 |

“重新启动 Webwright”和“查看日志”如需提供，必须作为独立故障操作，不得绑定到“打开 Webwright”入口。

### 3.5 程序与数据分离

程序本体由 WeWorker 安装器管理：

```text
macOS：WeWorker.app/Contents/Resources/webwright/
Windows：WeWorker/resources/webwright/
```

用户数据统一进入 WeWorker 数据根目录下的 Webwright 命名空间：

```text
~/.weworker/webwright/
```

规则：

- Electron 将绝对路径 `~/.weworker/webwright/` 作为 `WEBWRIGHT_HOME` 同时注入网站探索服务和 Backend，Backend 启动的 Claude Code、WebCLI Toolkit Runner 和内部 Runtime 继承同一路径。
- Webwright 只拥有该子目录，不读取或修改 `~/.weworker/` 下的 WeWorker 数据。
- WeWorker 更新只替换 embedded runtime，不覆盖 `~/.weworker/webwright/`。
- WeWorker 卸载删除 embedded runtime，默认保留整个 `~/.weworker/`。
- 如未来提供“同时删除 Webwright 用户数据”，必须是独立、明确的破坏性选项。
- embedded Webwright 继续遵守 `WEBWRIGHT_HOME` 必须是绝对路径的现有合同。
- 不提供旧 `~/.webwright` 的探测、迁移、兼容回退或软链接。

### 3.6 macOS 关闭窗口不等于退出应用

保持 WeWorker 现有 macOS 生命周期：

- 关闭最后一个窗口后应用仍在后台，Webwright 继续运行。
- 使用 `Cmd+Q` 或菜单“退出 WeWorker”后，Webwright 停止。

本次不将“关闭窗口”改为“退出应用”。

## 四、构建职责

### 4.1 Webwright 负责 embedded runtime

现有 `distribution/scripts/build.py` 增加显式构建模式：

```text
--mode standalone
--mode embedded
```

`standalone` 保持现有默认行为：

- macOS：`onedir` → `.app` → DMG。
- Windows：`onedir` → Inno Setup 安装器。

`embedded` 行为：

- 继续使用 PyInstaller `onedir`。
- 继续使用 `webwright.run.bootstrap` 入口。
- 继续收集 YAML、Web UI、canonical `toolkit_runtime.py`、Playwright driver、模型、环境和 Agent 模块。
- macOS 不生成独立 `.app` 或 DMG。
- Windows 不调用 Inno Setup。
- 不生成桌面入口、启动项或更新器。
- 不包含 `.env`、模型配置、Task、Toolkit、浏览器 Profile 或其他用户数据。

建议调用：

```bash
uv run \
  --project components/webwright/distribution \
  python components/webwright/distribution/scripts/build.py \
  --mode embedded \
  --output-root weworker/build/webwright-dist
```

建议产物：

```text
weworker/build/webwright-dist/
└── Webwright/
    ├── Webwright                  # Windows 为 Webwright.exe
    ├── _internal/
    ├── LICENSE.webwright
    └── webwright-runtime.json
```

Manifest 至少包含：

```json
{
  "webwright_version": "0.1.0",
  "platform": "darwin",
  "arch": "arm64",
  "mode": "embedded",
  "entrypoint": "Webwright"
}
```

构建结束必须验证 manifest、可执行文件 `--help`、内置 UI 资源、一个内部 Worker 参数错误路径和 `/api/health`。

### 4.2 WeWorker 负责构建编排

WeWorker 新增：

```text
weworker/scripts/ensure-webwright.cjs
weworker/scripts/build-webwright.cjs
```

`ensure-webwright.cjs`：

1. 检查 `components/webwright/pyproject.toml`。
2. 组件目录缺失时输出真实原因并失败。
3. 不检查 Git 状态，不覆盖本地修改。

`build-webwright.cjs`：

1. 检查组件源码目录。
2. 调用 Webwright embedded builder。
3. 将输出固定到 `weworker/build/webwright-dist/`。
4. 校验 manifest 的版本、入口、平台、架构和模式。
5. 失败时阻止 electron-builder 继续执行。

`weworker/build/webwright-dist/` 是临时构建目录，必须加入 `.gitignore`，不得提交二进制产物。

## 五、开发态

开发态不运行 PyInstaller，直接使用组件源码：

```bash
uv run \
  --project components/webwright \
  webwright-server \
  --host 127.0.0.1 \
  --port 8766
```

开发者标准流程：

```bash
git clone <weworker-repository>
cd WeWorker/weworker
npm run install:all
npm run dev
```

源码检查约束：

- `npm run install:all` 必须先执行 `ensure:webwright`，再执行 Webwright `uv sync`。
- `npm run dev` 必须先确认组件目录存在。
- Webwright 由 Electron 主进程自动启动，开发者不手工运行 Server。
- 组件目录缺失时不得静默降级为“无 Webwright 模式”。

## 六、运行生命周期

### 6.1 WeWorker WebwrightManager

WeWorker Electron 主进程新增独立 `WebwrightManager`，不复用 NodeManager。

开发态命令：

```text
uv run --project <components/webwright> webwright-server --host 127.0.0.1 --port 8766
```

发布态入口：

```text
macOS：<resourcesPath>/webwright/Webwright
Windows：<resourcesPath>/webwright/Webwright.exe
```

统一参数：

```text
--host 127.0.0.1
--port 8766
--parent-pid <Electron PID>
--exit-on-stdin-close
```

Manager 职责：

- 启动前检测端口。
- 通过 `spawn` 启动，不使用 shell。
- stdout／stderr 汇入 WeWorker 日志并增加 `[webwright]` 前缀。
- 轮询 `/api/health`，更新 `starting`／`running`／`error` 状态。
- 发布态校验 health 与 runtime manifest 的版本、平台、架构和模式。
- 异常退出时有限退避重启。
- 正常退出时等待子进程实际结束。
- 只清理由本次 Manager 启动的进程。
- 正常停止时关闭 Webwright 子进程 stdin，由 Webwright 在 macOS／Windows 统一执行优雅 shutdown；不得依赖 Windows 将 `SIGTERM` 转发给 Python。

Webwright 启动由 `app.whenReady()` 自动触发，但健康检查不应长时间阻塞 WeWorker 主窗口创建。

### 6.2 正常退出和更新

以下流程都必须等待 Webwright 停止：

```text
WeWorker before-quit
→ WebwrightManager.stop()
→ NodeManager.stop()
→ BridgeManager.stop()
→ app.exit()
```

```text
WeWorker beforeInstall
→ WebwrightManager.stop()
→ NodeManager.stop()
→ BridgeManager.stop()
→ 安装更新
```

### 6.3 Webwright 自身关闭合同

只终止 Flask 主进程不足以保证 Worker 不残留。Webwright 必须建立统一 shutdown：

1. 接收 `SIGTERM` 后停止接受新运行。
2. 通知 ProcessManager 取消当前活动运行。
3. 等待 Exploration、Replay、Development 和 Debug Worker 退出。
4. 超时后只终止自己启动的 Worker。
5. 停止 HTTP Server并释放 `8766`。

新增 `--parent-pid`：Webwright 监控 Electron 父进程；父进程消失时执行同一 shutdown，防止 Electron 崩溃或被强制结束后留下 Webwright 和 Worker。

新增 `--exit-on-stdin-close`：WeWorker 以 pipe 方式持有 Webwright stdin，正常退出或更新前主动关闭该 pipe，Webwright 收到 EOF 后执行同一 shutdown。stdin 负责正常跨平台停止，父 PID watchdog 负责父进程异常消失，两者职责不互相替代。

浏览器进程处理：

- 不关闭用户原本启动的 Chrome／Edge。
- 只关闭能够确认由 Webwright 启动的专用 Agent Browser。
- 无法确认所有权时不强制清理。

## 七、安全边界

Webwright API 能操作本地浏览器、执行代码路径并读取包含原始 API Key 的模型详情。直接开放 `8766` 至少要求：

- 只绑定 `127.0.0.1`。
- Host 只允许 `127.0.0.1:8766` 和 `localhost:8766`。
- 拒绝非本地 Origin 的 API 请求。
- 不配置宽泛 CORS。
- 日志不得记录模型 Key。
- `/api/health` 只返回版本、平台、架构、运行模式和必要状态，不返回敏感配置或用户路径。

以上防护降低恶意网页跨站调用本地 API 的风险，但不防御本机恶意进程。本次不引入会破坏直接浏览器访问的外部登录系统。

## 八、跨平台构建

目标矩阵：

| WeWorker 产物 | Webwright runtime |
|---|---|
| macOS arm64 | macOS arm64 |
| macOS x64 | macOS x64 |
| Windows x64 | Windows x64 |

规则：

- 每个平台和架构原生构建 Webwright，不交叉构建。
- 不得将一份 macOS arm64 runtime 同时打入 arm64 和 x64 WeWorker。
- WeWorker Electron `extraResources` 只收集本次架构对应的 `Webwright/` 目录。
- WeWorker 发布流程在 Webwright 构建或校验失败时整体失败，不发布缺少 Webwright 的安装包。

当前已知基线：

- Webwright macOS arm64 standalone 冻结与基础启动已验证。
- Webwright macOS x64 尚未验证。
- Webwright Windows x64 构建脚本已接通，但未完成实机构建和完整业务链验收。
- Webwright distribution 固定 CPython 3.14.6、Playwright 1.60.0 和 PyInstaller 6.21.0。
- WeWorker 当前 Windows workflow 使用 Python 3.12，需要调整。
- WeWorker 当前 macOS workflow 在单个任务中构建双架构，需要拆分为架构匹配的原生构建。

## 九、改动范围

### 9.1 Webwright 仓库

预计涉及：

| 文件／目录 | 改动 |
|---|---|
| `distribution/AGENTS.md` | 增加 embedded 分发规范 |
| `distribution/scripts/build.py` | 增加 embedded 模式 |
| `distribution/tests/` | 增加 embedded 构建合同测试 |
| `src/webwright/run/server.py` | 增加父 PID 和关闭参数 |
| `src/webwright/run/bootstrap.py` | 接入冻结入口生命周期 |
| `src/webwright/server/app.py` | health、Host／Origin 和关闭状态 |
| `src/webwright/server/process_manager.py` | 全局 shutdown |
| 新增 lifecycle/watchdog 模块 | SIGTERM 与父进程监控 |
| `tests/unit/` | 生命周期和安全回归 |
| `ROADMAP.md` | 同步真实进度 |

明确不改：

- Toolkit／Tool 产品模型。
- Exploration／Development／Debug／Publish 业务规则。
- Webwright 前端根路径。
- 已废弃的独立 `installer/`；不得恢复第二套 Python／Playwright Runtime。
- `skills/webwright/`。

### 9.2 WeWorker 仓库

预计涉及：

| 文件／目录 | 改动 |
|---|---|
| `AGENTS.md`、`ROADMAP.md` | 建立规范与进度源 |
| `docs/webwright_integration_design.md` | WeWorker 侧集成设计 |
| `components/webwright` | 主仓库直接管理的内部源码 |
| `weworker/scripts/ensure-webwright.cjs` | 组件目录检查 |
| `weworker/scripts/build-webwright.cjs` | embedded 构建编排 |
| `weworker/package.json` | scripts 与 `extraResources` |
| `weworker/electron/managers.js` | WebwrightManager |
| `weworker/electron/main.js` | 自动启动、退出和更新 |
| `weworker/electron/ipc-handlers.js` | 状态和固定打开入口 |
| `weworker/electron/preload.js` | 固定 IPC 能力 |
| `weworker/renderer/src/` | 入口与状态展示 |
| `weworker/.gitignore` | 忽略 runtime 产物 |
| `.github/workflows/release-latest.yml` | uv 和架构矩阵 |
| README | clone、开发与构建说明 |

明确不改：

- WeWorker Backend 的 `8765` API 路由。
- WebCLI Bridge 协议。
- extension 适配器。
- WeWorker 对话、调度和通知业务。

## 十、影响面评估

| 维度 | 等级 | 评估 |
|---|---|---|
| 产品行为 | 中 | 新增自动启动的本地服务和浏览器入口，其他 WeWorker 功能保持独立 |
| Webwright 业务逻辑 | 低 | 不改业务规则，主要变化在分发和进程生命周期 |
| Webwright 生命周期 | 高 | 必须解决 Server、Worker 和父进程异常退出后的清理 |
| WeWorker Electron 主进程 | 高 | 新增长生命周期原生子进程，影响启动、退出和更新 |
| 开发体验 | 中 | 增加 uv 环境，由脚本检查并自动启动组件 |
| CI／发布 | 高 | 新增 Python 构建和三架构原生产物 |
| 安装包体积 | 高 | 当前 macOS arm64 standalone 中间 `.app` 约 166 MB，DMG 约 69 MB；embedded 实际增量待构建确认 |
| 启动时间／内存 | 中 | 新增 Python Server 常驻和任务 Worker，需实测空闲与任务负载 |
| 安全 | 中高 | `8766` 提供高权限本地 API，必须补 Host／Origin 防护 |
| 用户数据 | 低至中 | 路径不变、无 schema 变更；升级兼容仍需按版本验证 |
| 回滚 | 中 | 回滚 WeWorker 会同时回滚 Webwright runtime，但不得损坏较新格式的用户数据 |

## 十一、主要风险与处理

| 风险                         | 处理                                           |
| -------------------------- | -------------------------------------------- |
| 组件源码目录缺失                    | `ensure-webwright.cjs` 明确失败                   |
| 构建打入错误平台或架构               | runtime manifest 与当前构建目标校验                |
| `8766` 被占用                 | 明确进入 `port_in_use`，不杀未知进程                    |
| Electron 退出后 Webwright 残留  | 正常 stop＋父 PID watchdog                       |
| Webwright 主进程退出后 Worker 残留 | ProcessManager 全局 shutdown                   |
| 更新时 runtime 文件被占用          | beforeInstall 等待 Webwright 完整停止              |
| macOS 架构不匹配                | arm64／x64 分别原生构建并校验 manifest                 |
| 安装包明显变大                    | 接受首版体积增长，后续基于构建分析做精准裁剪                       |
| 本地 API 被恶意网页调用             | loopback、Host、Origin 和 CORS 边界               |
| 新版 Webwright 不兼容旧数据        | 每次升级执行旧版本数据兼容验收                              |

## 十二、验证方案

### 12.1 Webwright 自动化验证

- 根项目完整测试。
- `distribution/tests/`。
- embedded `onedir` 构建合同。
- `--help`。
- 内部 Worker 参数错误路径。
- 包内 Web UI、YAML、Playwright driver 和 canonical Runtime。
- `/api/health` 的版本、平台、架构和模式。
- Host／Origin 拦截。
- SIGTERM 退出。
- 父进程消失后退出。
- 活动 Worker 清理。
- 退出后 `8766` 释放。
- `compileall`、前端 `node --check` 和 `git diff --check`。

### 12.2 WeWorker 开发态验证

- 组件目录缺失时，`npm run dev` 明确失败。
- 组件存在本地修改时，开发和构建命令直接使用当前工作区源码。
- Webwright 自动启动，入口不触发启动。
- 点击入口只在默认浏览器打开 `http://127.0.0.1:8766`。
- Webwright 启动失败不阻止 WeWorker 其他功能，并能查看真实日志。
- `8766` 被占用时不杀未知进程。
- 退出 WeWorker 后 `8766` 释放。
- 强制终止 Electron 后 Webwright 自行退出。

### 12.3 安装、升级和卸载验证

macOS arm64、macOS x64、Windows x64 分别验证：

1. 安装后不依赖系统 Python、uv 或 Playwright。
2. 启动 WeWorker 后 Webwright 自动启动。
3. Webwright UI 和 API 正常。
4. 至少完成一条真实 `local_browser + local_cdp` 完整业务链。
5. 退出 WeWorker 后 Server 和 Worker 均停止。
6. 从旧 WeWorker 升级后 runtime 版本随应用更新。
7. 升级后 `~/.weworker/webwright` 数据保留并可继续使用。
8. 卸载后 embedded runtime 删除且 `8766` 不可访问。
9. 默认卸载不删除 `~/.weworker`。

## 十三、验收标准

只有以下条件全部满足，集成才能标记完成：

- Webwright 源码由 WeWorker 主仓库直接管理并随应用版本交付。
- 标准开发命令在组件目录缺失时明确失败。
- WeWorker 启动后 Webwright 自动启动，不依赖入口点击。
- “打开 Webwright”只调用默认浏览器打开固定地址。
- Webwright 正常监听 `127.0.0.1:8766`。
- WeWorker 正常退出和异常退出后 Webwright 均不残留。
- 活动 Worker 不残留，`8766` 能释放。
- 更新 WeWorker 后 Webwright runtime 同步更新。
- 升级后用户数据保留且兼容。
- 卸载后 Webwright 程序删除，用户数据默认保留。
- macOS arm64、macOS x64、Windows x64 均完成目标平台实机验证。
- 完整 Exploration → Development → Debug → Publish → export 真实 CDP 链路通过。

## 十四、实施顺序

1. Webwright 落盘本设计并更新分发规范。
2. Webwright 实现 embedded build 和对应合同测试。
3. Webwright 实现 shutdown、父进程 watchdog 和安全边界。
4. Webwright 完成 macOS arm64 embedded 验证。
5. WeWorker 补项目规范、Roadmap 和对应集成设计。
6. WeWorker 将 `components/webwright` 作为内部源码目录接入构建脚本。
7. WeWorker 实现开发态 WebwrightManager。
8. WeWorker 接入自动启动、退出和更新生命周期。
9. WeWorker 增加只打开浏览器的入口和状态展示。
10. 完成 macOS arm64 WeWorker 安装包闭环。
11. 完成 Windows x64 构建和实机验收。
12. 完成 macOS x64 构建和实机验收。
13. 最后接入正式发布流水线。

Webwright 与 WeWorker 作为同一仓库版本共同实现和验证；embedded runtime 不维护独立版本指针。

## 十五、导出 Toolkit 的 WeWorker 运行合同

WeWorker 的 `full` 模式直接运行 Claude Code 标准 Skill。两类 Adapter 使用统一命令：

```text
webcli call <adapter-id>.<tool-id> --key=value
```

WeWorker 内置 WebCLI 的 Toolkit Runner 相对定位同一安装包中的 embedded Runtime：

```text
webcli call <adapter-id>.<tool-id>
→ <Resources>/webwright/Webwright[.exe] --internal-script <adapter-root>/scripts/toolkit.py <tool-id>
```

双方边界如下：

- Webwright 负责冻结 CPython、Playwright driver、canonical Runtime 和 `--internal-script`。
- WeWorker 负责 WebCLI Toolkit Runner、Claude Code SDK `PATH`、Adapter 根目录和权限模式。
- Runner 保持 cwd、stdin、stdout、stderr、参数边界、退出码和终止信号。
- Runner 清理外部 `PYTHONHOME`、`PYTHONPATH` 和 user site 污染。
- 该调用不连接 `8766` Server，也不要求 Webwright Server 正在运行。
- 不增加 Toolkit MCP；Toolkit export 增加 manifest 形成五文件 Adapter，不打包第二套 Python/Playwright。
- 不处理 Toolkit 与 Webwright UI／Debug 的并发冲突，由用户自行避免。
- 网站探索组件负责确定性生成 Toolkit manifest、Skill 与正式执行文件，并保持既有冻结入口。

完整权限矩阵、开发态行为、失败语义和验收标准以 WeWorker 的 [`skill_runtime_design.md`](../../../docs/skill_runtime_design.md) 为准。

### 15.1 磁盘直装

WeWorker embedded 启动时通过环境提供绝对 `WEWORKER_USER_FILES_DIR`。配置合法时，
Webwright health 公开布尔 capability，Toolkit
工具栏显示「安装到 WeWorker」，并只在 `export_eligible=true` 时启用。

按钮请求 Webwright 同源条件路由；Webwright 复核导出资格后，将当前正式四文件
Skill 直接原子覆盖到 `<user_directory>/.claude/skills/<skill-name>/`。浏览器不能
提交安装路径；配置无效时不注册路由，capability 为 false。

Webwright 不下载或解压自己的 export ZIP，不维护安装索引，也不保护同名手动 Skill。
除 `~/.weworker/webwright/` 外，只允许为该功能读写 Electron 指定用户目录下的
`.claude/skills/`；不得访问其他 WeWorker 数据。

## 十六、实施状态

截至 2026-07-22，Webwright 侧已完成：

- standalone／embedded 双构建模式，embedded 只输出 `onedir`。
- `webwright-runtime.json` 和 `LICENSE.webwright`。
- PyInstaller 显式使用仓库 `src/`，避免 distribution 非 editable 环境冻结到陈旧 wheel。
- health 返回版本、平台、架构和运行模式。
- Server 只允许 `127.0.0.1`／`localhost`，并校验 Host、端口和 Origin。
- 所有活动 Worker 使用独立进程组。
- `ProcessManager.shutdown()` 统一取消活动运行并终止自有进程树。
- `SIGINT`／`SIGTERM` 优雅关闭。
- `--parent-pid` 异常父进程 watchdog。
- `--exit-on-stdin-close` 正常跨平台关闭通道。
- macOS arm64 embedded `onedir` 实际构建、冻结 CLI、`8766` health、Host 拦截、stdin 关闭、父 PID 退出和端口释放验证。

尚未完成：

- macOS arm64 安装包中的真实 `webcli call` Toolkit Adapter 闭环。
- Windows x64 和 macOS x64 embedded 实机构建。
- WeWorker 安装、升级和卸载验收。
- Exploration → Development → Debug → Publish → export 完整真实 CDP 业务链验收。

## 共享浏览器合同补充（2026-10-27）

探索、调试、回放与已安装 Toolkit command 统一遵守仓库根目录的 [共享浏览器实施方案](../../../docs/shared_browser_implementation_plan.md) 。宿主注入 WebCLI 控制入口，Python 通过 JSON 标准输入／输出获取 Bridge 管理的实例、占用与页面协调信息，通过本机 CDP 操作同一浏览器。托管模式连接失败不得自行启动浏览器；运行时获取连接地址，不能复用历史任务的端口。Toolkit 普通调用独立于探索服务，保留共享 Runtime、连续调用页面复用和状态存储。
