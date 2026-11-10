# webcli 版本自检与 upgrade 命令 设计

日期:2026-11-10
分支:`feat/webcli-upgrade-check`(基于 upstream/dev-1.1.0,独立 PR)
范围:webcli/index.js(检查+命令)、weworker desktop 两处 spawn env 注入;随下次行内包(@webank/webcli 1.1.12)发布生效。

## 背景

skill 经 `webcli call ...` 使用 webcli;版本更新后 skill 使用过程难感知,语言层
"每天对话先检查更新"依赖模型自觉、不可靠。目标:把信号内建到 CLI 输出(agent 必然
读到命令 stderr),并提供一条命令的顺滑升级。

关键事实:
- CLI 单链分派(webcli/index.js main);agent 经 `Bash(webcli call *)` 执行,**stderr
  一定可见**;
- registry `GET <registry>/<pkg>/latest` 返回 manifest JSON(单次 HTTP 即可);
- 桌面端(weworker)以 `execFile` 方式调用自带 webcli,取结果逻辑是
  `output = stdout || stderr`——**stdout 为空的静默命令会把 stderr 当结果**,这是
  必须设护栏的兼容性约束;
- 桌面端捆绑的 webcli 只随应用更新,`npm -g` 升级的是全局 CLI 那份——内嵌场景必须
  完全不做检查/升级,避免提示噪音与"升错对象"。

## 已确认决策

1. **策略**:提醒(stderr 通知)+ `webcli upgrade` 一条命令;不做全自动升级。
2. **兼容护栏**:内嵌模式(WEBCLI_EMBEDDED=1)整段关闭;协议/长驻命令豁免。
3. **registry 区分**:包内 `internal-registry.json`(由行内 repack 流程注入,不入公开仓)
   提供 `{"registry": "..."}`;`resolveRegistry` 优先级:env/--registry 显式覆盖 > 注入文件 >
   npmjs 默认。公开源码零行内地址;行内包 repack 时随 internal delta 注入。

## 设计

### 1. 版本自检(notice)

- main 入口、命令分派前插入检查;**豁免清单**(不打提示、不触发检查):
  `--version` / `-v` / `upgrade` / `--service` / `internal-ai-call` / `mcp`;
  另:`WEBCLI_EMBEDDED=1` 时整段跳过。
- 缓存 `~/.webcli/version-check.json`:`{ latest, checkedAt }`。
  同步读缓存比对(零网络);`checkedAt` 超 24h → 后台异步刷新(fire-and-forget,
  2s 超时,失败静默),本次仍用旧缓存,刷新结果下次生效。
- 比较:轻量 semver 数字段比较函数(零依赖);`local < latest` 时 stderr 打一行:

  ```
  [webcli] 有新版本 1.1.11(当前 1.1.8)——运行 webcli upgrade 升级(自动清理 Service Worker 缓存)
  ```

  stdout 永不污染(`--json` 输出安全);registry 不可达/离线完全静默。

### 2. upgrade 命令

`webcli upgrade [--registry <url>] [--check] [--json]`:

1. 解析包名/registry(自推导 + 覆盖规则见上);
2. `GET <registry>/<name>/latest` 取 latest;网络失败 → 打印失败原因退出非零;
3. `local === latest` → "已是最新"退出;
4. `npm install -g <name>@<latest> --registry=<registry>`(spawn 继承 stdio;npm 不在
   PATH → 明确报错);
5. 成功后**自动清理 Service Worker 缓存**(`~/.webcli/browser/profile/Default/Service
   Worker`,存在才删,删除失败仅警告不阻断)→ 打印新版本与"重启 bridge / 重载扩展"提示;
6. npm 失败 → 保留原版本,打印原因与手动命令。

`--check` 只查不装;`--json` 输出 `{ current, latest, registry, updateAvailable }`。
内嵌模式(WEBCLI_EMBEDDED=1)下 upgrade 打印"桌面端自带 webcli 随应用更新,请走应用内升级"退出。

### 3. 桌面端护栏(weworker 同 PR)

- `weworker/backend-ts/src/webcli-runner.ts` 与 `server.ts` 两处 spawn env 增加
  `WEBCLI_EMBEDDED: '1'`;
- webcli 侧据此跳过检查/提示;upgrade 走内嵌分支话术。

### 4. skill 侧

SKILL.md 不强制改动(CLI 提示自解释)。可选:主 webcli skill 文档加一句
"看到 [webcli] 有新版本提示时,先执行 webcli upgrade 再继续"——默认不加。

### 5. 生效链路(鸡蛋问题)

现存用户需手动升一次到含此功能的版本,之后即可自动感知;首个含此功能的行内包
(1.1.12)发版说明里提醒一次。

## 测试

- semver 数字段比较纯函数(1.1.2 < 1.1.10 等边界);
- 缓存读写 + 24h TTL(注入时钟与 fetch;过期触发后台刷新、未过期零网络);
- notice:落后打印、豁免清单不打、WEBCLI_EMBEDDED 跳过;
- upgrade 编排(fake spawn):已最新跳过 / npm 失败保版本并报错 / SW 清理容错 /
  内嵌模式分支;
- registry:行内包由 repack 注入 internal-registry.json,公开包默认 npmjs;env/--registry 可覆盖。

## 明确不做

- 不做全自动升级;不做按包硬编码 registry(自推导+覆盖);不动 SKILL.md(默认);
- 不在 stdout 输出任何提示;离线/registry 不可达不做任何打扰。

## 交付

- 公开仓独立分支 `feat/webcli-upgrade-check` 独立 PR;
- 发布:随行内 repack(1.1.12)发布;桌面端护栏随 weworker 应用更新发布(两者独立,
  桌面端未更新前旧版 desktop 的内嵌 webcli 不含检查逻辑,天然无影响)。
