# WeWorker 本地构建指南（供大模型执行）

> 本文档的主要读者是负责协助发版的大模型。发版同学可以把本文档连同项目目录交给大模型，要求其在本地完成环境检查、依赖安装、客户端构建和产物验证。

## 1. 目标与边界

本项目原先通过 GitHub Actions 分别在 Windows 和 macOS Runner 上构建客户端。GitHub Actions 不是构建所必需的，本地可以执行相同流程：

- Windows 客户端必须在 Windows 上构建。
- macOS 客户端应在真实 macOS 设备上构建。
- 不要尝试在 Windows 上生成正式可用的 macOS DMG。
- 本地构建只生成安装包，不会自动创建 GitHub Release 或上传产物。

桌面应用统一使用 `weworker/package.json` 中的 npm 构建入口，在 `weworker` 目录执行：

```text
Windows: npm run build:win
macOS:   npm run build:mac
```

原 `scripts/build-win.bat`、`scripts/build-mac.sh` 和 Python 后端 `build:backend` 命令已移除，不应重新使用或恢复其中的旧打包步骤。上述完整构建均会重新编译 `backend-ts`，任一步骤失败即停止，避免继续封装旧后端；`electron-builder` 本身不负责重新编译源码。

构建产物输出到：

```text
weworker/dist-app/
```

## 2. 大模型执行原则

1. 先读取项目当前的 `weworker/package.json`、`weworker/build-profile.json`、`.github/workflows/common-build.yml` 和 `.github/workflows/build-desktop.yml`，不要完全依赖本文档中可能过期的版本号。
2. 执行命令前确认当前目录。除依赖安装 `webcli` 外，大多数构建命令应在 `weworker` 目录执行。
3. 不要删除用户的源码、依赖目录或构建缓存。除非明确证明缓存损坏，否则不要清理 `node_modules`、`build` 或 electron-builder 缓存。
4. 下载时间较长不等于失败。只有进程退出并返回非零退出码，或长时间没有网络/磁盘活动时，才进行故障处理。
5. 构建成功不能只根据某个中间步骤判断，必须验证最终安装包、更新描述和 blockmap 文件。
6. 修改源码、版本号或 `build-profile.json` 后，必须重新执行完整构建；仅下载失败时可以从 electron-builder 阶段续构。

## 3. Windows 完整构建

### 3.1 前置环境

推荐与 CI 保持一致：

- Windows 10/11 x64
- Node.js 22
- npm
- 可访问 npm、GitHub；访问 GitHub 较慢时使用下文的镜像配置

在 PowerShell 中检查：

```powershell
node --version
npm --version
uv --version
```

`node --version` 必须输出 22.x。项目通过 `uv` 自动准备锁定的 CPython 3.14.6、PyInstaller 和 pywin32 隔离环境，不使用系统 `pip`，也不要求 `python` 命令存在。

Windows 首次运行 `electron-builder` 还需要创建符号链接。建议提前开启 Windows“开发者模式”；否则应从管理员 PowerShell 构建。

### 3.2 安装 Node.js 依赖

从仓库根目录进入 `weworker`：

```powershell
cd "<仓库绝对路径>\weworker"
npm run install:all
```

该命令会安装以下目录的依赖：

- `weworker`
- `weworker/renderer`
- `weworker/backend-ts`
- `webcli`

这里的 `npm ci` 是 npm 官方的干净安装命令：它会先删除对应目录已有的 `node_modules`，严格按照 `package-lock.json` 安装且不会改写 lockfile，适合首次克隆和复现正式构建。日常开发新增或升级依赖时应使用 `npm install <package>`，并提交同步更新的 `package.json` 和 `package-lock.json`。

如果一键安装失败，可按照 CI 的顺序分别执行：

```powershell
cd "<仓库绝对路径>\webcli"
npm ci

cd "<仓库绝对路径>\weworker"
npm ci

cd renderer
npm ci

cd ..\backend-ts
npm ci
```

然后返回 `weworker`：

```powershell
cd ..
```

### 3.3 配置下载镜像

`npm registry` 只影响 npm 包，不控制 Electron 和 electron-builder 二进制下载。分别检查：

```powershell
npm config get registry
$env:ELECTRON_MIRROR
$env:ELECTRON_BUILDER_BINARIES_MIRROR
```

如果本机访问 GitHub 较慢，建议在当前 PowerShell 会话中配置：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

判断镜像是否生效，应查看构建日志中的实际下载 URL，例如：

```text
https://npmmirror.com/mirrors/electron/...
```

而不是只根据环境变量是否已设置判断。

### 3.4 执行完整构建

确认当前目录是 `weworker`，然后执行：

```powershell
npm run build:win
```

完整流程依次包括：

1. `prepare-build`：验证 `build-profile.json`、筛选适配器、生成构建配置、同步版本号。
2. `build:webwright`：构建 Windows embedded Webwright Runtime。
3. `build:renderer`：构建 Vite/React 前端。
4. `build:backend-ts`：打包 TypeScript 后端。
5. `build:bridge:win`：打包 WebCLI Bridge。
6. `build:webcli`：打包 WebCLI、适配器和 Skills。
7. `build:decrypt`：通过 PyInstaller 生成 `sd_decrypt.exe`。
8. `electron-builder --win`：打包 Electron 和 NSIS 安装程序。

Vite 关于动态导入和大于 500 kB Chunk 的提示目前属于警告，不代表构建失败。

首次构建会额外下载：

- Electron Windows Runtime（当前版本约 122 MB，实际版本以 `package-lock.json` 为准）
- electron-builder/NSIS 所需二进制

这些下载可能耗时较长，后续构建通常会复用缓存。

## 4. Windows 断点续构

如果完整构建已经成功完成前置步骤，只在 Electron 下载或 NSIS 打包阶段失败，无需从头执行。先验证关键中间产物：

```powershell
Test-Path .\renderer\dist\index.html
Test-Path .\build\backend-ts-dist\server.cjs
Test-Path .\build\bridge-dist\bridge.cjs
Test-Path .\build\webcli-dist\webcli.cjs
Test-Path .\build\webcli-dist\webcli.cmd
Test-Path .\build\webwright-dist\dist\Webwright\webwright-runtime.json
Test-Path .\build\decrypt-dist\sd_decrypt.exe
```

全部返回 `True` 时，可以设置镜像并从最后一步继续：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npx electron-builder --win
```

以下情况不能只执行 electron-builder，必须重新运行完整的 `npm run build:win`：

- 修改了业务源码。
- 修改了前端、后端、Bridge 或 WebCLI。
- 修改了版本号。
- 修改了 `build-profile.json`。
- 修改了扩展或适配器。
- 任一关键中间产物不存在或不能确认是否为最新版本。

## 5. 常见故障处理

### 5.1 PyInstaller 产物被安全软件阻止

如果 `build:webwright` 或 `build:decrypt` 已显示 `Build complete!`，随后出现以下错误：

```text
spawnSync ... EPERM
拒绝访问
```

先确认文件存在且普通已知程序在同一目录可以执行。这通常表示终端安全软件阻止了刚生成、尚未签名的 PyInstaller 可执行文件，不是 npm 或文件 ACL 问题。

```powershell
Test-Path .\build\webwright-dist\dist\Webwright\Webwright.exe
Test-Path .\build\decrypt-dist\sd_decrypt.exe
```

不要关闭安全防护。请让管理员放行构建目录/生成文件，或改用允许执行本地构建产物的可信机器。放行后必须重新执行完整的 `npm run build:win`，不能把跳过运行时校验的安装包视为正式成功。

### 5.2 Electron 仍然从 GitHub 下载

如果日志中的 URL 仍为：

```text
https://github.com/electron/electron/releases/...
```

说明本次进程没有读到镜像配置。应在同一个 PowerShell 窗口中重新设置环境变量，再启动新进程：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npx electron-builder --win
```

如果日志底部已经出现 `npmmirror.com`，说明新的构建进程已正确使用镜像；之前的 GitHub 错误可能属于上一次失败的构建输出。

### 5.3 electron-builder 无法创建符号链接

如果解压 `winCodeSign` 时报“Cannot create symbolic link”或“客户端没有所需的特权”，开启 Windows“开发者模式”后重新打开 PowerShell，或使用管理员 PowerShell 重新构建。不要手工提交或复用其他机器生成的 electron-builder 缓存。

## 6. Windows 成功判定

构建命令结束并回到 PowerShell 提示符后，检查：

```powershell
Get-ChildItem .\dist-app | Select-Object Name,Length,LastWriteTime
```

必须至少存在：

```text
WeWorker-<version>-win-x64.exe
WeWorker-<version>-win-x64.exe.blockmap
latest.yml
win-unpacked/
```

版本号以 `weworker/package.json` 为准。安装包应当是有实际体积的大文件，不能只根据目录存在判断成功。

文件大小随代码和依赖变化，不作为固定成功标准。

建议进一步执行人工冒烟测试：

1. 双击安装程序。
2. 完成安装并启动 WeWorker。
3. 检查主界面是否正常加载。
4. 检查内置后端、Bridge 和浏览器扩展相关功能是否可启动。
5. 检查应用显示的版本号是否与 `package.json` 一致。

未配置 Windows 代码签名时，系统可能显示“未知发布者”，这不代表构建失败。

## 7. macOS 本地构建

macOS 构建应在 Mac 上执行，推荐 Node.js 22。安装依赖后，在 `weworker` 目录执行：

```bash
npm run build:mac
```

当前配置会尝试生成 Intel x64 和 Apple Silicon arm64 的 DMG、ZIP 及更新文件。产物位于：

```text
weworker/dist-app/
```

应验证：

```text
WeWorker-<version>-mac-x64.dmg
WeWorker-<version>-mac-arm64.dmg
对应 ZIP、blockmap 和 latest-mac.yml
```

如果没有配置 Apple Developer 证书和 notarization，安装包仍可用于内部测试，但其他 Mac 可能提示无法验证开发者。正式外部分发需要单独配置签名和 Apple 公证。

## 8. 发版前检查

构建前至少确认：

- `weworker/package.json` 中的 `version` 正确。
- `weworker/changelog.json` 已添加对应版本记录。
- `weworker/build-profile.json` 中的适配器和 AI Provider 配置正确。
- 工作区中的代码确实是准备发布的提交。
- Windows 与 macOS 产物均在各自原生系统上构建并验证。

如果还需要构建官网，按照 `officialWeb/README.md` 更新官网版本、复制安装包并完成静态站点构建。本地客户端构建不会自动完成这些步骤。

## 9. 可直接投喂给大模型的任务模板

```text
请阅读仓库根目录的 LOCAL_BUILD_AI_GUIDE.md，并在当前机器上完成 WeWorker 本地客户端构建。

要求：
1. 先判断当前操作系统，只构建该系统原生支持的客户端。
2. 检查 Node.js 22、npm 和 uv；Python/PyInstaller 由 uv 自动准备，不使用系统 pip。
3. 读取当前 package.json、build-profile.json 和 GitHub Actions，确认实际版本和构建命令。
4. 访问 GitHub 较慢时配置 Electron 和 electron-builder 的 npmmirror 镜像。
5. 执行完整构建；如果只在 Electron 下载/打包阶段失败，验证中间产物后断点续构。
6. 不删除源码、用户修改、node_modules 或构建缓存，除非先说明原因并取得确认。
7. 构建后检查 dist-app 中的安装包、blockmap 和 latest 更新文件，并报告绝对路径、文件大小和更新时间。
8. 最后提醒我执行安装和核心功能冒烟测试。
```
