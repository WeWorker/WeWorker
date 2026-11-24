## ADDED Requirements

### Requirement: Existing desktop routing retains priority
普通桌面聊天 SHALL 保留现有确定性路由（含正则级联及按现有条件执行的本地批准路由）的顺序；仅在其筛选略过、未命中或执行失败且没有产出可用或已可见答复时，才进入 WebCLI 决策层。新增能力 MUST 服从现有 WebCLI 路由开关和权限，并且不得改变 IM、定时任务、专属 Bot 或外部 Shell 行为。

#### Scenario: Existing routing answers the turn
- **WHEN** 现有确定性路由给出答复
- **THEN** 结束本轮，不请求多轮决策或文本 Agent

#### Scenario: Existing routing does not answer
- **WHEN** 现有层筛选略过、未命中或派发失败，且没有发出可见答复
- **THEN** 开关开启且符合原有权限边界时进入决策层，不以追问正则是否命中作为额外条件

#### Scenario: Feature is disabled or entry is out of scope
- **WHEN** WebCLI 路由关闭，或入口为 IM、定时任务、专属 Bot
- **THEN** 不启用本功能的回执采集、展示登记或直答，保留原有链路

### Requirement: Single-turn recommendations remain advisory
无可用展示证据的首句及决策层判为无关的新话题 SHALL 保持单轮命令推荐的参考语义；不得因为推荐置信度高而自动执行单轮推荐。若多轮响应已包含单轮推荐，客户端 MUST 复用并避免在同一回合重复请求推荐。

#### Scenario: Agent receives a first-turn recommendation
- **WHEN** 单轮决策推荐一个命令
- **THEN** 文本 Agent 收到本轮推荐并按原有方法填参、执行与回复

### Requirement: Ordinals bind only to verified current display
客户端 SHALL 用后端同一会话／回合的可信结构化查询回执和实际交付给用户的可核对编号登记展示；没有唯一匹配的展示顺序、有效登记或当前快照时 MUST NOT 自动执行。桌面关联 SHALL 仅在当前进程保留；不得依赖普通 Shell 输出、Agent 自报、或用更早快照替代无法验证的当前列表。

#### Scenario: Actual displayed order is authoritative
- **WHEN** 可信结果中的对象已成功交付，且实际显示的编号和身份可唯一核对并登记
- **THEN** 「查看第二条」只能绑定到已登记的第二个展示对象，不能按原始结果的未展示顺序猜测

#### Scenario: Newer list has no trusted receipt
- **WHEN** 较早列表已有登记，但当前回复中的新列表来自普通 Shell 或无法可靠核对
- **THEN** 「查看第二条」交原有 Agent 链路，不自动操作较早列表

#### Scenario: Client restarts
- **WHEN** 旧聊天正文仍存在，但进程中的展示关联已丢失
- **THEN** 不从正文或 CLI 存储恢复旧列表的直答资格；登记新列表后才能再次直答

### Requirement: Contextual direct execution is single-object read-only
客户端 SHALL 仅对确定性绑定或通过现有 WebCLI 高置信校验的 `resolved` 决策派发直答：恰好一个当前已登记对象、一个步骤、完整且类型正确的参数、当前允许执行的只读直调命令且无需确认。不得把决策置信度或 `executionEligibility` 当作授权。可展示业务结果 SHALL 走桌面答复路径，不调用文本 Agent。

#### Scenario: Deterministic ordinal resolves a read
- **WHEN** 用户在有可信展示的列表后说「查看第二条」，现有路由未答出且确定性绑定合格
- **THEN** 只执行一次实际展示第二条的详情调用，直接答复，决策模型和文本 Agent 调用次数均为 0

#### Scenario: Decision model resolves a read
- **WHEN** 只有一个已展示对象，现有语法未确定性匹配，但决策模型通过现有高置信门槛并给出合格绑定
- **THEN** 后端用绑定参数执行一次并直接答复，不调用文本 Agent

#### Scenario: High-confidence result is not eligible
- **WHEN** 决策置信度足够但计划涉及多个对象／步骤、写入、须确认、无权限或参数不完整
- **THEN** 快捷路径不派发任何步骤；将相关上下文交给 Agent，原有权限与确认链路生效

### Requirement: Bounded single-attempt fallback preserves known results
新增多轮决策和详情调用 SHALL 各限制在 3 秒，整条新增直答路径 SHALL 限制在 8 秒，包含进程启动和收尾，不改变既有确定性路由、首句推荐或 Agent 的超时。未直答时，只要回合仍有效，客户端 SHALL 把相关上下文交还 Agent，不在快捷层澄清、重试或续调。已取得的可信业务结果 SHALL 作为有界参考交 Agent 复用；已答或取消不得再启动 Agent 补答。

#### Scenario: Decision is ambiguous or a stage times out
- **WHEN** 决策缺参、低置信、有歧义、超时、证据过期，或执行超出预算
- **THEN** 在新增预算内退回原 Agent 链路，传已知状态，不由客户端追加澄清回合、不重试、不执行过期结果

#### Scenario: Call only navigates
- **WHEN** 一次调用只打开页面，没有取得详情
- **THEN** 不声称查到详情，不自动再调，交 Agent 继续

#### Scenario: Result exists but cannot be rendered directly
- **WHEN** 后端已获得可信详情，但无法产出合适的直答正文
- **THEN** 交给 Agent 已选对象、查询已执行状态及可用结果，让 Agent 复用而非默认重查

#### Scenario: A late result belongs to a cancelled turn
- **WHEN** 用户取消或回合失效后才收到工具结果或登记回复
- **THEN** 不发直答，不开启 Agent，不用迟到结果覆盖其他回合的展示关联
