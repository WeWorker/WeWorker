# 共享浏览器实施记录

日期：2026-10-27。

[原始实施方案](shared_browser_implementation_plan.md) 为用户提供的原文快照，保持逐字节一致。其末尾「尚未实施」描述的是生成方案时的状态；本记录与两级 Roadmap 描述实施后的状态。

## 已实现

- Bridge 沿用既有 WeWorker 浏览器 Profile，同时启用 CDP Pipe 和本机动态调试端口；通过 Pipe 新建目标与 HTTP 目标清单交叉验证本次端点，拒绝遗留发现文件指向其他浏览器。每次启动生成新的实例标识。
- 内部 `shared_browser` 协议支持 `status`、`acquire`、`claim`、`release`。占用归控制连接所有，连接结束自动释放。相同 Toolkit 状态路径先取得排他占用；页面通过实例、CDP 目标和扩展标签页身份协调，兼容既有浏览器命令／探索页面锁。
- Python 通过宿主 WebCLI 的 `--internal-browser-control` JSON 标准输入／输出通道取得地址，Playwright 仍直接连接浏览器。控制实现保留在公共 Runtime 内，历史独立导出仍保持源码自包含；不增加 Python WebSocket 依赖。
- 覆盖探索、继续探索、浏览器查询／打开、正式调试、开发中调试、回放、CLI 直接 Toolkit 调用和 Bridge 内部 Toolkit 调用。托管模式禁止自行启动浏览器；只读查询不启动 Bridge 或浏览器。
- Toolkit 页面和状态继续跨调用复用；记录浏览器实例标识，实例变化后不使用旧绑定。已识别的自带旧启动器的历史 Toolkit 返回升级要求。
- Extension 普通页面命令在导航和执行前取得页面占用；后台命令仅取得任务占用，保持无需业务页的运行方式。观察／对话框回应保留原有不阻塞操作的规则。
- 活动任务阻止空闲回收、普通停止、重启及模式切换；显示状态保护人工查看。任务异常不自动重放操作，控制连接退出释放资源。并发首次 CLI 启动只有成功监听端口的 Bridge 写入 PID。
- Electron 正常退出和更新安装都先结束探索／Backend，再清理自己拥有的 Bridge／浏览器。外部 Bridge 的所有权规则保持不变。

## 已验证

本机为 macOS arm64，Chrome 156.0.8078.48，锁定 Playwright 1.60.0。

- 隔离双接口探针通过扩展加载、Pipe 与 Playwright 操作同一页面和正常关闭。
- Node 聚焦测试 97 项、扩展测试 332 项、Electron 聚焦测试 16 项通过。
- Python unit 与 distribution 全量 282 项通过、4 项跳过；1 项失败为此前 Roadmap 已记录的自定义 OpenAI 完整 URL 被追加 `/chat/completions`，本次未修改该模型逻辑。
- CLI、Bridge bundle 与 embedded onedir 构建通过。打包 CLI／Runtime 真实验证：并发首次启动、两条 Toolkit 执行入口、连续页面复用、Toolkit／Extension 同页冲突、探索／正式调试／回放忽略旧端口、无业务页后台调用、长任务取消、忙碌时停止被拒绝、重启后的新实例及新页面。
- 在测试命令向自有本机服务提交一次请求后强制结束测试 Bridge，当前命令失败，Pipe 关闭使其浏览器退出；随后新命令能取得新实例，提交计数仍为一次，没有重放操作。测试结束后确认无该探针的 Bridge／浏览器进程残留。
- 测试使用独立临时数据目录、浏览器 Profile、Adapter 和本机测试页面，不读取旧探索 Profile，不关闭用户已有页面。

可复用探针：

```sh
node webcli/scripts/verify-shared-browser-transports.mjs
node webcli/scripts/verify-shared-browser.mjs
node webcli/scripts/verify-shared-browser.mjs --bundled --runtime=<isolated-build>/dist/Webwright/Webwright
```

## 验收边界

- 2026-10-28 PR 分支基于官方 `dev-1.1.0`：公开 profile 预处理通过；Node 聚焦 59 项、扩展与 Electron 合计 338 项通过；Python 聚焦 66 项通过，仍有上述既有 URL 测试 1 项失败。独立工作区已排除官方合入的调试大结果截断修复。
- 用户反馈启动桌面端时浏览器窗口直接显示，原因待定位。启动调用链未发现新增显示调用；隔离浏览器对比改造前后参数的窗口坐标一致，但未覆盖实际 Profile、扩展及完整桌面流程，不能排除本次改造影响。PR 保持 Draft，待完成该项调查和桌面验收。

- macOS x64、Windows x64、Edge 实机以及完整 Electron 桌面安装包交互待验收。
- 「我自己的 Chrome」模式保留 Extension 能力；需要 CDP 的调用提示切换至「WeWorker 浏览器」，不自动切换或启动另一实例。
- 旧探索 Profile 保留原地，不迁移 Cookie；只在旧 Profile 登录过的站点需在共享浏览器重新登录。
- 页面锁属于受支持执行入口共同遵守的协作规则，不是任意 CDP 客户端的权限沙箱。
