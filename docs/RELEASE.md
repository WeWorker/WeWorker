# 发布指南

本文说明 WeWorker 公开桌面版本的发布流程。正式版本从对应的 `release-X.Y.Z` 分支上已经合并并验证的提交创建；桌面安装包发布与官网部署是两个独立操作。

## 发布触发方式

桌面版本使用 `.github/workflows/release-desktop.yml`（GitHub Actions 中显示为 **Release Desktop**）手动构建：

1. 打开仓库的 **Actions → Release Desktop → Run workflow**。
2. 在 **Use workflow from** 中选择对应的 `release-X.Y.Z` 分支。
3. 输入尚未创建的版本 Tag，例如 `v1.0.1`。
4. 启动 workflow，等待 Windows x64、macOS arm64 和 macOS x64 全部完成。

普通代码 push 和 Tag push 都不会触发该发布流程。不要在运行 workflow 前手工创建或推送 Tag；流程会拒绝已经存在的 Tag 或同名 Release，并在构建成功后创建 Draft Release。

## 版本与分支规则

正式版本分支和 Tag 使用：

```text
release-X.Y.Z
vX.Y.Z
```

例如：

```text
release-1.0.1
v1.0.1
```

构建测试或候选版本可使用预发布 Tag：

```text
vX.Y.Z-rc.N
```

例如 `v1.0.1-rc.1`。预发布 Tag 复用相同基础版本号；`v1.0.1-rc.1` 要求 `weworker/package.json` 的版本仍为 `1.0.1`，生成的 Draft Release 会标记为 prerelease。

发布前必须确认：

- PR 已合入对应的 `release-X.Y.Z` 分支。
- Actions 页面选择的 workflow 分支就是该 `release-X.Y.Z`。
- `weworker/package.json`、Renderer、Backend、官网、扩展、指标服务和变更记录中的产品版本一致。
- 输入 Tag 与产品版本一致。
- Tag 和同名 Release 尚不存在。
- 拟发布提交是经过确认的完整提交；不要从旧 SHA 或其他分支启动 workflow。

## 标准发布步骤

1. 合并所有发布准备 PR，并记录最终 `release-X.Y.Z` SHA。
2. 确认工作区和远端 `release-X.Y.Z` 指向同一提交，版本账本检查通过。
3. 在 Actions 页面从 `release-X.Y.Z` 手动运行 **Release Desktop**，输入 `vX.Y.Z`。
4. workflow 锁定本次运行的不可变 source SHA，并构建：
   - Windows x64：NSIS `.exe`、`.blockmap`、`latest.yml`
   - macOS arm64：`.dmg`、`.zip`、`.blockmap`
   - macOS x64：`.dmg`、`.zip`、`.blockmap`
5. workflow 汇总 `SHA256SUMS.txt`、`provenance.json` 和自动更新元数据，创建 Draft Release。
6. 将 `docs/releases/vX.Y.Z.md` 的发布文案更新到 Draft，填写实际 SHA、包大小、签名/公证状态和校验结果，删除占位符。
7. 核对 Draft 的 `provenance.json` 中 `sourceSha` 等于最终发布提交，安装包和校验和完整。
8. 维护者确认后手动发布 Draft Release。正式 Tag 在 Release 发布时创建；发布后禁止移动或覆盖。
9. Release 公开可下载后，再单独构建和部署官网，验证下载链接与分享卡片。

## 已存在 Draft 的处理

同一个 Tag 已有 Draft Release 时，`Release Desktop` 会在 source SHA 检查阶段拒绝继续，避免覆盖已有资产。

- 如果 Draft 已基于最终提交且资产、校验和、provenance 均正确，更新文案并审核后发布。
- 如果 Draft 基于旧提交或资产已过期，不能直接发布，也不能用新构建静默覆盖。取得明确授权后删除旧 Draft，再从最终 `release-X.Y.Z` 提交重新运行 **Release Desktop**。
- 删除 Draft、创建或推送 Tag、发布 Release 都属于发布变更，必须在执行前单独确认。

## 安装包验证

发布前至少确认：

- `provenance.json` 的 source SHA、版本和 Tag 正确。
- `SHA256SUMS.txt` 与全部上传资产逐项一致。
- Windows x64、macOS arm64、macOS x64 安装包和自动更新元数据齐全。
- 安装包能正常安装和启动，应用显示版本号与 Tag 一致。
- 浏览器扩展资源存在并能连接桌面端。
- 内置 Adapter 清单能正常加载。
- 网站探索agent入口能启动或正确显示状态。
- Windows/macOS 的签名与公证状态已如实写入 Release 文案。

## 失败处理

- 构建失败时不要手工创建 Tag 或发布不完整 Draft；先查看失败 job 和日志，修复后通过 PR 合入发布分支。
- workflow 未创建 Draft 时，可以在同一最终提交上重新运行同一个 Tag。
- workflow 已创建 Draft 后，先按“已存在 Draft 的处理”判断是否可继续使用。
- Release 已经公开后，不得覆盖同名 Tag 或替换同名安装包；需要修复时发布新的补丁版本。
- 官网部署失败不回滚或修改桌面 Release；两者分别处理和验证。
