# BotHub 内置 Bot 蓝图

一个 Bot = 一个文件夹。渲染引擎（`weworker/renderer/src/components/dedicated-agents/quick-create/blueprint-engine.js`）是唯一解释器，蓝图只放**纯数据**，不携带任何可执行代码——本地文件夹与未来远程 BotHub 下发的是同一种东西。

## 包结构

```
bothub/
  index.json                        ← 有序注册表：所有 Bot 的展示顺序
  <bot-id>/
    blueprint.json                  ← 必须：结构与逻辑（见下）
    skill.md                        ← 必须：技能正文模板
    intro.md                        ← 可选：介绍页（markdown），没有则点「创建」直接进问答
```

**新增一个 Bot 的全部工作：建文件夹、写三个文件、在 index.json 的 order 里加一行。** 不改任何代码。产物正确性由 `weworker/renderer/src/__tests__/quick-create-templates.test.js` 兜底（含与历史产物逐字节对比的基线测试）。

## blueprint.json 字段

```jsonc
{
  "schema_version": 1,              // 固定 1
  "id": "my-bot",                   // 小写字母/数字/._-，同时是技能名与问题默认 answerKey
  "version": "1.0.0",               // X.Y.Z
  "emoji": "🤖",                    // BotHub 卡片图标
  "name": "我的助手",               // 展示名（也是默认 Bot 名）
  "tagline": "一句话说明",           // BotHub 卡片副标题
  "site": { "id": "example.com", "label": "示例站" },  // 主站点（卡片门禁与标签）
  "introCta": "开始创建",            // 可选：介绍页按钮文案
  "sites": [                        // 可选：绑定站点（默认只有 site.id；可按条件附加）
    { "id": "example.com" },
    { "id": "mail.example.com", "when": { "answer": "useMail", "isNot": false } }
  ],
  "vars": { ... },                  // 变量（skill.md / 摘要 / 描述里用 {{名字}} 引用）
  "defaultAnswers": { ... },        // 问答默认值
  "questions": [ ... ],             // 问答（见下）
  "tasks": [ ... ],                 // 可选：定时任务
  "description": [ ... ],           // Agent 描述（行数组，支持条件块）
  "examples": [ ... ]               // 示例问题（行数组，支持条件块）
}
```

### questions

每个问题：`id`（同时是答案 key，除非显式写 answerKey）、`type`（text / textarea / hour / choice / credentials / guide / monitor）、`emoji`、`title`、`subtitle`（`[[https://…]]` 会渲染成外链）、`placeholder`，以及按题型：

- choice：`options: [{ value, label }]`
- credentials：`fields: [{ answerKey, label, placeholder, maxLength, secret }]`、`optional`、`note`
- guide：`actionUrl`、`actionLabel`、`confirmLabel`、`warning`、`when`（如填了对应凭证才出现）
- hour：`hours: [7, 8, …]`；monitor：`intervals: [1, 2, …]`

校验 `validate`（固定几种）：`{ "kind": "name" }` / `"members"` / `"hour"` / `"apiKey"` / `"credentialPair"`（带 idField/keyField/idLabel/keyLabel 等）/ `"monitorWindow"`；choice 题型自动校验。

摘要 `summary`：`[{ "when": 条件, "text": "…{{var}}…" }]`，首个命中生效。

### tasks

```json
{
  "key": "daily", "title": "任务名",
  "when": { "var": "monitorOn" },
  "cron": { "kind": "daily", "hour": { "from": "dailyHour", "num": true, "fallback": 9 } },
  "cron": { "kind": "window", "start": {...}, "end": {...}, "interval": {...} },
  "prompt": ["按 Skill 执行…，用 send_agent_message 发送给主人。"]
}
```

## skill.md 模板语法

普通 markdown 原样输出，两种指令：

```markdown
{{变量名}}                       ← 占位符，取 vars 求值结果

<!-- if: hasTencent && hasAliyun -->
…双通道文案…
<!-- elif: hasTencent -->
…仅腾讯文案…                      ← elif/else 自动与前面的分支互斥
<!-- else -->
…未配置文案…
<!-- endif -->
```

条件表达式只允许**变量名 + `!` `&&` `||` 括号**（固定文法，引擎 parse 而非执行）。答案派生的判断先在 `vars` 里声明成布尔变量（如 `"monitorOn": { "bool": { "answer": "monitorEnabled", "isNot": false } }`），表达式里只引用变量。

## vars 变量

```jsonc
{
  "qccKey":     { "from": "qccApiKey", "trim": true, "stripBearer": true, "max": 512 },
  "recipe":     { "var": "qccKey", "fallback": "<向主人确认>" },
  "literal":    { "var": "qccKey", "fallback": "<向主人确认>", "json": true },
  "hasTencent": { "bool": { "allAnswers": ["tencentSecretId", "tencentSecretKey"] } },
  "note":       { "if": { "var": "qccKey" }, "then": "已内置", "else": "向主人确认" },
  "roster":     { "members": "members", "join": "、", "fallback": "（待补充）" }
}
```

可用变换：`trim` / `stripBearer`（剥 Bearer 前缀）/ `max`（截断）/ `json`（JSON 引号）/ `pad`（两位补零）/ `num`。引擎固定注入 `skillName`（= id）。

JSON 里的条件对象（questions.when / sites.when / tasks.when / 行块 when）支持：`{"var":…}`、`{"answer":…, "is"/"isNot":…}`、`{"allAnswers":[…]}`、`{"and":[…]}` / `{"or":[…]}` / `{"not":…}`。

## intro.md

普通 markdown，经安全渲染管线展示（**原始 HTML 不执行**；表格/列表/引用/链接可用）。「开始创建」按钮由引擎统一渲染在底部。痛点/亮点建议用表格或列表表达。

## 红线

蓝图只能含纯数据。禁止放 JS 代码、禁止给渲染函数——远程化后这等于让服务端往客户端注入任意代码。引擎会对蓝图做 schema 白名单校验，不合法的蓝图整包跳过并在控制台告警。
