# WeWorker v1.0.1 推广准备清单

该清单记录不能仅靠代码 PR 完成的仓库设置、发布和传播准备。它不授权创建 Tag、发布 Release 或部署官网。

## 分支与发布基线

- [ ] 本 PR 合并到 `release-1.0.1`。
- [ ] 确认 `release-1.0.1` 已包含本次推广与发布准备改动。
- [ ] 确认拟发布 commit 和所有 `1.0.1` 版本账本一致。
- [ ] 旧的 `release-1.0.0` 是否保留或删除由维护者单独确认；禁止强制移动已有发布分支。
- [ ] 创建 `v1.0.1` 前再次确认 Tag 指向审核通过的发布提交。

## GitHub 仓库设置

- [ ] Homepage 设置为 `https://www.weworker.cc`。
- [ ] Topics 至少包含：`ai-agent`、`browser-automation`、`desktop-agent`、`web-automation`、`electron`、`adapter`、`local-first`、`chrome-extension`、`llm`、`open-source`。
- [ ] 使用 `officialWeb/public/social-preview.png` 更新 GitHub Social preview。
- [ ] 保持 Discussions 开启，并发布 Announcements、Q&A、Adapter 需求和 Show and tell 的首批内容。

## Release 页面

- [ ] 以 [`docs/releases/v1.0.1.md`](releases/v1.0.1.md) 为底稿更新真实 Release 页面。
- [ ] 填写 Release commit、签名/公证状态、实际文件大小和校验和核对结果。
- [ ] 核对 Windows x64、macOS x64、macOS arm64 三个安装包均存在。
- [ ] 核对 `SHA256SUMS.txt`、`provenance.json` 和自动更新元数据。
- [ ] 删除文案中的所有“发布前填写”和占位符。

## 官网与下载

- [ ] `v1.0.1` Release 真实发布后再部署 1.0.1 官网，避免 `latest/download/WeWorker-1.0.1-*` 在发布前返回 404。
- [ ] 验证首页、下载页、文档页和一个 SPA 子路由。
- [ ] 验证三个平台下载链接、GitHub Star 入口和 Discussions 入口。
- [ ] 验证 Open Graph 图片可公开访问，分享卡片显示为大图。

## 推广素材

- [ ] 完成 [#220](https://github.com/WeWorker/WeWorker/issues/220)：录制 10–20 秒 README GIF，并准备脱敏推广截图。
- [ ] 录制 45–60 秒真实产品视频，优先使用无需私人账号数据的公开网站场景。
- [ ] 准备桌面对话、Adapter 支持和跨站结果三张脱敏截图。
- [ ] 所有素材不得出现 API Key、Token、Cookie、私人账号、邮件、订单、用户目录或真实私人数据。

## 社区承接

- [ ] 发布 `WeWorker v1.0.1 正式发布` Discussion。
- [ ] 发布 `你希望下一个支持什么网站？` Discussion。
- [ ] 完成 [#219](https://github.com/WeWorker/WeWorker/issues/219)：发布安装与首次使用 FAQ。
- [ ] 准备 5–10 个带 `good first issue` 或 `help wanted` 的可认领任务。
