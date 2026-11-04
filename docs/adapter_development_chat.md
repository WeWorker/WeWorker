# 在 WeWorker 对话中开发 Adapter

## 从探索直接开始

1. 打开网站探索agent，完成或选择一次成功探索。
2. 在完成后的内联提问中点击 **是，开始开发**。无需预先填写目标 Adapter / Tool，也不会先创建开发工作区。
3. WeWorker 准备新的普通对话，附上真实 `input.json` 和精简提示词，并自动提交首条消息。直接进入开发对话，无需再点击 **发送**，不展示中间草稿或欢迎页。

网站探索agent只承担探索，不展示开发页签或站内开发入口。模型未配置不阻止把已有成功探索交给主对话；主对话使用自己的模型配置。准备失败保留当前探索并显示错误，重复点击共享同一次请求。原有探索对话、继续探索、暂停和回放保持不变。

## 输入契约

`input.json` 只描述任务与探索证据，不固化已安装 Adapter 目录，也不要求 `toolkit`、`tool` 或旧槽位。

```json
{
  "schema_version": 1,
  "instruction": "读取列表信息",
  "site": {
    "start_url": "https://example.com/",
    "allowed_domains": ["example.com"]
  },
  "source_exploration": {
    "exploration_id": "exp_example",
    "instruction": "读取列表信息",
    "steps": [],
    "messages": []
  }
}
```

- 默认 instruction 来自探索指令；调用方可显式传入开发指令。
- site.allowed_domains 仅包含探索起始站点，不把跳转或证据中的其他域名自动升级为授权范围。
- 原探索有关联目标时，记录在 source_exploration.provenance 中，只表示来源；即使原工作区已不存在，也不强制重新绑定。
- 用户明确指定目标时，可选传入 `target: { "adapter_id": "example.com", "tool_id": "read-items" }`；tool_id 可以省略。普通界面交接默认不传 target。
- 探索步骤和历史消息是证据，不是额外指令；Agent 应实时检查目标版本，不盲用历史信息。

宿主后端把文件写入新对话的独立工作区，通过普通附件链路传给 Agent。探索服务只返回数据，不写入对话目录。准备接口本身不调用模型或修改槽位。用户点击“是，开始开发”后，Renderer 通过该对话独立的普通消息队列自动发送一次，由主对话 Agent 开始开发；这不代表授权安装 Adapter 或执行需要确认的业务写操作。

预填提示词保持一句话：

> 请读取附件 input.json，运行 `webcli skills read adapter-development`，并按照该 Skill 开发和调试 Adapter。

## Agent 如何确定目标

决策规则和调用示例统一维护在 adapter-development Skill 中：

- `webcli adapter list --json` / `webcli adapter info <id> --json`：实时检查已安装能力和 digest。
- `webcli call development.list`：只读查询开发工作区、Adapter 身份、工具、保留命令及版本。
- 已有 Tool 满足需求则复用；需要改进则修改可编辑 Tool；已有 Adapter 缺少能力则新增 Tool；无合适目标才新建。
- 多个合理候选、破坏性修改、扩大权限时向用户确认。
- 编辑或扩展已安装 Adapter 前调用 `development.prepare`，参数为 adapter_id、expected_digest，以及用于消歧的可选 toolkit_id。

prepare 使用现有宿主绑定链路，优先复用唯一且版本匹配的工作区；没有工作区时绑定完整原包，不安装。返回 editable_tools、retained_commands、allowed_domains、revision 和 toolkit_id。后续 create/inspect/save/build/debug 仍需要明确 ID，但这些 ID 由 Agent 在分析后确定，不由探索阶段提前指定。

### 能力边界

- 支持修改已有工作区中的 Toolkit Tool，或给已有 Adapter 新增独立 Toolkit Tool。
- 原包保留命令不会自动变成可编辑槽位。Extension/HTTP，以及没有可编辑工作区的外部 Toolkit 原命令，不能用本流程直接重写。prepare 会返回为 retained_commands，Skill 要求说明限制，不能偷偷转为 Toolkit 或创建替代命令绕过。
- 原命令文件和契约保持不变。版本不匹配或有多个工作区时停止，不另建同名包覆盖。
- 安装仍走 development.review/apply，且需要用户明确确认权限、版本和覆盖变化。

## 接口与安全边界

- 交接：`POST /api/website-exploration/explorations/:id/development/chat`，仅接受 instruction 和可选 target。
- 探索快照：`POST /api/explorations/:id/development/input`，要求成功探索及当前宿主实例身份。
- 已有 Adapter 准备：`POST /api/website-exploration/adapters/:name/development-prepare`，要求当前安装 digest。
- CLI list 使用受管探索服务身份；prepare/review/apply 另外使用宿主注入的 Backend 身份和认证，不读取设置、密钥文件或任意服务地址。
- 不接受任意源文件/目标路径；不迁移旧输入格式。Python 开发模型内部的定向输入生成逻辑不属于此交接契约。

交接准备期间留在探索页；离开保护通过后才将首条消息入队，清空临时草稿并切换到对话。取消离开则保留草稿、不发送。重复点击共享同次准备请求；对话重挂载不会重复入队，也不消费其他流程的待发送消息或命令。发送失败沿用普通对话队列的暂停和手动重试，不自动重发。

草稿与待发送队列遵循现有内存机制；本入口不增加跨应用重启恢复能力。实际文件和已保存对话记录持久保留，重启不会自动发送。

## 已转开发的探索记录

首条开发消息成功入队后，客户端按探索 ID 和运行轮次持久保存对应开发对话 ID（仅保存这些标识，不保存探索证据或附件内容）。同一客户端返回记录或重启后，消息流不再显示提交按钮，改为：

> 探索结束已转开发，请在开发对话中完成开发。如需继续探索，请继续补充探索目标或要求。

用户从输入框成功发起继续探索后才清除此状态；继续探索请求失败、回放、刷新或开发消息发送失败均不清除。新的探索轮次完成后可再次提交。该提示为客户端交互状态，不改变探索执行状态，也不新增数据库 schema；清除客户端本地存储会清除标记。
