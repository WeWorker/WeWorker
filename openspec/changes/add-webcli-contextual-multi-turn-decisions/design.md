## Context

这是一层 Agent 执行前的命令决策辅助。正则先处理明确入口，route 用低成本决策选择已展示对象与已声明动作，文本 Agent 接手解释、新话题及不支持的复杂请求。省时/省 token 是设计目标，尚无真实模型对照数据，不宣称已测收益。

## Goals / Non-Goals

目标：独立 CLI 多进程连续调用、自动 UUID、三轮上下文、精确对象与原始参数类型、全部公开包合理分类、可验证的 mock 端到端链路。

不增加自由命令执行器、模型生成业务 ID、跨来源复杂批量、远程会话服务或全局 exactly-once。WeWorker 集成和真实站点/模型验收按用户要求后置。嵌入式宿主 context 当前明确不支持。

## Decisions

### 1. CLI 与职责

`route/call --new-context` 创建随机 UUID，回执提供 contextId；后续调用带 `--context <id>`。未带 context 不猜“最近会话”。route 输出 resolved/needs_input/handoff/unrelated；resolved 是绑定结果，不是业务成功或授权。call 原样交给独立 Runner。业务 yes/confirm/execute 沿用 schema，不新增通用确认关卡；退役的顶层 __confirmed 不传业务。

call 的业务 stdout 保持原合同；独立 stderr `WEBCLI_CONTEXT` 回执报告来源、快照、展示清单、执行事实和存储结果。decision/step 自动关联当前精确匹配；显式迟到标识拒绝。

### 2. 结果与展示

Adapter 的 commands[].results、旧 Toolkit tools[].results、旧 Extension command_metadata 归一到共享编译器。点分路径读取 item/query 或 JSON 常量；目标必须同 Adapter、可用且明确 safety。inputs 只收集 schema 声明的新参数，不覆盖对象身份，不由模型填值；多字段/数组/数字保持显式 JSON 类型。variants 按真实对象类型选择目标，不能把公开作品 ID 送进创作者删除。

原始输出完整保留；最多绑定前20条并标明截断。管道/Agent消费先 staged，由调用方报告实际展示顺序和范围后才允许序号选择。终端同源渲染交付成功后登记；不能从自由改写的文字推断序号。源/目标实现与元数据指纹改变要求刷新。

### 3. 决策

完整封闭语法优先；“查看第二条”直接绑定已展示第二项，不多问确认。否定、附带要求、混合动作不能只执行熟悉子句。当前焦点/展示优先，明确历史引用才追溯，歧义澄清；不得偷偷切换到旧的可操作列表。

自然表达最多两阶段 choice（来源、动作/范围）；保留 NONE/NEEDS_INPUT/HANDOFF。最多24选项、16KiB候选、8KiB输入、3秒总等待，不重试。概率完整、有限、归一化且唯一首选，至少0.85才采纳；分数不是准确率或权限。澄清绑定 clarificationId、源轮次、展示版本和指纹，过期/换题/迟答失效。

### 4. 文件、读取和生命周期

固定 `~/.webcli/contexts/v1/`，合法ID为 `[A-Za-z0-9_-]{1,128}`，SHA-256文件名。状态含 storageVersion/sessionEpoch/revision、三轮、快照、焦点、pending与operationGuards。上下文包含有限业务摘要/绑定参数，仍是本机敏感数据；不保存完整原始结果或持久授权，不承诺同OS用户进程隔离。

POSIX私有权限，Windows验证私有ACL；拒绝链接/非正常文件。每会话排他owner锁、同目录唯一tmp、flush/关闭/原子替换，绝不先删主文件。故障不覆盖坏文件/未知版本；只在证明旧owner死亡后恢复，dispatching转unknown，不重放。

当前输入最多检索之前三轮；关联call归同轮，直接call记工具轮。焦点和pending保留原来源，不复制续命。24小时闲置过期、30分钟证据有效；无未决操作的明确新查询可同ID新epoch重建。最多20对象、48KiB/轮、256KiB/文件、20个/16KiB guards、1000主文件/256MiB、全部制品512MiB。满则拒绝，不能丢未决事实。

事务成功后机会式执行GC，每15分钟最多一次，每批50候选或100ms并保存游标，锁内重查。无未决操作的过期状态先去正文留标记，7天后可回收；GC失败不改写已完成的业务结果，但维护检查可能增加CLI尾延迟；无CLI运行不承诺后台定时删除。status/recover/prune --dry-run提供最小维护入口。

### 5. 写派发和导航准备

写调用先落盘dispatching再派发；落盘失败不执行。成功回执记acknowledged而非verified_success；错误/断连等可能已执行则unknown，同context拒绝重放。最终保存失败分别报告业务结果与存储失败，保留未知事实。

Adapter在任何业务副作用之前需要打开页面时可声明导航phase=prepare。扩展验证write、resume=false和URL白名单，导航成功后产生业务体之外的可信execution.phase=prepared。Bridge透传；CLI仅凭该回执记录prepared/未派发，允许相同步骤继续。业务status/自报dispatched不能解除guard；已点击/已提交之后的跳转不得声明prepare。

防重只覆盖当前context，换context/raw call不受全局去重承诺。真实业务资格、事务一致性和结果核验仍归业务系统及宿主。

## Risks / Trade-offs

- Windows ACL检查及文件事务会增加延迟；必须以真实执行测量，不靠架构推断收益。
- 未决写事实会阻止自动重试和回收，保护重复操作但可能需要人工核验。
- 上限与三轮窗口会产生明确澄清/交接；不能偷偷扩大范围或丢掉失败项。
- 公开包分类并非真实站点认证；原部署资产和当前公开基线分别验证。

## Migration Plan

保持无context入口兼容；先更新运行时/扩展，再更新Adapter声明并刷新旧证据。旧扩展缺可信准备回执时按unknown处理。新宿主模式返回context_host_unsupported，不忽略参数继续执行。最终公开打包必须包含当前运行时、扩展和Adapter制品，测试证据绑定最终基线。
