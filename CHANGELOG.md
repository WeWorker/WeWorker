# 更新日志

本文件记录 WeWorker 自首次开源发布起的用户可见变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。内部开发历史不纳入公开版本记录。

## [未发布]

### 优化

- API 探索默认直接生成并验证只读工具，具体草稿错误最多触发一次限时智能修复，复杂任务保留智能生成入口。
- 探索预加载证据与指引，确认目标接口后直接结束分析；改进响应验证、补采回放保留与已有工具包的增量安装。

## [1.0.0] - 2026-09-14

### 新增

- 提供基于 Electron、React 和 TypeScript 的桌面应用。
- 支持通过自然语言调用网站 Adapter 完成网页操作。
- 提供统一的 `webcli call <adapter-id>.<tool-id>` 命令入口。
- 提供网站探索agent，用于探索网站并辅助开发网站工具。
- 提供定时任务、站点记忆和多渠道通知能力。
- 首次公开版本内置 QQ 邮箱、163 邮箱、Gmail、京东、闲鱼、1688、GitHub、Gitee、小红书、微博、Twitter/X、B 站、知乎、掘金、贴吧、V2EX、豆瓣、36氪、微信读书、雪球、BOSS 直聘、携程、12306、前程无忧、有道云笔记、大众点评、抖音、Hacker News、Wikipedia、今日头条、什么值得买、arXiv、诺诺网发票等网站 Adapter。

### 安全与隐私

- 清理内部系统、内部网络、内部业务资料及固定凭据信息。
- 指标上传改为显式配置并默认关闭。
- 默认将应用数据和网站探索agent持久数据保存在用户本地目录。

### 说明

- 这是 WeWorker 重新初始化开源仓库后的首个公开版本。
- 开源仓库不继承内部仓库的 Git 历史和内部版本记录。

[1.0.0]: https://github.com/WeWorker/WeWorker/releases/tag/v1.0.0
