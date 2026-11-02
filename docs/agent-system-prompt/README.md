# Agent 系统提示词契约

> 状态：当前实现与维护基线。本文定义 WeWorker Agent 的系统提示词、共享 Skill、托管 Adapter Skill 与运行时结果之间的契约关系；它不是单一文件的说明书。
>
> 关联文档：[WebCLI 调用路由与 Tab 选择](../webcli-call-routing/README.md)、[网站登录处理逻辑分析](../website-login-analysis/README.md)、[WeWorker 浏览器设计与演进](../weworker-browser/README.md)、[Adapter 开发指南](../../EXTENSION_DEV_GUIDE.md)。

## 1. 为什么系统提示词是契约

Agent 不直接拥有浏览器、登录态、Tab 或 Adapter 权限。它只能根据系统提示词与已加载 Skill 解释工具结果，并通过 `webcli call` 请求受宿主约束的能力。

因此，以下任一运行时行为变化都可能改变 Agent 的对外行为：

```text
Adapter manifest / catalog
  → WebCLI Bridge / 扩展执行、路由与登录结果
  → CLI 结构化输出、认证事件与错误码
  → Agent 系统提示词、共享 Skill、Adapter Skill 的解释
  → 用户可见回复与下一步工具调用
```

契约规则：

1. **运行时结果是事实来源。** 提示词和 Skill 不得把 `ok`、登录状态、路由状态或错误码解释成与实现不一致的含义。
2. **提示词不授予权限。** 它不能绕过 Adapter manifest 的 host 范围、读写确认、登录校验、Profile 固定或文件访问边界。
3. **安全行为必须一致。** 运行时新增、删除或重命名状态/错误码时，所有会引导 Agent 行为的提示词与 Skill 必须同步审查。
4. **不确定时不伪造成功。** 无法验证登录、页面来源、Profile 或命令结果时，Agent 必须说明状态未验证，而不能把“已开始”说成“已完成”。
5. **文档不替代验证。** 本文用于设计和评审；代码变更仍必须有对应聚焦测试与实际可观察的结果。

## 2. 指令来源与优先级

一次普通桌面端对话可能同时包含多种指令来源：

| 层级 | 来源 | 主要职责 | 维护方式 |
| --- | --- | --- | --- |
| 运行时强制 | Bridge、扩展、Backend 工具策略、manifest 校验 | 权限、路由、登录、确认、数据边界 | 代码与测试；提示词不能覆盖 |
| 全局系统提示词 | `weworker/backend-ts/src/agent.ts` 的 `buildSystemPrompt()` | Agent 通用行为、`webcli call` 规则、登录解释、文件/Shell 边界 | 修改运行时语义时必须审查 |
| 提示词模板 | `weworker/backend-ts/prompts/agent.md` | 系统提示词稳定正文与占位符 | 仅维护模板结构；动态规则通常在 `agent.ts` 注入 |
| 专属 Agent 提示词 | `weworker/backend-ts/src/dedicated-agents/agent-runtime.ts` | 单站点、单命令、渠道和专属 Skill 约束 | 与普通 Agent 的关键安全/登录语义同步 |
| 共享 WebCLI Skill | `webcli/skills/webcli/`、`webcli/skills/webcli-browser/`、`webcli/skills/webcli-api-exploration/` | WebCLI 操作手册、浏览器/探索流程 | 独立 Markdown 源，随桌面端打包并同步 |
| 托管 Adapter Skill | `webcli/adapter-views.js` 与 `webcli/adapter-skill-sync.js` 生成 | 当前 Adapter 的命令、参数、运行时、确认和站点说明 | 从已验证 catalog 派生，不手工编辑运行时副本 |
| 用户/专属 Skill | 用户目录或专属 Agent 配置 | 用户明确提供的工作知识 | 不得突破上层运行时安全边界 |

全局系统提示词与完整 Skill 文本不是同一份内容：系统提示词每轮构造；Skill 只有在被发现并加载后才会作为上下文进入当前和后续对话。两者对同一状态给出矛盾指导时，产品行为会变得不可预测，因此应保持语义一致。

## 3. 桌面端 Skill 的打包与同步

桌面端不依赖用户单独安装的全局 npm WebCLI。构建脚本 `weworker/scripts/bundle-webcli.cjs` 会将仓库 `webcli/skills/` 复制到桌面 WebCLI 资源目录。

Backend 的同步链路为：

```text
桌面内置 resources/webcli/skills/
  → Backend 启动：webcli install --skills
  → 运行时 Claude 配置目录的 skills/
  → 普通聊天前：syncBundledWebcliSkills()
  → Claude Code Skill 发现与已加载 Skill 上下文
```

- `weworker/backend-ts/src/server.ts` 在 Backend 启动时安装共享和托管 Adapter Skill。
- `weworker/backend-ts/src/agent.ts` 在普通 full-permission 聊天开始前调用 `syncBundledWebcliSkills()`，确保 `webcli`、`webcli-browser`、`webcli-api-exploration` 与桌面内置版本一致。
- 同一位置还会刷新当前 catalog 对应的 `webcli-<adapter-id>` 托管 Adapter Skill。
- 显式禁用的共享 Skill 保持禁用文件名；孤立/受限运行使用调用方提供的 Skill 根目录，不进行全局同步。

禁止手改安装后的运行时 Skill 或构建产物；应修改上述源文件并通过构建、同步链路更新。

## 4. 站点识别与 Skill 可见性契约

Agent 在调用任何站点工具之前，必须先把用户请求映射到具体 Adapter。这一映射由三层机制完成，每层能力有限且互相独立：

| 层 | 机制 | 触发条件 | 实现 |
| --- | --- | --- | --- |
| tier3 确定性识别 | URL host 命中 manifest `match`/`domains`，或消息文本命中 `gate_aliases`；命中后预注入站点工具提示 | 消息含站点 URL 或显式别名 | `weworker/backend-ts/src/site-gate.ts` |
| tier4 站点探索 | 消息含未知站点 URL 时启动探索，生成草稿 Adapter | 存在 `startUrl`；无 URL 时以 `no-unknown-site-signal` 跳过 | `weworker/backend-ts/src/tier4-dispatch.ts` |
| 模型自行判断 | 依据系统提示词与已发现 Skill 的内容 | 兜底 | `agent.ts` 与 SDK `skill_listing` |

当前实现的三条契约事实：

1. **站点显示名不是识别信号。** manifest 的 `i18n` 名称与 description 只用于 UI 展示和 Skill 描述；site-gate 刻意不做站点名自动匹配，避免中文名误触发。站点昵称必须显式声明 `gate_aliases` 才能进入 tier3。
2. **Skill 清单只有名字。** 普通聊天中 SDK 注入的 `skill_listing` 仅包含 skill 名称（如 `webcli-<adapter-id>`）；托管 Adapter Skill 的 description——站点中文名与能力摘要所在之处——在被显式加载前不进入模型上下文。
3. **系统提示词默认不含站点目录。** `buildSystemPrompt()` 不枚举已启用站点。因此昵称到 Adapter 的映射若未命中 `gate_aliases`，就完全依赖模型主动加载 Skill 或自行检索。

占位案例（真实故障的脱敏重述）：用户消息为“帮我打开示例站看看发票报销”，Adapter id 为 `app.example.com`，`i18n.zh.name` 为“示例站”，manifest 未声明 `gate_aliases`：

```text
tier3   消息无 URL、无 gate_aliases   → 不命中
tier4   消息无 URL                    → no-unknown-site-signal，跳过
模型    skill_listing 仅见 webcli-app.example.com（无描述）
        → 上下文中不存在“示例站 ↔ app.example.com”映射
        → 回复“找不到该站点”，且可能零工具调用即下结论
```

安装打包、站点启用开关、Skill 生成在该案例中全部正常；失败点只有一个——映射从未进入模型上下文。模型此时给出的其他站点建议只是域名语义推断，不是从任何描述读到的。

契约规则：

1. Adapter 需要被昵称、缩写或中文名唤起时，manifest 必须声明 `gate_aliases`；该字段已支持解析、打包与 tier3 匹配。
2. Agent 不得在零工具调用的前提下宣称某站点不存在；应先检索 Adapter 列表或 Skill（目标规则，见第 8 节验证）。
3. 若未来向系统提示词注入已启用站点目录（id + 本地化名 + 一行描述），该目录成为事实 3 的例外；注入逻辑必须有提示词构造测试覆盖。

## 5. WebCLI 调用契约

Agent 对网站的默认策略由运行时类型和 Adapter manifest 决定：

```text
background API 命令
  → 直接调用；不因“需要登录”机械打开业务页

Host-managed 页面命令
  → 直接调用；宿主选择/复用/创建合规 Tab
  → 如认证失败，Bridge 按登录协议处理

用户明确要求显示网站、通用浏览器流程或 Skill 明确要求页面准备
  → 才使用 open_browser
```

系统提示词、共享 WebCLI Skill、专属 Agent 提示词和生成的 Adapter Skill 都不得要求模型在每个网站工具之前先调用 `open_browser` 或 `check-login-status`。这样会绕开宿主的 Tab 路由、造成重复业务 Tab，并可能破坏共享 SSO 的登录体验。

关于 Profile、managed foreground/background、`pageRoute`、`routeDomain`、`tabDomain` 与 `open_browser --adapter` 的精确规则，以 [WebCLI 调用路由与 Tab 选择](../webcli-call-routing/README.md) 为准。若路由实现、manifest 字段或 CLI 结果发生变化，必须审查本节相关提示词是否仍然正确。

## 6. 登录状态契约

登录状态机由 Bridge 的 `SiteLoginCoordinator` 拥有；Agent、Renderer 与 Adapter 不自行编排登录。

### 6.1 Agent 可据以行动的状态

| 状态/结果 | 语义 | Agent 行为 |
| --- | --- | --- |
| `already_logged_in` | 已确认当前站点登录有效 | 可以继续正常流程 |
| `logged_in` | 本次登录 flow 已确认完成 | 可以继续；读命令由宿主按安全规则重试 |
| `waiting_user` | 已确认需要用户完成扫码、验证码、密码或其他人工步骤 | 告知用户在 WeWorker 浏览器完成登录；不重试 `open_browser`；暂停依赖登录的后续操作 |
| `AUTH_REQUIRED` + `auth.status=waiting_user` | 业务命令等待用户登录后仍未完成 | 同上；遵循读写重试边界 |
| `AUTH_CANCELLED` | 用户取消登录 | 说明已取消，不自动重试 |
| `AUTH_RETRY_REQUIRED` | 写操作可能已开始，登录后不得自动重放 | 请求用户确认后再执行 |

### 6.2 待实现的状态澄清：`login_pending`

`open_browser --adapter` 是非阻塞开页操作。当前实现以零等待启动后台登录 flow；若 flow 尚未完成，历史返回会把内部 pending 映射为 `waiting_user`。这会把“正在检查会话或尝试自动登录”误导为“已经需要用户手动登录”。

**目标契约（待实现，不得当作当前行为）：**

| 新状态 | 含义 | Agent 行为 |
| --- | --- | --- |
| `login_pending` | 页面已打开；宿主正在后台检查会话或尝试自动登录，尚未要求用户操作 | 不重试 `open_browser`，不要求用户手动登录；若流程需要安全业务操作，可直接调用该业务工具并让宿主复用登录 flow |
| `waiting_user` | 自动登录不可用、失败或已明确进入人工登录阶段 | 提示用户完成登录并暂停依赖登录的操作 |

在实现这一状态前，变更登录相关系统提示词、Skill 或 UI 文案时必须明确区分“当前行为”和“目标行为”，不得提前声称 `login_pending` 已可用。

更完整的登录范围、Tab 复用、认证 URL 安全边界和读写重试策略见 [网站登录处理逻辑分析](../website-login-analysis/README.md)。

## 7. 变更评审规则

任何改动满足下列任一条件时，都必须在 PR 中显式检查系统提示词契约：

| 运行时改动 | 必须检查的指令来源 |
| --- | --- |
| 新增/删除/重命名工具结果状态、错误码、认证字段 | `agent.ts`、共享 WebCLI Skill、专属 Agent 提示词、CLI 文案、Renderer 文案 |
| 改变 `open_browser`、登录 flow、自动登录、二维码、重试或登录 Tab 绑定 | `agent.ts`、`webcli/skills/webcli/SKILL.md`、专属 Agent 提示词、登录设计文档 |
| 改变 Profile/Tab 路由、页面创建、`pageRoute` 或 manifest 路由字段 | `agent.ts` 的开页/调用规则、共享 Skill、调用路由文档、Adapter 开发文档 |
| 改变 Adapter manifest schema、runtime、background/page 执行边界 | 生成 Adapter Skill、共享 Skill、Adapter 开发文档、相关系统提示词 |
| 改变确认、写操作、文件访问、凭据或安全策略 | 全局系统提示词、专属 Agent 提示词、Skill、用户可见文案与安全文档 |
| 改变 Browser/Bridge 生命周期或状态事件 | 系统提示词中的恢复动作、浏览器设计文档、Renderer/CLI 状态文案 |
| 改变 site-gate 信号、`gate_aliases` schema、站点目录注入或 Skill 清单注入方式 | `agent.ts` 动态规则、共享 WebCLI Skill、Adapter manifest 文档与本文第 4 节 |

评审结论只能是以下两种之一：

1. 运行时实现与现有提示词/Skill 契约一致；或
2. 运行时变更有意改变契约，并同步更新所有受影响的指令来源、文档和测试。

不能只修改实现而让 Agent 按旧语义行动，也不能只修改提示词去掩盖运行时错误。

## 8. 最小验证矩阵

提示词或 Skill 变更不是纯文案变更。至少应覆盖：

1. **提示词构造测试：** 断言普通 Agent 在 full/restricted/qa 模式获得预期的动态规则。
2. **专属 Agent 测试：** 断言其补充提示词不与普通登录、开页、确认规则冲突。
3. **Skill 同步测试：** 验证桌面内置共享 Skill 被复制到运行时 Skill 根，禁用状态不被意外恢复，旧文件可更新。
4. **运行时结果测试：** 每个受影响状态/错误码都由 Bridge/CLI 测试产生，不能只测试 Markdown 文案。
5. **行为回归：** 对登录、页面/后台命令、Profile 路由、写操作确认和异常恢复执行对应聚焦测试。
6. **构建验证：** WebCLI bundle、Backend 类型检查以及受影响的 Renderer/Electron 构建或测试通过。
7. **站点识别回归：** `gate_aliases` 命中时 tier3 预注入站点提示；未声明别名时不得在测试或文档中假定模型天然知道昵称映射。

对于登录状态变化，必须覆盖“自动登录成功”“自动登录失败后人工等待”“用户取消”“超时”“读命令重试”和“写命令不重放”。

## 9. 维护入口

| 主题 | 首要实现/来源 | 关联契约 |
| --- | --- | --- |
| 普通 Agent 系统提示词 | `weworker/backend-ts/src/agent.ts` | 本文、登录与调用路由文档 |
| 提示词模板 | `weworker/backend-ts/prompts/agent.md` | 动态占位符与稳定正文 |
| 专属 Agent 提示词 | `weworker/backend-ts/src/dedicated-agents/agent-runtime.ts` | 单站点和渠道约束 |
| 共享 WebCLI Skill | `webcli/skills/` | WebCLI 使用和浏览器准备 |
| 托管 Adapter Skill | `webcli/adapter-views.js`、`webcli/adapter-skill-sync.js` | 当前 catalog 和 manifest |
| 共享 Skill 同步 | `weworker/backend-ts/src/webcli-skills.ts` | 桌面内置 WebCLI 资源 |
| Backend 启动安装 | `weworker/backend-ts/src/server.ts` | 运行时 Skill 根 |
| 登录状态机 | `webcli/site-login.js`、`webcli/bridge.js` | 网站登录处理逻辑分析 |
| Profile/Tab 路由 | `webcli/browser-profiles.js`、`extension/background/service-worker.js` | WebCLI 调用路由与 Tab 选择 |
| 站点识别与别名 | `weworker/backend-ts/src/site-gate.ts`、`weworker/backend-ts/src/tier4-dispatch.ts` | 本文第 4 节、Adapter manifest `gate_aliases` |

维护本文件时，示例只能使用公开占位域名、占位状态和非敏感参数；不得记录账户、Cookie、Token、真实用户数据或真实会话内容。
