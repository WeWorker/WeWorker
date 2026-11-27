# Adapter 自进化二期方案(巡检接入 · playbook 化 · hub 经验共享 · 效果度量)

日期:2026-11-26
状态:设计已与需求方确认方向,待评审
上游:一期 `2026-11-23-adapter-self-evolution-design.md`(已实现,T9 真实验收待做);巡检执行器 `Int 仓 2026-10-10-adapter-daily-patrol-design.md`(已确认设计未实现,含 1453 行实现计划)

## 一、一期回顾与二期动机

一期已交付:errdetail 报错驱动修复管线(触发 → agent 修复循环 → 分层验证 → digest 草稿 → 人工发布)、本地经验库(沉淀/检索/注入)、adapterhub 更新静默感知。

一期遗留的能力缺口,即二期动机:

1. **报错驱动只覆盖「有人调且调失败」**——没人调的长尾命令与「静默退化」(API 仍 200 但字段改名/变空、DOM 选择器失效)无人发现
2. **经验是文本描述**——LLM 拿到后仍需自行探索,修复成本(轮数/tokens)下降有限
3. **经验库只在本地**——A 修 wekm 的经验,B 修同类站点无法复用
4. **修复效果无系统度量**——「越用越快」只是假设,没有数据

## 二、目标

1. 巡检执行器落地(按 Int 仓设计),补齐 API/DOM 查询命令的**主动探活**与**指纹 diff**,产出「需重新取证」清单
2. 巡检清单接入一期修复管线(统一 RepairTask),形成「巡检 → diff → 修复草稿」第二触发通道
3. 写命令巡检规范:只读探活 + 安全样本 + UAT 标记三层,真实写零风险
4. 经验库 playbook 化:rootCause 分类对应可执行修复模式,修复理想路径降至 1 轮
5. 经验库上 hub 团队共享,跨人跨站复用
6. 效果度量体系:修复收敛曲线、升级采纳率、轮数/token 趋势可查

## 三、非目标

- 不做全自动发布(人工发布门不变;「修复版灰度自动升级」仅做机制预留,见 §9)
- 不做视觉级页面 diff(截图对比)——规范化指纹已够,成本不匹配
- 不做巡检执行器的设计重制(按 Int 仓既有设计实现,本方案只定义自进化侧的对接与增量)
- 不做经验库的多租户/权限体系(hub 共享用现有 PAT 鉴权,同 adapterhub 一套)

## 四、决策记录(本轮讨论结论)

| # | 决策项 | 结论 |
|---|---|---|
| 1 | 修复识别通道 | 报错(errdetail,一期已有)+ 巡检(全部查询命令主动探活)双通道;巡检覆盖 errdetail 的两个盲区:无人调的长尾命令、静默退化 |
| 2 | DOM 改动判定 | 规范化指纹 diff(选择器命中率 + 结构形状 + 文本形态),不做全量 HTML/视觉 diff;diff 分级:可推断微变 → 修复管线,结构改版 → 重新取证 |
| 3 | 写命令巡检 | 三层:只读探活(零副作用)→ 安全样本(取消型/预览型)→ UAT 沙箱真写(标记类);真实生产写零风险 |
| 4 | 快速修复降成本 | playbook 化(检测片段+修复模板按 rootCause 分类)+ 取证复用(包内缓存页面/接口指纹,修复时对 diff 不对全量)+ hub 共享 |
| 5 | 客户端自更新 | 一期「提示+一键」保持;二期做效果度量(收敛曲线/采纳率),「修复版灰度自动升级」仅机制预留 |

## 五、巡检执行器(对接与增量)

巡检本体(枚举 → 探针 → 三层判定 → 基线 diff → 清单)按 Int 仓设计实现,本方案不重复。自进化侧的增量定义:

### 5.1 API 类命令的指纹 diff

- 基线:首次取证时缓存的**接口指纹**(URL 形状、响应字段集合、字段类型、行数量级)——generation-harness 的 source-evidence 已有接口指纹概念,复用其结构,落盘位置遵循 adapter 生命周期归属(随包发布入仓、用户级落用户目录)
- 巡检时:重放样本请求 → 提取同构指纹 → diff
- 分级:`字段改名/新增(可推断)` → 修复任务;`字段消失/类型翻转/行数塌方` → 需重新取证(转生成链路)

### 5.2 DOM 类命令的规范化指纹 diff

不做全量 HTML/视觉 diff(噪音:时间戳/个性化内容/广告)。指纹三层,全部**只读**:

| 层 | 内容 | 判定 |
|---|---|---|
| 选择器命中率 | manifest/生成产物声明的选择器在真实页面逐个 `querySelector`,记录命中与否与命中数量 | 命中归零 → 选择器失效;数量塌方(如 10→0) → 结构变化 |
| 结构形状 | 关键容器的子节点数、表单控件类型分布(input/select/button) | 类型分布翻转 → 页面重构 |
| 文本形态 | 关键文案的模式匹配(按钮文字、标题正则) | 形态不匹配 → 文案/流程改版 |

指纹与 diff 均为纯函数(巡检设计的 shape.js 职责),diff 结果直接映射 RepairTask 的 `failures[]`(tool + diff 明细),与 errdetail 源同构。

### 5.3 写命令巡检三层规范

| 层 | 做法 | 适用 |
|---|---|---|
| L1 只读探活 | 写命令依赖的目标页面元素(表单字段/提交按钮/导航入口)只读探活:存在性 + 文本形态匹配——验证写路径前半段健康 | 全部写命令,零副作用 |
| L2 安全样本 | 生成管线为写命令配套「取消型/预览型」样本:填表不提交、存草稿、对象归测试自己;巡检仅执行此类 | 生成器可产出安全样本的写命令 |
| L3 UAT 沙箱真写 | 标记 `uatVerifiable` 的 adapter(挂 uat.* 域名),巡检在 UAT 环境跑真实写 | 行内 UAT 覆盖的 adapter |

- **生成管线配套改造**:`adapter-scaffold`/探索产物为写命令新增 `safeSample` 字段(参数 + 预期可逆行为说明);存量 adapter 由巡检首次扫描时标记「无安全样本 → 仅 L1」
- **门控复用**:安全判定一律经 `runtime-test-policy`,不新增风险分级正则(巡检设计既定约束)

### 5.4 巡检 → RepairTask 映射

巡检「需重新取证/结构退化」清单字段与一期 RepairTask 对齐:

```
{ source: "patrol", adapterId, runtime, failures: [{ tool, count: 连续失败天数, lastErr: diff 摘要 }], repro: { sample, expect } }
```

一期 `task-source.js` 增加 `tasksFromPatrol(patrolReport, opts)`(纯函数,与 `tasksFromErrDetail` 并列),CLI `webgo repair task --from patrol` 消费巡检报告文件。

## 六、playbook 化经验库

### 6.1 经验条目结构升级(向后兼容)

```json
{
  "id": "...", "site": "wekm", "runtime": "wewright",
  "symptom": "...", "rootCause": "login-expired",
  "fixStrategy": "...", "outcome": "fixed", "hits": 3, "date": "...",
  "playbook": {
    "detect": "页面 fetch 返回 HTML 且含 SSO 登录表单特征 → 判定登录态失效",
    "detectSnippet": "const looksLogin = /passport|sso|login/i.test(text) && !/application\/json/.test(ct)",
    "fixTemplate": "在命令入口探登录态;失效时输出 {ok:false, code:'NEEDS_LOGIN', needs_user:true} 并引导登录"
  }
}
```

- `rootCause` 收敛为枚举:`login-expired | schema-drift | dom-drift | logic-bug | param-usage | needs-regeneration`(与 executor 既有分类对齐)
- playbook 按 rootCause 聚类沉淀;高频 rootCause 的 playbook 由人工审核固化为「标准修法」

### 6.2 执行器注入升级

诊断上下文 = 相关经验条目(一期)+ **命中 rootCause 的 playbook**(检测片段 + 修复模板)。理想路径:诊断直接命中 playbook → 第 1 轮产出补丁 → 验证过 → draft-ready(1 轮)。

### 6.3 降成本度量(进经验库元数据)

每次修复记录:`rounds`、`llmCalls`、`reusedPlaybook`(是否命中)、`durationMs`。可查:首轮成功率、平均轮数按时间/按 playbook 命中分组趋势——「越用越快」从假设变为可验证。

## 七、经验库上 hub(团队共享)

### 7.1 服务端(adapterhub 扩展)

- `GET /api/v1/experiences?site=&runtime=&rootCause=&k=` —— 返回脱敏经验条目(playbook 含内)
- `POST /api/v1/experiences` —— 修复完成后客户端可选上报(默认开启,`WEBCLI_REPAIR_EXPERIENCE_UPLOAD=off` 关闭)
- 复用 adapterhub 既有 PAT 鉴权与脱敏管线;条目全局去重(entryKey 同一期算法);上限与淘汰同本地(200 → 服务端放宽至 2000)

### 7.2 客户端

- 检索:本地命中不足 k 条时回源 hub 合并(本地优先,hub 条目标记 `shared: true`)
- 沉淀:本地写 + 异步上报(失败静默,与 update-check 同款纪律)
- 隐私红线:条目只含症状/根因/策略/片段,不含参数值、页面快照、凭据(复用一期截断规则;上报前过一遍 `sensitive` 正则——复用 exploration-verification 的脱敏正则,不新增)

## 八、效果度量体系

| 维度 | 指标 | 数据源 |
|---|---|---|
| 修复收敛 | 修复版发布后 N 天,errdetail 该 adapter 失败数下降曲线 | metrics-server(已具备) |
| 采纳率/时延 | 发布 → 用户 upgrade 的分布;按 adapter 的升级安装量 | adapterhub downloads + 新增 `upgrade` 事件上报(客户端 upgrade 命令带一次性埋点) |
| 修复成本 | 首轮成功率 / 平均轮数 / 平均 llmCalls,按 playbook 命中分组 | 经验库元数据(§6.3) |
| 巡检健康度 | 每 adapter 的巡检通过率趋势;「需重新取证」清单存量 | 巡检落库(巡检设计自带) |

呈现:官网 stats 看板新增「自进化」页(复用 metrics-server 看板通道),或先出 CLI `webgo repair stats`。

## 九、客户端升级策略

- 一期「静默感知 + 提示 + 一键 upgrade」保持不变
- **机制预留(不实现)**:`repair` 标记的 patch 版 + 非任务执行窗口 + 用户开关(默认关)→ 自动升级。触发条件齐备才启用,二期只在上报埋点里带 `repairRelease` 字段为灰度评估攒数据
- 聊天场景增强:agent 检测到 adapterhub 有更新时,在对话中主动提示(比 stderr 触达好),一期 update-check 的缓存直接可用

## 十、实现路径(建议顺序)

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0 | 巡检执行器本体实现(Int 仓 1453 行计划,8 任务 TDD) | 独立 |
| P1 | `tasksFromPatrol` + CLI 消费巡检报告(接一期管线) | P0 |
| P2 | 写命令三层巡检:safeSample 生成管线改造 + L1 只读探活 + UAT 标记 | P0 |
| P3 | playbook 结构 + 执行器注入升级 + 成本元数据 | 一期经验库(已就绪) |
| P4 | hub experiences 端点 + 客户端上报/回源 | adapterhub 服务端 |
| P5 | 效果度量:upgrade 埋点 + 看板/CLI stats | metrics-server |

P3 不依赖 P0(可先行);P1/P2 依赖巡检本体;P4/P5 可并行。

## 十一、边界与风险

- DOM 指纹对「无 manifest 选择器的纯数据型命令」退化为 API 指纹路径;两指纹都建不了的(纯计算命令)跳过巡检
- 巡检在开发者工作台机器跑(一期角色划分不变);普通用户仍是只读采集点
- hub 经验共享的上报内容脱敏不充分的风险 → 上报前强制过脱敏正则 + 服务端二次白名单校验
- playbook 质量参差 → 上报的 playbook 进「待审核」态,人工审核后才进入检索池(本地 playbook 不受此限)

## 十二、一期遗留承接

- T9 真实验收(wekm):一期验收门,先行完成;其验收记录(失败数收敛曲线)同时是本方案 §8 的第一个数据点
- 一期 feat 分支(`feat/adapter-self-evolution-dev112`)与 PR #416/#431/#433 已合内容,目标分支统一到 dev-1.2.x 线
