# WeWorker 网站探索前端 UI 与交互重构设计

## 文档状态

- 状态：实施前设计
- 更新时间：2026-08-09
- 适用范围：embedded 网站探索页面的 Toolkit／Tool 三工作区前端
- 关联产品设计：[`toolkit_product_design.md`](toolkit_product_design.md)
- 关联技术设计：[`toolkit_technical_design.md`](toolkit_technical_design.md)
- 关联集成设计：[`weworker_embedded_integration_design.md`](weworker_embedded_integration_design.md)

本文保留已实现的「探索｜开发｜调试」三工作区信息架构。2026-08-09 根据产品设计 `3.4` 增加一项局部能力：用户可在开发工作区手动修改并保存开发中 Python 代码；正式代码、Schema、运行契约和三工作区边界不变。

## 一、结论

新版界面采用以下结构：

```text
全局顶栏
├── 品牌
├── 当前活动状态
├── Agent 浏览器状态
└── 主题切换

主体
├── Toolkit／Tool 两级导航树
└── 当前 Tool 工作区
    ├── 工作区 Header：探索｜开发｜调试＋Toolkit 发布区
    └── 工作区 Body
```

三个工作区继续围绕当前选中的 Tool 工作：

- 探索：探索记录列表＋单次 Exploration 详情。
- 开发：Tool 基础定义＋开发依据＋可编辑的开发中代码／只读契约＋Developer Agent 控制区。
- 调试：正式／开发中渠道选择＋参数表单＋运行事件和 Debug Run 详情。

本轮不引入以下能力：

- 手工编辑正式代码、JSON Schema 或运行契约。
- 文件树和任意文件读写。
- 原始终端或网络 CDP 日志实时流。
- 代码历史、diff、回滚或多版本管理。
- 新的前端框架、构建工具或全局状态库。
- 新的后端业务接口。

开发中代码允许通过显式入口切换到编辑状态并保存；正式代码保持只读。运行日志可以使用深色 Console 视觉展示，但内容必须来自现有结构化事件和已保存日志，不能暗示为实时终端。

## 二、设计目标

### 2.1 目标

1. 让 Toolkit、Tool 和三类活动的层级关系始终清晰。
2. 减少顶栏控件拥挤，将 Toolkit 管理移入左侧树，将发布动作收口到工作区 Header。
3. 保留探索、开发、调试的完整业务闭环，不因视觉精简删除状态或操作。
4. 在任何工作区都能看见全局互斥活动与 Agent 浏览器状态。
5. 复用现有 REST API、SSE 和无框架 ES Modules 前端。
6. 在桌面常见宽度下保持信息可读，并为窄窗口提供明确降级布局。

### 2.2 非目标

1. 不改变「每个 Tool 最多一个正式版本和一个开发中版本」的规则。
2. 不允许用户绕过 Developer Agent 直接修改开发中槽位。
3. 不把 Toolkit 发布产物伪装成 Tool 开发文件。
4. 不把运行状态 SSE 描述成原始日志流。
5. 不修改 embedded 数据目录、浏览器生命周期或 WeWorker 安装边界。

## 三、全局状态与作用域

### 3.1 前端状态

前端继续维护以下最小状态：

```js
{
  toolkitId: null,
  toolId: null,
  workspace: "explore", // explore | develop | debug
  sourceExplorationId: null,
  restartFromExploration: false,
  debugRunEvidenceId: null,
  activity: {
    running: false,
    kind: "",
    id: "",
    toolkit_id: "",
    tool_id: ""
  }
}
```

导航树额外维护纯展示状态：

- 已展开的 Toolkit ID 集合。
- 搜索关键词。
- 窄窗口下导航抽屉是否打开。

这些展示状态不进入后端，也不改变业务对象。

### 3.2 作用域

- Toolkit／Tool 导航树是全局作用域。
- 探索、开发和调试 Tab 是当前 Tool 作用域。
- 正式验证、导出和安装是当前 Toolkit 作用域。
- Agent 浏览器和当前活动状态是全局作用域。

工作区 Header 必须同时展示当前 Toolkit 名称，避免用户误以为「导出 Toolkit」只作用于当前 Tool。

### 3.3 切换规则

1. 点击 Tool 后，同时更新 `toolkitId` 和 `toolId`，保留当前 Tab。
2. 点击 Toolkit 标题只展开／收起，不清空当前 Tool。
3. 当前 Tool 被删除后，优先选中同 Toolkit 的第一个 Tool；没有 Tool 时进入空态。
4. 当前 Toolkit 被删除后，选中剩余第一个 Toolkit 及其第一个 Tool；没有 Toolkit 时进入全局空态。
5. 搜索只改变树的展示，不暗中切换当前 Tool。
6. 切换 Tool 时清空 `sourceExplorationId` 和 `debugRunEvidenceId` 等 Tool 级临时选择。

## 四、整体布局

以下原型图使用示例 Toolkit、Tool 和 Run 数据，只表达信息架构、控件层级和视觉密度，不代表真实用户数据。桌面基准画布为 `1440 × 900`。

![WeWorker 网站探索整体页面布局原型](assets/web_ui_redesign/overall-layout.png)

### 4.1 全局顶栏

顶栏固定在页面顶部，高度默认 `52px`，包含：

#### 左侧

- 品牌：`WeWorker 网站探索`。

#### 右侧

1. 当前活动状态胶囊。
2. Agent 浏览器状态胶囊。
3. 主题切换按钮。

顶栏不再放置 Toolkit 下拉框、新建／管理 Toolkit、导出、安装、API 文档或独立刷新按钮。

### 4.2 左侧导航

- 默认宽度：`260px`。
- 独立纵向滚动。
- 顶部固定搜索和「新建 Toolkit」。
- 下方展示 Toolkit／Tool 两级树。

### 4.3 主工作区

主工作区由固定 Header 和可滚动 Body 组成：

```text
┌─────────────────────────────────────────────────────────┐
│ 当前 Toolkit／Tool  探索｜开发｜调试   验证状态  导出／安装 │
├─────────────────────────────────────────────────────────┤
│ 当前工作区内容                                            │
└─────────────────────────────────────────────────────────┘
```

Header 不随 Body 滚动。Body 独立滚动，避免长时间线导致 Tabs 和发布状态离开视野。

## 五、全局顶栏交互

### 5.1 当前活动状态

无活动时隐藏；存在全局互斥活动时显示：

```text
⚡ 探索运行中 · search_blog
⚡ 开发运行中 · edit_post
⚡ 调试运行中 · check_order
⚡ 回放运行中 · search_blog
```

要求：

- 根据 `/api/activity` 显示活动类型、ID 所属 Tool 和状态。
- 点击后切换到活动所属 Toolkit、Tool 和工作区。
- Exploration Replay 跳转到探索工作区。
- 活动运行时，所有会启动冲突活动的按钮禁用。
- 禁用按钮应通过 `title` 或邻近提示说明「当前有其他活动运行中」。

### 5.2 Agent 浏览器状态

状态示例：

```text
● Agent 浏览器：可用
● Agent 浏览器：未启动
```

要求：

- 点击调用现有浏览器打开接口，用于启动或聚焦 Agent 浏览器。
- 浏览器状态本身不负责 Tool 起始 URL 匹配；精确匹配只在新建探索弹窗内执行。
- 窗口重新获得焦点时刷新浏览器状态。

### 5.3 主题切换

- 保留亮色／暗色主题。
- 继续使用 `localStorage` 保存选择。
- 图标按钮必须有可访问名称和 Tooltip。

## 六、Toolkit／Tool 两级导航树

### 6.1 顶部工具栏

包含：

- 搜索框：`搜索 Toolkit 或 Tool…`。
- 主按钮：`+ 新建 Toolkit`。

首版搜索范围仅包含：

- Toolkit 的 `name`／`toolkit_id`。
- Tool 的 `name`／`tool_id`。

搜索不覆盖描述、域名、Exploration、代码或日志。命中 Tool 时保留并展开其父 Toolkit；命中 Toolkit 时展示该 Toolkit 及其全部 Tool。

### 6.2 Toolkit 节点

默认展示：

- 展开／收起图标。
- Toolkit 名称。
- 允许域名数量。

Hover 或键盘聚焦时展示：

- `+`：在该 Toolkit 下新建 Tool。
- `•••`：管理 Toolkit。

管理弹窗支持：

- 修改描述。
- 修改允许域名。
- 删除空 Toolkit。

删除操作必须二次确认。后端约束失败时，弹窗保持打开并显示真实错误。

### 6.3 Tool 节点

默认展示 Tool 名称，当前 Tool 高亮。Tool 列表不展示「正式／开发中／失败」等派生徽章。

Hover 或键盘聚焦时展示 `•••` 管理入口，管理弹窗支持：

- 修改功能描述。
- 修改起始 URL。
- 修改运行后达成的页面效果。
- 删除 Tool。

Tool ID 创建后不可修改；编辑弹窗只读展示或隐藏 Tool ID。删除操作必须二次确认。

### 6.4 数据加载

现有 `/api/toolkits` 不返回下属 Tool。导航树初始化时：

1. 请求 Toolkit 列表。
2. 对需要展示的 Toolkit 请求 Tool 列表。
3. 首版可并行加载全部 Tool；若真实数据量导致性能问题，再改为展开时按需加载。

不得把 `/api/toolkits` 描述成聚合树接口。

### 6.5 空态

- 没有 Toolkit：展示产品说明和「新建 Toolkit」。
- Toolkit 没有 Tool：在节点下展示「暂无 Tool」和「新建 Tool」。
- 搜索无结果：展示「未找到匹配的 Toolkit 或 Tool」，不改变当前选中状态。

## 七、工作区 Header

### 7.1 左侧上下文

展示当前上下文：

```text
blog_admin / search_blog
```

过长名称使用省略号，并在 Tooltip 显示完整内容。

### 7.2 Tab

使用分段控件：

```text
探索｜开发｜调试
```

切换 Tab 只改变 `workspace`，保持当前 Toolkit 和 Tool。

### 7.3 Toolkit 发布区

包含：

1. 正式验证状态 Pill：`正式验证 X/Y`。
2. `导出 Toolkit`。
3. `安装到 WeWorker`。

规则：

- 验证状态来自 `/api/toolkits/{toolkitId}/export-status`。
- 存在未验证 Tool 时，Pill 的 Tooltip 列出 `unverified_tools`。
- 导出按钮仅在 `export_eligible && !activity.running` 时启用。
- 安装按钮仅在 health capability `install_to_weworker === true` 时显示，并遵守同一资格。
- 禁用时必须说明是没有正式 Tool、存在未验证 Tool，还是当前有活动运行。
- 安装成功根据返回状态展示「已安装」「已更新」或「已是最新版本」。

## 八、探索工作区

### 8.1 布局

桌面宽度下采用主从两栏：

```text
探索记录 280px | Exploration 详情 minmax(0, 1fr)
```

Exploration 详情采用经典 Agent 会话结构：

```text
详情 Header：状态、URL、运行控制
历史流：目标 → User 消息 → Agent 步骤段 → User 消息 → Agent 步骤段 → 最终结果
底部 Prompt：追加指令／继续探索
```

历史流独立纵向滚动，详情 Header 和底部 Prompt 保持可见。页面不设置独立「活动」栏。

![探索工作区内部结构原型](assets/web_ui_redesign/exploration-workspace.png)

### 8.2 探索记录列表

顶部包含：

- `+ 新建探索`。
- 当前 Tool 内搜索框。

卡片展示：

- Exploration ID。
- 状态。
- 操作步数。
- 创建时间。

搜索范围为 Exploration ID 和状态。列表默认按后端返回顺序展示，首次进入默认选中第一条。

### 8.3 新建探索

弹窗只读展示：

- 功能描述。
- 运行后达成的页面效果。
- 起始 URL。

允许填写可选补充指令，但不能改变 Tool 根本目标。Toolkit 域名约束由系统内部带入，不作为用户可编辑字段。

启动前流程：

1. 调用 `/api/browser/match?url={startUrl}` 精确匹配已准备页面。
2. 匹配成功后保存返回的内部 `target_id`，启用「启动探索」。
3. 未匹配时禁用启动，并提示用户打开 Agent 浏览器。
4. 提示必须视觉强调「务必完成登录」。
5. 「打开 Agent 浏览器」直接使用当前 Tool 的起始 URL。
6. 窗口重新聚焦或用户点击「重新检测」时重新匹配。

`target_id` 只用于提交 Exploration，不在普通工作区展示。

### 8.4 Exploration 详情

详情头部展示：

- Exploration ID。
- 状态。
- 最终 URL。
- 失败原因。

控制区按状态显示或禁用：

- `running`：暂停、取消。
- `pause_requested`：显示等待步骤边界提示，并允许取消。
- `waiting_for_user`：继续、取消。
- 已有步骤且无冲突活动：回放。
- 满足开发输入资格：选为开发输入。

不要用一个始终可用的「停止」按钮代替现有状态机。

### 8.5 Agent 历史流

历史流按实际发生顺序展示面向用户的执行上下文，第一项固定为本次探索目标：

- 功能描述。
- 运行后达成的页面效果。
- 起始 URL。

目标之后只展示三种历史节点：

- `user`：创建 Exploration 时的补充指令和后续追加指令。
- `agent_step`：Agent 的思考、执行动作和执行后的页面观察。
- `agent_final`：成功 Exploration 的唯一最终结果。

连续 `agent_step` 组成一段带纵向连接线的 Agent 步骤流。`user` 使用靠右的 User 消息块，并在视觉上切断前一段步骤连接线；后续 Agent 步骤从新的连接线段继续，步骤编号保持全局连续。创建 Exploration 时的补充指令放在目标之后、第一个步骤之前，不能把包含 Tool 目标和预期效果的组合运行指令标成用户补充指令。

每一步固定按「Agent 思考 → 执行动作 → 执行后页面」展示，不得把执行后页面放在动作之前。对应现有返回字段为：

- 步骤号和状态。
- Agent 思考：`thought`。
- 执行动作：执行代码／动作摘要，默认折叠。
- 执行后页面：动作全部执行结束并等待页面稳定后采集的标题、URL 和截图。

执行后页面属于对应 `agent_step`，只展示 UI-safe 的页面标题、URL、成功状态和截图，不展示异常摘要、完整 ARIA Snapshot、模型上下文或 Console 原文。截图点击进入 Lightbox。探索启动时供 Agent 首轮决策使用的初始页面观察不作为步骤节点展示。

`system`、普通 `user`／`assistant`、observation、exit 和以下内部异常事件不得进入历史流：

- `FormatError`。
- `InvalidModelResponse`。
- `SelfReflectionGate`。
- 自动重试和已经恢复的浏览器异常。

只有仍然有效的阻塞、必须用户接管或导致流程终止的错误，才通过详情顶部的当前状态提示展示。一旦阻塞解除，顶部提示消失，不在历史流保留已解决异常。

已完成 Exploration 的最终结果作为历史流最后一条 Agent 输出且只展示一次。失败、取消、暂停和等待用户处理属于当前运行状态，不生成历史节点；失败原因只在详情顶部展示。

### 8.6 底部 Prompt 输入区

Prompt 输入区固定在 Exploration 详情底部，中间历史流滚动时保持可见。包含：

- 多行文本框。
- 主提交按钮。
- `Command/Ctrl + Enter` 快捷键提示。

`waiting_for_user` 状态下按钮显示「继续探索」，提交到 resume；其他允许追加指令的状态显示「发送」，使用 messages 接口。输入区上方可显示与当前状态直接相关的一行提示，例如「请在 Agent 浏览器完成登录后继续」。服务端拒绝时显示真实错误，不伪造成功状态。

底部输入区必须预留自身高度，不能覆盖历史流最后一条消息。在不允许追加指令的终态下，输入框和提交按钮保持禁用，但仍可查看完整历史。

## 九、开发工作区

### 9.1 原则

开发工作区以 Developer Agent 协作为主，同时允许用户直接修改并保存当前开发中 Python 代码。它不是通用 IDE，不提供文件树、任意文件读写、Schema 编辑或代码历史。

![开发工作区内部结构原型](assets/web_ui_redesign/development-workspace.png)

### 9.2 布局与内容顺序

采用左侧核心开发区（60%）与右侧即时调试面板（40%）的双栏联动布局。

左侧核心开发区按以下顺序展示：

1. Tool 基础定义。
2. 最近一次 Development Run。
3. 当前开发依据。
4. 开发中版本，代码可编辑、契约只读。
5. 继续开发输入区。
6. 已应用到 Toolkit 的版本，只读且默认收起。

右侧即时调试面板包含：
1. 测试输入表单。
2. 历史试运行（Debug Run）切换下拉列表。
3. 当前选中记录的 Terminal 日志流与步骤截图。

### 9.3 Tool 基础定义

只展示属于 Tool 本身的字段：

- 功能描述。
- 起始 URL。
- 运行后达成的页面效果。

`parameters_schema` 和 `result_schema` 属于具体代码槽位，必须在开发中／正式版本内部展示，不能合并成唯一的 Tool 契约。

### 9.4 当前开发依据

展示：

- 来源 Exploration。
- 开发起点：首次开发或已发布版本。
- 最近开发指令。
- 用户明确选择的 Debug Run。
- 更新时间。

普通继续开发不能更换来源 Exploration。改用另一条 Exploration 必须走「从探索重新开发」。

### 9.5 开发中版本

展示：

- 描述。
- 参数 Schema。
- 返回 Schema。
- 当前代码。

代码区可提供：

- 行号。
- Python 语法高亮。
- 复制按钮。
- 开发中代码的「编辑代码」入口。
- 编辑状态下的「保存修改」和「取消修改」。
- 展开／收起。

正式代码区不得提供光标编辑或保存。开发中代码进入编辑状态后只允许修改 Python 代码；保存时在后台携带进入编辑前的 `code_hash`，服务端复用现有 Slot 校验并拒绝签名与参数 Schema 不一致的代码。保存成功后刷新发布资格；文件增删、Schema 表单编辑、自动保存、代码历史和跨页面持久化草稿均不提供。

`code_hash`、`artifact_hash` 等内部版本标识不得直接显示在界面上。需要表达版本关系时，只显示「首次开发／已应用到 Toolkit 的版本」或「当前产物／旧产物」等用户语义。

### 9.6 开发操作状态

#### 首次开发

正式和开发中版本都不存在时：

- 必须先从探索工作区选择一次成功 Exploration。
- 显示必填首次开发指令。
- 用户点击「开始开发」后调用普通首次开发接口。

#### 基于已应用版本开发

存在已应用版本但没有开发中版本时，允许「基于已应用版本开发」。

#### 从探索重新开发

允许选择当前 Tool 的一次成功 Exploration。选择后回到首次开发输入态；只有用户填写必填指令并点击「开始开发」时，服务端才清空当前开发中版本并启动隔离开发。

#### 继续开发

存在开发中版本且没有正在运行的 Development Run 时，显示必填指令输入框。可明确引用一次即时调试失败的 Debug Run 作为本轮证据。

#### 重新开始

清空开发中版本，属于不可恢复操作，必须二次确认。已应用版本不受影响。

#### 应用到 Toolkit (原发布)

只有当前开发中代码哈希存在成功的 development Debug Run 时才允许应用到 Toolkit。应用成功后提示用户该版本已生效。

### 9.7 Development Run

显示：

- Run ID。
- 状态。
- 创建时间。
- 失败原因。
- `process.log` 入口。
- 存在异常详情时显示 `runtime_errors.jsonl` 入口。

运行期间显示取消入口。SSE 仅用于状态更新，不能描述为 Developer 日志实时流。

## 十、调试工作区

![调试工作区内部结构原型](assets/web_ui_redesign/debug-workspace.png)

### 10.1 渠道

默认选择开发中版本；不存在开发中版本时选择正式版本。不存在任何版本时显示空态并引导用户到开发工作区。

渠道控件：

```text
开发中｜正式
```

不可用渠道保持禁用，不自动创建槽位。

### 10.2 参数表单

根据当前渠道槽位的 `parameters_schema` 渲染：

- `string`：文本输入。
- `integer`／`number`：数字输入。
- `boolean`：复选框。
- 必填字段：明确标记。
- `description`：辅助说明。
- `default`：表单初始值。

业务类型和约束最终由后端再次校验，前端校验不能替代服务端校验。

### 10.3 运行控制

- 没有全局冲突活动时允许「运行」。
- 当前 Debug Run 为 `queued` 或 `running` 时提供「取消」。
- 已结束 Run 提供「重复运行」。
- 重复运行使用原渠道和原参数，但仍需接受当前全局活动互斥检查。

### 10.4 运行事件面板

使用深色 Console 视觉，但只展示现有结构化信息：

- Run 已创建。
- Runtime 已启动。
- 当前 Tool 和参数摘要。
- 运行中。
- 成功、失败或取消。
- 结构化结果或错误摘要。

不承诺实时打印：

- 原始 stdout／stderr。
- 网络请求明细。
- CDP 协议报文。
- Traceback 全文。

完整日志通过 Run 详情中的「查看日志」打开已保存的 `process.log`。后续若需要日志 tail，必须另行设计受控增量日志接口和脱敏规则。

### 10.5 Debug Run 历史与详情

每条 Run 展示：

- Run ID、状态、渠道和创建时间。
- 正式渠道是否匹配当前产物，不显示内部版本 Hash。
- 参数和结构化结果。
- 错误摘要。
- 执行前后 URL／Title。
- 截图。
- 查看日志、取消或重复运行。

调试工作区不提供自动修复、自动进入开发或自动修改代码。

## 十一、弹窗、反馈与可访问性

### 11.1 弹窗关闭规则

所有业务弹窗和截图 Lightbox 只能通过：

- 明确的取消／关闭控件。
- 提交成功。

不得响应遮罩点击或 `Escape` 关闭。

### 11.2 破坏性操作

删除 Toolkit、删除 Tool、清空开发中版本必须二次确认。确认内容应说明准确对象、影响范围和不可恢复性。

### 11.3 加载与错误

- 异步按钮提交期间禁用并显示进行中状态，避免重复请求。
- API 错误优先显示服务端真实 `error.message`。
- 页面级加载失败显示可重试入口，不清空当前选择。
- SSE 断开后刷新对应 Run 和全局活动状态；不得直接将 Run 判为失败。
- Toast 用于短反馈，复杂错误在当前卡片或弹窗内展示。

### 11.4 键盘与读屏

- 所有仅图标按钮必须有 `aria-label` 和 Tooltip。
- 导航树节点、菜单和 Tabs 必须可通过键盘聚焦和激活。
- 当前 Tab 使用 `aria-selected`，当前 Tool 使用 `aria-current`。
- 状态不能只依赖颜色，必须同时显示文本或图标。

## 十二、响应式设计

### 12.1 `>= 1280px`

- 左侧树 `260px`。
- 探索记录 `280px`。
- Exploration 详情使用单列 Agent 历史流，底部 Prompt 固定可见。
- 调试区可保持参数／事件和历史双列。

### 12.2 `900px～1279px`

- 左侧树缩至 `220px`。
- 探索记录缩至 `240px`。
- Exploration 详情继续保持单列历史流，目标卡片和 Prompt 适当压缩内边距。
- 调试区改为单列。
- 工作区 Header 允许发布区换行，但 Tabs 不折行。

### 12.3 `< 900px`

- 左侧树改为显式按钮打开的抽屉，不响应遮罩点击或 `Escape` 关闭，只能通过关闭按钮退出。
- 工作区上下文和发布区分两行。
- 探索记录与详情上下排列。

### 12.4 `< 760px`

- 操作工具栏允许按组换行。
- 长 ID、URL 和代码强制可换行或横向滚动。
- 固定按钮不得遮挡内容。

网站探索主要运行在桌面浏览器中，响应式设计用于窄窗口可用性，不追求移动端产品体验。

## 十三、真实 API 对接矩阵

### 13.1 全局状态与浏览器

| UI 动作 | 方法 | 端点 | 说明 |
|---|---|---|---|
| 获取 capability | `GET` | `/api/health` | 判断是否显示安装入口 |
| 获取当前活动 | `GET` | `/api/activity` | 返回活动类型、ID、Toolkit、Tool |
| 获取浏览器状态 | `GET` | `/api/browser/status` | 顶栏状态 |
| 启动／聚焦浏览器 | `POST` | `/api/browser/open` | 可选提交 `url` |
| 匹配起始页面 | `GET` | `/api/browser/match?url={url}` | 新建探索前精确匹配 |

### 13.2 Toolkit 与 Tool

| UI 动作 | 方法 | 端点 |
|---|---|---|
| Toolkit 列表／创建 | `GET`／`POST` | `/api/toolkits` |
| Toolkit 详情／更新／删除 | `GET`／`PUT`／`DELETE` | `/api/toolkits/{toolkitId}` |
| Tool 列表／创建 | `GET`／`POST` | `/api/toolkits/{toolkitId}/tools` |
| Tool 详情／更新／删除 | `GET`／`PUT`／`DELETE` | `/api/toolkits/{toolkitId}/tools/{toolId}` |

### 13.3 Exploration

| UI 动作 | 方法 | 端点 |
|---|---|---|
| Exploration 列表／创建 | `GET`／`POST` | `/api/toolkits/{toolkitId}/tools/{toolId}/explorations` |
| Exploration 详情 | `GET` | `/api/explorations/{explorationId}` |
| 面向用户的历史时间线 | `GET` | `/api/explorations/{explorationId}/timeline` |
| 原始安全消息／追加指令 | `GET`／`POST` | `/api/explorations/{explorationId}/messages`；`GET` 仅供内部诊断，工作区不消费 |
| 状态 SSE | `GET` | `/api/explorations/{explorationId}/events` |
| 暂停 | `POST` | `/api/explorations/{explorationId}/pause` |
| 继续 | `POST` | `/api/explorations/{explorationId}/resume` |
| 强制取消 | `POST` | `/api/explorations/{explorationId}/cancel?force=true` |
| 回放 | `POST` | `/api/explorations/{explorationId}/replay` |
| Run 文件 | `GET` | `/api/explorations/{explorationId}/files/{relativePath}` |

### 13.4 开发与发布

| UI 动作 | 方法 | 端点 |
|---|---|---|
| 正式槽位 | `GET` | `/api/toolkits/{toolkitId}/tools/{toolId}/formal` |
| 开发槽位、资格和最近 Run | `GET` | `/api/toolkits/{toolkitId}/tools/{toolId}/development` |
| 手动保存开发中代码 | `PUT` | `/api/toolkits/{toolkitId}/tools/{toolId}/development` |
| 首次开发 | `POST` | `/api/toolkits/{toolkitId}/tools/{toolId}/development/start` |
| 继续开发 | `POST` | `/api/toolkits/{toolkitId}/tools/{toolId}/development/messages` |
| 取消开发 | `POST` | `/api/toolkits/{toolkitId}/tools/{toolId}/development/cancel` |
| 基于正式版本开发 | `POST` | `/api/toolkits/{toolkitId}/tools/{toolId}/development/reset-from-formal` |
| 从探索重新开发 | `POST` | `/api/toolkits/{toolkitId}/tools/{toolId}/development/restart-from-exploration` |
| 清空开发中版本 | `DELETE` | `/api/toolkits/{toolkitId}/tools/{toolId}/development` |
| Development 状态 SSE | `GET` | `/api/toolkits/{toolkitId}/tools/{toolId}/development/events` |
| Development Run 详情 | `GET` | `/api/development-runs/{developmentRunId}` |
| Development Run 文件 | `GET` | `/api/development-runs/{developmentRunId}/files/{relativePath}` |
| 发布 Tool | `POST` | `/api/toolkits/{toolkitId}/tools/{toolId}/publish` |

### 13.5 Debug Run

| UI 动作 | 方法 | 端点 |
|---|---|---|
| Run 列表／创建 | `GET`／`POST` | `/api/toolkits/{toolkitId}/tools/{toolId}/debug-runs` |
| Run 详情 | `GET` | `/api/debug-runs/{debugRunId}` |
| 取消 | `POST` | `/api/debug-runs/{debugRunId}/cancel` |
| 状态 SSE | `GET` | `/api/debug-runs/{debugRunId}/events` |
| Run 文件 | `GET` | `/api/debug-runs/{debugRunId}/files/{relativePath}` |

### 13.6 导出与安装

| UI 动作 | 方法 | 端点 |
|---|---|---|
| 导出资格 | `GET` | `/api/toolkits/{toolkitId}/export-status` |
| 下载 Toolkit | `GET` | `/api/toolkits/{toolkitId}/export` |
| 安装到 WeWorker | `POST` | `/api/toolkits/{toolkitId}/install-to-weworker` |

安装端点只在 embedded 用户目录 capability 可用时注册。前端必须先读取 health capability，不能通过请求失败来判断是否显示按钮。

### 13.7 SSE 边界

系统不存在全局 `/api/events`。前端 `watchEvents(path, onEvent)` 只是对 `EventSource` 的包装。三个 Run 专属 SSE 只用于状态变化通知，收到事件后重新读取对应资源和 `/api/activity`；不得把它们描述成 stdout、stderr、网络或 CDP 日志流。

## 十四、前端代码影响范围

预计修改：

- `src/webwright/server/web/index.html`
- `src/webwright/server/web/styles.css`
- `src/webwright/server/web/app.js`
- `src/webwright/server/web/state.js`
- `src/webwright/server/web/components/toolkit_tree.js`
- `src/webwright/server/web/components/activity_status.js`
- `src/webwright/server/web/components/browser_status.js`
- `src/webwright/server/web/views/explore.js`
- `src/webwright/server/web/views/develop.js`
- `src/webwright/server/web/views/debug.js`

按需新增纯展示组件，例如：

- `components/workspace_header.js`
- `components/code_viewer.js`
- `components/run_console.js`

不预计修改：

- Toolkit Store。
- ProcessManager 状态机。
- Publisher 和安装逻辑。
- Exploration、Development、Debug REST API。
- Runtime、模型调用和浏览器生命周期。

若实施中需要修改上述后端模块，应停止并重新评估是否已经超出 UI 重构范围。

## 十五、实施顺序

1. 重构全局布局和工作区 Header，保持旧工作区 Body 可运行。
2. 将 Toolkit 下拉框迁移为两级导航树，补齐搜索、空态和切换规则。
3. 重排探索工作区，不改变现有状态与动作绑定。
4. 重排开发工作区，允许显式编辑并保存开发中代码，保持契约和已发布版本只读，保留完整 Developer Agent 流程。
5. 重排调试工作区，引入 Console 视觉的结构化事件面板。
6. 补齐响应式布局、键盘操作、加载态和错误态。
7. 完成自动化回归和真实浏览器手动验收。

每一步都应保持现有 API 适配层可用，避免同时重写布局、状态模型和请求逻辑。

## 十六、验证标准

### 16.1 自动化

- Toolkit／Tool 两级树：加载、展开、搜索、选择、创建、编辑、删除和空态。
- Tool 切换后三个工作区上下文一致。
- 当前活动胶囊能跳转到正确 Toolkit、Tool 和工作区。
- 全局活动运行时，冲突操作全部禁用且原因可见。
- 安装按钮严格按 health capability 显示。
- 导出／安装严格按当前正式产物资格启用。
- 探索暂停、继续、强制取消、回放、Follow-up 和选为开发输入。
- 首次开发、基于正式开发、继续开发、从探索重新开发、取消、清空和发布。
- 开发中代码编辑、取消、保存、哈希冲突、结构校验和保存后发布资格失效。
- Development Run 日志及异常详情入口。
- Debug 渠道、参数表单、运行、取消、重复运行、结果、截图和日志入口。
- 弹窗和 Lightbox 不响应遮罩或 `Escape`。
- 页面中不出现内部组件名称。
- SSE 断开不误判 Run 终态。

### 16.2 构建与语法

- 所有 Web 前端 JavaScript 通过语法检查。
- Webwright 聚焦前端／Server API 测试通过。
- WeWorker embedded 集成回归通过。
- Renderer 正式构建不受影响。
- `git diff --check` 通过。

### 16.3 手动验收

- 宽屏、普通桌面宽度和窄窗口布局符合响应式规则。
- 长 Toolkit／Tool／Run ID 不遮挡按钮。
- 真实 Agent 浏览器启动、聚焦、精确页面匹配和登录提醒正确。
- 真实 Exploration、Development Run 和 Debug Run 的状态可自动收敛。
- 开发中代码可手动保存；无效签名保留编辑状态和错误信息，取消后恢复只读展示。
- 导出和安装按钮在不满足资格时给出准确原因。
- 页面重新聚焦后，浏览器、活动、发布资格和当前工作区状态刷新正确。

## 十七、安全与产品边界

1. 页面用户文案不得出现内部组件名称，只使用「WeWorker 网站探索」「网站探索 agent」和「Agent 浏览器」。
2. 不在页面、日志或 Tooltip 展示模型 Key、内部 token、CDP URL 或原始 `target_id`。
3. 持久数据根保持 `~/.weworker/webwright/`，不得读取、迁移或清理旧 `~/.webwright`。
4. 只有 Electron 注入的用户目录 capability 可启用「安装到 WeWorker」。
5. 导出和安装继续复用服务端资格复核，前端禁用状态不是安全边界。
6. 不为视觉 Console 新增未经脱敏的网络、CDP 或 Traceback 输出。
7. UI 重构不得改变全局运行互斥、探索步骤边界暂停、强制取消或发布资格规则。
