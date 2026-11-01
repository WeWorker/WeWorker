# 后台 API 探索与页面依赖

2026-10-26 验收口径：分别记录“用户无需手动开页”“宿主创建/复用业务页”“完全后台无业务页”。PAGE_FETCH 可能满足第一项，不能仅凭它使用页面就判定查询失败；PUBLIC_API/EXTENSION_API 的声明也不能代替实际证明。检查当前 Adapter 的 source/version/digest 与 runtime/execution，只关闭测试任务自有标签页后执行普通调用，记录是否创建新页或回退。此次本地公开排行榜夹具的 HTTP 工具在零业务页时通过新会话查询，细节见 [交接记录](api_exploration_cli_handoff.md)。

2026-10-18：通用流程修正。开源与内部仓库复用同一 CLI、Bridge、Extension 与生成/验证/修复实现，差别留在 Adapter 内容和对应打包范围。内部源码只用于核对现有能力，本文件及验收使用公开占位站点。

## 为什么修正

此前 analyze 对成功接口默认推荐 PAGE_FETCH，生成没有显式入口复用 Extension 后台运行器；包生成遗漏 execution 元数据，运行验证也默认在页面预览。基础 Skill 还要求调用任何 Adapter 前打开网站。这些流程不能正确表达已有的后台 API 能力。

鉴权需求与页面需求分开判断。公开 HTTP、宿主凭据、浏览器 Cookie、后台已初始化的 storage 缓存都可能支持无需业务页的请求；页面签名、控件或 DOM 仍可采用相应页面策略。一次无 Authorization 的请求失败不构成必须使用页面的证据。

## 实现

- analyze 列出 PUBLIC_API、AUTH_API、COOKIE_API、EXTENSION_API 和页面候选，要求 Agent 核对鉴权/页面依赖；为旧调用保留省略策略时的 PAGE_FETCH 兼容行为。Skill 要求作者显式选择，不把默认值当事实。
- EXTENSION_API 是新的**探索计划策略**，复用现有 `runtime:extension` 与 `execution:{type:api,runtime:background}`，没有新增业务 Runner。只读骨架需要 Agent 实现请求/鉴权/字段映射与 schema，标记 authored 并提供作者 cases；不猜测或固化捕获凭据。
- 包生成保留 execution 元数据；既有包增量保留模块字节和命令契约。repair 要求后台命令保持 EXTENSION_API，保留安装基线/权限/运行时，拒绝改用页面策略。HTTP 和页面的原有执行能力继续保留。
- validate 按选定命令实际运行时分流，混合包分别验证。后台验证要求选定插件支持 `background_preview_v1`，走与普通调用相同的 managed offscreen 生命周期，无网站 tabId、查页或注入；来源页关闭后仍可验证。旧插件/缺作者 cases/缺执行回执不能放行。
- 预览仅允许 cookies_get、缓存限定 storage_get 和 backend_fetch。Cookie 不借页面调试器，storage 不打开/读取业务页；API 鉴权失败不回退 browser_fetch。Bridge 在派发前复用只读语义判定，支持 GET/HEAD、已识别 JSON/form POST 与 GraphQL query，拒绝写操作/方法覆盖/凭据 URL/重定向，失败不进入 curl 或浏览器重放；响应有界且不记录原请求/响应正文。
- 每后台 case 使用独立 offscreen 生命周期、30 秒执行预算、最多 50 helper 请求；一条验证消息一个 case，下一 case 派发前检查取消。已派发只读请求可能完成，取消丢弃结果，不自动重试。受信任作者 JS 的 helper 边界不是恶意代码沙箱。

安装后的既有后台 API 传输兼容行为没有被替换为上述预览限定；新作者应显式设置 `browserFallback:false`，并验证普通调用确实不新开网站页。已有后台实现是否使用 fallback 或页面缓存补读，必须逐命令核对，不能仅凭 execution 字段承诺完全无页。

## 验收与限制

可复跑入口：`node webcli/scripts/verify-exploration-browser.mjs --background-only --playwright=<本地路径> --chromium=<隔离 Chromium 路径>`；支持 `--bundled-cli --bundled-bridge`。测试启动任务自有 Chromium、临时 Bridge、独立用户目录和 loopback 服务；公开 Cookie 转 Authorization，模拟 5h/week 查询，不操作真实账户或日常浏览器。

覆盖生成/作者 cases/关闭业务页后验证/审阅安装/重复普通调用、GET 与 JSON 只读 POST、页面与后台混合验证、增量保留、字段漂移失败与定向修复、禁止改成页面策略、Bridge 重启、缺 Cookie 零请求/零新页面。最终 WebCLI 1464 项、扩展相关 53 项、完整 Chromium 1217 双打包 114 项、后台最终专项 8 项及独立 HTTP 双打包 24 项通过。精确报告和失败修正记录见交接末尾，未通过的运行不计验收。

登录态缺失仍需恢复登录；storage 冷缓存、浏览器冷启动、外部真实网站的复杂签名/OAuth、其他系统和独立 Agent 对话没有由此验证。后续 GLM 专项已按用户要求删除旧页面版并从新观察重建：显式准备组织/项目缓存后，全部业务页关闭时的真实后台验证、普通调用和 Bridge 重启查询通过，见 [实站报告](glm_quota_adapter_validation.md)。仅 Authorization 的成功响应不足以证明数据口径正确；组织/项目等上下文也须核对。页面准备使用 task-local helper，普通后台查询明确 cacheOnly，账号或上下文切换后重新准备。该结果不证明浏览器冷启动、真实登录过期恢复或其他站点全部可用。完整 OpenCLI 余项和整体暂停状态保持。
