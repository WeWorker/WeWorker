# Adapter 自进化方案(报错/巡检驱动的修复与知识沉淀)

日期:2026-11-23
状态:设计已与需求方确认,待实现
上游依赖:`2026-10-10-adapter-daily-patrol-design.md`(巡检执行器,已确认设计未实现)、metrics-server `by=errdetail`(已上线)、`exploration-repair.js`(仅支持 Extension/HTTP)

## 一、背景

- Toolkit(wewright/Python)adapter 的失败长尾真实存在:近 7 天 `Toolkit Adapter exited with code 1` 146 次 / 26 工具 / 22 用户(errdetail 下钻确认),wekm 单包 46 次为重灾区
- 现有 repair 交互工作流(`exploration-repair.js`)明确只支持 Extension/HTTP 包,拒绝 wewright——占比最大的失败类型没有修复通道
- 巡检执行器(每日自动探活 + 基线 diff + 需重新取证清单)已完成设计但未实现,其设计文档明确把「自愈」留作下一个子项目
- 修复经验(登录态失效、字段改版、参数惯例)散落在个人经验里,下次探索/修复无法复用

## 二、目标

1. 建立「触发 → 修复 → 验证 → 草稿」的自动化管线,全自动跑到**验证通过的修复草稿**,发布人工确认
2. 触发源解耦:线上报错(errdetail)与巡检「需重新取证」清单汇成统一修复任务;支持聊天手动指定
3. 一期支持 wewright(Python toolkit)adapter 的修复(真实痛点);Extension/HTTP 沿用现有 repair 工作流
4. 知识两层沉淀:包内字段知识(已有机制)+ 本地跨 adapter 经验库(自动写入、修复/探索时自动注入)
5. 经验反哺:修复结论入经验库,下一次探索/修复按站点/运行时/错误签名检索注入,越用越快

## 三、非目标

- 不做全自动发布(人工发布门,见决策记录)
- 不做"每台机器自己修自己"的分布式自愈(见角色划分)
- 不在本方案内实现巡检执行器本体(独立子项目,按既有实现计划推进;本方案只消费其清单)
- 不新增读写风险分级正则(复用 `runtime-test-policy` 门控,遵守巡检设计的既有约束)
- 一期不回流行内源码仓的 builtin 发布通道(二期;一期聚焦 hub 系 adapter)

## 四、决策记录(需求澄清结论)

| # | 决策项 | 结论 |
|---|---|---|
| 1 | 修复对象 | wewright/Python 优先(exit-code-1 长尾 96% 为 toolkit 型);Extension/HTTP 复用现有 repair |
| 2 | 触发源 | 报错 + 巡检双触发统一设计;报错驱动先行(errdetail 已上线),巡检实现后接入 |
| 3 | 自治度 | 全自动到「验证通过的草稿」;发布到 hub 前人工确认 |
| 4 | 知识沉淀 | 包内字段知识(已有)+ 本地跨 adapter 经验库(~/.webcli/repair-knowledge.json) |
| 5 | 角色划分 | 普通用户机器 = 巡检/报错采集点(只读);开发者机器 = 巡检 + 修复工作台 |
| 6 | 发布通道 | hub 系 adapter 走 `adapterhub publish`;桌面内置系走行内源码仓回流(二期) |

## 五、目录归属与覆盖关系(关键澄清结论)

遵循 `2026-07-21-generated-adapter-lifecycle-design.md` 的所有权模型:

- **hub 安装的用户级 adapter**(`~/.webcli/adapters/`):客户端更新**不触碰**;修复就地改用户级副本 → 验证 → 人工确认 → `adapterhub publish` 新版本 → 用户经 `adapterhub upgrade` 收敛
- **桌面内置 adapter**(`resources/adapters/`):catalog 对 builtin 做 digest 绑定校验(`BUILTIN_ADAPTER_CONTENT_CHANGED`),**不可就地修改**;修复在用户级副本/工作台进行,产物回流行内源码仓 `adapters/`,随下个客户端版本发布——"覆盖"即官方修复的收敛手段
- 结论:不存在「客户端更新覆盖本地修复」的冲突;`adapterhub upgrade` 是获取修复的正向途径

## 六、架构(分层管线)

```
触发层(解耦)                执行层(新建)                     产物层(复用现有)
──────────────────          ────────────────────            ────────────────────
报错源:errdetail     ─┐                                  ┌─→ 修复草稿(digest 守护,扩 wewright)
巡检源:需重新取证清单 ─┴→ 统一修复任务 RepairTask ─→ agent 修复循环 → 分层验证     ─┴→ 人工审批 → adapterhub publish
手动:聊天指定 adapter ─┘         ↑ 注入:包内知识 + 本地经验库    ↓ 结果回写经验库(含"此路不通")
```

三段职责单一:触发只负责"发现问题并结构化";执行只负责"修到验证通过";产物复用现有草稿守护/审批/发布。

## 七、统一修复任务 RepairTask

```json
{
  "id": "rt-20261123-wekm",
  "source": "errdetail | patrol | manual",
  "adapterId": "wekm",
  "runtime": "wewright",
  "failures": [
    { "tool": "wekm.get-article", "count": 27, "lastErr": "exited code 1: TypeError ...", "lastSeen": "2026-11-23", "users": ["v_wbvincentli"] }
  ],
  "repro": { "command": "webgo call wekm.get-article --keyword=x", "sample": { "keyword": "x" } },
  "status": "open | diagnosing | draft-ready | published | archived | needs-login | needs-regeneration"
}
```

- 报错源:`webgo repair task --from errors --since 7d --min-calls 3` —— errdetail 拉取 → 按 adapter 聚合 → 阈值筛选 → 生成任务(纯函数,可单测)
- 巡检源:巡检清单字段与本结构对齐,实现后直接映射
- 手动:聊天里指定 adapter,现场取证构造任务
- 任务持久化:`~/.webcli/repair-tasks/*.json`,状态机推进

## 八、修复执行器(agent 循环,有界 ≤3 轮)

每轮四步:

1. **取证**:本地实跑 `repro.command` 复现原始报错(stderr 尾部样本);读取 adapter 包代码与包内知识
2. **诊断**:LLM 对照知识/经验库定位根因,输出结构化结论(`rootCause: login-expired | schema-drift | logic-bug | param-usage | needs-regeneration`)
3. **补丁**:产出 Python 模块 diff;`needs-regeneration` 类(站点改版)不硬修,转交生成链路
4. **验证**:见第九节;通过 → 产出修复草稿(digest 守护,`exploration-repair` 草稿机制扩展 wewright 包:python 模块 + manifest version patch+1)

循环上限 3 轮;每步超时;任何一步失败带原因退出,任务按状态机归档。

## 九、验证器(确定性判定)

| 层 | 内容 | 失败含义 |
|---|---|---|
| 静态 | Python 语法解析、自包含检查(禁外部 import)、manifest schema 一致性 | 代码层错误 |
| 复现重放 | 原始报错命令经 Webwright 运行时实跑:exit 0 + stdout 尾行为合法 JSON | 功能未修复 |
| fixture 断言 | `exploration-verification` 的 expect(equals/patterns/rowCount)审计;有基线时 diff 无退化 | 输出语义漂移 |
| 回归冒烟 | 同包其他命令各实跑 1 次 | 补丁连带破坏 |

写操作安全:验证仅执行只读命令或带安全模式的写样本(复用 `runtime-test-policy` 门控);登录态缺失整站跳过并标记 `needs-login`(沿用巡检约定)。

## 十、知识/经验沉淀

- **包内知识**(已有):修复导致的字段映射变化走 `exploration-knowledge` 修订流程(需 30 天内验证记录)
- **本地经验库** `~/.webcli/repair-knowledge.json`:修复结束(成功或失败)由执行器自动追加:
  `{ id, pattern, site, runtime, symptom, rootCause, fixStrategy, evidenceRef, adapterId, outcome, date }`
  - 检索:执行循环启动前按 `site + runtime + 错误签名` 取 Top-K(默认 3)注入诊断上下文
  - 治理:同 pattern 去重合并;条目上限(200)淘汰最旧;支持人工修订与删除
- **反哺探索**:adapter 生成/探索流程读取同一经验库注入(二期接线,一期先服务修复)

## 十一、人工发布

草稿就绪 → 聊天通知(diff 摘要 + 验证记录 + 涉及失败数)→ 人工确认 → 现有 `adapterhub publish` 流程(版本 patch+1);拒绝 → 草稿归档,拒因入经验库。

## 十二、分发收敛(用户端自动感知,不更客户端只更 adapter)

hub 系 adapter 的更新天然与客户端解耦(用户级目录不受客户端更新影响,`adapterhub check/upgrade` 已存在),本方案补「自动感知」一环,仿 `version-check.js` 成熟模式:

- CLI/聊天会话启动时**后台异步**查询已装 adapter 的远端版本(24h TTL 缓存;离线/超时完全静默,零阻塞)
- 有更新 → 下次调用输出提示:`[webgo] adapter wekm 有新版本 1.0.9 → 1.1.0(含官方修复)——运行 webgo adapterhub upgrade wekm`
- **只提示不自动装**:升级时机由用户/聊天 agent 决定,避免任务执行中 adapter 行为突变
- 「经巡检验证的紧急修复自动下发」不在一期;修复管线跑稳后再评估

收敛闭环:开发者巡检/修复 → publish hub → 用户端启动静默感知 → 提示 → 一键 upgrade。

## 十三、角色划分

| 角色 | 机器 | 职责 |
|---|---|---|
| 普通用户 | 各自客户端 | 正常使用(只读采集点):失败经 metrics 上报(errdetail 已具备);按提示 upgrade 收敛 |
| adapter 维护者/开发者 | 工作台机器(登录态完备) | 巡检执行(巡检实现后)、`repair task` 生成、修复循环、验证、确认发布 |

## 十四、一期实现路径(TDD)

1. RepairTask 结构 + 状态机 + 报错源任务生成(errdetail → 任务,纯函数)
2. wewright 包草稿读写(digest 守护扩展,复用 `adapter-package-files`)
3. 修复执行循环(agent 命令化,假 LLM 注入单测)
4. 验证器:静态层 + 复现重放层(Webwright 实跑,fixture 环境跑测)
5. 经验库读写、检索、注入
6. **合成故障 adapter 端到端**:故意写坏的 python 模块 fixture(如缺登录分支)全链路跑通
7. **真实验收**:实修一个真实失败 adapter(wekm 优先,与 v_wbvincentli 侧复现环境对齐;或取 wekm 包在工作台复现)
8. **分发收敛**:adapterhub 启动静默 check + 升级提示(仿 version-check 后台刷新模式,带单测)

## 十五、测试策略

- 纯函数(任务生成/分类/经验检索)全量单测;执行循环注入假 LLM/假 spawn
- Webwright 实跑测试仅在有运行时的环境跑(`test:e2e:real` 同款门控),CI 跳过
- 合成故障 fixture 进仓库,回归用;真实 adapter 修复记录归档作验收证据

## 十六、边界与错误处理

- 修复不了 → 归档 + 经验库记「此路不通」(症状+已试策略),不静默
- LLM 诊断与实际报错矛盾 → 以实跑复现为准,拒绝基于猜测的补丁
- 草稿与线上包 digest 不一致 → 按 `ADAPTER_BASE_CHANGED` 既有语义要求重新取证
- 经验库损坏/超限 → 截断保最近,文件损坏时备份重建,不阻塞主流程
