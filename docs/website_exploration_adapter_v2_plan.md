# 网站探索agent生成 v2 Adapter 与统一 Adapter 树方案

日期：2026-10-24

状态：三个阶段的源码实现已落地，聚焦自动化验证已执行；真实网站与正式安装包验收仍待完成。实际进度和验证结果以项目 ROADMAP 为准。

## 一、背景

本次改造的目的是将 Toolkit 与 Extension 两种方式的代码融合在同一个 Adapter 中，共用包名称、manifest、版本、Skill 和调用入口。用户可以选择已有 Extension Adapter，通过网站探索agent新增 Toolkit 能力，并在同一棵 Adapter 树中查看和维护相关内容。

当前网站探索agent将探索、开发和调试得到的工具发布为 v1 Toolkit 包：`manifest.json` 使用 `schema_version: 1`、`adapter_type: "toolkit"` 和统一的 `scripts/toolkit.py` 入口，包内自带 `SKILL.md`、运行时脚本和依赖声明。安装路径仍以 Toolkit Skill 目录为中心。

现有 v2 Adapter 已支持在一个包内同时声明 Extension 与 Toolkit 命令：JavaScript 命令使用 `runtime: "extension"`，Python 命令使用 `runtime: "wewright"`。两类命令共用包名称、manifest、版本和调用入口，分别由不同 Runner 执行。v2 包的运行时 Skill 由有效包元数据派生，不需要生成器随包交付 `SKILL.md`。

当前探索页的 Adapter 树只读取网站探索agent自身维护的 Toolkit 和工具记录，无法直接展示、选择和扩展已有 v2 Adapter。因此需要同时打通 v2 产物链路和已有包的交互入口。

本方案将 Adapter 的生成和更新维护交给网站探索agent。WebCLI 提供发现、渐进式 help 和命令执行，复用已有安装与 Skill 刷新实现，不新增由 WebCLI 决定业务代码合并的职责，也不新建独立 Adapter 管理模块。

## 二、目标与范围

按以下顺序形成三个闭环：

1. 新建 v2 Toolkit 包：生成、调试、安装、Skill 加载和真实调用完整通过。
2. 扩展已有 Adapter：保留 Extension 命令，新增 Toolkit 命令，以完整工作副本直接覆盖更新用户版本。
3. 统一 Adapter 树：已有包可见、可选择扩展，草稿与安装版本同步展示。

本方案不增加并发合并、安装冲突解决界面、独立的完整性校验体系或 Extension 命令编辑能力。保留已有必要的 v2 格式校验、权限约束和安装规则；直接覆盖不等于绕过这些现有约束。

根据用户确认，没有真实的旧 Toolkit 交付给用户，本机旧产物由用户自行清理。因此不安排旧 Toolkit 数据迁移、转换工具或双格式发布，不自动清理本机历史数据。

## 三、本次改动模块与职责

| 模块 | 本次改动职责 |
|---|---|
| 网站探索agent | 创建 Adapter、读取已有包并准备工作副本、生成和调试 Toolkit 命令、维护完整 manifest、冻结正式调试快照并提交完整更新包 |
| WeWorker Renderer 探索页 | 统一 Adapter 树与工作区，支持选择已有包扩展、展示安装评审和收集确认，同步草稿和已安装状态 |
| WeWorker Backend 集成接口 | 对接已有包读取、v2 调试目录准备、安装评审与安装入口、目录和 Skill 刷新通知 |
| Toolkit Runtime 对接与分发（按需） | 核对生成命令所需的公共入口与打包资源；已有能力不足时补充对应支持 |

Adapter 内容如何更新由网站探索agent决定。WeWorker 的 Backend 可承担接口对接，复用现有安装逻辑完成落地，不另建一套包注册表。

## 四、新建 v2 Toolkit 包

### 4.1 产物结构

```text
example.com/
├── manifest.json
├── guidance.md
└── wewright/
    ├── commands/
    │   └── download-report.py
    └── internal/
```

`guidance.md` 与业务辅助目录按需生成。`wewright` 保留现有机器协议名称，用户界面显示 Toolkit。

- manifest 使用 `schema_version: 2`，包含包名称、版本、描述和 `commands`。
- 每条 Toolkit 命令声明唯一 ID、`runtime: "wewright"`、对应 Python 模块、描述、参数 Schema 和安全标记。
- 每条命令具有独立入口；业务辅助代码放入 `wewright/internal/`。
- 通用 Toolkit Runtime 由宿主提供，不在每个 Adapter 中复制旧运行时文件或依赖声明。
- 包内不生成 `SKILL.md`，安装后由现有 Skill 派生机制生成真实文件。

### 4.2 生成、调试与调用

保留现有探索、开发和调试流程，改造产物生成与执行入口。调试和正式执行使用同一份命令产物与运行契约，避免调试通过后重新生成另一份代码。

Toolkit 命令承接既有参数输入和 JSON 结果输出约定。参数默认值、类型转换和业务校验仍由 Toolkit 命令及其运行能力处理，WebCLI 不增加按业务 Schema 转换参数的职责。浏览器连接、允许域名、运行状态和错误退出语义需要在改造中保持明确。

完整链路为：

```text
新建 Adapter → 探索 → 生成 v2 命令 → 开发中调试
  → 冻结完整 v2 包 → 正式调试 → 安装评审与确认
  → 安装同一快照 → 刷新目录与 Skill
  → Claude Code 加载 Skill → WebCLI 真实调用
```

### 4.3 未安装工作副本的正式调试

开发中调试继续验证当前代码槽位，成功证据绑定任务、命令和当前 `code_hash`；它不能替代完整包的正式调试。网站探索agent完成本地发布后，先生成完整 v2 包并确定版本，再冻结正式调试快照。这里的本地发布只形成正式候选产物，不安装到用户目录，也不将草稿标记为已应用。

快照放在网站探索agent自身数据根下的任务目录，包含最终交付的全部文件。生成端按 v2 包文件的排序、文件名、长度和原始字节计算摘要以绑定调试证据；宿主在正式调试和安装前仍使用现有 `readPackageDirectory()`／`validatePackageFiles()` 独立校验，并要求两者摘要一致，不以生成端摘要代替宿主校验。快照、调试记录和目录元数据分别保存，调试产物不进入 Adapter 包。

WeWorker Backend 集成接口使用宿主已有 Node、WebCLI 和包校验能力，为每次正式 Debug Run 准备独立 v2 目录。接口只接受已关联的任务、快照标识和预期摘要，由服务端解析受控路径；不接受调用方传入任意安装目录。目录布局为：

```text
<debug-run>/
├── catalog/
│   ├── .profile.json
│   └── example.com/          # 已冻结的完整包
├── empty-adapters/           # 空目录，不放入其他包
├── host-data/                # 本次调试独立的 v2 状态和缓存
└── evidence/                 # 调试证据，不属于包内容
```

`catalog/.profile.json` 沿用现有格式，`schema_version` 为 `1`，`profile` 为当前宿主 Profile，`adapters` 只包含本快照的 `name`、`version` 和 `digest`。这是子进程发现快照的目录元数据，不表示把草稿安装成真实内置包，也不改变主目录的来源或授权。

正式调试子进程使用以下环境，全部路径均由宿主准备：

| 配置 | 值与作用 |
|---|---|
| `WEWORKER_BUILTIN_ADAPTERS_DIR` | 本次 `catalog`，只发现目标快照 |
| `WEWORKER_USER_ADAPTERS_DIR`、`WEBCLI_ADAPTERS_DIR` | 同一个 `empty-adapters`，不读取真实用户包 |
| `WEWORKER_ADAPTER_DATA_DIR` | 本次 `host-data`，不读取或修改真实 v2 选择状态 |
| `WEWORKER_BUILD_PROFILE` | 当前宿主 Profile，与目录元数据一致 |
| `WEWORKER_ADAPTERS_DIR` | 本次 `empty-adapters`，阻断旧 Toolkit Skill 目录参与调试发现；不再依赖它发现 v2 包 |
| `WEWORKER_TOOLKIT_RUNTIME` 及其模式配置 | 继续使用宿主注入的同一 embedded／开发态 Runtime |
| `WEBWRIGHT_RUNTIME_PATH`、CDP 和截图配置 | 继续使用当前任务的受控运行状态、浏览器连接和本次 Debug Run 截图路径 |

启动前通过同一环境解析 v2 有效目录，核对 Profile、Adapter 名称、命令 ID、`runtime: "wewright"` 和摘要，随后调用既有 `webcli call <adapter-name>.<command-id>`。命令 ID 使用 manifest 中的规范 ID，不从探索任务 ID 推导。WebCLI 与 Toolkit Runner 保持现有分派实现。

目录元数据中的固定摘要让现有加载器检查实际读取的包。调试完成后再次读取快照并核对摘要；发现包缺失、变化、命令不匹配或目录诊断时，本次调试失败，不调用已安装版本兜底。正式调试仍执行真实命令，沿用已有写操作确认规则，不能因目录隔离而自动授权业务写入。

网站探索agent新生成的 Toolkit 命令暂时统一声明 `safety: "read"`，不再维护独立副作用列表，Tool 表单也不提供操作类型选择。扩展已有 Adapter 时，原有命令的 `safety` 保持原声明；此约定不改变其确认规则。

Developer Slot 不再包含页面前置／后置状态文字数组；生成契约、槽位存储、开发界面和 Skill 内容均不要求这类字段。工具组合由调用方根据实际执行结果与页面状态判断。

### 4.4 正式调试证据与可安装资格

沿用现有 Debug Run 和 `export_eligible`，将其适配到 v2 命令与包摘要，不新增独立验证系统：

- 正式成功证据至少绑定当前宿主 Profile、任务、Adapter 名称、规范命令 ID、`channel: "formal"`、完整 v2 包 `digest` 和宿主 Runtime 构建标识。退出码为零且结构化结果 `ok: true`，前后摘要一致，才可记录成功。
- 新建包和混合包都以快照中的全部 `runtime: "wewright"` 命令作为 Toolkit 正式调试集合；已有 Toolkit 命令可按 manifest 在快照中执行，不要求伪造探索或开发历史。未验证的命令仍可逐条手动调试，不能自动重放写命令。
- 保留的 Extension／HTTP 命令不要求具备 Toolkit Debug Run；它们的文件、命令声明与原有元数据按工作副本基线核对保持不变，且继续完成阶段二要求的原能力调用验收。
- 任意包文件或 manifest 变化，包括版本、Schema、辅助代码、图标和指导文档，都会形成新摘要，使旧的包级正式调试证据失效；任务或命令 ID 相同不能复用旧证据。Runtime 构建标识变化后也需重新验证。
- `export_eligible` 只在包格式有效、保留内容检查通过、全部 Toolkit 命令具有匹配当前摘要和 Runtime 的正式成功证据时为真。安装与导出使用同一份已验证快照，不在调试后重新生成代码、改写版本或添加文件。

安装评审中的权限批准与调试成功是两项独立条件。调试成功不授予安装权限；安装批准也不能替代正式调试资格。

## 五、扩展已有 Adapter 与覆盖更新

### 5.1 完整工作副本

用户选择已有 Adapter 后，网站探索agent取得当前完整包，建立工作副本。工作副本保留原有 Extension 文件、命令声明、执行方式、权限与其他资源，在此基础上新增 Toolkit 命令和文件。

混合包结构示例：

```text
example.com/
├── manifest.json
├── guidance.md
├── extension/
│   ├── commands/
│   │   └── search.js
│   └── internal/
└── wewright/
    ├── commands/
    │   └── download-report.py
    └── internal/
```

两类命令使用同一个 `commands` 清单和包版本，命令 ID 在包内唯一。新增命令通过现有格式检查；本方案不提供重名冲突解决流程。

更新以完整工作副本为准：

1. 将新增 Toolkit 命令加入工作副本的 manifest。
2. 完成开发中调试，冻结包含原 Extension 能力的完整 v2 包，并通过第 4.3、4.4 节的正式调试和资格检查。
3. 按第 5.2 节完成安装评审与必要确认，通过现有安装入口覆盖该 Adapter 的用户版本，并使其成为当前有效版本。
4. 刷新 Adapter 目录、派生 Skill 和界面。

覆盖的对象是完整用户版本，不能只用新增 Toolkit 文件替换整个 Adapter。内置包可作为起点，但更新结果安装为同名用户版本，不直接修改应用安装目录里的内置资源。

不做并发版本合并。如果工作副本创建后，原包又通过其他途径更新，本次应用仍以工作副本内容为准，不保留那些后续修改。已有安装约束导致失败时，明确显示失败并保留草稿，不标记为已应用。

已有 Extension 命令在本轮保持原样，尤其保留后台 API 执行声明、鉴权来源与页面依赖，不能因生成 Toolkit 命令而改变原能力的执行方式。

### 5.2 安装评审、授权与提交

纯 Extension 包首次加入 Toolkit 命令会新增 `runtime:wewright` 安装权限，即使新增命令只读也必须评审。新增域名、写命令等权限由现有 `adapterPermissions()` 计算；已有用户包从本地、Hub 等来源改为网站探索agent生成来源，以及版本降级，继续遵守现有确认要求。

复用 `describeGeneratedInstall()`、`resolveGeneratedInstallApproval()` 与 `installAdapter()`。Backend 负责评审和提交，Renderer 展示并收集用户选择，网站探索agent提供已验证的完整快照；不将现有生成发布器绑定“创建草稿时摘要”的外层流程直接套入本方案的整包覆盖流程。

应用区在提交前展示 Backend 返回的目标包、版本、完整权限和覆盖结果预览，用户可在点击「应用」前查看；点击后仍须重新读取当前状态。Backend 保存本次评审与任务、快照及 Runtime 标识的关联，提交时同时核对这些关联和 `reviewId`。

1. 用户点击「应用」后，Backend 依据任务读取冻结快照，核对正式调试资格、包摘要、保留内容和当前宿主 Profile；对当前真实目录生成安装评审。客户端不能直接提供包文件、来源、基线或授权布尔值来绕过这些检查。
2. 评审包含 `profile`、`name`、目标 `version`／`digest`、`stateRevision`、`baselineDigest`、当前版本和来源、目标来源、完整权限、新增权限、来源切换和降级标记，以及已有机制生成的 `reviewId`。目标安装来源固定为 `{ kind: "generated" }`。新建包无比较基线时，界面仍展示其完整权限。
3. 没有新增权限、来源切换或降级时，本次「应用」直接提交。存在任一变化时，展示安装评审弹窗，明确列出具体变化，用户只能选择「取消」或「确认并应用」。内置包会被同名用户版本覆盖的结果也要展示，但不伪造已有安装器没有要求的来源切换授权。弹窗遵守遮罩和 `Escape` 不关闭的项目约定。
4. 确认请求只提交任务／快照标识、`reviewId` 与 `acceptChanges: true`。Backend 重新读取同一快照和真实目录生成评审，验证与先前返回的评审一致，再调用 `resolveGeneratedInstallApproval()` 得到 `expectedStateRevision` 和所需的 `allowPermissionChange`、`allowSourceChange`、`allowDowngrade`；这些参数不接受客户端直接指定。
5. 调用 `installAdapter()` 时传入已冻结并核对摘要的文件字节、固定来源、`expectedSourceDigest: review.baselineDigest`、上述评审结果和 `activate: true`。默认无变化的直接提交路径同样携带评审时的 revision 和基线。后续目录和 Skill 刷新继续按第六节执行。

整包覆盖的基线以安装评审时的当前有效包为准，不要求它仍等于工作副本创建时的包。如果二者已经不同，应用信息中展示起始与当前版本／摘要，提示本次将覆盖草稿创建后的更新，仍使用原工作副本，不合并后续修改。是否需要确认弹窗继续按新增权限、来源切换和降级规则判断，保持本方案已确认的直接覆盖边界。

评审后包内容、任务快照关联、Runtime、正式调试资格或真实目录状态变化，旧确认均不可继续使用。包摘要或 Runtime 改变时回到正式调试；只有安装状态变化时重新评审，并保留原快照及其仍有效的调试证据。安装器在锁内通过 `expectedStateRevision` 和 `expectedSourceDigest` 做最终检查，变化时报错并保留草稿，不自动重试授权或静默覆盖。校验、域名冲突等失败也不通过放开授权参数绕过。

用户取消评审时不执行安装、不修改当前有效包，也不丢弃草稿。上述授权只覆盖本次明确展示的包与安装状态，不记录为该 Adapter 未来更新的永久许可。

## 六、统一 Adapter 树与状态同步

树的数据来源为已有 Adapter 目录与网站探索agent草稿，按稳定的 Adapter 名称关联。同一个 Adapter 在树中只显示一个节点，在其下展示已安装命令与待应用的新命令。

| 对象或状态 | 展示与操作 |
|---|---|
| 已安装 Adapter | 展示名称、来源、版本和全部命令，可选择新增 Toolkit 命令 |
| 已有 Extension 命令 | 展示描述和参数，保留可见，不接入本轮编辑流程 |
| 开发中的 Toolkit 命令 | 挂在目标 Adapter 下，支持生成、编辑、调试，标明开发中或待应用 |
| 新建 Adapter 草稿 | 未安装时仍可见，应用成功后与已安装节点合并 |
| 应用失败的草稿 | 保留内容和待应用状态，显示错误并允许重试 |

探索任务 ID 与 Adapter 名称、命令 ID 分别保存并建立关联，避免现有内部 ID 规则限制带域名的包名称。已有包不需要伪造探索历史。

应用成功后的同步顺序为：安装入口确认成功，刷新有效目录与 Skill，再重新读取树数据并将对应草稿标记为已应用。界面不能在安装完成前显示成功。切换 Adapter 或命令继续遵守现有未保存代码的离开保护。

WeWorker 统一 Adapter 树中的删除 Tool 是一次操作：确认后移除探索工作区中的 Tool，以及当前有效 Adapter 中同 ID（下划线映射为连字符）的命令。已安装命令即使没有探索草稿，也提供删除入口。确认框列明关联探索历史不再从此 Tool 展示，并会移除已安装命令；如果它是用户安装包中的唯一命令，明确提示将卸载整个 Adapter。内置 Adapter 或非用户安装来源不能通过此入口直接删命令，预检失败时两侧均不改变；卸载会回退到同名内置包时拒绝删除。客户端提交当前目录摘要，Backend 重新读取真实目录，防止确认后安装包变化时误删。

删除由 Backend 协调：先在网站探索agent中暂存 Tool 目录及开发中目录，再用现有安装器事务更新用户包（删除命令及其模块）或卸载唯一命令所在的包，最后清理暂存。安装器失败时恢复暂存的 Tool；暂存失败时不改变安装包。安装成功后若清理暂存失败，目标已从两个可见目录消失，报告清理待完成，不误报整次删除失败。跨进程操作不宣称原子事务；崩溃或恢复失败须报告待人工检查，不自动覆盖后续安装变更。删除完成后刷新有效目录、Skill 和树；失败时不在界面显示删除成功。

## 七、实施步骤与验收

| 阶段 | 主要改动 | 完成标准 |
|---|---|---|
| 一：新建 v2 Toolkit 包 | 发布器、Python 命令入口、Toolkit Runtime 对接、v2 快照正式调试、安装评审与 Skill 刷新 | 一个真实网站只读命令完成生成、开发中与正式调试、安装、Skill 加载及真实调用；安装摘要与正式调试快照一致 |
| 二：扩展已有包 | 已有包读取、完整工作副本、manifest 追加、权限评审与整包覆盖更新 | 同一 Adapter 的原 Extension 命令和新增 Toolkit 命令均能真实执行，help 与 Skill 同时包含两类命令；新增 Runtime 权限获确认后才可安装 |
| 三：统一 Adapter 树 | 目录与草稿关联、目标选择、节点状态、安装后刷新 | 已有包可见并可扩展；新建、待应用、成功和失败状态正确；重开页面后读取的已安装内容与有效包一致 |

各阶段运行对应聚焦自动化测试。涉及 Renderer 时通过相关单测和生产构建；涉及 embedded Runtime 时核对分发资源，并在实际安装包中验证 Python 命令可脱离源码目录执行。仅通过源码测试不得记为安装包验收完成。

前两阶段还须覆盖以下聚焦回归，实施时补齐，不以本文的设计核对代替执行结果：

- 未安装的新包能通过正式调试；主目录中存在同名旧包时仍执行指定快照，真实安装与选择状态保持不变；快照损坏或缺失时失败，不回退旧包。
- 任一包文件或 Runtime 构建变化后，旧正式成功证据不可用于安装；调试期间改包不能记录成功，安装使用的摘要与成功证据完全一致。
- 混合包只将 Toolkit 命令纳入 Toolkit 调试资格；多个 Toolkit 命令尚有一个未验证时不可安装，原 Extension／HTTP 文件和命令声明保持不变。
- 纯 Extension 包新增只读 Toolkit 命令也须展示并确认 `runtime:wewright`；新建包完整权限可见；来源变化和降级分别按现有规则确认。
- 取消评审不安装；伪造或过期 `reviewId`、客户端直接提交授权标记不能安装；评审后包或注册表变化被拒绝，并按变化类型回到正式调试或安装评审。
- 工作副本创建后原包被更新时，展示覆盖信息并完成必要的权限／来源／版本确认后，可按完整工作副本覆盖；评审确认后原包再次变化时本次安装失败，不静默接受新基线。

上述验收项的执行结果及尚未覆盖的场景记录在项目 ROADMAP。

## 八、实施边界与待落定细节

- 沿用当前组件的数据访问边界：网站探索agent维护自身工作数据，通过 WeWorker 对接读取和安装能力，不直接任意读写宿主配置、数据库或安装目录。如实现需要改变现行权限约定，先更新对应规范。
- 生成命令从宿主提供的 `webwright.tool_runtime.toolkit_runtime.PublishedToolkitRunner` 导入运行器；每个 v2 包内的 `wewright/commands/<command-id>.py` 以标准输入接收 JSON 参数，并以结构化 JSON 输出结果。新建包从 `1.0.0` 开始；扩展现有包时，在原版本的 `major.minor.patch` 上递增 patch，原包的 Extension 文件和命令声明保持原样。
- 正式调试的 Runtime 标识包含版本、平台、架构、模式及 `build` 摘要。源码态摘要由 Python 源码和 `uv.lock` 计算；embedded 包在构建时将同一摘要写入 `webwright-runtime.json`。Runtime 构建变化后，旧的正式成功证据失效。
- WebCLI、Extension Runner 和 Toolkit Runner 均复用现有实现，不属于本次改动范围。
- 不新增全局依赖，不改变两类 Runner 的独立边界。
- 本文中的“发布”指生成本地正式产物与应用到本机，不包含上传 AdapterHub、公开发布或生产部署。

相关背景文档：[Adapter 统一架构与迁移计划](adapter_architecture_unification.md) 、[Toolkit Adapter 既有设计](webcli_toolkit_adapter_design.md) 、[Adapter 人工指导](adapter_guidance.md) 。上述文档中的 v1 Toolkit 交付说明是现状背景，本方案的 v2 交付目标需要随实施同步到相关设计文档。
