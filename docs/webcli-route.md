# WebCLI 自然语言路由

`webcli route` 将自然语言需求映射到当前可用的 Adapter 命令，只推荐命令，不执行命令，也不生成业务参数。

```text
webcli route --help
webcli route "Search for browser automation projects"
webcli route github.com "List repository issues" --json
webcli route github.com "List repository issues" --verbose
```

可选的第一个参数是完整且精确的 Adapter ID。指定后跳过站点选择；否则整段文本作为需求。需求以 `-` 开头时，在它前面加 `--`。`--json`（或 `--output-format=json`）输出结构化结果，`--verbose` 只向 stderr 输出阶段耗时。

## 配置与协议

调用进程必须通过 `WEBCLI_D3_URL` 指定决策服务的 HTTP(S) 基地址，没有内置部署地址。示例：

```powershell
$env:WEBCLI_D3_URL = 'http://127.0.0.1:8080'
webcli route github.com "List repository issues"
```

CLI 不读取桌面端模型配置。部署启动器可以从其独立配置读取环境默认值并注入子进程；已经存在的进程环境变量优先。实际部署地址应保存在部署配置中。

客户端向 `<WEBCLI_D3_URL>/v1/systemone` 逐题发送 POST，使用 `model: "vllm-sr/d3-flash"`、`state` 和 `questions`。每个问题包含 `type: "choice"`、`instructions` 和以真实候选 ID 为键的 `criteria`；应答需提供对应的 `answers[id]`，包含 `type: "choice"`、合法 `choice` 和覆盖所有候选的 `[0, 1]` 概率。概率总和应接近 1，`choice` 应对应最高概率候选；不满足时拒绝路由。拒绝重定向，单题超时为 30 秒，不附带认证凭据。

需求原文与候选名称、说明会发送给配置的决策服务。参数 Schema、用户数据、模型 Key 和浏览器凭据不在请求中。只有一个候选的问题直接确定，不请求服务。

## 选择流程与结果

1. 从宿主当前生效的托管 Adapter 目录提取规范命令，按完整 Adapter ID 分组。不扫描旧目录，不将别名或旧版本作为新候选；停用或损坏的包不可参与选择。
2. 每组最多九个站点，各组分别取前三名；候选仍超过九个时继续分组筛选，不直接比较不同组的概率。最终将不超过九个候选放在同一题终选，概率达到 0.85 才进入命令层。
3. 对目标 Adapter 的规范命令进行选择，概率达到 0.85 时返回 `kind: "routed"`、`callCommand`、`helpCommand` 和置信度。普通文本输出同时展示当前命令的参数与安全提示。
4. 概率不足返回 `kind: "low-confidence"`、停止层级和最多三个候选，不给出唯一推荐。

`--json` 的 stdout 始终为结果 JSON，诊断写入 stderr。退出码：`0` 表示分类完成（包括低置信度候选）；`1` 表示配置、目录或服务失败；`2` 表示参数用法错误。路由不验证业务页面、登录态或参数是否可执行，后续调用继续走既有确认与运行器边界。

实现保留工程包的分组粗筛、站点终选、命令选择、0.85 门槛及 System One 协议。未引入备用决策引擎、旧静态目录、特定站点的人工选择规则或其他工具市场改动。


## 可配置决策服务

桌面与 npm 使用同一 WebCLI 实现。部署默认值从模型配置的 environment 白名单生成，通用源码不包含部署地址或凭据。`WEBCLI_D3_URL`、`DECISION_API_KEY`、`WEBCLI_D3_MODEL` 可通过进程环境覆盖；模型名显式设为空字符串时，请求不发送 model。System One 服务使用 `/v1/systemone`，基地址不要包含该后缀。

需要模型字段的服务可设置模型名称；不接受模型字段的服务配置空字符串。两者均使用 state/questions 请求及 answers 响应。切换服务时同时配置地址、凭据与模型，禁止把内部凭据发送到其他服务。系统不自动回退或探测切换。

受保护凭据可用 `scripts/set-decision-api-key.ps1` 配置；启动器 `scripts/run-webcli.cjs` 只注入上述白名单字段。内部发行版仅维护配置及 Adapter 资源，不得覆盖 webcli 运行时代码。
