# Adapter 多轮结果声明

查询命令在 `manifest.json` 的 `commands[].results` 中声明返回对象及后续动作。WebCLI 从原始结果绑定参数，决策模型只选择对象和动作；模型不生成对象 ID，也不转换业务参数类型。

## 列表返回

```json
{
  "id": "list",
  "safety": "read",
  "results": [{
    "itemsPath": "$.records",
    "idField": "id",
    "titleField": "title",
    "actions": [{
      "id": "detail",
      "label": "查看详情",
      "command": "detail",
      "args": { "record_id": { "from": "item.id" } }
    }, {
      "id": "edit",
      "label": "修改",
      "command": "edit",
      "args": { "record_id": { "from": "item.id" } },
      "inputs": ["body"]
    }]
  }]
}
```

该片段合入现有命令声明，保留原有 `runtime`、`module`、`schema` 和执行配置。目标 `detail`、`edit` 必须是同一个 Adapter 中的真实命令，显式声明 `safety` 和参数 schema。

- `itemsPath` 指向数组；单对象返回使用 `itemPath`，两者只能声明一个。返回本身是数组或对象时，路径使用 `$`。
- `idField`、`titleField` 相对单条结果读取。身份必须唯一且精确，标题最多 256 字节；只接受属性路径，不执行表达式。
- `args` 支持 `item.*`、`query.*` 或显式 `value`；`query` 包含命令 schema 声明的默认值。
- `inputs` 只能列出目标 schema 允许的待补业务参数，不能覆盖已绑定身份参数，也不能收集密钥或 `__` 开头的内部控制字段。业务字段 `yes`、`confirm` 等可按 schema 声明。
- `detail` 是“查看第二条”等通用查看意图的默认动作。其他动作保留独立 ID 和明确标签。

## 单对象返回

```json
{
  "itemPath": "$",
  "idField": "username",
  "titleField": "username",
  "actions": [{
    "id": "detail",
    "label": "查看用户发帖",
    "command": "user",
    "args": { "username": { "from": "item.username" } }
  }]
}
```

WebCLI 在会话中将单对象作为一个候选对象处理，Adapter 的原始返回结构保持不变。已用于 V2EX `whoami`。

## 没有对象后续动作

```json
{
  "results": [{
    "actions": [],
    "reason": "当前命令返回资料；此 Adapter 没有该对象的下钻或操作命令。"
  }]
}
```

必须先检查实际源码、返回内容和当前包的全部命令，再给出具体原因。没有声明的查询计入待审查，不能自动归为“无需适配”。仅声明空动作也不能替代源码和测试证据。

## 执行与验证

调用方将同一系统生成的 UUID 作为 `--context` 传递。查询结果被记录后，Agent 必须登记真实展示的对象顺序；“第二条”依据展示顺序选择，不依据接口原始序号。终端直接展示在输出成功后登记。

每次查询最多为前20条结果建立动作绑定，原始查询输出保持完整。超出时展示清单标记 `completeness: "truncated"`，并返回 `capturedCount`、`resultCount`。不能将截断清单登记为完整列表，也不能按其执行“全部”；超出已记录范围的序号不生成调用步骤。调用方只登记清单中实际向用户展示的对象。

执行步骤须验证会话、展示记录、参数和实际选中包的指纹。用户明确要求的写动作在目标及参数完整后生成可执行步骤，不增加第二套确认协议。业务参数 `yes`、`confirm`、`execute` 原样保留；仅丢弃已废弃的顶层 `__confirmed`。写操作在派发前持久记录，重复派发及结果未知时的同工具重试会被拦截，不能靠新一轮对话绕过。错误返回、过期展示或包变化均不能通过猜测继续执行。

验证需区分三类证据：manifest 与合成结果的绑定测试、实际 Adapter 源码加 mock 网络/页面的调用测试、独立 CLI 进程与 Bridge 的端到端测试。真实站点和 WeWorker 集成另列结果，不能用其中一类代替其余类别。

## 写命令仅准备目标页面

写命令需要先打开目标页、且本次尚未执行页面脚本、点击、提交或文件写入时，返回已有导航控制体并显式声明 `phase: "prepare"`：

```json
{
  "__webcli_navigation": {
    "version": 1,
    "url": "https://example.com/items/A",
    "resume": false,
    "phase": "prepare",
    "result": { "status": "prepared", "executed": false }
  }
}
```

该声明属于 Adapter 执行协议，只能用于没有产生业务副作用的准备分支。已经点击购买再跳转结算页等流程不得声明 prepare。扩展校验写命令、终止续接和导航白名单，导航成功后才生成结果体之外的执行回执；不会自动再次调用处理器。读命令、`resume: true`、未知 phase 和导航失败不能取得准备回执。

Bridge 保留该回执，CLI 将其记录为 `toolOutcome: "prepared"`、`retryDisposition: "safe_to_retry_before_dispatch"`。原决策和步骤仍可使用相同参数继续调用，实际写入成功或结果未知后继续阻止重放。业务 JSON 自带的 prepared、dispatched 或 status 字段不能解除防重放；旧扩展只返回准备文案而没有独立回执时按未知结果处理，需升级扩展后重新开始会话。

新接入的嵌入式浏览器宿主目前未提供上下文目录/执行回执协议，`call --context` 在派发前拒绝并返回 `context_host_unsupported`；普通宿主调用保留原协议。独立 CLI 的 Extension、HTTP 和 Toolkit 调用继续使用原有独立 Runner。

## 同一列表包含不同对象类型

同一动作可用 `variants` 按结果字段选择真实命令。例如知乎的“查看详情”：

```json
{
  "id": "detail",
  "label": "查看详情",
  "variants": [
    { "when": { "type": "answer" }, "command": "answer-detail", "args": { "id": { "from": "item.url" } } },
    { "when": { "type": "question" }, "command": "question", "args": { "id": { "from": "item.question_id" } } }
  ]
}
```

`when` 相对单条结果做精确值匹配，不执行表达式。不匹配的对象不获得该动作。分支必须互斥，全部目标须属于同一 Adapter、使用同一读写等级并通过各自参数 schema 校验；每个分支可独立声明 `inputs`。外层不能再声明 `command`、`args` 或 `inputs`。实际调用使用被选对象绑定的命令，不能使用列表中其他类型的命令。
