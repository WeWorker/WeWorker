# 网站探索agent：开发模型输入精简

开发请求仍使用原有八字段输出协议。精简仅作用于模型输入组装与发送；原始探索轨迹、步骤文件、调试记录和已有开发运行的输入文件不被改写。

## 用户输入与步骤位置

- `source_exploration.instruction` 保留首次探索指令原文。
- `followup_instructions` 保留用户补充原文及 `after_step`、`before_step`。无补充时省略该列表。
- 优先读取探索目录下的 `.server/user_turns.json`；旧记录无补充记录时，从轨迹中的用户补充消息恢复。整份历史消息不再发送。
- 保留原有 `step` 标识，不强制连续编号；`before_step` 不保证等于 `after_step + 1`。未知或没有后续记录时保留相应 `null`，不猜测位置。

## 内部证据对应关系

原始记录继续区分 `model_turn` 与 `execution_step`，组装完成后不向开发模型发送这两个内部字段。

- 模型响应已保存但尚未执行时退出，会消耗模型轮次而不产生执行文件。
- 代码优先取同一 observation 的 `python_code`，其次取显式关联的执行文件，最后取同一调试记录的动作代码。不再根据相同文件编号拼接不同动作。
- 旧记录缺少执行编号时，只以执行代码与文件内容的唯一完全匹配恢复对应。截图也使用实际观察路径或已确定执行编号。
- 只有执行文件、没有调试证据的记录仍为 `unknown`，不是执行成功证明；其模型位置可能未知。

## 精简后的步骤字段

- 保留 `step`、`status`，按需保留非空 `thought`、`code`、`exception`。
- `output` 改为 `execution_output`：表示 Python 执行的 stdout/stderr 合并文本，不是函数返回值，也不是浏览器控制台日志。代码和输出正文不截断、不改变缩进与换行。
- 不发送 `code_type`、`model_turn`、`execution_step`、`returncode`、`done`、截图路径及截图展示 URL。
- `status: ok` 只表示执行未报错，不代表业务目标完成。与状态一致的 `observation.success` 省略；矛盾时通过 `status_conflict.observation_success` 保留。未知状态下不丢弃原有成功标志。
- 所有非空 `final_response` 提取到 `source_exploration.conclusions`，每项包含 `after_step` 和 `text`。继续探索后的各次结论均保留位置，不能把结论直接当作成功证据。
- 无内容的 observation、快照表、日志表、结论列表不发送。不对业务数据和 Schema 做递归空值裁剪。

## 页面信息与完整文本去重

- `step.page` 仅记录首次可用或发生变化的 `url`、`title`。省略的字段沿用最近一次已知值；空值或读取失败不清除已知状态。URL 查询参数原样保留。
- 如果旧证据中外层页面值与 observation 值不同，保留 observation 的差异值，不静默合并。
- 所有不同的页面快照全文保留在 `source_exploration.snapshots`，步骤用 `aria_snapshot_ref` 引用。只有完全相同的文本才复用，不筛选片段、不生成摘要、不限制长度。
- 控制台文本全文保留在 `console_logs`，步骤通过 `console_output_ref`、`recent_console_ref` 引用；保留普通日志，只对完全相同文本去重。
- 代码、输出等与 observation 对应字段完全一致时只保留一份；存在差异时保留 observation 中的 `executed_code` 或 `execution_output`。

## 元数据白名单

- Toolkit 保留允许域名和存在的执行、运行时、鉴权来源约束。
- Tool 保留 `tool_id`、业务目标、起始地址、非空预期效果及执行约束；不发送内部关联 ID、创建时间、更新时间和槽位状态标志。
- `base_slot` 保留完整代码、描述、参数 Schema、结果 Schema、前置条件（requires）、后置条件（ensures）、副作用声明（side_effects）和风险提示，不发送来源 ID、哈希、更新时间。
- 调试证据保留调用通道、参数、执行状态、业务结果、非空错误及必要的前后页面信息；去掉运行 ID、包哈希、运行时身份、截图路径和时间戳。
- 调试执行状态与业务结果独立：`status: succeeded` 可以同时出现 `result.ok: false`。业务参数、结果与 Schema 内的 `false`、`0`、空字符串、空容器和 `null` 保留。

## 保存与发送

新建开发运行的 `input.json` 保持格式化排版，方便检查。读取后向模型发送时使用 `json.dumps(..., ensure_ascii=False, separators=(",", ":"))`，只去掉 JSON 排版空白。

字符串内部的代码、快照、日志换行在发送文本中表示为 JSON 转义字符，解析后内容完全相同；不得全局删除换行或折叠正文空白。已有输入文件不因发送而被重写。

## 验证

测试覆盖中断恢复映射、用户输入位置、不同快照全文保留、页面状态还原、状态冲突、各次结论位置、元数据白名单、业务空值保留，以及紧凑发送与磁盘输入内容等价。输出八字段协议与原有校验逻辑保持不变。
