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
| Node.js | ≥ 18 | 运行时 & 构建工具 |
| npm | 随 Node.js | 包管理 |
| uv | 当前稳定版 | 管理 Python 环境并构建 Windows 解密工具 |
| CPython | 3.14.6 | 正式构建 Webwright embedded runtime |

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

或手动逐个安装：

```bash
npm install              # weworker 主进程（electron、esbuild、electron-builder 等）
cd renderer && npm install   # 渲染进程（React、Vite 等）
cd ../backend-ts && npm install  # TypeScript 后端（Express、Claude Agent SDK 等）
cd ../../webcli && npm install   # WebCLI Bridge（ws、@anthropic-ai/sdk）
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

桌面应用统一通过本目录的 `package.json` 中的 npm 命令打包，按当前操作系统选择下面的入口。请先安装上述各模块的依赖，并切回 `weworker` 目录执行。

原 `scripts/build-win.bat`、`scripts/build-mac.sh` 和 Python 后端 `build:backend` 命令已移除。完整构建会重新编译 TypeScript 后端（包括 `backend-ts/src/agent.ts` 中的系统提示词），任一步骤失败即停止；修改源码后请运行完整构建，直接调用 `electron-builder` 只会封装已有产物。

### macOS

```bash
npm run build:mac
```

### Windows

构建脚本会通过 `uv` 在 `build/decrypt-venv/` 创建隔离环境，不需要修改系统 Python：

```bash
npm run build:win
```

### 模型配置与构建 Profile

模型供应商统一定义在 [`model.json`](model.json)，[`build-profile.json`](build-profile.json) 通过 `modelProviders` 引用该文件，并继续声明要打包的 Adapter：

```json
{
  "modelProviders": "./model.json",
  "adapters": ["mail.qq.com", "jd.com"]
}
```

模型配置示例（地址和模型名称仅为占位）：

```json
{
  "defaultProvider": "example",
  "providers": [{
    "id": "example",
    "name": "示例供应商",
    "models": [],
    "defaultModel": "",
    "fixed": true,
    "builtin": false,
    "fixedModel": false,
    "allowMultiple": true,
    "authType": "api_key",
    "weworker": { "protocol": "anthropic_messages", "baseUrl": "https://example.com/anthropic" },
    "webwright": { "protocol": "openai_chat_completions", "modelClass": "openai_chat", "baseUrl": "https://example.org/v1", "structuredOutput": "openai_json_object" },
    "presentation": { "subtitle": "示例服务", "color": "#2563eb", "bg": "#eff6ff" }
  }]
}
```

| 字段 | 说明 |
|------|------|
| `defaultProvider` | 默认供应商 ID，必须存在于 `providers` 中 |
| `id` / `name` | 稳定标识与默认显示名称；现有供应商的 ID 应保持不变，以兼容已保存设置 |
| `weworker` | 主对话协议及网关 `baseUrl` |
| `webwright` | 网站探索agent 的协议、模型 Adapter、网关及结构化输出策略；字段名为内部兼容标识 |
| `fixed` | 是否为固定供应商：常驻显示、名称固定且不可删除；不代表固定模型名称 |
| `builtin` | 是否由应用托管凭据并使用只读服务配置 |
| `fixedModel` | 是否锁定 `defaultModel`；为 `true` 时必须提供非空默认模型 |
| `models` / `defaultModel` | 备用模型列表与默认模型；普通供应商保留空列表并从网关 API 获取可选模型 |
| `allowMultiple` | 是否允许从该供应商模板新增独立配置；托管内置模型不支持新增副本 |
| `authType` | `api_key` 使用 `x-api-key`，`auth_token` 使用 Bearer 鉴权 |
| `apiKeyEnv` / `baseUrlEnv` | 既有内置模型和部署网关解析器使用的环境变量名称；此字段保存变量名；内置密钥密文使用 `encryptedApiKey` |
| `encryptedApiKey` | 内置托管模型的 AES-256-GCM 密文，格式为 `iv.tag.ciphertext`（各段使用 base64url）；仅 Backend 解密，普通供应商不允许配置此字段 |
| `presentation` | 设置页展示用副标题及主题颜色 |

`fixed`、`builtin`、`fixedModel`、`allowMultiple` 和 `authType` 在 JSON 中必须显式声明。公开配置仅保留内置模型、Anthropic、智谱 coding plan、DeepSeek 和自定义供应商。普通供应商的 API Key 仍由用户填写并按现有方式保存。内置模型的加密 API Key 与全部预设网关集中在 `model.json`，内置托管凭据只由后端解密；不再使用代码中的密钥密文或加密网关常量。Renderer 构建注入、开发服务的 JSON 模块与 Backend 供应商元数据均剔除密文字段。显式环境变量优先，JSON 中填写的网关优先于旧部署文件；旧部署文件仅在对应 JSON 网关为空时兼容读取。内置模型缺少密文且未设置环境变量时不可用，不回退到代码中的旧密钥。

开发启动和生产构建读取同一份 JSON。现有供应商的精简版与完整版配置可以在构建前整份覆盖 `model.json`，无需修改代码或同时调整构建 Profile；列表、默认供应商、网关、鉴权及固定规则均跟随覆盖后的文件。保留条目原有 ID 和必需字段即可兼容已保存设置；不在 JSON 中的条目不会被代码自动补回。修改后 Vite 开发服务会自动重新加载构建 Profile 及其引用的模型配置，更新注入页面的固定供应商等标记；Backend 仍需重启。已打包应用需要重新构建，不支持安装后直接修改 JSON 热更新。构建校验会拒绝非法字段、重复 ID、无效默认供应商及包含凭据的网关地址；现有供应商运行时使用当前 JSON 网关，避免旧保存地址覆盖新配置。新增供应商 ID 仍需配套后端配置存储支持，不能仅添加 JSON 条目。

`adapters` 只控制打包范围，开发模式下所有 Adapter 都可用。派生发行版将差异写入独立 overlay，通过 `WEWORKER_BUILD_PROFILE` 与 `WEWORKER_BUILD_OVERLAY` 传入：

```powershell
$env:WEWORKER_BUILD_PROFILE = 'variant'
$env:WEWORKER_BUILD_OVERLAY = '..\variant\config\build-overlay.json'
node scripts/prepare-build.cjs
```

Overlay 支持 `adapters.add/remove`、`providers.upsert/remove`、`defaultProvider`，以及 Extension 的权限和访问范围增删。`providers.upsert` 替换整个供应商条目，须携带完整协议与上述行为字段。构建阶段在最新 JSON 上重新应用已准备的 overlay，排除的供应商不会被开发默认值补回；旧的非公共构建缓存需要用原 overlay 重新执行 prepare-build。生成的 `build/extension-dist/` 是打包输入，也可作为派生版扩展的手工加载目录。

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

`.github/workflows/release-latest.yml` 在推送 `v*` tag 或手动触发时执行三套原生构建：

| 目标 | Runner | 产物 |
|------|--------|------|
| Windows x64 | `windows-latest` | NSIS `.exe`、`.blockmap`、`latest.yml` |
| macOS arm64 | `macos-15` | arm64 `.dmg`、`.zip`、`.blockmap` |
| macOS x64 | `macos-15-intel` | x64 `.dmg`、`.zip`、`.blockmap` |

Webwright 源码随 WeWorker 一次 checkout，不需要额外 PAT 或仓库 secret。发布 `latest` prerelease 使用 GitHub 自动提供的 `GITHUB_TOKEN`。

三个构建 job 全部通过后，release job 会合并两份 macOS 更新元数据，并更新 `latest` tag 和 prerelease。最终用户可下载产物位于仓库 GitHub Releases 的 `latest` prerelease；各构建 job 的原始产物也保留在对应 workflow run 的 Artifacts 中。

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
