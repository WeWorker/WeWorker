# 上报用户名兜底(HRM 解析)与 metrics 映射 设计

日期:2026-11-10
分支:`feat/metrics-user-fallback-dev110`(基线 upstream/dev-1.1.0 ceb9129,独立于 PR #352)
范围:webcli(上报兜底)+ Chrome 扩展(代取身份)+ metrics-server(存量修正)。

## 背景

看板按用户聚合时出现 `client-xx` 甚至 `(unknown)`:`webcli/metrics.js` 的
`buildUploadConfig` 以 `whoami()` 取系统用户,失败(无命令/超时/受限环境)降级为
`client-<clientId 前 8 位>`。这些机器的真实身份无法归因。

上报在 Node 侧(`bridge.js` 的 `callTool()` 与 `toolkit-runner.js` 收口),SSO cookie
在浏览器(扩展,`host_permissions: <all_urls>`);CLI 与扩展之间已有 WebSocket 通道
(`ws://localhost:3711`)。server 端 `client_id` 逐行入库,存量行可按其修正。

## 已确认决策

1. **解析通道**:经 extension 代取——bridge 通过既有 WS 通道让扩展在浏览器上下文
   fetch getUserInfo,SSO cookie 天然携带,cookie 不落盘、不进 CLI 进程。
2. **接口**:仅 `https://weoa.com/weoa/api/hrm/getUserInfo`(公司统一 SSO,覆盖所有
   站点);不做按站接口适配,不读工具结果(维持"绝不记 args/result"原则)。
3. **映射:方案 X(backfill 直改存量行)**:`insertBatch` 收到已解析上报时,直接
   `UPDATE` 该 client_id 的存量降级行;不建映射表、不改查询 SQL。

## client 侧设计(webcli/metrics.js + bridge.js + extension)

### 身份缓存

`~/.webcli/user-cache.json`:

```json
{ "user": "rickhuang", "resolvedAt": 1762700000000,
  "lastAttemptAt": 1762700000000, "lastFailedAt": 1762699000000 }
```

字段均可缺省;文件读写失败静默降级(视同无缓存)。

### buildUploadConfig 优先级

1. 缓存存在且 `user` 非空 → `meta.user=缓存值`,`userSource="hrm-cache"`;
2. 否则 `whoami()` 成功 → 现状不变,`userSource="whoami"`;
3. 否则 `client-<id8>`,`userSource="client-id-fallback"`。

### 解析编排(bridge.js)

bridge init 完成后,当 `meta.userSource === "client-id-fallback"` 时**异步触发一次**
(fire-and-forget,绝不阻塞调用与上报):

1. 读缓存:`lastFailedAt` 距今 < 1 小时 → 本轮放弃;
2. 经 WS 通道向扩展发 `{ type: "identity_fetch" }` 请求,超时 5 秒;
3. 成功(拿到非空 username):写缓存 `user/resolvedAt`,**就地更新**
   `_metricsCfg.meta.user` 与 `userSource="hrm"`,后续上报立刻使用真实名;
4. 失败(未连接/未配对/超时/HRM 未登录):写 `lastFailedAt`,维持 client-xx。

进程重启后缓存里有真实名则不再触发解析;失败退避以文件为准(跨进程生效)。

### 扩展侧(extension/background/service-worker.js)

新增 `identity_fetch` 消息处理:`fetch(HRM_URL, { credentials: "include" })`
(扩展 `<all_urls>` host permission 下携带 SSO cookie)→ 解析响应提取 username →
回 `{ user }` 或 `{ user: null }`。

**username 字段解析策略**(无固定 schema 依赖):响应 JSON 为对象时,依次探测
`username / userName / loginName / account / workCode / user.loginName / user.name`
取首个非空字符串;实现期用真实登录态抓一次响应确认实际字段,并在测试中固化该形态。
任何异常(非 JSON/未登录错误码/字段全空)返回 `{ user: null }`。

### 上报体

不加新字段。解析成功后 `meta.user` 即真实名,`clientId` 照传——"真实名 + client-xx
一起传"由既有 `clientId` 承担,server 按它修正存量。

## server 侧设计(metrics-server/db.js)

`insertBatch` 内,当 `body.userSource ∈ {"hrm","hrm-cache"}` 且 `clientId`、`user`
均有效时,同一事务内追加:

```sql
UPDATE metrics SET user = ?
 WHERE client_id = ? AND (user IS NULL OR user = '' OR user LIKE 'client-%')
```

- 只改写降级行;`whoami` 来源的真实行永不触碰;
- 幂等:同一批重复上报重复 UPDATE 无副作用;
- 多机同人:各自 client_id 各自修正,`by=user` / DAU / MAU 按 user 去重后自然合并;
- 查询层零改动(err 的 users 计数、by=user、active 全口径自动统一);
- `userSource` 不入库(RECORD_FIELDS 白名单外,仅作触发信号)。

渐进修复:未升级客户端的旧上报维持 client-xx,直到该机器升级 webcli 且解析成功
上报一次后,其全部存量行被修正。

## 失败降级

| 场景 | 行为 |
|---|---|
| 扩展未连接 / 未配对 | 本轮放弃,1h 退避 |
| 请求超时(5s) | 同上 |
| HRM 未登录 / 响应无 username | 同上 |
| toolkit-only(无浏览器扩展) | 不具备解析通道,永久维持 client-xx |
| 缓存文件不可读写 | 静默降级为无缓存,主流程不受影响 |

## 隐私边界

只提取并保存 username(工号/登录名);HRM 返回中的姓名、部门等一律不取不存;
不读工具调用结果;cookie 不进 CLI 进程。

## 测试

- **webcli(vitest,webcli/__tests__/metrics.test.js 扩展)**:buildUploadConfig 缓存
  优先级(缓存命中→hrm-cache;无缓存→whoami;whoami 失败→client-id-fallback);
- **bridge 解析编排(注入 fake 发送器与时钟)**:退避窗口内不发起;成功更新
  meta 并写缓存;失败写 lastFailedAt;
- **扩展 identity_fetch(vitest,mock fetch)**:字段探测顺序;未登录/异常 → user:null;
- **metrics-server(node --test)**:backfill 触发(userSource=hrm 修正存量 client-xx
  与空 user 行)、真实名行不动、幂等、userSource 缺失不触发、修正后 by=user 展示
  真实名。

## 明确不做

- 不做按站点接口适配;不做 cookie 读入 CLI;不做数据删除/重置端点;
- toolkit-only 模式不解析;不取工号/姓名等 HRM 附加字段;
- 不改查询层 SQL(方案 Y 已否决)。

## 交付

- metrics-server 与 webcli、extension 同一分支 `feat/metrics-user-fallback-dev110`,
  独立 PR(base dev-1.1.0);
- **生效链路**:server 可独立部署(backfill 等首个带 `userSource=hrm` 的上报到达才
  修正);客户端需发 webcli 行内包(wnpm)+ 扩展随包更新,用户升级后逐步修正;
- HRM 真实响应字段在实现首个任务期经登录态抓取确认(sessionbridge 或真机),并固化
  进测试。
