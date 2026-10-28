# 网站探索agent子目录规范

## 范围

本目录是 WeWorker 中网站探索agent的实现源码目录，不作为独立仓库或独立产品迭代。

源码中可以沿用既有包名、路径和命令名；用户侧文案、UI、公开文档统一使用「网站探索agent」，不得暴露 `webwright` 名称。

## 开发约定

- 当前只维护 Python harness；`skills/webwright/` 仅保留为备份或兼容资料，默认不迭代。
- Python harness 位于 `src/webwright/`，与 `skills/webwright/` 是独立实现，不互相加载运行时代码。
- 当前只关注 `local_browser + local_cdp` 模式，其他模式不作为默认维护范围。
- Python 环境由 `uv` 管理；在本目录执行 Python 命令时使用 `uv run python`，不要使用系统 `pip` 修改环境。
- 持久数据固定写入 `~/.weworker/webwright/`；不得读取、迁移或清理旧 `~/.webwright`。
- WeWorker 托管模式统一通过宿主 WebCLI 控制通道获取 Bridge 浏览器实例、任务占用和页面锁；每次执行获取当前地址，禁止 Python 自行启动另一浏览器。状态查询不拉起浏览器，Toolkit 普通调用不依赖探索服务。

## 验证

- 修改 harness 行为时运行对应聚焦测试。
- 修改嵌入式运行时、构建入口或分发资源时，同时检查 `distribution/AGENTS.md`。
