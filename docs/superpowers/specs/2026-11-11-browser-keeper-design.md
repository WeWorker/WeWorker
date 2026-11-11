# Browser Keeper:浏览器与 Bridge 生命周期解耦 设计

日期:2026-11-11
分支:`feat/browser-keeper`(基于 fix/webcli-webgo-port-3713,依赖其 breakaway 机制)
范围:webgo/npm 发行版;desktop(3711)不动。

## 背景与目标

WorkBuddy 用 Job Object 圈住子进程并在命令结束时整树回收,且黑名单拦掉 schtasks 等常规
脱离工具。1.0.8 已用 PowerShell P/Invoke breakaway 让 bridge daemon 脱离 Job;但 bridge
管理的 Chrome 是 bridge 子进程(pipe fd 3/4 持有),bridge 死 → pipe EOF + Job 回收双杀
→ 浏览器死。登录/扫码等人工操作被中断,这是当前主要痛点。

目标:bridge 可以随命令短命,但**浏览器常驻**(纯显式退出),登录会话全程不中断。

## 现状关键事实

- Chrome 以 `--remote-debugging-pipe` + `--remote-debugging-port=0` 启动;pipe EOF 时
  Chrome 退出(design 注释明示);动态 port 写 profile 下 `DevToolsActivePort` 文件;
- 扩展业务操作走 bridge↔扩展 WebSocket(3713),不依赖 pipe;管理 CDP(截图/窗口/扩展
  刷新)可走动态 port 的 browser-endpoint websocket;
- keeper 脱离 Job 后,其子进程 Chrome 天然不在任何 Job 里。

## 设计

### 进程模型

```
命令(短命) ─breakaway─> keeper(node --browser-keeper,常驻)
                            └─ spawn Chrome(pipe fd 3/4 由 keeper 持有)
bridge(每次命令重新起)
  └─ attach:读 DevToolsActivePort → ws 连 /devtools/browser/<id>(验证 profile 归属)
     失败/超时 → breakaway 启动 keeper → 轮询 discovery → attach
```

- keeper:跑 BrowserHost 的 spawn 模式(现 _startInternal 全流程:pipe CDP 加载扩展、
  createTarget、discovery),生命周期纯显式(`browser stop` / `service stop`);
- bridge:BrowserHost 的 attach 模式——不 spawn,连接已有 Chrome 的 browser endpoint,
  获得 **ws 版 CDP client**(协议消息与 pipe 版一致:JSON {id, method, params, sessionId});
  截图/窗口/扩展刷新全部经 ws CDP;
- bridge 死:不杀任何东西;下条命令重启 bridge → attach 同一浏览器 → 扩展 service
  worker 重连 bridge → 会话无感恢复;
- `browser stop`:bridge 经 ws CDP 发 `Browser.close` → Chrome 退 → keeper 的
  _handleExit(stopping 标志)→ keeper 自退。

### attach 归属验证

复用 discoverCdpEndpoint 的文件+endpoint 校验(DevToolsActivePort 两行内容 + /json/version
的 webSocketDebuggerUrl path 匹配),但**不校验 targetId**(那是 spawn 本次验证用的)——
附加 profile 归属校验:instance.json 的 token 经 CDP 读扩展 storage 比对(与
markExtensionInstance 同源),防连到无关浏览器的同名端口。

### 兼容与回退

- desktop(3711)完全不动;keeper 只在 isolated 发行版(webgo/npm)启用;
- keeper 启动失败(breakaway 被更深层拦截等)→ bridge 回退 spawn 模式(现状行为,
  Chrome 随 bridge 死),报 status detail 提示;
- pipe CDP 与 ws CDP 统一为一个接口(send/onEvent/close),BrowserHost 不感知传输层。

## 测试

- ws CDP client:send/onEvent/多 session/close(pipe 协议等价);
- attach 探测:DevToolsActivePort 读取/验证/失败重试/归属校验;
- keeper 分支:index.js --browser-keeper 启动 BrowserHost 并常驻;Browser.close → 退出;
- bridge 解耦:shutdownBrowser(keeper 模式)不关浏览器;browser stop 显式关闭;
- 集成:webgo 环境 start → browser show → 强杀 bridge 进程(模拟 Job 回收)→ Chrome
  存活 → 新命令 attach → call 正常。

## 明确不做

- 不做 keeper 空闲自退(纯显式退出);
- 不改 desktop;
- pipe 传输不删除(spawn 模式 keeper 内部仍用)。
