# Adapter Generation Harness

## 目标

将插件内的 Adapter 生成从单轮提示词调用升级为可恢复、可验证、可审计的生成循环：

```text
Generation lifecycle loop
  └─ Generation harness loop
       └─ Model tool loop
```

当前第一阶段覆盖 API 类 Adapter：模型负责读取探索上下文和制定生成计划，Harness 负责草稿隔离、预算、静态验证、修正、确认发布和冲突保护。

## 运行目录

每次智能生成保存在独立目录：

```text
~/.webcli/generation-runs/<run-id>/
├── run.json
├── trace.jsonl
├── drafts/
│   ├── revision-0/<site-key>/
│   └── revision-1/<site-key>/
└── backup/<site-key>/
```

`run.json` 保存会话外状态，Bridge 或 Side Panel 重连后可以通过 `runId` 恢复进度。敏感字段在持久化和 WebSocket 输出前会被脱敏。

## 状态机

```text
created
→ context_ready
→ planning
→ drafting
→ static_validating
↔ revising
→ runtime_validating
→ awaiting_approval
→ publishing
→ completed
```

异常终态包括：`failed`、`cancelled`、`needs_user_input` 和 `budget_exceeded`。

模型不能直接改变状态或发布文件。状态流转、预算检查和发布操作由 Harness 控制。

## 模型输出额度与恢复

探索相关模型调用的单次输出额度由模型调用层统一解析：探索分析、动作捕获分析、语义增强、连通测试、旧 Adapter／Skill 生成入口与 Agent 计划／修复均不再填写各自的固定额度。客户端被动探索 Agent 通过现有 SDK 使用客户端模型，不经过独立 WebCLI 配置；客户端快速 scaffold 不调用模型。

- 优先级：调用方显式 `maxTokens` → 请求模型配置中的 `max_output_tokens` → 阶段变量（生成使用 `WEBCLI_GENERATION_MAX_OUTPUT_TOKENS`，分析使用 `WEBCLI_ANALYSIS_MAX_OUTPUT_TOKENS`）→ `WEBCLI_MAX_OUTPUT_TOKENS` → 默认 16,384。业务入口不传显式额度，避免覆盖用户设置；低层 API 仍支持显式参数。
- 可通过请求模型配置的 `model_max_output_tokens` 声明当前模型已知的输出上限；也可使用 `WEBCLI_MODEL_MAX_OUTPUT_TOKENS`。实际请求取期望额度与声明上限的较小值。
- 默认值只是应用回退策略，不是任何模型的官方能力声明。不会根据模型名字猜测上限，也不会自动探测或扩大额度。切换模型时应同步核对声明上限。
- 两项配置必须为正整数，允许范围为 1–1,048,576；这是配置校验边界，不表示模型支持该上限。服务端仍可能有更低限制。
- 此额度是单次输出预算，不是上下文窗口或整个任务的总 token 预算；对将推理计入输出额度的服务，思考和正文共享额度。

客户端当前没有独立的额度输入框。开发态可在启动客户端的同一个 PowerShell 中设置（数值仅为示例，请按所用模型能力选择）：

```powershell
$env:WEBCLI_GENERATION_MAX_OUTPUT_TOKENS = '24000'
$env:WEBCLI_ANALYSIS_MAX_OUTPUT_TOKENS = '24000'
$env:WEBCLI_MODEL_MAX_OUTPUT_TOKENS = '32768'
```

环境变量需要重新启动客户端及其托管模型进程才能生效；已有请求级配置优先于环境默认值。独立 WebCLI 使用自身模型配置；客户端通过请求传入模型身份和凭据，不会为了额度配置回读另一套凭据。

Anthropic 的 `stop_reason=max_tokens` 和 OpenAI-compatible 的 `finish_reason=length` 会被识别为 `MODEL_OUTPUT_LIMIT_EXCEEDED`，包括仅有思考、正文为空，以及正文看起来可解析但服务端声明已截断的情况。停止原因和数值诊断可穿过一次性／常驻 Worker；不保存思考原文。截断动作不会执行，也不会进入原有 JSON 格式修复重试。

Agent 生成遇到额度耗尽或无效额度配置，会进入 `needs_user_input`，保存计划、草稿与已完成工具的上下文。调整配置后，可在原任务回答并继续；恢复时重新验证草稿，不重置调用次数或步骤预算。等待用户的时间不消耗运行时长，继续请求只等待 Worker 启动确认，后续进度由客户端轮询。旧 Worker 的延迟退出不能移除同一任务的新 Worker。

任务级默认上限仍是 32 次模型调用、40 次工具步骤、2 次 revision 和 10 分钟运行时间；Agent 编排自身最多 24 步。原有格式修复每步最多两次，也计入模型调用预算。不会因为一次输出额度耗尽而自动增加任务预算、延长超时、发布草稿或重放站点写操作。

## Tool Loop

当前 Tool Loop 使用模型无关的 JSON Action 协议：

```json
{"type":"tool_call","name":"inspect_generation_context","arguments":{"section":"overview"}}
```

或：

```json
{"type":"final","content":"计划已保存","data":{}}
```

规划阶段仅开放：

- `inspect_generation_context`
- `save_generation_plan`

修正阶段仅开放：

- `inspect_validation_errors`
- `list_draft_files`
- `read_draft_file`
- `write_draft_file`
- `validate_adapter_draft`

修正工具只能读写隔离草稿内已存在的 `.js`、`.json`、`.md` 和 `.txt` 文件，不能访问正式 Adapter 或执行 Shell。

## 发布保护

生成草稿前，Harness 会将现有 Adapter 复制到隔离目录并记录目录指纹。发布时会重新计算正式 Adapter 指纹：

- 指纹一致：通过 staging 目录原子替换，并保存 backup；
- 指纹不一致：以 `ADAPTER_CHANGED_DURING_GENERATION` 失败，避免覆盖生成期间发生的人工修改。

发布成功后 Bridge 广播 Adapter 更新事件，扩展刷新匹配页面中的工具。

## Bridge 协议

- `start_generation_run`
- `get_generation_run`
- `cancel_generation_run`
- `publish_generation_run`
- `generation_run_event`

Side Panel 同时保留“快速生成”入口，用于直接调用原 Scaffold 流程。

## 当前验证范围

已实现：

- JavaScript 语法检查
- manifest JSON、站点 ID 和 match 检查
- support files 路径与存在性检查
- Adapter 注册入口检查
- 工具命名空间和重复名称检查
- 最多两轮受限自动修正
- Preview Adapter 临时注入和正式 Adapter 恢复
- 预期工具注册检查
- 查询工具风险分类和安全测试参数解析
- 高置信度只读工具真实调用
- 列表/对象基础返回契约、登录页、敏感字段和超时检查
- 运行验证失败回传 revision Tool Loop

后续阶段将继续增加 CDP 请求级副作用探测、更精细的业务输出契约，以及 Adapter 失效后的自动 Repair Run。
