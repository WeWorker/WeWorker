# AdapterHub

Adapter 目录与分发服务：浏览、检索、下载 Adapter（站点整包），供 `webcli adapterhub` 命令行消费。

开源形态是**纯只读分发站**——无登录、无上传、无令牌管理。企业内网部署如需登录/发布能力，通过认证模块注入扩展（见下）。

## 技术栈

Node.js ≥ 22（原生 `http` + `node:sqlite`，零框架依赖）；Web UI 为 React + Vite（`web/`）。

## 目录

```
server/            服务端（index.js 入口；app.js 路由；db.js sqlite；auth.js 默认无认证）
server/scenarios.default.json   随包的官方推荐场景基线（公开站点）
lib/adapt-package.js  .adapt 包打包/解包库
web/               Web UI（React + Vite，构建产物 → dist/）
config.example.json  运行时动态配置模板
```

## 运行

```bash
# 服务端
npm start            # 默认 127.0.0.1:8790，数据目录 ./data

# Web UI
cd web && npm install && npx vite build   # 产物 → ../dist

# 测试
npm test
```

### 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `ADAPTERHUB_DATA_DIR` | 数据目录（db/制品/配置） | `<root>/data` |
| `ADAPTERHUB_WEB_DIR` | Web UI 静态目录 | `<root>/dist` |
| `ADAPTERHUB_HOST` / `ADAPTERHUB_PORT` | 监听地址 | `127.0.0.1` / `8790` |
| `ADAPTERHUB_DB` | sqlite 文件 | `<DATA_DIR>/adapterhub.db` |
| `ADAPTERHUB_CONFIG` | 动态配置文件路径 | `<DATA_DIR>/config.json` |
| `ADAPTERHUB_SCENARIOS` | 场景覆盖文件路径 | `<DATA_DIR>/scenarios.json` |
| `ADAPTERHUB_ADMINS` | 管理员 userid（逗号分隔） | 空 |

### 运行时动态配置（config.json）

按 mtime 动态读取，改动免重启：

```json
{ "admins": ["userid1"], "review_required": false }
```

管理员默认名单为空——部署后请通过 `config.json` 或 `ADAPTERHUB_ADMINS` 配置。

### 官方推荐场景（scenarios）

`server/scenarios.default.json` 为随包基线；部署侧可用 `<DATA_DIR>/scenarios.json` 按 domain 覆盖/新增（置 `[]` 屏蔽），改动免重启（`syncOfficialAdapters` 触发时生效）。

## 认证扩展（企业部署）

默认无认证（`server/auth.js` 的 `nullAuth`）。如需登录与发布能力，设置：

```
ADAPTERHUB_AUTH_MODULE=/path/to/your-auth.mjs
```

模块导出 `createAuthProvider({ db })`，返回 `{ handleRoute(req,res,url), attachUser(req), sendMe(req,res), configured }`；`configured=true` 时服务端才会挂载发布（`POST /api/v1/adapters`、`publish-preflight`）与令牌管理（`/api/v1/me/tokens`）路由。

## API（只读面）

`GET /api/v1/healthz`、`GET /api/v1/adapters`（分页/检索/排序）、`GET /api/v1/adapters/index`（name/version/sha256 轻量索引）、`GET /api/v1/adapters/:name`、`/versions`、`/commands`、`/download`，以及 v1 sites 冻存兼容端点。写入面仅在上传能力启用（认证模块）后存在。

## webcli 侧使用

```
webcli adapterhub list            # 浏览目录
webcli adapterhub install <name>  # 安装/升级
```
