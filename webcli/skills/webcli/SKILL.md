---
name: webcli
version: 1.1.6
description: "通过 WebCLI 操作网站的浏览器自动化。当用户想操作网站时使用——打开某个网站、搜索、下单、查订单、填表、读取页面内容、截图，或让浏览器自动完成网页任务。涵盖：打开浏览器、调用网站工具、截图。支持京东、1688、闲鱼、B 站、知乎、微博、抖音、小红书、豆瓣、贴吧、12306、携程、51job、BOSS 直聘、GitHub、Gitee、V2EX、掘金、有道云笔记、大众点评、什么值得买、雪球、Wikipedia、arXiv、Hacker News 等站点。"
allowed-tools: Bash(webcli *), Bash(npm install *), Bash(npm view *)
---

# WebCLI — 浏览器自动化

读取本安装包的使用说明：`webcli skills list --output-format=json` 列出随包 Skill，`webcli skills read webcli-browser` 或 `webcli skills read webcli-api-exploration` 返回原文；`--json` 返回内容信封。已知参考文件可传 `<skill>/references/<file>`。这些命令不安装、不执行 Skill；已安装 Adapter 的专属说明仍用 `webcli adapter skill <id>`。

需要 shell 补全时，`webcli completion bash|zsh|fish` 输出脚本，在用户选定 shell 中加载；不要自动修改启动配置。补全首级命令/Adapter、二级命令和别名，不补业务参数。发现过程只读静态 catalog/help，不运行 Adapter、不启动 Bridge；旧版动态计算注册名不求值。

通过 HTTP、Chrome 扩展或 Toolkit Adapter 调用网站能力；每个命令使用其声明的运行时。先查看 Adapter 信息，再决定是否需要浏览器、登录准备或业务页面。

需要探索新网站 API 或生成 Adapter 时，使用随包提供的 `webcli-api-exploration` Skill，并先运行 `webcli call exploration.help`。该链路由当前 Agent 分析和编写代码；HTTP 模式只需 WebCLI，浏览器模式另需插件，不依赖桌面客户端或额外模型 Key。

需要直接操作或检查页面时，使用随包提供的 `webcli-browser` Skill，先运行 `webcli call browser.help`。命名 session 在多个 CLI 进程之间共享绑定，浏览器命令与探索任务共用同一 Bridge。

## 环境准备（agent 自动完成，无需让用户操作）

**第一步——核对当前入口与所需能力**。旧发布版可能缺少探索入口，版本号相同也不代表能力相同；已有工作区/开发版或桌面内置入口时保留该入口，不能机械地用 npm 发布版覆盖。下面仅用于准备普通全局发布版：

```bash
REG=https://registry.npmjs.org
LATEST=$(npm view weworker-webcli version --registry=$REG 2>/dev/null)
CURRENT=$(webcli --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
if [ -z "$CURRENT" ] || [ "$CURRENT" != "$LATEST" ]; then
  npm install -g weworker-webcli@latest --registry=$REG
else
  echo "webcli 已是最新版 ($CURRENT)"
fi
```

- 命令不存在（`CURRENT` 为空）时上面会自动安装；版本落后时自动升级；已是最新则跳过。整个过程 agent 自动完成，不要让用户手动操作。
- 全局安装遇到权限错误（`EACCES` / `EPERM`）时，请用户自己在终端执行同一条命令，不要自行提权。
- 运行桌面端 WeWorker 的用户已内置 WebCLI，无需全局安装。
- **Bridge 服务**：首次 `webcli call` 时自动启动，无需手动 `webcli service start`。

## 首次准备（用户说「帮我完成 webcli 首次准备」时执行）

当用户要求做首次准备、或首次使用需要浏览器的命令时，按顺序执行，并**把结果直接回显给用户**。仅运行 PUBLIC_API/AUTH_API 的任务不要求加载扩展或打开网页：

1. 确保 `webcli` 已安装且为最新版（见上面的「环境准备」）。
2. 取扩展目录并**原样给出完整路径**：

   ```bash
   webcli extension-path
   ```

3. 把下面这份操作清单整段发给用户——只需要做一次：

   > 还差最后一步（只做一次）：
   > 1. 打开 Chrome，访问 `chrome://extensions/`
   > 2. 打开右上角的**开发者模式**
   > 3. 点击**加载已解压的扩展程序**，选择这个目录：`<第 2 步输出的完整路径>`
   > 4. 确认列表里出现 **WeWorker Browser Adapter**，且已启用
   > 5. 页面型命令打开目标网站并等待就绪；后台命令仅在需要建立登录态时登录一次

4. 用户完成后，用 `webcli call profile.list` 检查连接，再运行目标只读命令。仅在该命令确需页面时使用页面登录检查。

## 唯一需要用户手动做的一步：加载 Chrome 扩展

加载扩展是一次性的 Chrome 手动操作，agent 无法代劳。当工具调用返回 `Extension not connected` / `Chrome扩展未连接` 时，说明扩展尚未加载，引导用户完成：

1. 获取扩展目录：
   ```bash
   webcli extension-path
   ```
2. 打开 Chrome，访问 `chrome://extensions/`。
3. 打开右上角的 **开发者模式**。
4. 点击 **加载已解压的扩展程序**，选择上一步输出的目录。
5. 确认列表中出现 **WeWorker Browser Adapter** 扩展且已启用。
6. 页面型命令打开或刷新目标网站并等待就绪；后台 API 直接调用，按实际鉴权错误决定登录准备。

扩展会自动重连 Bridge，无需重启服务。加载完成后，重新执行刚才失败的 `webcli call` 验证连接。

> 扩展随 npm 包一起提供，无需另外下载；桌面端用户用同一条 `webcli extension-path` 也能拿到内置的那份。

## 发现有哪些站点和工具

不要凭记忆猜工具名或参数——已安装的适配器才是唯一真源。逐级查：

```bash
webcli help                    # 一级：已安装站点
webcli list                    # 站点简表（adapter list 的简写）
webcli list --json             # 站点 + 完整工具定义
webcli <site> help             # 二级：某站的全部命令（如 webcli jd.com help）
webcli <site> <command> help   # 三级：单个命令的参数
webcli <site> -help -f json    # 结构化输出，便于解析
webcli adapter skill <id>      # 该站的 SKILL.md（含 Homepage URL）
```

## 核心命令

### 调用适配器工具

```bash
webcli call <domain>.<action> --key=value          # 标量参数推荐这种
webcli call jd.com.search_products --keyword=手机
webcli call mail.163.com.get_unread_emails --limit=5

webcli call <domain>.<action> --args '<json>'      # 数组/对象参数用 JSON
webcli call <domain>.<action> --args '{"key":"value","arr":[1,2]}'
```

### 打开浏览器

调用输出可用 `--output-format=json|markdown|table|plain|csv|yaml`（别名 md/yml）。业务默认终端 markdown、管道 JSON；browser/exploration/profile 默认 JSON，也接受显式格式。JSON/YAML 保留完整结构与 trace 信封，CSV/table 展示行，plain 适合文本。不要使用业务 `--format` 代替输出选项。console/network --follow 固定 JSONL，不能指定 CSV/YAML；错误退出码不因展示格式变化。

AdapterHub 的结果、help 和错误也支持显式输出格式，仍须遵守来源/权限变更和发布确认；显示格式不是授权。`adapter status [id]` 展示 v2 包候选、当前选择和失效原因，`adapter validate <directory>` 或 `adapter validate --installed [id]` 只做包/摘要/JavaScript 静态检查。`executed:false` 不能代替实际读取或副作用验证；Toolkit Python 和冻结 legacy 不在此语法检查范围。

编辑内置 v2 包时，`adapter eject <id> --directory <new-directory>` 复制到包名相同的新目录（父目录须存在），不自动激活或覆盖。先静态检查与实际验证，再用 `adapter develop <directory>` 显式选择；`adapter use <id> builtin` 切回且保留编辑文件。eject/develop/use 支持六类输出，不自动删除本地 override。

打开已知 Adapter 的网站并接入其登录 flow：

```bash
webcli call open_browser --url="<Homepage URL>" --adapter=<adapter-id>
```

`--adapter` 是显式绑定，不由 Bridge 根据 URL 或共享 SSO 地址反查。Bridge 会验证 URL 属于该 Adapter；已登录时直接返回，未登录时在后台启动登录流程并返回 `auth.status=waiting_user`。打开普通网页或探索未知网站时可以省略 `--adapter`，此时只开页面、不处理登录。

使用目标适配器 Skill 文档里的 **Homepage** URL——它带有正确的协议（http/https）和路径。不要猜测或默认用 https，部分站点只支持 http。

仅页面型命令需要打开业务网页并等待注入完成。先用 `adapter info/skill` 查看具体命令：PUBLIC_API/AUTH_API 无浏览器依赖；COOKIE_API 和 Extension 后台 API 可以复用浏览器登录态而无需业务页。Extension 后台是否还使用页面 helper，以其代码和实际验收为准，不凭登录要求推断必须开页。

### 遇到登录要求（AUTH_REQUIRED）

脚本/AI 调用遇到未登录时**立即返回**，不会阻塞等待：命令返回 `AUTH_REQUIRED`，WeWorker 浏览器已自动打开登录页，登录流程在后台继续。此时：

1. **立即告知用户**去登录：「WeWorker 浏览器已打开 <站点名> 登录页，请完成登录（支持扫码、短信验证码或账号密码）」。不要替用户等待或反复重试。
2. **用户确认后重新执行原命令**——这是最通用的方式：原命令在未登录时会立即返回 `AUTH_REQUIRED`（不会阻塞），登录后则直接出结果；不需要也不依赖各 Adapter 是否实现 `check-login-status` 类工具（各站命名与实现不一，并非都有）。
3. 主动探测（可选）：仅当站点可用 `webcli auth check <站点>`（基于 manifest `auth` 声明，非所有站点支持）或该 Adapter 确有登录检查类工具时才轮询，且有界（如每 15 秒一次、最多 5 次）；无探测手段就直接重跑原命令判断。
4. 返回 `AUTH_RETRY_REQUIRED` 表示登录已完成但该命令是写操作，为防重复执行没有自动重试——向用户确认后重新执行。
5. 需要 CLI 代为等待时显式传 `--login-wait=<秒>`（上限 900）；终端人工使用默认等待 300 秒并自动继续，脚本/AI 默认不等待。

### 截图

```bash
webcli call capture_screenshot --args '{}'
webcli call capture_screenshot --args '{"fullPage":true}'
```

## 适配器管理

```bash
webcli adapter list              # 列出已安装的适配器
webcli adapter list --json       # JSON 输出（含工具定义）
webcli adapter info <id>         # 查看某适配器的工具
webcli adapter skill <id>        # 输出某适配器的 SKILL.md
```

## 规则

1. 调用前检查命令运行时与鉴权说明；已有后台 API 直接调用。只有实际依赖页面或明确需要重新登录时才打开网站，不能给所有 Adapter 增加开页前置步骤。
2. 用 `open_browser` 打开已知 Adapter 网站时，传入 `--adapter=<adapter-id>` 并使用该 Adapter Skill 的 **Homepage** URL；Bridge 会校验二者归属并接入登录 flow。探索未知网页时省略 `--adapter`。不要默认猜测 http/https。
3. 页面型命令打开网站后等待页面和 Adapter 就绪；后台型命令不等待页面注入。
4. 工具名遵循 `<domain>.<action>` 格式，如 `jd.com.search_products`。
5. 参数优先用 `--key=value`；数组/对象用 `--args '<json>'`；重复 flag 会聚合成数组。数字文本保持字符串，由适配器按自身 schema 解析。
6. 工具返回错误时，最多重试 2 次。仍失败则告知用户。
7. 如果调用报 `Extension not connected` / `Chrome扩展未连接`，检查浏览器、插件和 Bridge 连接；该错误不能证明需要业务页面。
8. `open_browser` 返回 `auth.status=waiting_user` 时，页面已打开但登录尚未完成；提示用户登录并停止后续网站调用，不要重试 `open_browser`。登录态按命令实际 Cookie、宿主环境或缓存来源检查。仅在包确有对应工具且其运行时适合时使用登录检查；页面就绪辅助命令不能证明后台鉴权可用。


### 静态规范审计

`webcli adapter convention-audit <directory>` 或 `--installed [id]` 不执行命令，复用 v2 包/来源/摘要校验并输出七类提示。未声明 safety 是配置事实；字段遗漏、混合大小写、limit 截断、catch 空返回、占位回退和缺反向写操作是启发式，需要按业务核实，不凭提示自动改名、删除或添加逆操作。结果 executed:false，六种格式保留 findings，存在提示/无效包退出 1；无提示不能代替真实调用和写效果验证。动态/helper/Toolkit/legacy 未覆盖。
