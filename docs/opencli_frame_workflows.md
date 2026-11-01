# B01 frame 只读工作流

公开运行时提供 `page_workflow_frames_v1`。生成命令仍通过 `webcli call <adapter>.<tool>`，使用选定 profile 和固定主 tab。内部客户端继承公开运行时；内部独立重打包或已安装客户端是否包含新能力，须另行核验产物。

## 声明

```json
{
  "mode": "workflow",
  "timeoutMs": 30000,
  "steps": [
    {
      "pathname": "/entry",
      "query": {"mode":"read","result":{"strategy":"UI_SELECTOR","selector":"h1","fields":{"title":{}}}}
    },
    {
      "frames": [{"selector":"#reports","origin":"https://example.org","pathname":"/reports"}],
      "pathname": "/reports",
      "query": {"mode":"read","result":{"strategy":"DOM_STATE","path":["publicResult"]}}
    }
  ]
}
```

先在 `exploration.start.allowedOrigins` 声明 `https://example.org`。`frames` 按外到内列出 1–8 层，只有 selector/origin/pathname 三个字段。origin 和初始 pathname 精确匹配；浏览器临时 frame/document ID 不进入生成包。

同一 selector 链只解析一次，后续步骤保留原始完整声明。每个上下文独立衔接 pathname/origin，跨源目的地只允许显式 navigate.resultOrigin；下一步显式声明当前 origin。主文档及各 frame 可交替读取，when 使用上一个实际执行步骤的结果；循环、去重、收集上限和整体 30 秒预算沿用既有契约。

workflow 内的 read 无副作用且保持当前路由。query/filter 保留原生搜索/筛选/翻页语义检查，click 使用真实指针投影，Enter 保留原焦点控件。导航/query 只派发一次，提交后验证结果和文档；hash 需结果关联和业务刷新字段，相同完整地址只重载叶文档。

## 身份、权限和修复

运行时通过原生 owner 节点及 Chrome 文档身份关联上下文，不按 URL 或 frame 索引猜测。每个 owner、src/srcdoc、祖先文档及完整 URL 均保留；同 URL 的 owner 替换也拒绝。只有明确发起的导航能更新原叶文档，祖先或 owner 不随导航重新解析。OOPIF 跨进程导航可能不返回旧会话的 CDP 响应，因此可用同一 frame 的导航事件确认派发，随后验证所有 owner 和精确目的文档；不补发导航。

主 tab 选择只使用主文档路由；包 match 和审阅权限则包括所有祖先、叶节点及目的主机与精确 origin/端口/路径。旧 profile 缺 capability 时在派发前拒绝，不切换 profile。取消/断线/超时锁存终止状态，迟到回复不触发下一动作，清理有独立短预算且只针对原对象。

生成、作者断言、review/install、普通调用、knowledge 和 scoped repair 共享完整契约。结果提取可修复，owner 链、动作、参数、路由和控制流不能借 repair 改动。作者 cases 必须重新执行。

## 验收入口

- `webcli/scripts/verify-page-frame-context.mjs`：基础身份、同 URL 替换、父文档替换、取消、无关加载 frame。
- `webcli/scripts/verify-exploration-browser.mjs --frames-only`：真实 CLI/Bridge/扩展全链路，公开双 origin fixture，重复 owner、嵌套 frame、原生控件、跨源/hash、循环收集、生成安装、知识和修复、取消及任务 Bridge 重启。
- 加 `--bundled-cli --bundled-bridge` 验证桌面双打包入口；当前 Chrome 需 `--cdp-extension`，只在临时 profile 加载扩展。

实际结果和失败记录见 [上下文审计](opencli_workflow_context_audit.md)。这不关闭 W 系列 frame 写、自定义控件、其他浏览器或安装包分发验收。
