# WeWorker

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Validate](https://github.com/WeWorker/WeWorker/actions/workflows/validate.yml/badge.svg)](https://github.com/WeWorker/WeWorker/actions/workflows/validate.yml)
[![GitHub release](https://img.shields.io/github/v/release/WeWorker/WeWorker)](https://github.com/WeWorker/WeWorker/releases)
[![GitHub stars](https://img.shields.io/github/stars/WeWorker/WeWorker)](https://github.com/WeWorker/WeWorker/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/WeWorker/WeWorker)](https://github.com/WeWorker/WeWorker/issues)

WeWorker 是一个 AI 驱动的桌面端网页自动化工具。它将自然语言任务交给 AI Agent，通过浏览器扩展或内置 Toolkit Adapter 调用网站能力，并在涉及登录、提交、下单、支付等关键步骤时保留用户确认环节。

官网：[https://www.weworker.cc](https://www.weworker.cc)

## 功能

- **自然语言操作网站**：通过桌面端对话描述任务，由 AI 选择并调用网站工具。
- **两类 Adapter**：Extension Adapter 通过 Chrome 扩展操作网页，Toolkit Adapter 通过内置运行时执行；两者共享 `webcli call` 调用入口。
- **网站探索agent**：探索网站页面和请求，辅助创建、验证和维护网站工具。
- **定时任务**：按计划执行已配置的任务。
- **站点记忆**：在本地保存与网站相关的操作上下文。
- **消息通知**：支持将任务结果发送到已配置的通知渠道。
- **多模型配置**：支持 Anthropic、智谱、DeepSeek 和兼容接口的自定义模型配置。

## Adapter 支持

WeWorker 初次开源版本已内置一批常用网站 Adapter。常用示例：

| 网站 | Adapter ID | 当前能力 |
| --- | --- | --- |
| QQ 邮箱 | `mail.qq.com` | 邮件搜索、未读读取、邮件详情、附件和发票下载 |
| 163 邮箱 | `mail.163.com` | 邮件搜索、未读读取、邮件详情、附件下载、写邮件 |
| 京东 | `jd.com` | 商品搜索、购物车、订单、商品详情、购买与支付流程 |
| 小红书 | `xiaohongshu.com` | 笔记搜索、笔记详情、评论读取、点赞、收藏、发布与草稿 |
| B 站 | `bilibili.com` | 视频搜索、视频详情、评论读取、点赞、收藏 |
| 知乎 | `zhihu.com` | 搜索、问题、回答、评论、热榜、点赞、收藏 |
| GitHub | `github.com` | Trending 仓库读取 |
| Gitee | `gitee.com` | 搜索、趋势榜、用户信息 |
| 豆瓣 | `douban.com` | 条目搜索、详情、影评、Top250、相册、标记 |
| 微博 | `weibo.com` | 热榜、搜索、信息流、用户主页、评论、发布 |

更多已支持网站、Adapter ID 和能力范围见 [Adapter 清单](docs/ADAPTERS.md)。

## 快速开始

### 下载桌面应用

可从[官网](https://www.weworker.cc/download)选择平台，安装包由 [GitHub Releases](https://github.com/WeWorker/WeWorker/releases) 提供：

- Windows 10/11 x64：`.exe`
- macOS Intel：x64 `.dmg`
- macOS Apple 芯片：arm64 `.dmg`

正式发布地址和签名状态以具体 Release 说明为准。

### 从源码启动

前置环境：

- Node.js 22.x（不支持使用其他主版本代替）
- npm
- [uv](https://docs.astral.sh/uv/)
- Chrome 或 Chromium 浏览器

先确认实际生效的版本：

```bash
node --version
npm --version
uv --version
```

`node --version` 必须输出 `v22.x.x`。项目所需的 Python 由 `uv` 自动准备，不需要预先安装系统 Python 或 PyInstaller。

```bash
git clone https://github.com/WeWorker/WeWorker.git
cd WeWorker/weworker
npm run install:all
npm run dev
```

首次安装会同步网站探索agent运行环境，并通过 npm 官方的 `npm ci` 命令严格按照各目录的 `package-lock.json` 安装桌面端、Renderer、Backend 和 WebCLI 依赖。`npm ci` 会先删除对应目录已有的 `node_modules`，且不会改写 lockfile，适合首次克隆和复现正式构建；日常开发新增或升级依赖时请使用 `npm install <package>`，并提交同步更新的 `package.json` 和 `package-lock.json`。期间会下载 Python 运行环境和 Electron（约 120 MB），可能出现一段时间没有新日志；请确保能够访问 npm registry、GitHub Releases 和相关 CDN。

### 加载浏览器扩展

开发模式下可以手动加载扩展：

1. 打开 Chrome 的 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择仓库中的 `extension/` 目录。

安装版桌面应用会携带与当前版本匹配的扩展资源。

## 基本使用

1. 启动 WeWorker。
2. 在设置中配置受支持的 AI 模型和 API Key。
3. 启动或连接浏览器扩展。
4. 打开目标网站并完成登录。
5. 在对话框中描述任务，核对关键操作后再确认执行。

示例：

```text
帮我查看 163 邮箱里是否有未读邮件
帮我在京东搜索机械键盘并整理搜索结果
帮我在小红书搜索杭州周末徒步路线
```

### WebCLI

```bash
# 查看可用 Adapter
webcli list

# 调用 Adapter 工具
webcli call <adapter-id>.<tool-id> --key=value
```

WebCLI 的安装、Bridge 和命令说明见 [webcli/README.md](webcli/README.md)。

## 项目结构

```text
WeWorker/
├── components/            桌面端使用的内部组件源码
├── extension/             Chrome 扩展与 Extension Adapter
├── webcli/                统一 Adapter CLI 与 Bridge
├── weworker/              Electron 桌面端、React Renderer 和 TypeScript Backend
├── officialWeb/           产品官网与下载页
├── metrics-server/        可选的自托管匿名指标服务
└── docs/                  设计与开发文档
```

核心调用关系：

```text
用户任务 → AI Agent → WebCLI → Extension/Toolkit Adapter → 网站
```

## 数据与安全

- API Key 由用户配置，不应写入仓库、Issue、日志或截图。
- WeWorker 会把任务内容发送给用户选择的模型服务商，请遵守对应服务商的隐私政策。
- 网站操作使用浏览器中已登录的账号，执行结果等同于用户本人操作。
- Bridge 和本地服务不应暴露到公共网络。
- 指标上传默认关闭，只有显式配置后才会启用。
- 应定期检查扩展权限和已启用的 Adapter，只使用可信代码。
- 安全漏洞请按照 [SECURITY.md](SECURITY.md) 私下报告，不要创建公开 Issue。

## 开发与构建

主要开发入口位于 `weworker/`：

```bash
cd weworker
npm run install:all
npm run dev
```

生产构建必须在目标操作系统上执行：

```bash
# Windows x64
cd weworker
npm run build:win

# macOS 当前原生架构
cd weworker
npm run build:mac
```

Windows 构建产物位于 `weworker/dist-app/`，成功后至少包含 `.exe`、`.exe.blockmap`、`latest.yml` 和 `win-unpacked/`。

### Windows 下载与权限问题

如果 Electron 下载长期停留在 GitHub，可在**同一个 PowerShell 窗口**临时使用镜像后重新安装或构建：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run install:all
npm run build:win
```

这些变量只影响当前 PowerShell 会话，不建议写入项目文件。如果 `electron-builder` 报“无法创建符号链接/客户端没有所需的特权”，请开启 Windows 开发者模式，或从管理员 PowerShell 构建。如果刚生成的网站探索 Agent 或解密工具报 `EPERM`/“拒绝访问”，通常是终端安全软件阻止未签名的 PyInstaller 产物；不要关闭安全防护，应让管理员放行构建目录或改用允许执行本地构建产物的可信机器。

详细说明见：

- [桌面端开发与构建](weworker/README.md)
- [本地构建指南](LOCAL_BUILD_AI_GUIDE.md)
- [浏览器扩展与 Adapter 开发](extension/README.md)
- [WebCLI](webcli/README.md)
- [官网开发](officialWeb/README.md)

## 贡献

欢迎提交 Bug、文档、测试、新功能和新网站 Adapter。请先阅读 [贡献指南](CONTRIBUTING.md)、[社区行为准则](CODE_OF_CONDUCT.md)、[支持说明](SUPPORT.md) 和 [Git 工作流](docs/GIT_WORKFLOW.md)。新增或完成 Adapter 时，需要在同一个 PR 中更新 [Adapter 清单](docs/ADAPTERS.md)。

## 版本

当前版本为 `1.0.1`。公开版本变化见 [CHANGELOG.md](CHANGELOG.md)。

```bash
git tag v1.0.1
git push origin v1.0.1
```

正式发布由维护者完成；推送版本 Tag 后会自动构建 Draft Release，维护者验证安装包后再发布。创建 Tag 前必须通过项目规定的审核、测试、构建和发布验证，完整流程见 [发布指南](docs/RELEASE.md)。

### 版本号与分支号对应

`dev-X.Y.Z` 分支的版本号必须与分支号保持一致。创建或维护 `dev-X.Y.Z` 分支时，需要将以下位置的版本统一更新为 `X.Y.Z`（`scripts/check-public-config.mjs` 会强制校验）：

- `weworker/package.json`
- `weworker/renderer/package.json`
- `weworker/backend-ts/package.json`
- `officialWeb/package.json`
- `metrics-server/package.json`
- `extension/manifest.json`
- 上述各目录下 `package-lock.json` 的根版本字段（仅根条目，不含依赖版本）
- `weworker/changelog.json` 的首条版本记录
- `officialWeb/src/lib/downloadConfig.js` 的 `APP_VERSION`
- `CHANGELOG.md` 与 README「版本」章节

注意：`webcli/` 走 npm 独立发布节奏，版本与桌面端解耦，不随分支号更新。

桌面端打包（electron-builder）与安装后显示的版本均取自 `weworker/package.json`；若分支号与版本号不对应，打包产物名称和安装后的版本显示都会与预期不符。WebCLI 版本一致性由 `webcli/version.json`、`webcli/.claude-plugin/plugin.json` 和 `webcli/skills/webcli/SKILL.md` 的独立账本约束。

## 许可证

本项目使用 [Apache License 2.0](LICENSE)。第三方依赖说明见 [第三方软件声明](THIRD_PARTY_NOTICES.md)。第三方网站、商标和服务归各自权利人所有；使用 Adapter 时仍需遵守目标网站的协议和规则。
