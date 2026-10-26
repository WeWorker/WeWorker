# metrics-server

Adapter 调用埋点服务端。接收 `webcli` 客户端的回调上报，集中存储与聚合查询，形成团队级看板数据源。

配套客户端方案见仓库根目录 `ADAPTER_METRICS_PROPOSAL.md`。

## 特性

- **零运行时依赖**：Node ≥22 内置 `node:sqlite` + 原生 `http`
- **鉴权**：`Authorization: Bearer <token>`
- **幂等**：以 `(client_id, ts, trace_id, tool)` 去重，容忍客户端 at-least-once 重发
- **脱敏兜底**：入库按白名单字段过滤，丢弃任何 `args`/`result` 类多余字段，`err` 截断至 200 字符
- **限尺**：单请求 body ≤ 1MB，`batch` ≤ 500 条

## 运行

```bash
cd metrics-server
METRICS_TOKEN=<your-token> node server.js
# 或
METRICS_PORT=8787 METRICS_DB=/var/lib/webcli/metrics.db METRICS_TOKEN=xxx node server.js
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `METRICS_PORT` | `8787` | 监听端口 |
| `METRICS_DB` | `./metrics.db` | SQLite 文件路径 |
| `METRICS_TOKEN` | 空 | Bearer 鉴权 token（**强烈建议设置**；为空则接口开放，仅限内网/测试） |

> 公网部署务必前置 HTTPS（反代）并设置 token。

## 接口

### `POST /v1/metrics/batch`

接收一批上报记录。请求体：

```json
{
  "clientId": "a1b2c3d4",
  "user": "tester",
  "webcliVersion": "1.0.6",
  "os": "win32",
  "batch": [
    { "ts": 1733300000000, "tool": "itsm.example.com.search_tickets",
      "domain": "itsm.example.com", "kind": "adapter", "ok": true,
      "ms": 1840, "traceID": "abc123", "err": null }
  ]
}
```

响应：`{ "accepted": N, "skipped": M }`（`skipped` 含去重命中与非法记录）。

错误码：`401` 鉴权失败 / `400` body 非法或缺 batch / `413` 超尺寸 / `500` 落库失败。

### `GET /v1/stats`

聚合查询，与客户端 `webcli stats` 输出同构。

| query | 默认 | 说明 |
|---|---|---|
| `by` | `domain` | `domain` 或 `tool` |
| `since` | `30d` | 时间窗，支持 `d`/`h`/`m` |
| `kind` | 全部 | `adapter` 或 `builtin` |
| `top` | 全部 | 只返回前 N |

响应：`{ "rows": [...], "totalCalls": N }`。

### `GET /v1/healthz`

`{ "ok": true }`。

## 客户端如何接入

在运行 `webcli service` 的机器上配置（三者齐备才上报）：

```bash
export WEBCLI_METRICS_UPLOAD=on
export WEBCLI_METRICS_ENDPOINT=https://metrics.internal/v1/metrics/batch
export WEBCLI_METRICS_TOKEN=<token>
export WEBCLI_METRICS_USER=alice   # 可选，不设则全匿名
```

查询全团队汇总：

```bash
webcli stats --remote --since 7d --top 10
```

## 测试

```bash
node --test
```

## 存储迁移

起步用 SQLite。规模扩大后可迁 PostgreSQL：schema 与 SQL 基本兼容，
百分位改用原生 `percentile_cont`，`INSERT OR IGNORE` 改为 `ON CONFLICT DO NOTHING`。
