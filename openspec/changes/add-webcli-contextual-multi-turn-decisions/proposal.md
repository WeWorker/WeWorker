## Why

WeWorker 先尝试正则路由，未命中时将用户输入交给 `webcli route`，再由文本模型处理推荐结果。原 route 只处理单次输入；后续“查看第二条”“修改这条”需要主 Agent 重新理解结果、查找标识和拼装参数，增加等待与模型成本。

让 route 利用 WebCLI 管理的最近三轮上下文作有限决策，返回精确的既有 call 调用。既可被 WeWorker 使用，也可由其他 Agent 或命令行独立连续调用。

## What Changes

- `--new-context` 随机生成 UUID，后续 `--context <id>` 自动读取本机状态，无需手传 JSON 文件。
- 从实际原始结果采集少量对象和动作参数，按真实展示顺序解释序号；最多追溯三轮，歧义或缺参时保留对象并澄清。
- Adapter 用 `results` 声明结果路径、身份、动作和参数来源；包括新业务参数 inputs 及条件 variants，不让模型生成身份或自由命令。
- route 只决策；call 保留 Extension、HTTP、Toolkit 既有执行入口、参数类型和业务输出。
- 本地私有文件实现版本、锁、原子替换、容量、过期、轮转、清理与崩溃恢复；未决派发事实独立保留。
- 写命令派发前保存 guard；导航准备通过可信执行回执区分，防止准备阶段锁死或未知结果被重复执行。
- 全部公开 Adapter 分类及 mock 执行验证。WeWorker 客户端联调、真实模型效果、真实站点业务验收后置，不作为 WebCLI 实现前置条件。

## Capabilities

### New Capabilities

- `webcli-context-sessions`: UUID、本地私有存储、三轮、过期、容量、锁与恢复。
- `webcli-result-action-bindings`: 跨包格式声明式结果与动作参数绑定、展示、指纹。
- `webcli-contextual-routing`: 有限对象/动作选择、确定性序号、低成本 choice、澄清续接。
- `contextual-plan-handoff`: 决策/调用关联、写派发事实、导航准备与已知执行边界。

### Modified Capabilities

无。

## Impact

修改 WebCLI CLI/目录/结果采集/包文件清单、Extension/Bridge准备回执，以及公开 Adapter 声明和必要身份提取。无新增依赖、数据库、常驻上下文服务或合并 Runner。嵌入式宿主暂不支持 context，必须派发前明确拒绝。

原部署资产在受控环境单独接入；旧基线证据不作为当前公开源码证据。详见设计、任务及 `docs/webcli-context-verification.md`。
