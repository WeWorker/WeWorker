# 官网 Stats 看板:错误聚合 / 用户活跃 / 日期筛选 设计

日期:2026-11-07
分支基线:`upstream/dev-1.1.0`(ceb9129,已含 PR #326)
范围:metrics-server 后端小改 + officialWeb 前端看板,一个 PR 交付。

## 背景

PR #326 在 metrics-server 三处聚合的 WHERE 里加了噪音排除(flag 误用 + CLI 管理命令首段),
前端看板(officialWeb `/stats`)随之需要对应能力:

1. 非 adapter 噪音调用不展示;
2. 新增按错误类型汇总的列表;
3. 新增用户日活(DAU)/月活(MAU);
4. 时间筛选新增「近90天」,并支持具体日期范围筛选。

其中需求 2 后端已支持(`by=err`),需求 1 后端已过滤;需求 3、4 需要后端补能力。

## 现状与关键事实

- `classifyTool()`(webcli/metrics.js)把所有带 `.` 的工具名标为 `kind="adapter"`,
  因此 `skill.list` 等噪音调用带着 adapter 标签入库——前端 kind 筛选挡不住噪音,
  只有名字单能挡(这就是 PR #326 做 SQL 侧排除的原因)。
- `GET /v1/stats` 现支持 `by=domain|tool|user|err|route` + `since`(相对时长 `Nd/Nh/Nm`)。
- `by=err` 返回 `{rows:[{err,calls,tools,users,sampleTool}], totalFailed}`,不吃 kind,统计所有 kind 的失败。
- `by=user` 返回 user×domain 扁平 rows,无 day 维度——前端算不出逐日 DAU,必须后端加聚合。
- 官网对 metrics-server 只反代两条路径:`/api/stats` → `/v1/stats`、`/api/visits` → `/v1/visits`
  (vite.config.js proxy + 生产 Nginx)。新能力走 `by=active` 复用 `/api/stats`,代理零改动。
- 日期口径统一 UTC(与现有 visits 表 `dayString` 一致),用户基数以 UTC 日界聚合。

## 方案取舍

- **方案 A(采用)**:扩展 `GET /v1/stats`,新增 `by=active` + 全局 `from`/`to` 参数。
  代理零改动,后端样板最少。
- 方案 B(否):新端点 `/v1/active`。需同步改 vite proxy 与生产 Nginx,部署侧联动,不值。
- 方案 C(否):前端拉 `by=user` 自算 DAU。rows 无 day 维度,不可行。

## 后端设计(metrics-server/db.js + handler.js)

### 时间窗统一化

新增 `resolveWindow({since, from, to})` → `{start, end}`:

- `from`/`to` 为 `YYYY-MM-DD` 字符串(UTC):`start` = from 当日 00:00,`end` = to 次日 00:00(含 to 当天)。
- 给了 `from` 或 `to` 任一即视为自定义窗:缺 `from` = 不设下界(从最早数据起),缺 `to` = 不设上界(到 now);
  只为出现的边界加 SQL 条件。
- 都不给时维持现状:`start = now - parseDuration(since)`,无上界。
- 非法格式(`\d{4}-\d{2}-\d{2}` 之外)由 handler 返回 400。

改造点:`queryStats`(tool/domain)、`queryByErr`、`queryByUser`、`queryRouteStats`、
`queryVisits`、`percentilesFor`、`topToolFor` 统一改走 resolveWindow,SQL 增加 `ts < end` 上界(自定义窗时)。

### by=active(用户活跃)

`queryActiveUsers(db, {window, kind})` → `{rows:[{day,dau}], mau}`:

- DAU rows:`SELECT date(ts/1000,'unixepoch') AS day, COUNT(DISTINCT COALESCE(NULLIF(user,''),'(unknown)')) AS dau`
  按天分组升序,跟随所选时间窗;空 user 归 `(unknown)`,与 `by=user` 口径一致。
- MAU:固定查「近 30 天」去重用户数(同样的 COALESCE / noise / kind 过滤),不随时间窗漂移,语义保持「月活」。
- 两者都追加噪音排除与 kind 过滤。

handler:`by` 白名单增加 `active`;新增 `from`/`to` 参数解析与校验。

### 噪音 SQL 清理(顺手)

PR #326 留下的三处内联噪音 SQL 长串与 `NOISE_FIRST_SEGMENTS` 有漂移(内联版多 `wecli`),
本次收敛为复用 `noiseExcludeClause()` 单一来源;`noiseExcludeClause` 与 `noiseClauseFor` 重复,合并为一个。

## 前端设计(officialWeb)

### 数据层(src/lib/stats.js、visits.js)

- `fetchStats`/`fetchVisits` 增加 `from`/`to` 透传;仅自定义日期时携带,预设窗不携带。
- 新增 `isNoiseTool()` 名单兜底(名单对齐 `metrics-server/db.js` 的 `NOISE_FIRST_SEGMENTS`,
  注释注明来源),在 `groupByDomain` / `groupByUser` 入口过滤——旧版 server 未升级时也不展示噪音。
  `by=err` 是新接口,只有新 server 才有,不做兜底。
- `fetchActiveUsers` 改打 `by=active`,返回 `{rows, mau}`(替换工作区现有 WIP 实现)。

### 页面(src/pages/Stats.jsx)

- **视图**:「按 Adapter | 按用户 | 按错误」三 tab。err 视图列:错误类型 / 调用次数 / 涉及工具数 /
  涉及用户数 / 样例工具;底部汇总「N 类错误 · M 次失败」;err 视图下隐藏「类型」选择器(后端不吃 kind),
  此时「用户活跃」区块仍沿用当前持久化的 kind,不做额外重置。
- **时间筛选**:预设 `1d / 7d / 30d / 90d / 自定义` +「自定义」展开起止两个日期输入框(`YYYY-MM-DD`),
  选完即生效;时间筛选对主表、err、DAU 趋势、PV/UV 全局生效。
- **用户活跃区块**:与「网站访问量」同款样式,标题行右侧 `MAU(近30天) N`,表体为逐日 DAU 趋势条
  (复用 PV/UV 行样式),随时间窗联动;加载/失败/未接入态与 visits 区块一致。

## 测试

- `metrics-server/__tests__/server.test.js`(node --test)新增:
  - `by=active` 返回 rows/mau 形态与数值;
  - `from`/`to` 在 stats(domain)、err、user、visits 四条路径的过滤生效;
  - 非法 `from`/`to` → 400;
  - 噪音 SQL 收敛后仍排除噪音工具(flag 误用 + 名单首段)。
- officialWeb 无测试设施(仅 vite dev/build),不引入测试框架;本地起 metrics-server + `npm run dev` 实测。

## 交付

- 新分支 `feat/metrics-dashboard-dev110`(基于 upstream/dev-1.1.0),后端+前端一个 PR,推 `fork` remote。
- 本 spec 随分支提交(仓库既有惯例,docs/superpowers/specs 已有两篇入库先例)。
- 工作区无关未跟踪文件(webcli/login-recovery 等)不进 PR。

## 明确不做

- 不做 WAU 指标卡、不做 DAU 图表库引入(复用条形表);
- 不做时区切换(固定 UTC 口径);
- 不动 webcli 客户端上报侧(噪音治理已在 #326 服务端完成);
- 不给 `by=err` 加 kind 过滤(维持全 kind 失败统计口径)。
