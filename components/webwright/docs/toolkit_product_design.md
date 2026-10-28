# Webwright Toolkit 产品功能设计

> 当前分发与调用合同：正式产物增加 `manifest.json`，作为五文件 Toolkit Adapter Skill 交付；用户统一通过 `webcli call <adapter-id>.<tool-id>` 调用，不再提供 `webcli-py`。完整设计见 [`../../../docs/webcli_toolkit_adapter_design.md`](../../../docs/webcli_toolkit_adapter_design.md)。本文后续历史版本记录中的旧命令与四文件描述不再构成现行规范。

## 文档状态

- 当前版本：`3.4`
- 更新时间：2026-08-09
- 状态：阶段一至阶段七、五文件 Toolkit Adapter、统一 `webcli call` 入口、Skill 域名描述与 WeWorker 安装入口已实现；开发中代码支持用户手动修改保存，新安装包真实按钮闭环待验收
- 关联技术设计：[`toolkit_technical_design.md`](toolkit_technical_design.md)
- 关联 Roadmap：[`toolkit_roadmap.md`](toolkit_roadmap.md)
- 适用范围：Python harness 的 `local_browser + local_cdp` 模式

## 一、升级目标

Webwright 从当前的「网站探索、追问、步骤回放」升级为围绕浏览器工具建设的完整产品，覆盖三个工作区：

```text
探索｜开发｜调试
```

最终沉淀物不再是探索步骤或简单拼接的 `script.py`，而是可以被 AI 调用的站点 Toolkit。Toolkit 中的 Tool 应具备：

- 独立运行能力。
- 结构化参数接收能力。
- 稳定、可重复执行能力。
- 明确的工具描述、参数描述和返回结果。
- 由 Toolkit Runtime 自动维护的浏览器页面状态。
- 可供 AI 理解和调用的配套 Skill。
- 与同一 Toolkit 中其他 Tool 组合使用的能力。

探索步骤是工具开发的证据，不是最终工具代码。工具开发需要基于一次完整探索重新分析、参数化、实现和调试。

## 二、核心产品原则

### 2.1 先创建 Toolkit 和 Tool

用户必须先创建 Toolkit，再创建 Tool，之后才能进行探索、开发和调试。

```text
Toolkit
└── Tool
    ├── Explorations
    ├── 正式版本，最多一个
    ├── 开发中版本，最多一个
    └── Debug Runs
```

不允许创建没有明确 Tool 归属的探索任务、开发活动或调试运行。Tool 本身就是长期存在的工具开发项目。

### 2.2 所有活动围绕明确的 Tool

探索、开发和调试是同一个 Tool 下的不同活动，不是相互独立的任务。用户切换 Tool 后，三个工作区同时切换到该 Tool 的上下文。

### 2.3 一次开发只使用一次探索

一个 Tool 可以进行多次相互独立的 Exploration，但一次开发周期最多只能选择其中一次作为探索输入。

- 不合并多个 Exploration 的步骤。
- AI 开发时不读取未被选择的 Exploration。
- 被选择的 Exploration 必须完整完成 Tool 所需的全部操作。
- 普通继续开发期间，来源 Exploration 不可更换。
- 如果需要改用其他 Exploration，必须通过独立的「从探索重新开发」入口开始新的开发周期：选择 Exploration 后先回到首次开发页填写必填指令，用户明确点击「开始开发」时才清空当前开发中版本并启动；正式版本不受影响。

### 2.4 只保留正式版本和开发中版本

每个 Tool 最多有两个代码槽位：

- 正式版本：供 AI 和正常工具运行使用。
- 开发中版本：供开发和调试使用。

不保存代码修改历史、代码 diff、旧开发版本、旧正式版本或回滚快照。Developer Agent 或用户手动保存代码时持续覆盖开发中版本；发布时开发中版本替换正式版本，并清空开发中版本。

### 2.5 用户与 Developer Agent 共同维护开发中代码

开发工作区允许用户手动修改并保存当前开发中 Python 代码，也允许用户继续通过自然语言指令驱动 Developer Agent 覆盖开发中版本。两种方式共用同一个开发中槽位和同一套代码哈希、结构校验及发布门槛，不增加人工代码分支或历史版本。

第一版只允许手动修改代码正文，不开放参数 Schema、返回 Schema、页面状态契约、副作用或风险说明的手工编辑。用户手动修改函数签名导致代码与现有参数 Schema 不一致时，保存必须失败；需要同步改变参数或契约时应交给 Developer Agent 处理。

调试失败或运行效果不满意时，系统仍不自动切换工作区或修改代码。用户自行切换到开发工作区，并明确选择是否将某条 Debug Run 作为本轮开发证据。

## 三、核心产品对象

### 3.1 Toolkit

Toolkit 是服务于同一站点或域名的一组 Tool，也是最终交付给 AI 使用的资产集合。

Toolkit 包含：

- Toolkit 名称和标识。
- 明确配置的允许域名列表。
- Toolkit 描述。
- Tool 列表。
- 正式 CLI 脚本。
- 正式 Toolkit Runtime。
- 内嵌于正式 CLI 的工具运行规格。
- 正式 Skill。
- 各 Tool 的开发中版本。
- Toolkit Runtime Store。

同一 Toolkit 中的 Tool：

- 操作 Toolkit 明确配置的允许域名范围，不做隐式子域名泛匹配。
- 使用 `local_browser + local_cdp` 运行模式。
- 正式版本组织在同一个 CLI 脚本中。
- 共享一份正式 Skill。
- 通过 Toolkit Runtime 自动复用同一个浏览器页面，Tool 和 AI 不接触 `target_id`。

### 3.2 Tool

Tool 是所有产品活动的中心对象。创建 Tool 时由用户确定：

- Tool 名称，同时作为 Tool 标识，例如 `search_blog`。
- 功能描述。
- 所属 Toolkit。
- 起始页面或页面范围。
- 运行后达成的页面效果。

参数 Schema、返回结果、页面状态契约等内容可以在开发阶段由 AI 基于探索结果提炼。

Tool 长期保存：

- 工具描述。
- 参数 Schema。
- 返回值 Schema。
- 页面前置状态和后置状态。
- 副作用与风险说明。
- Exploration 列表。
- 正式版本。
- 开发中版本。
- Debug Run 列表。

### 3.3 Exploration

Exploration 是一个 Tool 下的一次独立网站探索。

每次 Exploration：

- 只属于一个 Tool。
- 继承功能描述和 Toolkit 域名约束。
- 拥有独立模型上下文。
- 拥有独立的 trajectory、steps、截图和页面状态。
- 不读取同一 Tool 的其他 Exploration。
- 必须独立完成 Tool 的全部操作，才可作为开发输入。

Exploration 状态：

```text
running
waiting_for_user
succeeded
failed
cancelled
```

`succeeded` 应表示 Exploration 已经完整完成 Tool 的业务目标，而不只是 Agent 自己结束了运行。

### 3.4 正式版本

正式版本是 AI 在真实任务中发现和调用的版本。一个 Tool 最多存在一个正式版本。

正式版本包括：

- 正式函数实现。
- CLI 子命令。
- 正式参数 Schema。
- 正式返回值 Schema。
- 正式页面状态契约。
- 正式工具描述。
- 正式 Skill 中对应的工具说明。

### 3.5 开发中版本

开发中版本是当前唯一的候选实现。一个 Tool 最多存在一个开发中版本。

开发中版本包括：

- 当前代码。
- 当前参数 Schema。
- 当前返回值 Schema。
- 当前页面状态契约。
- 当前工具描述。
- 来源 Exploration，最多一个。
- 基于哪个正式版本开始开发。
- 当前代码哈希和更新时间。

每次 AI 修改都会直接覆盖当前开发中版本，不保留之前的开发中代码。

### 3.6 Debug Run

Debug Run 是正式版本或开发中版本的一次实际运行。

记录内容：

- `tool_id`。
- 运行渠道：`formal` 或 `development`。
- 当前代码哈希。
- 正式渠道运行时对应的当前正式产物哈希；开发中渠道不记录该字段。
- 输入参数。
- 结构化结果。
- 日志和异常。
- 截图。
- 执行前后 URL 和页面标题。
- Toolkit Runtime Store 的更新结果，不向 AI 或 Tool 暴露原始 `target_id`。
- 开始和结束时间。
- 运行状态。

Debug Run 不保存完整代码快照。开发中代码发生变化后，旧 Debug Run 仍可查看，但不保证能够精确重放当时的代码。正式 Debug Run 必须实际运行已发布的 `toolkit.py`，并记录当次运行的正式产物哈希；旧正式 Debug Run 只有同时匹配当前 Tool 代码哈希和当前正式产物哈希时，才构成当前产物的验证证据。

## 四、总体业务流程

### 4.1 首次开发

```text
创建 Toolkit
→ 创建 Tool
→ 进行一次或多次独立探索
→ 选择其中一次完整探索
→ 生成开发中版本
→ 持续覆盖迭代开发中版本
→ 调试开发中版本
→ 发布
→ 开发中版本替换正式版本
→ 清空开发中版本
→ 调试已发布的正式产物
→ 当前 Toolkit 的全部正式 Tool 验证通过
→ 允许导出分发包
```

首次开发时，如果 Tool 没有正式版本和开发中版本，必须选择一次成功 Exploration，才能生成开发中版本。

### 4.2 正式版本后续迭代

```text
已有正式版本
→ 基于正式版本创建开发中版本
→ 持续覆盖迭代开发中版本
→ 调试
→ 发布
→ 新版本替换旧正式版本
→ 清空开发中版本
→ 调试已发布的正式产物
→ 当前 Toolkit 的全部正式 Tool 验证通过
→ 允许导出分发包
```

如果网站发生变化，可以先创建新的 Exploration。本轮开发仍然以正式代码为代码基础，并且最多选择一次 Exploration 作为补充证据。

### 4.3 开发中版本的处理规则

如果已存在开发中版本：

```text
继续修改当前开发中版本
```

如果不存在开发中版本，但存在正式版本：

```text
复制正式版本
→ 创建开发中版本
→ 在开发中版本上修改
```

如果正式版本和开发中版本都不存在：

```text
选择一次成功 Exploration
→ 生成首个开发中版本
```

### 4.4 从探索重新开发

已经发布过的 Tool 可以选择一次属于当前 Tool 且状态为 `succeeded` 的 Exploration，完全放弃当前开发中实现并开始新的开发周期：

```text
当前正式版本继续有效
＋
选择一次成功 Exploration
→ 回到首次开发页并填写必填开发指令
→ 明确点击「开始开发」
→ 清空当前开发中版本并完全基于该 Exploration 重新开发
→ development Debug
→ 发布
→ 新版本替换正式版本
→ 重新 formal Debug
```

「基于已发布版本开发」和「从探索重新开发」是两个独立入口。后者不读取正式代码、正式契约、当前开发中代码、旧 Development Run 或旧 Debug Run 证据，只获得 Toolkit 与 Tool 产品定义、允许域名等约束、所选 Exploration 的完整证据和本次开发指令。

启动该流程时必须清空当前开发中版本，并固定新 Development Run 的 `source_exploration_id` 为所选 Exploration、`based_on_formal_hash` 和 `debug_run_evidence_id` 为空。清空不修改正式槽位、当前正式 Skill、当前 `artifact_hash`、formal Debug 证据或当前导出资格。Developer Agent 失败后开发中版本保持为空，不自动回退为基于正式版本开发。

## 五、探索工作区

探索工作区只展示当前 Tool 的 Exploration。

主要功能：

- 新建 Exploration。
- 查看执行过程。
- Follow-up。
- 暂停和人工接管。
- 查看步骤、截图和错误。
- 原始步骤回放。
- 查看探索历史。
- 选择一次成功 Exploration 作为开发输入。

新建 Exploration 时自动带入并在弹窗内只读展示：

- 功能描述。
- 运行后达成的页面效果。
- 起始 URL。

Tool 名称通过所在探索工作区标题始终可见，不在弹窗内重复展示。Toolkit 域名约束由系统内部读取；用户准备好的 Agent 浏览器页面以可选择的候选列表展示，同时展示页面标题与网址。

启动 Exploration 前必须确认 Agent 浏览器可用，并选择 Adapter 允许域名内的页面。起始 URL 只作为默认打开地址和优先匹配依据，不限制页面路径、查询参数或片段。只有一个完整 URL 匹配页面时默认选中；没有完整匹配且只有一个允许页面时默认选中；其余多页面情况由用户选择。将真实 `target_id` 作为内部执行身份传入 Exploration，服务端和 Worker 再次校验页面存在、域名允许，并保留浏览器实例与占用检查。从选定页面的当前状态开始，禁止因 URL 与起始网址不同而注入首次导航。没有允许页面时阻止启动，提示打开起始网址、完成登录或调整 Adapter 允许域名。创建入口和弹窗标题使用「新建探索」，提供「打开起始网址」入口；顶栏浏览器状态仍用于启动或聚焦浏览器。正式 Tool 调用缺少可复用页面时仍使用起始 URL 恢复页面。

用户可以补充本次探索指令，但不能改变 Tool 的根本目标。如果实际目标属于另一个工具，应先创建新的 Tool。

探索列表应展示：

- 运行状态。
- 操作步数。
- 创建时间。

选中一条 Exploration 后，详情内展示最终 URL。是否完整达成目标、是否被当前开发中版本使用不作为独立展示字段，通过「选为开发输入」按钮是否可点间接体现；失败步骤通过步骤时间线中的失败节点直接查看，不单独统计数量。

## 六、开发工作区

开发工作区围绕当前 Tool 展示：

1. Tool 定义。
2. 正式版本，只读。
3. 开发中版本，可持续迭代。
4. 当前开发依据。

当前开发依据可以包括：

- 一次选中的 Exploration。
- 用户本轮开发指令。
- 用户明确选择的 Debug Run。

AI 开发时可以获得：

- Toolkit 约束。
- Tool 名称和功能描述。
- 当前选中的唯一 Exploration。
- 当前正式版本和开发中版本。
- 正式工具清单和 Skill。
- 用户明确选择的 Debug Run。

系统提供给开发 AI 的 Exploration 和 Debug Run 证据必须过滤运行时内部字段，不包含原始 `target_id`。

AI 不应获得：

- 未被选择的 Exploration。
- 其他 Tool 的 Exploration。
- 未经用户选择的 Debug Run。
- 无关任务的 trajectory。

开发工作区主要操作与布局：

开发工作区采用 **左侧核心开发区（60%） + 右侧即时调试面板（40%）** 的双栏联动布局。

- 首次开发：仅在已应用版本和开发中版本都不存在时可用。用户从探索工作区选择成功 Exploration 后，左侧开发区显示「开始开发」和首次开发指令输入框；用户填写本次指令后，通过普通首次开发流程生成开发中版本，不使用「从探索重新开发」文案或 API。
- 基于已应用版本开发：仅在没有开发中版本且存在正式版本时可用，复制已应用版本作为开发起点，不改变既有行为。
- 从探索重新开发：选择当前 Tool 的一次成功 Exploration，清空当前开发中版本并按 4.4 节开始全新的开发周期；已有已应用版本在被新版本覆盖前继续有效。
- 继续开发当前开发中版本：在左侧指令协作框提交本轮开发指令，交给 Developer Agent 处理。
- 手动修改当前开发中代码：进入显式编辑状态，只保存 Python 代码；保存前复用 Tool 槽位结构校验，并使用当前 `code_hash` 做冲突检查。保存成功后生成新哈希，旧 Debug Run 不再构成当前代码的验证证据。
- 即时测试：在右侧即时调试面板中一键触发当前开发中代码的试运行（Debug Run），面板流式输出 Terminal 日志与步骤截图。
- 引用失败证据：当右侧即时测试失败时，可在右侧一键 `[ 📌 引用此失败证据为开发参考 ]`，将该 Debug Run 预选绑定到左侧，由用户自主填写提示词并提交指令让 Agent 修复代码。
- 重新开始：清空当前开发中版本的全部修改。属于危险操作，点击后必须告知不可恢复并要求二次确认。
- 应用到 Toolkit：测试跑通后解锁此操作。点击后将开发中版本覆盖为已应用到 Toolkit 的版本（原“发布”）。

### 6.1 自我优化

AI 只分析当前选中的 Exploration：

- 识别失败尝试。
- 识别重复操作。
- 识别纯观察步骤。
- 找出真正推动任务完成的操作。
- 提取稳定定位器。
- 提取需要参数化的固定值。
- 补充必要等待和结果校验。
- 重新编写最小、独立、稳定的工具实现。

最终工具不是删减后的 steps，也不是 `script.py` 的简单加工，而是基于探索证据重新开发的实现。

### 6.2 参数和运行契约

每个 Tool 必须包含：

- 工具描述。
- 参数 Schema。
- 返回值 Schema。
- 支持的域名和 URL 范围。
- 是否要求登录。
- 成功判定。
- 稳定错误码。
- 副作用和风险说明。

`target_id` 和 `cdp_url` 都由 Toolkit Runtime 管理，不属于 Tool 业务参数，不写入 Tool 参数 Schema，也不向调用 Tool 的 AI 暴露。

Tool 函数只接收业务参数和 Runtime 注入的页面对象。多个 Tool 的组合由调用方结合前一步结果与当前页面状态判断。

### 6.3 Toolkit Runtime Store

每个 Toolkit 维护一份运行时状态文件，至少包含：

```json
{
  "target_id": "",
  "last_url": "",
  "last_title": "",
  "updated_at": ""
}
```

该文件只供 Toolkit Runtime 读取和维护，不作为 Tool 参数，不写入正式 Skill，也不提供给调用 Tool 的 AI 或开发 AI。开发工作区不挂载该文件。

每次运行 Tool 时：

1. Toolkit Runtime 读取 Runtime Store。
2. 如果存在 `target_id`，尝试精确复用对应页面。
3. 如果没有 `target_id`，或者保存的页面已不存在、无法复用，则新建页面。
4. 新建页面后按 Tool 约定的起始页面完成初始化。
5. 将实际页面的 `target_id`、URL 和标题写回 Runtime Store。
6. Tool 执行完成后再次更新页面状态。

该逻辑沿用现有探索阶段的 target 复用模式。多个 Tool 顺序执行时自动共享 Runtime Store，从而持续操作同一页面。

## 七、调试工作区

调试工作区负责运行当前 Tool 的正式版本或开发中版本。

主要功能：

- 选择正式版本或开发中版本。
- 根据参数 Schema 填写参数。
- 执行和取消工具。
- 查看结构化结果。
- 查看日志、异常和截图。
- 重复运行。
- 查看 Debug Run 历史。
- 调试同一 Toolkit 下多个 Tool 的顺序组合。

调试工作区默认选择开发中版本；没有开发中版本时默认选择正式版本。

开发中渠道直接运行当前开发中槽位，用于发布前验证。正式渠道必须运行已经发布到 Toolkit 根目录的 `toolkit.py`，不得绕过正式产物重新读取 `formal.json` 执行。正式调试失败后，系统保留当前正式产物；用户自行回到开发工作区，基于正式版本开始新一轮开发、修改并重新发布。

运行前检查：

- Toolkit Runtime 能否复用已有页面或创建新页面。
- 页面域名是否属于 Toolkit。
- 所选版本是否存在。
- 参数是否合法。

运行后展示：

- 是否成功。
- 结构化业务结果。
- 页面执行前后变化。
- 日志、异常和截图。
- 错误是否适合重试。

调试工作区不提供：

- 「进入开发」入口。
- 自动修复按钮。
- 自动切换到开发工作区。
- 自动修改开发中版本。

## 八、Toolkit 中的正式区和开发区

正式版本与开发中版本都属于同一个 Toolkit，但使用不同区域保存，避免同一脚本中出现两个同名 Tool 函数。

概念结构：

```text
blog_admin/
├── runtime.json
├── blog-admin/             # 工程内唯一正式 Skill 产物
│   ├── SKILL.md
│   └── scripts/
│       ├── toolkit.py
│       ├── toolkit_runtime.py
│       └── requirements.txt
├── tools/                  # 工程内部正式事实源，不分发
├── development/            # 工程内部开发数据，不分发
├── debug_runs/             # 工程内部调试证据，不分发
└── .server/                # 工程内部事务和构建数据，不分发
```

- `<skill-name>/SKILL.md`：符合 Agent Skills 目录约定，只描述正式版本。
- `SKILL.md` frontmatter 的 `description` 由 Toolkit 描述和「当需要操作以下域名的网页时可使用：<allowed_domains>」组成，不列举 Tool 名称。
- `<skill-name>/scripts/toolkit.py`：所有 Tool 的正式版本和 CLI。
- `<skill-name>/scripts/toolkit_runtime.py`：自包含的正式运行内核，由 Webwright canonical Runtime 原样发布，不依赖 Webwright 包。
- `<skill-name>/scripts/requirements.txt`：固定 Playwright 依赖声明。
- 根目录 `runtime.json`：仅供工程内 development／formal Debug 共享页面状态，不属于正式 Skill。
- `tools/`、`development/`、`debug_runs/` 和 `.server/`：仅供工程内部开发、恢复和追踪使用，不属于正式分发产物。

同一个 Toolkit 可以有多个 Tool，各自拥有一个开发中槽位。

### 8.1 正式调用

AI 正常使用 Tool 时只调用正式版本：

```bash
webcli call blog-admin.search-blog --keyword=Webwright
```

正式 Skill 根目录必须包含 `manifest.json` 与 `SKILL.md`，执行资源统一位于 `scripts/`。调用依赖 WeWorker 内置 WebCLI、embedded runtime 和系统 Edge／Chrome；Python 与 Playwright 由 embedded runtime 提供，不读取用户已有 Python 环境。`scripts/requirements.txt` 继续作为固定依赖声明，但 `SKILL.md` 不再要求用户通过 pip 安装。正式调用不依赖 Exploration、trajectory、steps、`formal.json`、ToolkitStore 或源码安装的 Webwright 包。

正式 CLI 连接本机 CDP endpoint 失败时，Runtime 必须自动启动使用独立用户目录的 Chrome／Edge，等待 endpoint 可用后重新连接；远程 CDP endpoint 不得触发本机浏览器启动。外部 Skill 的 `runtime.json` 在用户状态目录按 Toolkit ID 和 Skill 绝对路径生成，不写入 Skill 目录；标签页失效时必须新建标签页、打开当前 Tool 的 `start_url` 并写回状态。恢复只发生在业务函数执行前，不得自动重跑已经开始执行的 Tool。

### 8.2 调试调用

调试运行时明确选择：

```text
Tool：search_blog
运行版本：development
```

选择 `development` 时加载当前开发中槽位。选择 `formal` 时必须执行正式 Skill 的 `scripts/toolkit.py`，以验证最终交付形态本身。

## 九、应用到 Toolkit、放弃与重置

### 9.1 将开发中版本应用到 Toolkit

这里的“应用到 Toolkit”是 Tool 级别的本地正式化操作（原称“发布”），不是公开发布或生产部署。

应用时原子执行：

1. 检查开发中版本存在。
2. 检查代码能够独立加载。
3. 检查参数和返回值 Schema 完整。
4. 检查当前开发中代码哈希是否至少存在一次成功的 Debug Run。
5. 用开发中实现和运行规格更新 `toolkit.py` 中该 Tool 的已应用内容。
6. 更新 `SKILL.md` 中该 Tool 的说明。
7. 清空该 Tool 的开发中版本。
8. 将当前 Toolkit 标记为需要重新完成正式产物验证；该状态由当前正式产物哈希和 Debug Run 动态推导，不单独保存布尔字段。

开发中代码发生任何修改后，旧 Debug Run 的成功结果立即失效，必须针对新的代码哈希重新测试成功后才能应用到 Toolkit。

应用操作只影响当前 Tool，不改变同一 Toolkit 中其他 Tool 的已应用版本或开发中版本。

应用完成表示工程内正式产物已经更新，不表示已经导出或对外分发。系统不引入“候选产物”、历史 Build 或额外版本槽位；如果正式调试发现问题，直接基于当前已应用版本继续开发并再次应用到 Toolkit。

### 9.2 正式产物验证与导出

正式产物验证以整个 Toolkit 的当前产物哈希为边界。某个 Tool 验证通过必须同时满足：

```text
存在 succeeded formal Debug Run
且 Debug Run.code_hash == 当前 Tool formal.code_hash
且 Debug Run.artifact_hash == 当前 Toolkit artifact_hash
```

只有当前 Toolkit 的全部正式 Tool 都满足上述条件时，才允许导出。发布任意一个 Tool 都会改变整套正式产物哈希，因此此前针对旧产物哈希的正式 Debug Run 仍可查看，但不再满足当前导出条件。

导出不是二次构建，不生成或修改业务代码，只执行：

1. 重新校验当前正式产物哈希和全部正式 Tool 的验证资格。
2. 校验 `SKILL.md` 和 `scripts/requirements.txt` 与发布时内容一致；二者不参与正式产物哈希。
3. 逐字节打包当前正式 Skill 目录并下载。

导出包不得包含 `tools/`、`development/`、`debug_runs/`、`.server/`、日志、截图、模型输入或历史运行结果。

### 9.3 安装到 WeWorker

当 Webwright 由 WeWorker embedded 启动且收到有效 `WEWORKER_USER_FILES_DIR` 时，
Toolkit 顶部在「导出 Toolkit」旁显示「安装到 WeWorker」。该按钮与导出使用
同一资格：只有 `export_eligible=true` 时启用。standalone Webwright 不显示。

点击按钮不改变发布、formal Debug、正式产物或导出资格。Webwright 复核资格后，
将当前正式四文件 Skill 直接原子安装到
`<user_directory>/.claude/skills/<skill-name>/`。同名目录无论来源均整体覆盖，
不维护安装索引；资格变化、用户目录无效或磁盘写入失败时显示明确错误。

### 9.4 重新开始

用户在开发工作区执行「重新开始」：清空当前开发中版本，正式版本保持不变。该操作必须先做危险告知并二次确认；由于不保留代码修改历史，确认后不能恢复被清空的开发中代码。

- 如果 Tool 已有正式版本，之后通过「开始开发」重新基于正式版本创建开发中版本。
- 如果 Tool 还没有正式版本，必须重新选择一次成功 Exploration 才能开始新的开发。

这是唯一的开发回退方式，不支持回到开发过程中的任意历史节点。

「从探索重新开发」不是历史回退：它不恢复旧代码，而是清空开发中槽位后，以一次成功 Exploration 作为唯一实现证据重新生成代码。选择弹窗必须说明开发中修改不可恢复、正式版本在发布前不受影响，并且只能通过明确取消按钮或提交成功关闭，不响应遮罩点击或 `Escape`；不得使用 `window.confirm()`。

## 十、Skill 与 AI 使用规则

正式 `SKILL.md` 只描述正式版本：

- 使用 YAML frontmatter 声明合法的连字符 Skill 名称和触发描述，且名称与 Skill 根目录一致。

- Tool 名称和用途。
- 参数说明。
- 页面前置状态和后置状态。
- 返回结构。
- 调用命令。
- 工具组合方式。
- 常见错误和处理方式。
- 具有副作用的操作。

Skill 不描述 `target_id`，AI 只提供业务参数。页面创建、复用和运行时状态维护由 Toolkit Runtime 自动完成。

开发中版本只在开发和调试工作区可见，不进入正式 Skill。AI 在真实任务中只能发现和调用正式版本。

## 十一、多工具组合

现实中的复杂浏览器任务由 AI 组合同一 Toolkit 中的多个正式 Tool 完成。例如：

```text
search_blog(keyword)
→ open_blog(post_id)
→ edit_blog(content)
→ save_blog()
```

组合规则：

- 每一步必须引用明确的 Tool。
- 所有 Tool 通过 Toolkit Runtime Store 自动复用同一个浏览器页面。
- 前一步输出可以映射为后一步输入。
- 调用方根据前一步结果与当前页面状态决定是否继续。
- 任一步失败后停止。
- 每一步分别生成 Debug Run。

第一版只支持固定顺序组合调试，不建设可视化 DAG、条件分支或通用工作流编排器。

## 十二、Tool 展示状态

Tool 不设置复杂生命周期状态，系统只跟踪两个事实：

```text
正式版本：有／无
开发中版本：有／无
```

| 正式版本 | 开发中版本 | 含义 |
|---|---|---|
| 无 | 无 | 新 Tool，尚未生成代码 |
| 无 | 有 | 首个正式版本正在开发 |
| 有 | 无 | 只有可正式使用的版本 |
| 有 | 有 | 正式版本可用，同时正在开发下一版 |

Tool 列表不使用徽章标注这两个事实：用户在开发工作区通过开发代码区和「已发布版本」对照条感知当前状态，在调试工作区通过可选的运行渠道感知。

Exploration 和 Debug Run 保留各自的运行状态，但不映射为 Tool 状态。

## 十三、第一版范围

### 13.1 必须完成

- Toolkit 和 Tool 创建与管理。
- 全局模型配置的新增、编辑、删除和激活。
- Agent 浏览器启动／聚焦、目标页面检测和首次 Exploration 精确绑定。
- Tool 下的多次独立 Exploration。
- 从一次完整 Exploration 生成开发中版本。
- 探索步骤识别、精简和参数化。
- 正式版本与开发中版本双槽位。
- 独立 CLI、正式工具清单和正式 Skill。
- Toolkit Runtime Store 自动维护页面 target，Tool 和 AI 不接触 `target_id`。
- 单 Tool 开发和调试闭环。
- 当前开发中代码必须有成功 Debug Run 才能发布。
- 用户可以手动修改并保存当前开发中 Python 代码；参数和运行契约继续由 Developer Agent 维护。
- 开发中版本发布并替换正式版本。
- 同一 Toolkit 下多个 Tool 的固定顺序组合调试。

### 13.2 暂不纳入

- 多 Exploration 合并开发。
- 代码修改历史和任意版本回滚。
- 多正式版本共存。
- Toolkit Revision。
- 可视化工作流编排器。
- 多浏览器并行运行。
- 云端工具市场。
- 多用户权限。
- 自动定时任务。
- Browserbase、`local_launch` 和 `local_persistent` 模式。
- 自动公开发布 Tool 或 Skill。
- 跨域名 Toolkit。
- Tool 任意创建和管理多个标签页。

### 13.3 阶段七切换边界

- 三工作区新前端只使用 Toolkit、Tool、Exploration、Development Run、Debug Run 和 Publish 新接口，不调用 `/api/tasks*`。
- 旧单页 Task 前端不再继续维护；新前端接入完成后由三工作区页面作为唯一产品入口。
- `/api/tasks*` 旧接口及其 OpenAPI、接口文档和测试在阶段七暂时保留，仅作为新版本开发参考，不承担新前端兼容职责。
- 旧接口的删除不属于阶段七；待新接口和新前端验证稳定后，另行启动专门清理任务。
- 不迁移、不绑定、不展示历史 Task。升级前的历史 Task 数据由用户自行清理，新版本实现不增加历史数据兼容逻辑。
- 新页面必须保留旧页面仍适用于新产品的全局能力：模型管理、Agent 浏览器启动／聚焦、全局刷新、API 文档、窗口重新聚焦后的状态刷新和截图灯箱。模型管理弹窗默认只展示已配置模型列表；只有用户明确点击「新建模型」或某条模型的「编辑」后才展示供应商和模型配置表单。所有弹窗和截图灯箱只能通过明确的取消／关闭控件或提交成功关闭，不响应遮罩点击或 `Escape`。
- Toolkit／Tool 必须支持编辑和删除；三类活动的当前运行、失败原因、结果和日志必须可见，全局互斥运行时应在顶栏展示并禁用冲突操作。

## 十四、系统约束汇总

1. 必须先创建 Toolkit，再创建 Tool。
2. 探索、开发、调试必须归属于明确的 Tool。
3. 一个 Tool 可以有多次 Exploration。
4. 每次 Exploration 必须独立完整达成 Tool 的目标。
5. 首次开发必须选择且只能选择一次成功 Exploration。
6. 当前开发周期最多引用一次 Exploration。
7. 普通继续开发期间不能更换来源 Exploration；只有独立的「从探索重新开发」流程可以清空开发中槽位后改用所选成功 Exploration。
8. AI 不得合并多个 Exploration。
9. 一个 Tool 最多有一个正式版本和一个开发中版本。
10. Developer Agent 和用户手动保存的开发修改始终覆盖当前开发中版本。
11. 不保存代码修改历史和旧代码快照。
12. 没有开发中版本时，优先基于正式版本创建。
13. 没有任何版本时，必须基于选中的 Exploration 创建。
14. 发布时开发中版本替换正式版本，并清空开发中版本。
15. 正式 Skill 只暴露正式版本。
16. 调试可以选择正式版本或开发中版本。
17. 调试失败不自动进入开发。
18. `target_id` 由 Toolkit Runtime Store 内部维护，不属于 Tool 参数，也不向 AI 暴露。
19. Debug Run 记录代码哈希但不保存完整代码快照；formal Debug Run 还必须记录正式产物哈希。
20. 同一 Toolkit 中的 Tool 通过 Runtime Store 自动复用同一个浏览器页面。
21. Toolkit 必须显式配置允许域名列表，不做隐式子域名泛匹配。
22. 正式 CLI 位于 Skill 的 `scripts/` 目录，只依赖同目录 `toolkit_runtime.py` 和固定版本 Playwright，不依赖已安装的 Webwright 包。
23. 当前开发中代码哈希必须至少有一次成功 Debug Run，才能发布为正式版本。
24. 三工作区新前端不得依赖 `/api/tasks*` 旧接口。
25. 历史 Task 不迁移、不兼容、不展示。
26. 首次 Exploration 必须精确绑定用户准备且 URL 匹配的 Agent 浏览器页面。
27. 全局模型、浏览器和当前活动状态必须在三工作区页面中可管理或查看。
28. 正式 `scripts/toolkit.py` 不得依赖 ToolkitStore、`formal.json` 或 Webwright server。
29. 正式 Debug Run 必须运行当前已发布 Skill 的 `scripts/toolkit.py`，并记录当前两个执行文件的正式产物哈希。
30. 只有全部正式 Tool 都针对当前正式产物哈希调试成功，Toolkit 才允许导出。
31. 导出不得重新生成或修复正式文件，只能校验并逐字节打包五文件 Toolkit Adapter Skill；`runtime.json` 不属于发布内容。
32. 系统不引入候选产物、历史 Build 或额外版本槽位。
33. 正式 Runtime 必须在本机 CDP 浏览器关闭时自动拉起浏览器，在保存的标签页失效时重新打开 Tool 起始页；不得自动重跑已经开始执行的业务 Tool。
34. 「从探索重新开发」必须显式隔离正式／开发中代码和历史 Development／Debug 证据；新版本发布前不得改变正式产物、formal Debug 证据和导出资格。
35. 正式 `SKILL.md` 必须使用 `webcli call <adapter-id>.<tool-id>` 作为调用入口，不得暴露脚本路径，不得要求用户安装 Python／Playwright 或使用 `python` 命令运行。
36. 正式 `SKILL.md` frontmatter 的 `description` 必须列出 Toolkit 允许操作的网页域名，不得列举 Tool 名称作为触发描述。
37. 「安装到 WeWorker」只在 embedded 用户目录 capability 可用时显示，并与轻量导出共用 `export_eligible` 资格；同名项目 Skill 无条件整体覆盖。
38. Webwright 只允许直接写 Electron 指定用户目录下的 `.claude/skills/`；安装失败不得修改正式产物或导出资格。
39. 用户只能手动编辑开发中代码；正式代码、参数 Schema、返回 Schema 和运行契约保持只读。
40. 手动保存必须携带预期 `code_hash`；开发中版本已变化时不得覆盖服务端新版本。
41. 手动保存必须复用 Tool 槽位校验；函数签名与现有参数 Schema 不一致时拒绝保存。
42. 手动保存生成新 `code_hash` 后，旧 Debug Run 不得继续满足当前开发中代码的发布门槛。

## 十五、修改记录

- 2026-08-09：版本更新至 `3.4`，在现有「探索｜开发｜调试」三工作区内允许用户手动修改并保存开发中 Python 代码；人工保存与 Developer Agent 共用唯一开发中槽位，使用预期 `code_hash` 防止覆盖并复用现有结构校验，正式代码、Schema 和运行契约保持只读，代码变化后必须重新调试成功才能发布。
- 2026-08-06：版本更新至 `3.3`，正式交付增加 `manifest.json` 形成五文件 Toolkit Adapter，统一通过 `webcli call` 执行并删除 WeWorker 随包 `webcli-py` wrapper；Toolkit Runtime 继续复用 embedded runtime。
- 2026-08-06：版本更新至 `3.2`，删除独立 `webcli-py` installer；正式 Skill 暂时继续使用 WeWorker 随包轻量 wrapper，Python／Playwright 统一复用 embedded runtime；该过渡合同已由 `3.3` 替代。
- 2026-08-03：版本更新至 `3.1`，安装改为 Webwright 直接原子覆盖 `<user_directory>/.claude/skills/<skill-name>/`；移除 Backend Bridge、ZIP 回拉、安装索引和同名手动 Skill 保护。
- 2026-07-27：版本更新至 `3.0`，增加 embedded 模式「安装到 WeWorker」入口；按钮只在 Bridge 可用且 Toolkit 达到导出资格时启用，实际拉取、校验和安装归 WeWorker 所有。
- 2026-07-21：版本更新至 `2.9`，正式 Skill 从五文件收敛为四文件，删除 `scripts/toolkit.json`；Toolkit ID、允许域名、起始 URL 和参数／返回值 Schema 内嵌于 `toolkit.py`，正式 Runtime 不再读取独立 manifest。
- 2026-07-19：版本更新至 `2.6`，正式 Skill 的 frontmatter `description` 使用「当需要操作以下域名的网页时可使用」列出 Toolkit 允许域名，不再列举 Tool 名称。
- 2026-07-19：版本更新至 `2.5`，正式 Skill 的对外调用入口改为单文件 `webcli-py`；Python 与 Playwright 由该 Runtime 内嵌，`SKILL.md` 不再要求用户执行 pip 安装，五文件结构和 `requirements.txt` 依赖声明保持不变。
- 2026-07-18：版本更新至 `2.4`，区分首次开发和「从探索重新开发」：从未发布的 Tool 选择 Exploration 后显示「开始开发」及首次开发指令输入框，提交时走普通首次开发流程；「从探索重新开发」只用于已有正式版本或开发中版本的 Tool。
- 2026-07-18：版本更新至 `2.3`，新增「从探索重新开发」独立入口，允许已发布 Tool 清空开发中槽位后完全基于一次成功 Exploration 重新开发；新版本发布前正式槽位、正式 Skill、`artifact_hash`、formal Debug 证据和导出资格保持不变。
- 2026-07-18：版本更新至 `2.2`，正式产物改为根目录 `SKILL.md` 加 `scripts/` 四个执行／依赖文件的标准 Skill；`artifact_hash` 只覆盖 formal Debug 实际使用的三个执行文件；`runtime.json` 改为外部首次运行时在用户状态目录生成，导出不再包含空 Runtime。
- 2026-07-17：版本更新至 `2.1`，明确正式 Runtime 的本地 CDP 自愈规则：本机 endpoint 不可用时自动启动独立 Chrome／Edge，保存的 target 失效时新建标签页并打开 Tool 起始页；恢复仅发生在业务函数执行前，不自动重跑可能产生副作用的 Tool。
- 2026-07-17：版本更新至 `2.0`，正式交付物增加 canonical Runtime 的逐字节副本 `toolkit_runtime.py`；正式 CLI 不再依赖已安装的 Webwright 包，导出依赖仅保留固定版本 Playwright，`artifact_hash` 纳入该 Runtime 文件，ZIP 白名单调整为六个文件。
- 2026-07-17：版本更新至 `1.9`，重新定义发布、正式调试和导出关系：发布直接生成工程内最终可分发产物，不增加候选产物；正式 Debug 必须运行已发布 `toolkit.py` 并记录 `artifact_hash`；全部正式 Tool 针对当前产物验证成功后才允许轻量导出，导出仅复制正式文件、初始化空 Runtime、加入固定依赖声明并打包。
- 2026-07-15：版本更新至 `1.8`，调整未匹配目标页面的登录提示，并视觉强调「务必完成登录」。
- 2026-07-15：版本更新至 `1.7`，将 Exploration 创建入口统一为「新建探索」；目标页面未匹配时，从创建弹窗打开 Agent 浏览器会直接打开当前 Tool 的起始 URL。
- 2026-07-15：版本更新至 `1.6`，补齐阶段七真实产品闭环：恢复模型管理、Agent 浏览器启动／聚焦、目标页精确绑定、全局刷新／文档／焦点刷新／截图灯箱／快捷关闭；要求 Toolkit／Tool 可管理，并展示 Exploration／Development Run 的结果、错误、日志和全局活动状态。
- 2026-07-15：版本更新至 `1.5`，明确阶段七切换边界：三工作区新前端只使用新产品接口；旧 Task 前端停止维护；`/api/tasks*` 旧接口、OpenAPI、文档和测试暂时保留作开发参考，待新版本验证稳定后单独立项删除；历史 Task 数据不迁移、不兼容、不展示。
- 2026-07-13：确定产品升级为「探索、开发、调试」三个工作区，最终沉淀参数化、可独立运行并配套 Skill 的 Toolkit。
- 2026-07-13：调整为先创建 Toolkit 和 Tool，再进行探索；所有活动必须归属于明确 Tool；允许多次独立探索，但一次开发最多使用一次完整探索。
- 2026-07-13：移除调试失败后自动进入开发的交互，由用户主动切换工作区并选择 Debug Run。
- 2026-07-13：简化版本模型，每个 Tool 仅保留一个正式版本和一个开发中版本；开发持续覆盖开发中版本，发布后替换正式版本。
- 2026-07-13：取消代码修改历史、旧版本和 Toolkit Revision，只保留当前正式代码、当前开发中代码及 Debug Run 的代码哈希。
- 2026-07-14：将 `target_id` 从 Tool 必填参数调整为 Toolkit Runtime Store 内部变量；Tool 和 AI 不接触该值，Runtime 自动复用页面并在缺失或复用失败时新建页面。
- 2026-07-14：明确 Toolkit 使用显式允许域名列表；正式 CLI 可以依赖已安装的 Webwright Tool Runtime。
- 2026-07-14：增加发布门槛，当前开发中代码哈希必须至少有一次成功 Debug Run；代码变更后需要重新调试成功。
- 2026-07-14：开发工作区界面文案去槽位术语：主体直接展示当前开发代码，正式版本以「已发布版本」收起对照，发布说明文案为「发布工具新版本，发布后本次修改正式生效」且不提及调用方；「放弃开发中版本」与「从正式版本重新开始」合并为带二次确认的「重新开始」；「开始开发」不提供来源选择，自动基于正式版本或已选成功 Exploration；取消 Tool 列表的正式／开发中徽章；调试工作区运行渠道文案保持「正式／开发中」不变。
- 2026-07-14：Tool 字段文案对齐当前 UI 实现并理顺表述矛盾：`Tool 名称`与`Tool 标识`合并为同一字段（名称即标识，此前 UI 已合并但文档未同步）；`Tool 目标`改称「功能描述」，`期望产生的业务效果`改称「运行后达成的页面效果」，涉及 §3.2 字段定义、§3.3 Exploration 继承约束、§五探索工作区自动带入清单与探索列表展示项、§六开发依据展示项、§十四系统约束汇总；新建 Exploration 自动带入清单补充「运行后达成的页面效果」（此前遗漏）；重写 §六「开发工作区主要操作」中「开始开发」条目，修复此前语句中断、与「继续开发」顺序交叉导致的表述不完整问题，改为与 §4.3 保持一致的简洁引用。
- 2026-07-14：对照前端交互 demo 复核 §五探索工作区，以 demo 实际交互为准修订两处表述：新建 Exploration 弹窗只读展示功能描述、运行后达成的页面效果、起始 URL 三项，Tool 名称由页面标题体现、Toolkit 域名与 Agent 浏览器页面由系统内部维护，均不作为弹窗字段单独展示；探索列表精简为运行状态、操作步数、创建时间，是否完整达成目标与是否被开发中版本使用改为通过「选为开发输入」按钮可用性间接体现，失败步骤改为通过详情内步骤时间线的失败节点查看，不再单独展示最终 URL 列和失败步骤计数（选中详情后可见最终 URL）。截图、Debug Run 取消/重复运行、同一 Toolkit 下多 Tool 顺序组合调试等仍是文档要求但 demo 尚未实现的功能，暂不改动文档，留待后续实现。
