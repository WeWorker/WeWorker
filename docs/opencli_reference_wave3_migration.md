# OpenCLI 参考信息 wave3：Wikipedia + GitHub Trending

日期：2026-09-30。基线914dbe2f，来源固定为jackwener/OpenCLI **24136945847afbfad266c6c46a8cd335377f9112**。本轮直接由Codex实现，未使用dsh。

**6项源码已接入，fixture通过；真实站点验收未通过，阻塞在网络/传输阶段。** 不等于自然语言、所有语言、全部筛选已验收。

## 来源、范围和许可

- Wikipedia全部5项：search/summary/random/trending/page及utils.js；GitHub Trending全部1项：repos.js。相关来源测试也已核查。Apache-2.0，Copyright 2025 jackwener；上游LICENSE与已有docs/third_party/OpenCLI-LICENSE.txt换行归一化后一致，继续沿用桌面extraResources许可证打包。
- 包为wikipedia.org、github.com。后者只迁github-trending，不代表OpenCLI github/*站点命令已迁；未来在同包接入时必须先盘点命令名冲突。
- 命令参数/默认值见[6项机器清单](opencli_reference_wave3_inventory.json)。使用根v2包、既有Extension后台Runner、backend_fetch；无新依赖、无旁路运行时。
- Wikipedia声明wikipedia.org及*.wikipedia.org，包内语言代码严格限制为2–3个字母及可选连字符后缀，不能传域名、路径、凭据；GitHub只声明github.com。

## 业务语义与相对来源的调整

| 命令 | 关键语义 |
|---|---|
| wikipedia.org.search | query必填，limit=10（1..50），lang=en；snippet最多120字符并标记截断；仅真实搜索列表投影 |
| wikipedia.org.summary | title必填，导语最多300字符，extract_length/extract_truncated和content_scope=lead_summary；缺description为null |
| wikipedia.org.random | 随机条目导语，不是全文；允许最多两次同语言、同域的summary端点重定向，其余重定向拒绝；此重定向路径仅fixture验证 |
| wikipedia.org.trending | 请求昨日UTC的featured feed中mostread列表；feed_date是请求日期，mostread_date是上游数据日期，不假设相同；缺views为null，真实0保留 |
| wikipedia.org.page | title/lang，paragraphs=0默认返回API纯文本extract；N>0明确限制段落，返回total_paragraphs和extract_truncated；不是完整网页/媒体导出 |
| github.com.repos | since=daily/weekly/monthly、language=''、limit=25（1..25）；仅主区域Box-row仓库卡，校验周期文案；stars/forks累计值、starsSince周期新增值 |

普通参数使用--key=value，包内转换整数；拒绝布尔/小数/越界。Wikipedia来源search/trending的静默limit夹取改为显式拒绝越界，缺字段不补造。API错误、结构缺失、合法空列表分别报告；GitHub明确空文案之外的空页面不当作空榜。未自动换语言、周期、数据源或放宽HTTP跳转。摘要/描述的来源长度上限保留并显式说明。

## 验证

- 新增专项36项：真实v2 bootstrap、参数契约、语言/查询编码、截断/正文/重定向、跨年UTC日期、未知字段、HTTP/API/空态/结构异常、GitHub周期与字段含义、无结果/脚本伪卡片、guidance派生。
- 新增+上批两组+宿主+Profile/打包：8文件 **238项通过**。
- public prepare为20个host-managed包；WebCLI bundle成功（既有可选列名映射文件缺失警告仍在）。两包.adapt在仓库外打包/结构/哈希校验通过；manifest+guidance确定性Skill测试通过。
- 未运行全仓测试；既有extension-v2-loader的旧精确断言失败未在本批修改，也不宣称全量通过。

## 真实调用证据（未验收通过）

| 命令 | trace | 结果 |
|---|---|---|
| wikipedia.org.search | 268ab91fd4e2 | FETCH_ERROR，未取得业务数据 |
| wikipedia.org.summary | b26397bedf71 | FETCH_ERROR，未取得业务数据 |
| wikipedia.org.random | fbc7e8fc58f5 | FETCH_ERROR，未取得业务数据 |
| wikipedia.org.trending | 99e3b50063b9 | FETCH_ERROR，未取得业务数据 |
| wikipedia.org.page | 6b17b0be5838 | FETCH_ERROR，未取得业务数据 |
| github.com.repos | e7700f0b6433 | FETCH_ERROR，未取得业务数据 |

Wikipedia search trace明确显示en.wikipedia.org:443连接超时；其他四项同轮请求失败，不能仅凭相同错误消息断言根因完全一致。GitHub weekly/rust返回传输失败，curl回退报43（bad argument），原因尚未确定。首次daily由验收进程45秒时限终止，未获得trace；不将其视为宿主自身超时证据或成功。Bridge服务可达且请求进入扩展运行时。没有修改代理、重启未知进程或绕过网络限制。

复验时使用已连接扩展的同一客户端：

```powershell
node weworker/build/webcli-dist/webcli.cjs call wikipedia.org.search --query=Transformer --limit=2 --lang=en
node weworker/build/webcli-dist/webcli.cjs call wikipedia.org.page --title=Computer --paragraphs=2
node weworker/build/webcli-dist/webcli.cjs call github.com.repos --since=weekly --language=rust --limit=2
```

网络恢复后还需逐项核对业务字段、Wikipedia多语言与随机跳转、GitHub三个周期/语言筛选，再补自然语言验收；不得把fixture冒充该证据。

## 对齐与边界

[179目录映射](opencli_clis_alignment_map.json)更新为13个已迁入、5个有包未对齐、161个无包；分类互斥。github-trending已迁入使github拥有同域包，但github命令仍未对齐。目录数不是验收完成数；此前抖音draft/publish等缺口继续保留。

本轮只改公开站点包/站点测试/Profile/文档。内部未修改，无通用架构变化；用户原文章和两个内部lockfile原改动保持。未推送、合并或发版。
