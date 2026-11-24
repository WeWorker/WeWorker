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

## 桌面端 Adapter 更新

对外部署时，将 `/adapterhub/api/v1/` 转发到 AdapterHub API，保留查询参数与 `ETag`／`If-None-Match`，不要落到官网的 HTML 回退页。桌面客户端使用随构建固定的 HTTPS 地址，不接受重定向。可用 `GET /api/v1/adapters/index?channel=desktop` 验证服务：应返回 JSON `{ channel: "desktop", items: [...] }`，每项沿用已有版本和制品 SHA-256，并提供 `official` 标记。未上架和只有占位制品的条目不会出现在索引中。未传 `channel` 的客户端仍可使用原格式。

内置 Adapter 只接受官方条目由管理员发布的版本；已从同一 Hub 安装的 Adapter 可按原来源更新，已有内置副本的同名 Adapter 仍要求官方版本。本地导入、生成或开发中的 Adapter 不会被替换。用户点更新后，桌面端通过 `GET /api/v1/adapters/:name/download?version=...` 取得确切版本，校验制品 SHA-256、包名和版本后安装。安装不允许降级或扩大权限，已禁用的 Adapter 更新后仍保持禁用。部署验收请同时验证索引 JSON、条件请求的 304、确切版本的 `.adapt` 下载和哈希一致性。

当前的完整性校验信任官方 HTTPS Hub 和受控的发布权限；SHA-256 不是发行者签名，不能防止被攻陷的 Hub 同时替换索引和制品。若部署需要独立的发布者身份验证，应在启用分发前引入由客户端验证的签名，并明确签名密钥轮换及撤销规则。本任务不更改发布流程。

### 桌面端 AdapterHub 浏览与安装（Backend 待接入）

桌面端「AdapterHub」页已完成前端，等待 Backend 提供以下鉴权路由：

- `GET /adapter-hub` → `{ items: [{ name, displayName?, description?, version, official?, iconUrl?, installedVersion? }] }`。`name` 必填且为 Adapter 包名；`installedVersion` 留空表示本地未安装。
- `POST /adapter-hub/:id/install`，请求体 `{ version }`；失败返回 `{ detail }`，桌面端直接展示该文案。

前端行为：列表由远端完整返回，搜索只在本地过滤；安装期间显示顶部进度提示，成功后刷新站点列表并重新拉取 Hub 列表；接口不可用时显示「AdapterHub 暂不可用，请稍后重试。」并提供重试。Backend 可代理 `GET /api/v1/adapters` 与确切版本下载，复用 `installAdapter({ origin: { kind: 'hub', service } })`，并保持 SHA-256、包名、版本与权限的既有校验。

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
