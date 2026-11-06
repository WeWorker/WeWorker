# Adapter 迁移验收与 Toolkit 接手说明

更新：2026-09-22。本记录区分架构验证、产品实测和发布验收；历史批次的“未完成”描述以此处最新证据为准。

## 安装后发现的 Claude Code 启动问题

用户安装测试发现聊天请求报 `spawn UNKNOWN`。核实内部包内 `claude-code/bin/claude.exe` 是 500 字节文本占位脚本，真实可选平台依赖虽已存在，但未替换该文件。此前桌面启动和直接 WebCLI/Toolkit 验收未覆盖聊天 Agent 原生进程启动，不能据此宣称该链路通过。

已执行依赖自带 `install.cjs` 恢复原生文件，并在两仓 `afterPack` 增加最终资源校验：Windows PE、macOS Mach-O 及目标 CPU 架构，macOS 同时检查执行权限；占位脚本、缺失文件或架构不符将直接阻断打包，校验先于 macOS 签名。新增回归覆盖文本占位、截断 PE、架构不符及打包钩子。修复构建机依赖时，应针对 `package.json` 的 `extraResources` 实际来源执行 `node <claude-code目录>/install.cjs`；若提示缺少平台包，须先恢复同版本 optional dependency，不能只复制其他版本的可执行文件。macOS 格式校验单测不等于 Mac 实机验收。

验证：公开构建相关测试 14 项、内部 13 项通过；实际打包资源中的原生程序已从隔离临时 HOME/cwd 启动 `--version`，内部返回 `2.1.252 (Claude Code)`（217,406,624 字节），公开返回 `2.1.196 (Claude Code)`。两版 Windows 安装包已重新生成，内部官方构建入口最终校验仍为 35 个 Adapter。内部修复包另存为 `weworker/dist-app/WeWorker-0.2.6-win-x64-cc-fixed.exe`，避免与先前同版本安装器混淆。未使用真实模型凭据；聊天查询仍需安装后复验。

## 查询时目录变化误报修复

真实安装测试中，宿主目录的 Profile/摘要一致，但扩展漏处理 `adapter_catalog_result` 和 `adapter_bundle_result`，导致请求超时、工具被误判为非托管，最终报“Adapter changed since this call started”。已补齐两类响应分发。新增 3 项回归直接执行产品 `requestBridge`/`handleNativeMessage`，覆盖成功、宿主错误、匹配快照调用与真实过期摘要拒绝；两仓真实 Chrome for Testing 各 38 项通过。浏览器 fixture 的目录/包请求现在也经过产品消息处理函数。先前 fixture 直接返回宿主结果，未覆盖这个分发缺口。

扩展修复后需重载实际加载的扩展并刷新业务页面。内部推荐使用官方 prepare 生成的 `weworker/build/extension-dist`；无需为此修改业务 Adapter 或绕过摘要校验。真实业务查询结果仍待用户复验。公开 Windows 最终打包成功；内部两次在安装器与 blockmap 生成后清理临时 `.nsis.7z` 时遇到 EBUSY，构建命令退出 1，不记为全流程成功。对生成安装器执行 7-Zip 完整性测试通过，并直接从安装器提取扩展脚本确认修复已包含、核对 Claude 原生程序大小；SFX 尾部附加数据警告已观察。内部 `cc-fixed` 安装器副本已更新。官方生成 Profile/Backend 校验通过。

## 本次交付

统一 v2 包、Profile 隔离、安装快照、注册表、CLI/Backend/Skill/UI 发现与状态刷新已经接通。Extension 与 Toolkit 保留独立 Runner。Toolkit 自动探索、DOM 策略、生成器适配及业务工具由负责同事接手，不属于本次公共架构实现。

本轮实际 Runtime 验收发现并修复公开 CLI 的 Toolkit 输出分支引用未定义格式化函数的问题；Backend 测试补齐合法的隔离 Profile fixture。内部特有修复和资产清单仅记录于内部仓库。

## 验证证据

| 项目 | 结果与范围 |
| --- | --- |
| 公开 WebCLI | 81 文件，556 通过 |
| 公开 Backend | 73 文件，479 通过、4 跳过，使用已有 `test:ci` 的 15 秒超时 |
| 内部 WebCLI / Backend | 709 通过 / 857 通过、4 跳过；详情见内部交接 |
| 实际 MV3 浏览器 | 公开 Chrome for Testing、Edge 和内部 Chrome for Testing 各 37 项检查通过 |
| 重定向 | 真实 loopback 网络验证 301/302/307/308、授权/未授权目标、初始 URL、307 POST/body、redirect:error |
| Toolkit | 两仓源码 CLI、两仓打包 CLI 均通过真实 embedded Runtime 的安装、列表、帮助、Skill、调用、确认门、错误、启停及更新验收 |
| Windows 构建 | 两版 NSIS 安装包生成，资源包含独立 Runtime；未执行安装向导或覆盖升级 |
| 公开 Windows 客户端 | 隔离启动、Backend 健康、7 个内置 Skill；运行中安装中性测试包后 Skill、站点与工具目录自动更新；API 探索未连接时禁用开始；正常退出并释放 3711/8765/8766 |
| 内部 Windows 客户端 | 修复打包查询路由依赖及 Windows 父进程检测后，最终包隔离启动正常；Backend、Runtime、35 个 Adapter Skill 与目录正常；正常退出并释放三个端口，无父进程检测异常 |
| Renderer / 构建 | 两版 Renderer 生产构建通过；公开 Electron/Renderer/解密构建相关聚焦 31 项通过，新增启动器预检 2 项通过 |

浏览器验证使用真实浏览器、产品加载器与从产品提取的网络 helper，服务端为 loopback fixture。最终主机检查发生在浏览器跟随重定向后，拒绝未授权响应不代表阻止向重定向目标发送请求。

桌面启动器创建临时 HOME、用户数据和 Adapter 根，提前占用测试 Bridge 并拒绝带 Origin 的浏览器连接，以避免接入日常浏览器。客户端因此显示 Bridge 端口被占用提示；不能把这次测试记成客户端自启动 Bridge 或真实扩展连接验收。测试临时目录不自动删除。

## Toolkit 同事如何接手

先读 `docs/adapter_architecture_unification.md`，再以 `extension/test/toolkit-managed.acceptance.mjs` 中的 `writePackage()` 作为可运行最小包。测试会自动生成中性样例并安装到独立临时目录。

包布局：

```text
toolkit-fixture/
  manifest.json
  wewright/commands/echo.py
  wewright/commands/write.py
```

manifest 使用 `schema_version: 2`，每个命令声明 `id`、`runtime: "wewright"`、`module`、`description`、`safety` 和 `schema`。此处 runtime/module 是既有机器契约。命令脚本从 stdin 读取 JSON，命令 ID 为脚本参数，stdout 输出 JSON，非零退出码传回 CLI。WebCLI 原样传递参数，样例特意验证 schema 写 integer 时字符串 `"007"` 仍保持字符串。

已分类为写命令的 Adapter 必须声明 `safety: "write"` 并经过统一确认门；不能另建安装目录、注册表或绕过 Profile。网站探索agent当前生成的新命令暂时统一声明 `safety: "read"`，写语义分类规则待后续确定，这个值不能作为无业务副作用的保证。生成器应产出完整 v2 包，再走统一安装管理器；UI、Skill 调用入口统一为 `webcli call <adapter-id>.<tool-id>`。

仓库根目录下复现（PowerShell）：

```powershell
$env:WEWORKER_TEST_CLI = (Resolve-Path webcli/index.js).Path
node --test extension/test/toolkit-managed.acceptance.mjs

# 构建后从临时工作目录调用打包 CLI，验证不依赖源码 cwd。
$env:WEWORKER_TEST_CLI = (Resolve-Path weworker/dist-app/win-unpacked/resources/webcli/webcli.cjs).Path
node --test extension/test/toolkit-managed.acceptance.mjs

$env:WEWORKER_TEST_BROWSER = 'C:/browser-fixtures/chrome/chrome.exe'
node --test extension/test/adapter-script-loader.browser.mjs

node weworker/scripts/adapter-desktop-acceptance.mjs weworker/dist-app/win-unpacked
```

浏览器路径需替换为本机测试浏览器。Toolkit 运行前须完成对应 Profile 的 embedded Runtime 构建。内部版必须使用内部官方构建入口。macOS 应用内 CLI 位于 `Contents/Resources/webcli/webcli.cjs`；可用同一 Toolkit 测试验证，桌面启动器目前仅支持 Windows。

## 仍需人工或对应环境完成

1. 在一次性 Windows 测试机/虚拟机执行安装、启动、升级、卸载及重装；当前仅生成安装器并验证其打包目录中的程序，未改变现有安装。
2. 在 macOS 构建并验收安装资源、启动、Toolkit、关窗后后台继续运行及真正退出清理。本机没有 macOS 执行环境。
3. 使用测试账号和模型配置完成客户端 API 探索的真实页面捕获、生成、预览、确认安装及正式调用；现有真实浏览器 fixture、真实 Worker/mock 与 UI 入口验证不是该产品全流程。
4. 内部未选中草稿包已按用户确认删除，此项已关闭。
5. 审阅提交后批准推送/合并，提供同事可拉取的明确基线；没有执行推送、合并或发版。

真实业务站点写操作需要独立选择测试目标和授权，不能从模拟测试推导为已通过。Toolkit 自动探索本身由负责同事在基线交付后改造和验收。
