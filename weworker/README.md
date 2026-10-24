# WeWorker 桌面端

AI 操作网站的桌面应用。基于 Electron，提供对话式交互界面，通过浏览器扩展实现对网站的自动化操控。

## 目录结构

```
weworker/
├── electron/                Electron 主进程
│   ├── main.js             入口，窗口与进程管理
│   ├── managers.js         BridgeManager / NodeManager
│   ├── ipc-handlers.js     IPC 通信处理
│   └── preload.js          渲染进程 API 暴露
│
├── renderer/               渲染进程 (React)
│   └── src/
│       ├── components/
│       │   ├── chat/       对话界面
│       │   ├── sidebar/    侧边栏
│       │   ├── settings/   设置页面
│       │   ├── scheduled/  定时任务
│       │   └── welcome/    欢迎/引导页
│       ├── store/          Zustand 状态管理
│       │   ├── settings.js AI 配置、主题
│       │   ├── sites.js    站点列表
│       │   ├── works.js    任务状态
│       │   └── status.js   Bridge/后端连接状态
│       ├── api/            后端 API 调用
│       └── utils/          工具函数
│
├── backend-ts/src/         TypeScript 后端
│   ├── server.ts           Express 服务器 + SSE
│   ├── agent.ts            Claude Agent 集成
│   ├── scheduler.ts        定时任务调度
│   ├── task-executor.ts    任务执行器
│   ├── site-memory.ts      站点持久化记忆
│   ├── adapter-scaffold.ts 适配器脚手架生成
│   ├── skill-generator.ts  Skill 文件生成
│   ├── tools.ts            工具定义
│   ├── channels/           通知渠道
│   │   ├── channel-manager.ts  渠道管理
│   │   ├── qq-channel.ts       QQ 机器人
│   │   ├── weixin-channel.ts   微信机器人
│   │   └── wecom-channel.ts    企业微信机器人
│   └── works-store.ts      任务状态持久化
│
└── scripts/                构建脚本
    ├── bundle-backend-ts.cjs  后端打包
    └── bundle-bridge.cjs      Bridge 打包
```

## 前置条件

| 依赖 | 最低版本 | 用途 |
|------|---------|------|
| Node.js | 22.x | 运行时与构建工具；其他主版本不受支持 |
| npm | 随 Node.js | 包管理 |
| uv | 当前稳定版 | 自动准备 Python 3.14.6 隔离环境，并构建 embedded runtime 和 Windows 解密工具 |

Webwright 源码由 WeWorker 主仓库直接管理在 `components/webwright/`，普通克隆即可取得完整源码：

```bash
git clone <weworker-repository>
```

标准安装和开发命令会校验该目录及其 `pyproject.toml` 存在，不执行额外仓库初始化。

## 开发

### 安装依赖

一条命令同步 Webwright Python 环境并安装所有 npm 依赖（weworker、renderer、backend-ts、webcli）：

```bash
npm run install:all
```

该命令使用各目录的 `package-lock.json` 和 `npm ci` 做可重复安装。运行前用 `node --version` 确认是 `v22.x.x`；不需要自行安装系统 Python、PyInstaller 或 pywin32。

或手动逐个安装：

```bash
npm ci                       # weworker 主进程（electron、esbuild、electron-builder 等）
cd renderer && npm ci        # 渲染进程（React、Vite 等）
cd ../backend-ts && npm ci   # TypeScript 后端（Express、Claude Agent SDK 等）
cd ../../webcli && npm ci    # WebCLI Bridge（ws、@anthropic-ai/sdk）
```

### 启动开发模式

```bash
npm run dev
```

同时启动渲染进程 Vite dev server（`localhost:5173`）和 Electron 主进程。
Electron 主进程会自动启动 `backend-ts`，通常不需要另外启动后端。

如需单独查看或调试后端日志，可以先在 `backend-ts` 目录执行 `npm run dev`，再在 `weworker` 目录执行 `npm run dev`。开发版 Electron 会识别并使用这个外部后端，退出 WeWorker 时不会结束它。

Electron 主进程会自动从 `components/webwright` 源码启动 Webwright，并监听 `127.0.0.1:8766`。不需要手动启动 Webwright Server；界面中的“打开 Webwright”只调用系统默认浏览器打开固定地址。

## 构建桌面应用

### macOS

```bash
npm run build:mac
```

### Windows

构建脚本会通过 `uv` 在 `build/decrypt-venv/` 创建隔离环境，不需要修改系统 Python：

```bash
npm run build:win
```

### 构建配置：build-profile.json

公开发行版由 [`build-profile.json`](build-profile.json) 决定打包哪些适配器和 AI 提供商：

```json
{
  "adapters": ["mail.qq.com", "jd.com", ...],
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "models": ["claude-sonnet-4-6"],
      "defaultModel": "claude-sonnet-4-6",
      "weworker": { "protocol": "anthropic_messages", "baseUrl": "https://api.anthropic.com" },
      "webwright": { "protocol": "anthropic_messages", "modelClass": "anthropic", "baseUrl": "https://api.anthropic.com", "structuredOutput": "anthropic_json_schema" }
    }
  ],
  "defaultProvider": "anthropic"
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `adapters` | `string[]` | 要打包的适配器 ID 列表，对应 `extension/adapters/` 下的目录名。未列出的适配器不会进入安装包，构建时会跳过并输出 WARNING |
| `providers` | `object[]` | 用户可选的 AI 提供商列表。每项声明 `models`、`defaultModel`，以及 WeWorker／Webwright 各自使用的明确协议、Adapter、Base URL 和结构化输出策略 |
| `defaultProvider` | `string` | 默认选中的提供商 ID，必须存在于 `providers` 的 `id` 中 |

> **提示**：`adapters` 只控制打包哪些适配器，开发模式下（`npm run dev`）所有适配器都可用，不受此限制。如需查看所有可用适配器，见 `extension/adapters/` 目录。

派生发行版不要直接修改公共 Profile 或 Extension Manifest。将差异写入独立 overlay，通过 `WEWORKER_BUILD_PROFILE` 与 `WEWORKER_BUILD_OVERLAY` 传入：

```powershell
$env:WEWORKER_BUILD_PROFILE = 'internal'
$env:WEWORKER_BUILD_OVERLAY = '..\internal\config\build-overlay.json'
node scripts/prepare-build.cjs
```

Overlay 支持 `adapters.add/remove`、`providers.upsert/remove`、`defaultProvider`，以及 Extension 的 `permissions` 和访问范围增删。生成的 `build/extension-dist/` 既是打包输入，也可作为派生版扩展的手工加载目录。

### 构建流程说明

`build:mac` / `build:win` 会依次执行以下步骤：

1. **prepare-build** — 合并并校验 Profile，生成 `.build-defines.json`、筛选后的 Adapter 和完整 `build/extension-dist/`；不修改源配置
2. **build:webwright** — 从当前工作区源码构建当前平台、当前架构的 embedded `onedir`
3. **build:renderer** — Vite 构建 React 前端
4. **build:backend-ts** — esbuild 打包 TypeScript 后端为 `server.cjs`
5. **build:bridge** — esbuild 打包 WebCLI Bridge 为 `bridge.cjs`
6. **build:decrypt**（仅 Windows）— PyInstaller 打包 `sd_decrypt.exe`
7. **electron-builder** — 将 embedded runtime 放入 `resources/webwright/`，并只构建与当前 Webwright runtime 相同的架构

输出目录：`weworker/dist-app/`

Webwright 中间产物位于 `weworker/build/webwright-dist/`，已被 Git 忽略，不得提交。构建不要求 `components/webwright/` 工作区干净；runtime manifest 只校验版本、平台、架构、模式和入口。

### CI/CD

GitHub Actions 使用以下工作流：

- `validate.yml`：配置检查、单元测试和各模块编译检查。
- `build-desktop.yml`：PR 默认构建 Windows x64，也可手动选择 Windows x64、macOS x64、macOS arm64 或全部平台。
- `release-desktop.yml`：手动输入版本 Tag，完成三平台构建后创建 Draft Release。

桌面构建使用三套原生 Runner：

| 目标 | Runner | 产物 |
|------|--------|------|
| Windows x64 | `windows-latest` | NSIS `.exe`、`.blockmap`、`latest.yml` |
| macOS arm64 | `macos-15` | arm64 `.dmg`、`.zip`、`.blockmap` |
| macOS x64 | `macos-15-intel` | x64 `.dmg`、`.zip`、`.blockmap` |

Webwright 源码随 WeWorker 一次 checkout，不需要额外 PAT 或仓库 secret。发布 `latest` prerelease 使用 GitHub 自动提供的 `GITHUB_TOKEN`。

三个构建 job 全部通过后，release job 会合并两份 macOS 更新元数据并创建 Draft Release，不会直接公开发布。各构建 job 的原始产物保留在对应 workflow run 的 Artifacts 中。

### 发版清单

发版前需手动完成以下步骤。`prepare-build` 会把应用版本写入生成的 Extension Manifest，并校验 Renderer 版本一致，但不会修改源文件。

#### 1. 更新版本号

编辑 `weworker/package.json` 的 `version` 字段，并同步更新 `renderer/package.json`：

```json
{ "version": "0.2.0" }
```

构建时 `prepare-build` 会将该版本写入 `build/extension-dist/manifest.json`。如果 Renderer 版本不一致，构建会直接失败，避免构建过程回写工作区。

应用内版本号展示链路：
- 侧边栏 logo 旁、设置页底部 → Electron `app.getVersion()` → 读取 `package.json`

#### 2. 更新更新日志

在 `changelog.json` **开头**新增一条记录：

```json
[
  {
    "version": "0.2.0",
    "date": "2026-06-01",
    "commit": "",
    "items": [
      "新功能描述1",
      "修复描述2"
    ]
  },
  ...
]
```

| 字段 | 说明 |
|------|------|
| `version` | 与 `package.json` 版本号一致 |
| `date` | 发版日期 |
| `commit` | 可留空，构建时自动取 `git rev-parse --short HEAD` |
| `items` | 更新条目列表，会展示在首次启动引导页和官网下载页 |

发版时还需同步官网（`officialWeb/`）：

- 更新 `officialWeb/package.json` 与 `officialWeb/src/lib/downloadConfig.js` 中的版本号（`APP_VERSION`）
- 在 GitHub Release 上传安装包；若改为静态托管下载，将安装包放入 `officialWeb/public/downloads/`（命名见该目录 README）

详见 [officialWeb/README.md](../officialWeb/README.md)。

#### 3. Commit ID（无需手动操作）

构建时 `prepare-build` 自动执行 `git rev-parse --short HEAD` 写入 `.build-defines.json`，Vite 通过 `__BUILD_COMMIT_HASH__` 注入渲染进程，展示在设置页底部。

> **注意**：开发模式下 commit ID 显示为 `dev`，因为没有 `.build-defines.json`。

## 核心功能

### AI 对话

通过 Claude Agent SDK 与 AI 交互，AI 可调用浏览器扩展的适配器工具来操控网站。对话使用 SSE 流式输出，实时展示 AI 的操作过程。

### 定时任务

基于 cron 表达式的任务调度，支持自动执行周期性操作（如每日订单报表、邮件摘要等），无需人工干预。

### 多渠道通知

任务执行结果可通过以下渠道推送：
- QQ 机器人
- 微信机器人（扫码登录）
- 企业微信机器人

### 站点记忆

为每个网站维护持久化的上下文信息（site-memory），让 AI 在后续操作中能利用历史经验，提升操作准确率。
