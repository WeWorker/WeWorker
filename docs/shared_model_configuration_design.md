# WeWorker 与网站探索agent共享模型配置设计

## 2026-09-22 配置流程修订（本地验证通过）

本节替代下文旧版中自定义双地址必填、两侧共用 Key／模型、首次同时检测两套接口的约束；其余运行时隔离与加密边界不变。

- 主配置只展示服务地址、API Key、模型。服务地址沿用 Claude Code 配置；高级设置容纳鉴权方式和上下文窗口。主配置验证、保存与启用不依赖探索接口。
- 主连接验证检查最小工具调用；自定义鉴权默认自动检测，仅在鉴权失败后尝试另一种受支持方式，成功后保存实际鉴权方式。列表获取失败允许手动填写模型。
- 首次打开网站探索agent时验证探索连接。内置服务沿用注册表；自定义服务优先使用既有探索地址，其次使用与完整主地址精确匹配的内置映射，最后只尝试用户提供的同一 Base URL。不替换或枚举未知路径，不根据域名猜测服务商。
- 模型配置统一在「设置 → 模型」管理。探索工作区不展示模型配置表单或「网站探索模型」区域；自动检测成功时不占用工作区，失败时仅显示原因、重试和前往模型设置的入口，不阻断主任务。
- 「设置 → 模型」保留折叠的「网站探索模型」区域，直接展示可编辑的服务地址、复用主 Key 选项和模型，不再提供连接方式选择。保存后探索工作区自动重新检测。独立配置跨主 Provider 切换保留；复用 Key／模型时明确跟随当前主配置。
- 2026-09-23：探索地址优先预填已保存值（包括旧配置），其次采用完整地址匹配的内置映射；其他自定义地址规范化后追加 `/v1`，末尾已有 `/v1` 不重复追加。生成值标注「根据主服务地址生成，请验证」，只用于可编辑表单，不自动写入配置或改变运行时地址；验证成功后才保存，失败保留输入与原配置。修改主地址不得覆盖已保存的探索地址。内置接口地址保持原有协议与模型适配能力。
- 新增设置字段 `exploration_base_url`、`exploration_api_key`、`exploration_model`、`exploration_use_main_key`，默认空地址／空 Key／空模型／复用主 Key。独立 Key 纳入既有 secret store 加密，响应只返回是否已保存。无需数据库迁移，也不读取旧探索数据目录。
- 保留 `openai_base_url_custom` 供既有配置读取与预填；新主表单不再修改它，新探索配置保存后优先使用显式保存地址。
- 探索临时表单验证成功后才保存；失败保留已保存配置。成功检测按实际连接配置在进程内缓存；Key、模型、地址或协议变化后重新检测，失败允许重试。
- 连接成功必须验证响应结构；探索检测校验结构化 JSON，不能把 HTTP 200、HTML 或空对象视为可用。禁止跟随检测请求重定向传递凭据，错误详情须移除当前 Key。
- 所有配置仍由 WeWorker 管理，通过原内部快照接口提供给探索 Worker；运行中任务保留旧快照，新任务使用新配置。

验收覆盖：仅主地址可保存启用；鉴权自动选择；已知映射／同地址双协议／不同地址／独立服务；旧配置继续读取；超时与鉴权失败不误报不支持；编辑期间旧检测结果不生效；密钥不进入明文设置和 API 响应；Renderer 单测、构建和 Backend 类型检查。

## 状态

- 版本：`1.5`
- 日期：2026-09-22
- 状态：单地址接入与按需探索配置已完成本地自动化和模拟界面验证；真实模型服务与跨平台安装包验收待完成
- 关联设计：[`webwright_integration_design.md`](webwright_integration_design.md)

## 结论

WeWorker 是 embedded 场景唯一的模型配置入口和配置真相源。用户选择内置厂商时只填写 API Key 并选择模型；程序从内置 Provider 注册表解析 WeWorker 与 Webwright 各自需要的协议和 Base URL。

自定义模型不暴露产品内部模块名称，只要求用户填写：

- API Key。
- 模型名称。
- Anthropic 兼容 Base URL。
- OpenAI Chat Completions 兼容 Base URL。

同一份自定义配置中，WeWorker 使用 Anthropic 兼容接口，embedded Webwright 使用 OpenAI Chat Completions 兼容接口。现有 `base_url_custom` 继续表示 Anthropic 兼容 Base URL，只新增 `openai_base_url_custom`；不引入字段别名或双写兼容层。

## 目标

- 内置厂商只让用户管理 API Key 和模型，不要求理解协议或完整 endpoint。
- WeWorker 继续通过 Claude Code SDK 使用 Anthropic Messages 协议。
- Webwright 按厂商原生能力使用 Anthropic Messages 或 OpenAI Chat Completions，并保留可靠 JSON 输出。
- 现有 WeWorker 模型配置无需迁移、无需重新输入 API Key。
- Webwright 仅作为 WeWorker embedded 组件运行，始终使用 WeWorker 当前激活的模型。
- API Key 只在 WeWorker 加密设置和受控进程内存中出现，不复制到 Webwright 持久文件。

## 非目标

- 不把所有厂商统一转换为 Anthropic 协议。
- 首期不支持只提供 OpenAI Responses API 的自定义网关。
- 首期不支持同一自定义厂商为两种协议配置不同 API Key 或不同模型名称。
- 不根据域名猜测厂商、协议、Base URL 或 endpoint。
- 不把内置厂商端点持久化到用户设置。
- 不兼容、导入或迁移 Webwright 历史模型配置。
- 不保留 Webwright 独立模型配置 UI、Provider Store 或模型配置文件读写能力。

## 术语与 URL 合同

### 协议标识

系统使用明确的协议枚举，不用“OpenAI 兼容”代替具体协议：

| 协议标识 | 请求 endpoint | 用途 |
|---|---|---|
| `anthropic_messages` | `<baseUrl>/v1/messages` | WeWorker；也可供 Webwright 的 Anthropic 原生实现使用 |
| `openai_chat_completions` | `<baseUrl>/chat/completions` | 智谱 coding plan、DeepSeek 和自定义模型的 Webwright JSON 请求 |

Webwright 既有 OpenAI Responses 实现不再属于目标架构。WeWorker 当前 Provider 注册表和自定义模型均不使用 Responses API，因此不为它保留协议分支。

### Base URL 规则

- 注册表和用户设置只保存 Base URL，不保存完整 endpoint。
- 规范化时去除首尾空白和末尾 `/`，保留 Base URL 中已有的路径前缀。
- 禁止用户填写以 `/v1/messages`、`/chat/completions` 或 `/responses` 结尾的完整 endpoint；校验错误必须提示应填写哪一种 Base URL。
- Adapter 只按协议追加固定路径，不擅自补 `/v1`，也不从 hostname 推断协议。
- 自定义 Base URL 可使用 `http` 或 `https`；WeWorker 不判断厂商是否支持明文 HTTP，实际可用性由模型接口探测或真实调用决定。
- URL 不得包含 username、password、query 或 fragment。

示例：

| Base URL | 协议 | 完整请求 URL |
|---|---|---|
| `https://api.anthropic.com` | `anthropic_messages` | `https://api.anthropic.com/v1/messages` |
| `https://open.bigmodel.cn/api/anthropic` | `anthropic_messages` | `https://open.bigmodel.cn/api/anthropic/v1/messages` |
| `https://open.bigmodel.cn/api/coding/paas/v4` | `openai_chat_completions` | `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions` |
| `https://api.deepseek.com` | `openai_chat_completions` | `https://api.deepseek.com/chat/completions` |

## Provider 注册表

### 定位

Provider 注册表是随构建交付的候选模型兜底配置，不是用户数据。它继续由 `build-profile.json` 进入构建产物，并由 Backend 与 Renderer 使用同一份生成结果；不得复制出多份手工维护的开发默认值。

注册表负责声明：

- 厂商 ID 和显示名称。
- 远程模型列表不可用时的候选模型列表及默认模型。
- WeWorker 使用的协议与 Base URL。
- Webwright 使用的协议、Adapter、Base URL 和结构化输出策略。

建议结构：

```ts
type ApiProtocol =
  | 'anthropic_messages'
  | 'openai_chat_completions'

type StructuredOutputMode =
  | 'anthropic_json_schema'
  | 'openai_json_object'

type WebwrightModelClass =
  | 'anthropic'
  | 'zhipu'
  | 'openai_chat'

interface ProviderEntry {
  id: string
  name: string
  models: string[]
  defaultModel: string
  weworker: {
    protocol: 'anthropic_messages'
    baseUrl: string
  }
  webwright: {
    protocol: ApiProtocol
    modelClass: WebwrightModelClass
    baseUrl: string
    structuredOutput: StructuredOutputMode
  }
}
```

### 首期内置映射与模型目录来源

| 厂商 | 内置候选模型 | 远程目录 | WeWorker | Webwright | JSON 策略 |
|---|---|---|---|---|---|
| Anthropic | 当前构建所选 Claude 模型 | Anthropic `GET /v1/models` | `anthropic_messages`；`https://api.anthropic.com` | `anthropic_messages`；`anthropic`；`https://api.anthropic.com` | `output_config.format` + `json_schema` |
| 智谱 coding plan | `glm-5.2`、`glm-4.7` | OpenAI 兼容 `GET /models`，失败时使用内置候选 | `anthropic_messages`；`https://open.bigmodel.cn/api/anthropic` | `openai_chat_completions`；`zhipu`；`https://open.bigmodel.cn/api/coding/paas/v4` | `response_format: {"type":"json_object"}` + 本地 Schema 校验 |
| DeepSeek | `deepseek-v4-flash`、`deepseek-v4-pro` | DeepSeek `GET /models` | `anthropic_messages`；`https://api.deepseek.com/anthropic` | `openai_chat_completions`；`openai_chat`；`https://api.deepseek.com` | `response_format: {"type":"json_object"}` + 本地 Schema 校验 |
| Custom | 无 | 分别尝试 Anthropic `GET /v1/models` 和 OpenAI 兼容 `GET /models`，合并去重 | `anthropic_messages`；用户填写 | `openai_chat_completions`；`openai_chat`；用户填写 | `json_object` + 本地 Schema 校验 |

远程目录请求成功时，候选项完全以官方接口返回为准；请求失败时才回退内置候选模型。系统不维护「停用模型」名单，也不根据候选列表判断用户当前配置是否可用。

### 注册表约束

- `defaultModel` 必须存在于 `models`。
- 内置厂商的两套 Base URL 必须为非空合法 URL。
- WeWorker 首期协议必须为 `anthropic_messages`。
- `modelClass` 必须与 Webwright 协议匹配：`anthropic_messages` 只能使用 `anthropic`；`openai_chat_completions` 可使用 `zhipu` 或 `openai_chat`。
- `structuredOutput` 必须与 Webwright 协议匹配。
- `custom` 在注册表中只声明协议和结构化输出策略，Base URL 保持为空；运行时必须从用户的两个自定义 Base URL 字段解析，禁止把空值当作可请求端点。
- Backend、Renderer 和测试从同一生成模块读取注册表；移除当前散落在 Backend bundle、Vite 和 Store 中的重复开发列表。

## 职责边界

模型目录、配置存储和协议探测必须保持独立：

- 模型目录只回答「有什么可以选」。远程成功时返回远程候选；远程失败时返回内置候选及失败原因。它不读取或修改当前选中模型，也不输出可用／停用结论。
- 配置存储只回答「用户选择了什么」。保存和切换 Provider 不要求模型存在于远程或内置候选列表中。
- 协议探测只回答「当前表单中的模型、Key 和 Base URL 能否完成指定协议请求」。结果不修改模型目录和配置。

设置下拉框必须把当前表单模型作为可选项保留。若它不在本次候选列表中，动态插入 `<model>（当前配置）`；该选项保持启用，不标记为停用或不可用，不静默映射为其他模型。

Backend 提供两个独立接口：

```text
POST /settings/provider/models
POST /settings/provider/probe
```

模型目录接口接受 Provider、未保存 API Key 和自定义 Base URL，返回 `models`、`source`（`remote`／`fallback`）及可选 `warning`。内置候选仅在所有适用远程目录均失败时使用；成功返回空列表仍属于远程结果，不触发兜底。展开配置、填写 Key 或 Base URL 后触发的自动拉取失败时静默回退，不显示刷新错误；只有用户明确点击「刷新模型」后遇到 `fallback`、部分接口失败或远程空列表，Renderer 才显示错误提示。远程接口返回非成功状态或成功响应格式无效时，`warning` 必须包含 HTTP 状态和未经摘取的实际响应体；Renderer 在「刷新模型失败」或部分失败提示下原样显示该内容。即使下拉框仍可展示内置候选或当前配置，也不得把本次手动刷新显示为成功。

协议探测接口接受同一份临时表单配置和 `target`（`weworker`／`webwright`），按目标实际协议发送最小请求。结果至少包含 `ok`、`target`、`protocol`、`model` 和稳定的错误类别；远程接口返回非成功状态时，失败结果的 `detail` 必须包含 HTTP 状态和未经摘取的实际响应体，Renderer 按协议分别原样显示。未保存 Key 优先于已保存 Key，空 Key 才读取该 Provider 的已保存 Key。修改模型、Key 或 Base URL 后，Renderer 必须清除旧探测结果。

## 用户配置与交互

### 内置厂商

设置界面展示：

- 厂商。
- API Key。
- 模型。

不展示厂商 Base URL 和协议选择。每个厂商只显示一个「测试模型可用性」按钮；无需保存，点击后用当前表单值并行测试两套实际接口：

- Anthropic 兼容接口。
- 厂商注册表声明的结构化输出接口。

测试结果必须分别显示两套接口的成功或失败；失败时在对应结果下原样显示远程接口的 HTTP 状态与实际响应体。用户文案只使用「Anthropic 接口」「OpenAI 接口」等协议名称；当两套接口均为 Anthropic 协议时，第二项显示「Anthropic 结构化输出接口」。界面不得出现 WeWorker 或 Webwright 名称。

### 自定义模型

设置界面固定展示：

- API Key。
- 模型名称。
- Anthropic 兼容 Base URL。
- OpenAI Chat Completions 兼容 Base URL。

界面不出现“WeWorker Base URL”或“Webwright Base URL”。字段帮助文本分别显示「不要加 `/v1/messages` 后缀」和「不要加 `/chat/completions` 后缀」，明确用户只需填写 Base URL。

首期假设同一个 API Key 和模型名称在两种兼容接口上都有效。不满足该条件的自定义网关不在首期支持范围内。

保存规则：

- API Key、模型名称、Anthropic 兼容 Base URL 必填。
- OpenAI Chat Completions 兼容 Base URL 可在旧设置过渡期为空，但为空时必须明确显示“Webwright 接口未配置”。
- 新建自定义配置时四项均必填，避免产生只能供一侧使用的新配置。
- 两套连接测试独立执行；任何一项失败都不清除已保存值。

## 持久化结构与 WeWorker 旧配置兼容

### 保留字段

以下现有字段语义不变：

```ts
active_provider
api_key
base_url
model
api_key_anthropic
model_anthropic
api_key_glm
model_glm
api_key_deepseek
model_deepseek
api_key_custom
model_custom
base_url_custom
```

`base_url_custom` 明确表示“Anthropic 兼容 Base URL”。新增且仅新增：

```ts
openai_base_url_custom: string
```

不新增 `anthropic_base_url_custom`，不把 `base_url_custom` 改名，也不在 API 中同时返回新旧别名。

### 默认值与读取

- `openai_base_url_custom` 默认值为 `''`。
- 旧 `settings.json` 缺少该字段时按空字符串读取，不执行文件迁移，不要求重新输入 Key。
- `api_key_custom` 继续使用现有 secret store 加密，不增加第二份 Key。
- 派生字段 `api_key`、`base_url`、`model` 继续服务现有 WeWorker Agent；其中自定义 `base_url` 仍来自 `base_url_custom`。
- 内置厂商 Base URL 始终从注册表解析，不回写用户设置。

### Settings API

自定义配置响应固定为：

```json
{
  "has_key": true,
  "model": "example-model",
  "base_url": "https://gateway.example/anthropic",
  "openai_base_url": "https://gateway.example/openai/v1"
}
```

保存请求固定接受：

```json
{
  "provider": "custom",
  "api_key": "...",
  "model": "example-model",
  "base_url": "https://gateway.example/anthropic",
  "openai_base_url": "https://gateway.example/openai/v1"
}
```

这里的 `base_url` 延续现有 API 语义，表示 Anthropic 兼容 Base URL；`openai_base_url` 对应新持久化字段 `openai_base_url_custom`。

### WeWorker 旧配置行为

| 场景 | 行为 |
|---|---|
| 旧内置厂商配置 | Key 和模型原样生效；Base URL 改由新注册表解析 |
| 旧自定义配置且仅有 `base_url_custom` | WeWorker 原样可用；embedded Webwright 明确不可用，直到用户补填 OpenAI Chat Completions Base URL |
| 旧内置厂商配置的模型不在当前候选列表 | 原值继续显示为启用的「当前配置」，可保存、切换和透传；仅协议探测或真实调用判断是否可用 |

Webwright 既有模型配置不属于兼容范围：不读取、不导入、不迁移。升级不主动删除磁盘上可能存在的旧 `models.json`，但所有模型配置代码路径均忽略该文件。

## 运行时共享机制

### 运行前提

- Webwright 只由 WeWorker 启动，不再判定 standalone／embedded 模式。
- Electron 必须为自己启动的 Webwright 注入共享模型配置凭据。
- 缺少凭据或获取配置失败时，模型 Task 必须失败关闭；Webwright 的非模型页面和健康检查仍可运行。
- Webwright 不提供本地模型配置来源，也不得回退任何历史配置文件。

### 内部鉴权

Electron 每次应用启动生成独立的 `webwrightModelToken`，仅通过子进程环境传给 Backend 与本次 `WebwrightManager` 拥有的 Webwright。该 token 与 Renderer 当前使用的 `WEWORKER_HTTP_TOKEN` 分离，不经 preload 暴露。

建议环境变量：

```text
WEWORKER_MODEL_CONFIG_URL=http://127.0.0.1:8765/internal/webwright/model-config
WEWORKER_MODEL_CONFIG_TOKEN=<per-launch random token>
```

Backend 仅在 URL 为固定 loopback、token 非空时注册内部接口。请求必须携带：

```http
Authorization: Bearer <WEWORKER_MODEL_CONFIG_TOKEN>
```

接口不开放 CORS，不接受浏览器 cookie，不允许 query token，并使用固定时间比较校验 token。

### 运行时配置快照

Webwright 在每个 Task 创建 Worker 前调用内部接口，Backend 此时解析当前激活 Provider，返回一次不可变快照：

```json
{
  "provider_id": "glm",
  "protocol": "openai_chat_completions",
  "model_class": "zhipu",
  "base_url": "https://open.bigmodel.cn/api/coding/paas/v4",
  "model": "glm-5.2",
  "api_key": "...",
  "structured_output": "openai_json_object"
}
```

约束：

- 响应使用 `Cache-Control: no-store`。
- Backend 不返回 WeWorker 的 Anthropic Base URL，除非 Webwright 当前协议确实为 `anthropic_messages`。
- Webwright 不把响应写入任何模型配置文件、Task JSON、日志或浏览器状态。
- Server 只在创建 Worker 时持有响应；只把必要字段通过 Worker 进程环境或 stdin 传入，并在 Task 生命周期结束后释放引用。
- 浏览器 UI 只能读取脱敏状态，例如 Provider 名、模型名和“由 WeWorker 管理”；不能取得 Base URL、Key 或 token。
- 用户切换模型后，新 Task 获取新快照；已经运行的 Task 继续使用创建时快照，不中途切换。

## Webwright 协议适配与 JSON 输出

### Adapter 划分

Webwright 当前 `ZhipuModel` 使用 Chat Completions，而 `OpenAIModel` 使用 Responses API；两者不能通过改 URL 相互替代。协议字段决定请求 URL 与结构化输出合同，`model_class` 决定使用哪一个 Webwright Adapter。

通用 `OpenAIChatCompletionsModel` 负责：

- Bearer 鉴权。
- `/chat/completions` 请求与响应解析。
- `response_format: {"type":"json_object"}`。
- JSON 解析、Schema 校验和有限修复重试。

智谱 coding plan 使用现有 `ZhipuModel`，由运行时快照覆盖模型名和 Coding Plan endpoint，保留智谱特有的 Thinking 修复请求逻辑。DeepSeek 与自定义 Provider 使用通用 `OpenAIChatCompletionsModel`。现有 OpenAI Responses Adapter、Webwright Provider 注册表、模型配置 API／UI 和 Model Store 均应移除。

Anthropic Adapter 继续使用 Messages API，并增加原生结构化输出：

```json
{
  "output_config": {
    "format": {
      "type": "json_schema",
      "schema": {}
    }
  }
}
```

### JSON 可靠性

Anthropic 原生 `json_schema` 由服务端约束输出，返回后仍进行本地解析和 Schema 校验，以防代理兼容实现声明支持但实际忽略字段。

智谱 coding plan、DeepSeek 和自定义 Chat Completions 使用 `json_object`；该模式只保证合法 JSON，不保证符合业务 Schema，因此必须：

1. 在 system prompt 中明确要求 JSON，并包含目标 Schema／字段约束。
2. 设置 `response_format: {"type":"json_object"}`。
3. 解析响应并执行本地 JSON Schema 校验。
4. 失败时把精简的校验错误反馈给模型，最多修复重试一次。
5. 第二次失败后返回结构化错误，不把错误 JSON 交给后续浏览器动作执行。

不得用正则从 Markdown code fence 中“抢救”任意文本作为成功结果；只有完整 JSON 解析和 Schema 校验通过才算成功。

## 错误语义

至少区分以下错误：

| 错误 | 用户提示 |
|---|---|
| 内置厂商 Key 缺失 | 当前厂商尚未配置 API Key |
| 自定义 Anthropic Base URL 缺失 | Anthropic 兼容接口未配置 |
| 自定义 Chat Base URL 缺失 | OpenAI Chat Completions 兼容接口未配置，Webwright 暂不可用 |
| URL 实际为完整 endpoint | 请填写 Base URL，程序会自动追加对应路径 |
| 内部配置鉴权失败 | embedded 模型配置不可用；不得暴露 token 细节 |
| 模型返回非法 JSON | 模型未返回符合要求的结构化结果 |
| Provider 协议不匹配 | 当前厂商的 Webwright 协议配置无效 |

外部接口错误可记录状态码、厂商 ID、协议和请求 ID；禁止记录 Key、Authorization header、请求正文、模型原始敏感输出和用户数据路径。

## 安全边界

- API Key 的唯一持久化来源是 WeWorker 加密 settings secret store。
- 内部 token 每次应用启动重建，不落盘，不复用现有 Renderer token。
- 模型配置接口固定绑定 `127.0.0.1:8765`，不接受远程 Host。
- Webwright 只通过受鉴权内部接口读取当前模型快照，不读取 WeWorker 的 `settings.json`、数据库或其他配置文件。
- Webwright 不能修改 WeWorker 模型设置。
- 模型 Key 不进入 `WEBWRIGHT_HOME`、Task、Toolkit、日志、health、Renderer 或浏览器网络响应。
- `8766` 被未知进程占用时 Electron 不向该进程传递 token；只有本次成功 spawn 的自有 Webwright 获得 token。
- 应用退出和 Webwright 重启后，旧 token／旧 Worker 不得继续取得配置。

## 实施顺序

### 第一阶段：配置模型与注册表

- 扩展构建 profile 和 validator，使 Provider 同时声明 WeWorker 与 Webwright 协议／Base URL。
- 生成单一 Provider 注册表模块，Backend、Renderer 与测试共同消费。
- 更新 DeepSeek 内置候选模型；远程目录成功时以官方返回结果替代内置候选。
- 扩展 Settings，新增 `openai_base_url_custom`，保持 `base_url_custom` 原义。
- 更新设置 UI、保存 API 和双接口连接测试。
- 增加模型目录服务和协议探测服务；候选列表不得成为配置校验白名单。

### 第二阶段：embedded 配置传递

- Electron 生成独立 token，并注入 Backend 与自有 Webwright。
- Backend 增加固定 loopback 内部配置快照接口。
- 移除 Webwright 独立模型配置 UI、API、Provider Store、`models.json` 读写和 Responses Adapter。
- Webwright Worker 只使用 WeWorker 快照，不提供第二配置来源。

### 第三阶段：Webwright 协议 Adapter

- 保留通用 Chat Completions Adapter。
- 智谱 coding plan 接入现有 `ZhipuModel`；DeepSeek、自定义模型接入通用 Adapter。
- Anthropic Adapter 接入 `output_config.format`。
- 所有 Adapter 统一接入本地 Schema 校验和有限重试。

### 第四阶段：集成与发布验证

- 验证开发态与 packaged embedded runtime。
- 验证 Webwright 在没有 WeWorker 模型凭据时拒绝启动模型 Task。
- 完成 macOS arm64 自动化与真实请求，再纳入 macOS x64／Windows x64 安装包验收。

## 验收标准

### 注册表与设置

- 精确断言每个内置厂商的两套协议、Base URL、内置候选模型和默认模型。
- 远程模型目录成功时只展示远程结果，失败时展示内置候选；当前配置始终作为启用选项保留。
- 保存、切换、WeWorker Agent 和 Webwright 快照均不校验模型是否属于候选列表。
- 构建 profile 非法组合在构建期失败。
- 旧 settings 无 `openai_base_url_custom` 时可正常启动，既有 Key 无需重新输入。
- `base_url_custom` 仍驱动 WeWorker；缺少新字段只禁用自定义 Webwright。
- API 响应不返回明文 Key。

### URL 与连接

- 覆盖末尾 `/`、路径前缀、误填完整 endpoint、query、fragment、HTTP 与 HTTPS。
- Anthropic、智谱 coding plan、DeepSeek 分别验证最终完整 URL 和 `model_class`。
- 自定义两套连接测试由一个按钮触发，并分别显示协议结果。
- 协议探测使用当前表单值且不持久化；修改模型、Key 或 Base URL 会清除旧结果。

### 运行时与安全

- Webwright 模型 Task 只使用 WeWorker 快照；代码中不存在 `models.json` 或其他本地模型配置回退路径。
- 无 token、错误 token、过期 token 和非 loopback 请求全部拒绝。
- 浏览器无法读取内部 token、API Key 和模型配置响应。
- Key 不出现在日志、Task 文件、health 或进程命令行。
- 未知 `8766` 占用者无法获得任何凭据。
- 切换模型后新 Task 使用新配置，运行中 Task 保持旧快照。

### 结构化输出

- Anthropic 原生 JSON Schema 成功、拒绝和不兼容代理路径均有测试。
- 智谱 coding plan、DeepSeek、自定义覆盖合法 JSON、Schema 不匹配、修复成功、二次失败和截断响应。
- 未通过 Schema 的动作不得进入浏览器执行阶段。
- Webwright 旧 OpenAI Responses Provider、模型配置 API／UI 和 Model Store 不再被生产入口引用；相关文件的物理删除需按项目红线单独确认。

## 官方依据

- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [智谱 Claude API 兼容](https://docs.bigmodel.cn/cn/guide/develop/claude/introduction)
- [智谱编程端点](https://docs.bigmodel.cn/cn/guide/develop/others)
- [智谱结构化输出](https://docs.bigmodel.cn/cn/guide/capabilities/struct-output)
- [DeepSeek Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)
- [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)
- [DeepSeek V4 变更记录](https://api-docs.deepseek.com/updates/)
