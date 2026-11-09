/**
 * AdapterHub 服务入口。
 *
 * 环境变量（与部署脚本约定）：
 *   ADAPTERHUB_DATA_DIR    数据目录（db、制品、config.json、scenarios.json），默认 <root>/data
 *   ADAPTERHUB_WEB_DIR     Web UI 静态目录，默认 <root>/dist
 *   ADAPTERHUB_HOST/PORT   监听地址，默认 127.0.0.1:8790
 *   ADAPTERHUB_DB          sqlite 文件路径，默认 <DATA_DIR>/adapterhub.db
 *   ADAPTERHUB_AUTH_MODULE 可选认证模块（ESM，导出 createAuthProvider({db})）；
 *                          缺省无认证 = 纯只读分发站（无登录/发布/令牌）
 */

import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openCatalog } from './db.js'
import { createHandler } from './app.js'
import { nullAuth } from './auth.js'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DATA_DIR = process.env.ADAPTERHUB_DATA_DIR || path.join(ROOT, 'data')
const WEB_DIR = process.env.ADAPTERHUB_WEB_DIR || path.join(ROOT, 'dist')
const HOST = process.env.ADAPTERHUB_HOST || '127.0.0.1'
const PORT = Number(process.env.ADAPTERHUB_PORT || 8790)

mkdirSync(DATA_DIR, { recursive: true })

const db = openCatalog(process.env.ADAPTERHUB_DB || path.join(DATA_DIR, 'adapterhub.db'))

let auth = nullAuth
if (process.env.ADAPTERHUB_AUTH_MODULE) {
  const mod = await import(process.env.ADAPTERHUB_AUTH_MODULE)
  const provider = mod.createAuthProvider ? await mod.createAuthProvider({ db }) : mod.default
  if (!provider || typeof provider.handleRoute !== 'function' || typeof provider.attachUser !== 'function') {
    throw new Error('ADAPTERHUB_AUTH_MODULE 必须导出 createAuthProvider({db})，返回 { handleRoute, attachUser, sendMe, configured }')
  }
  auth = provider
}
const handler = createHandler({ db, dataDir: DATA_DIR, webDir: WEB_DIR, auth })

createServer(handler).listen(PORT, HOST, () => {
  console.log(`AdapterHub listening on http://${HOST}:${PORT} (data=${DATA_DIR}, web=${WEB_DIR}, auth=${auth.configured ? 'custom' : 'none'})`)
})
