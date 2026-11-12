
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { nullAuth } from './auth.js'
import { readAdapterPackage } from '../lib/adapt-package.js'
import { artifactForAdapter, artifactForAdapterVersion, artifactForSite, getAdapter, getCommand, getSite, incrementAdapterDownload, incrementSiteDownload, listAdapters, listAdapterCommands, listAdapterReleases, listCommands, listSites, createAccessToken, listAccessTokens, revokeAccessToken, listFavorites, addFavorite, removeFavorite, listManagedAdapters, checkAdapterPublish, preflightAdapterPublish, importAdapter, addAdapterOwner, canManageAdapter, useridFromAccessToken, isAdmin, adapterVersionIndex } from './db.js'

function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'x-content-type-options': 'nosniff', ...extraHeaders })
  res.end(body)
}

function error(res, status, code, message) { sendJson(res, status, { error: { code, message } }) }

function queryOptions(url) {
  return { q: url.searchParams.get('q') || '', sort: url.searchParams.get('sort') || '', runtime: url.searchParams.get('runtime') || '', page: url.searchParams.get('page'), pageSize: url.searchParams.get('page_size') }
}

function safeArtifactPath(dataDir, relative) {
  const root = path.resolve(dataDir)
  const target = path.resolve(root, relative)
  return target.startsWith(`${root}${path.sep}`) ? target : null
}

function streamArtifact(req, res, dataDir, artifact, increment) {
  if (!artifact) return error(res, 404, 'ARTIFACT_NOT_READY', '该 Adapter 尚未提供安装包（官方站点迁移中），请稍后再试')
  const target = safeArtifactPath(dataDir, artifact.path)
  if (!target || !existsSync(target) || !statSync(target).isFile()) return error(res, 404, 'ARTIFACT_MISSING', 'Artifact file is unavailable')
  const size = statSync(target).size
  res.writeHead(200, {
    'content-type': 'application/vnd.weworker.adapt+zip',
    'content-length': size,
    'content-disposition': `attachment; filename="${artifact.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
    etag: `"${artifact.sha256.slice(7)}"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') return res.end()
  increment()
  createReadStream(target).pipe(res)
}

function staticFile(res, webDir, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '')
  const root = path.resolve(webDir)
  let target = path.resolve(root, requested)
  if (!target.startsWith(`${root}${path.sep}`) || !existsSync(target) || !statSync(target).isFile()) target = path.join(root, 'index.html')
  if (!existsSync(target)) return false
  const ext = path.extname(target)
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }
  const body = readFileSync(target)
  res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'content-length': body.length, 'x-content-type-options': 'nosniff' })
  res.end(body)
  return true
}

export function createHandler({ db, dataDir, webDir, auth = nullAuth }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      if (await auth.handleRoute(req, res, url)) return
      auth.attachUser(req)
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      if (url.pathname === '/api/v1/healthz' && req.method === 'GET') return sendJson(res, 200, { ok: true })
      // 登录态信息（Passport 校验成功后使用 AdapterHub 自有 Session；匿名 API 仍可浏览）
      if (url.pathname === '/api/v1/me' && req.method === 'GET') return auth.sendMe(req, res)

      // ── 用户设置与收藏（需登录态 oaUser；匿名访问这些端点返回 401 业务错误供前端引导登录）──
      const requireUser = () => req.oaUser?.userid || null
      // ── 个人访问令牌 PAT（服务端签发，存哈希；用于 webcli 上传/下载 Adapter）──
      if (auth.configured && parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'me' && parts[3] === 'tokens') {
        const userid = requireUser()
        if (!userid) return sendJson(res, 401, { error: { code: 'LOGIN_REQUIRED', message: '登录后可管理访问令牌' } })
        // 列表（不返回明文令牌）
        if (req.method === 'GET' && parts.length === 4) return sendJson(res, 200, { items: listAccessTokens(db, userid) })
        // 创建（POST body: {name, expires_in_days}）— 返回明文令牌仅此一次
        if (req.method === 'POST' && parts.length === 4) {
          const chunks = []
          req.on('data', (c) => chunks.push(c))
          req.on('end', () => {
            try {
              const parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
              const name = String(parsedBody.name || '').trim().slice(0, 100) || '默认令牌'
              const days = Math.min(365, Math.max(1, Math.floor(Number(parsedBody.expires_in_days)) || 90))
              const created = createAccessToken(db, userid, name, days * 24 * 60 * 60 * 1000)
              sendJson(res, 201, created)
            } catch (cause) {
              error(res, 400, 'BAD_REQUEST', cause instanceof Error ? cause.message : 'Invalid request')
            }
          })
          return
        }
        // 撤销（DELETE /me/tokens/:id）
        if (req.method === 'DELETE' && parts.length === 5) {
          const ok = revokeAccessToken(db, userid, parts[4])
          return ok ? sendJson(res, 200, { ok: true }) : error(res, 404, 'NOT_FOUND', '令牌不存在或无权操作')
        }
      }
      // ── 与我相关：收藏 + 我管理的（登录态；前端拿 name 集合做目录过滤）──
      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'me' && parts[3] === 'adapters' && req.method === 'GET' && parts.length === 4) {
        const userid = requireUser()
        if (!userid) return sendJson(res, 401, { error: { code: 'LOGIN_REQUIRED', message: '登录后可查看与我相关的 Adapter' } })
        return sendJson(res, 200, { favorites: listFavorites(db, userid).map((f) => f.adapterName), managed: listManagedAdapters(db, userid) })
      }
      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'me' && parts[3] === 'favorites') {
        const userid = requireUser()
        if (!userid) return sendJson(res, 401, { error: { code: 'LOGIN_REQUIRED', message: '登录后可收藏' } })
        if (req.method === 'GET' && parts.length === 4) return sendJson(res, 200, { items: listFavorites(db, userid) })
        if ((req.method === 'PUT' || req.method === 'DELETE') && parts.length === 5) {
          const adapterName = decodeURIComponent(parts[4])
          try {
            // 兼容 site hub_id（s-xxx）：落到其 domain，使收藏在当前 site 维度数据上可用
            if (req.method === 'PUT') {
              if (!db.prepare('SELECT 1 FROM adapters WHERE name=?').get(adapterName)) {
                const site = db.prepare('SELECT domain FROM sites WHERE hub_id=?').get(adapterName)
                const key = site?.domain || adapterName
                addFavorite(db, userid, key)
              } else addFavorite(db, userid, adapterName)
            }
            else {
              const site = db.prepare('SELECT domain FROM sites WHERE hub_id=?').get(adapterName)
              removeFavorite(db, userid, site?.domain || adapterName)
              if (site) removeFavorite(db, userid, adapterName)
            }
            return sendJson(res, 200, { ok: true })
          } catch (cause) {
            return error(res, 400, 'BAD_REQUEST', cause instanceof Error ? cause.message : 'Invalid request')
          }
        }
      }
      // ── v2：Adapter 维度（唯一可下载/安装粒度）──
      // 批量发布预检：与正式发布复用 PAT、权限、版本规则，但不写文件或数据库。
      if (auth.configured && url.pathname === '/api/v1/adapters/publish-preflight' && req.method === 'POST') {
        const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1]
        const userid = token ? useridFromAccessToken(db, token) : (req.oaUser?.userid || null)
        if (!userid) return error(res, 401, 'UNAUTHORIZED', '请先登录或提供访问令牌（Authorization: Bearer ahp_...）')
        const chunks = []
        let totalBytes = 0
        let aborted = false
        req.on('data', (chunk) => {
          totalBytes += chunk.length
          if (totalBytes > 256 * 1024) { aborted = true; error(res, 413, 'PAYLOAD_TOO_LARGE', '预检请求超过 256KB 上限'); req.destroy() }
          else chunks.push(chunk)
        })
        req.on('end', () => {
          if (aborted) return
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
              return error(res, 400, 'BAD_REQUEST', 'items 必须包含 1-100 个发布项')
            }
            return sendJson(res, 200, preflightAdapterPublish(db, userid, body.items))
          } catch (cause) {
            return error(res, 400, 'BAD_REQUEST', cause instanceof Error ? cause.message : 'Invalid request')
          }
        })
        return
      }
      // 上传/发布 Adapter（v2 schema_version=2 包；PAT 鉴权；归属人或管理员可更新，新人可上传新 Adapter）
      if (auth.configured && url.pathname === '/api/v1/adapters' && req.method === 'POST') {
        // 鉴权优先 PAT（webcli CLI 用），回退 session cookie（网页登录态）
        const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1]
        const userid = token ? useridFromAccessToken(db, token) : (req.oaUser?.userid || null)
        if (!userid) return error(res, 401, 'UNAUTHORIZED', '请先登录或提供访问令牌（Authorization: Bearer ahp_...）')
        const chunks = []
        let totalBytes = 0
        let aborted = false
        req.on('data', (c) => {
          totalBytes += c.length
          if (totalBytes > 32 * 1024 * 1024) { aborted = true; error(res, 413, 'PAYLOAD_TOO_LARGE', '包超过 32MB 上限'); req.destroy() }
          else chunks.push(c)
        })
        req.on('end', () => {
          if (aborted) return
          try {
            const body = Buffer.concat(chunks)
            if (!body.length) return error(res, 400, 'EMPTY_PACKAGE', '请求体为空，请上传 .adapt 包（application/octet-stream）')
            const { manifest, sha256: hash, expandedBytes } = readAdapterPackage(body)
            const existing = db.prepare('SELECT 1 FROM adapters WHERE name=?').get(manifest.name)
            const isOfficialSite = Boolean(db.prepare('SELECT 1 FROM sites WHERE domain=?').get(manifest.name))
            if (existing && !canManageAdapter(db, userid, manifest.name)) {
              return error(res, 403, 'FORBIDDEN', `Adapter "${manifest.name}" 已存在且你不是归属人，无法覆盖发布`)
            }
            if (isOfficialSite && !canManageAdapter(db, userid, manifest.name)) {
              return error(res, 403, 'FORBIDDEN', `"${manifest.name}" 是官方内置站点，仅管理员可发布新版本`)
            }
            const check = checkAdapterPublish(db, manifest.name, manifest.version, hash)
            if (!check.ok) return error(res, 409, 'VERSION_CONFLICT', check.reason)
            if (check.duplicate) {
              // 同版本同内容的历史重传：幂等成功，且不变更 current_release_id（防回滚线上版本）
              return sendJson(res, 200, { ok: true, duplicate: true, name: manifest.name, version: manifest.version, sha256: hash, size: body.length, owner: userid })
            }
            // 路径安全：version/name 不得含路径分隔符或逃逸字符（防写入任意路径）
            const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.name) && !manifest.name.includes('..')
            const safeVersion = /^v?\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/.test(manifest.version)
            if (!safeName || !safeVersion) {
              return error(res, 400, 'UNSAFE_METADATA', `Adapter 名称或版本号包含非法字符（name=${JSON.stringify(manifest.name)}, version=${JSON.stringify(manifest.version)}）`)
            }
            // 双保险：最终落盘路径必须仍在 dataDir 内
            const shortHash = hash.replace('sha256:', '').slice(0, 16)
            const fileName = `${manifest.version}-${shortHash}.adapt`
            const adapterDataDir = path.join(dataDir, 'adapters', manifest.name)
            const resolvedDataDir = path.resolve(dataDir)
            if (!path.resolve(adapterDataDir).startsWith(resolvedDataDir + path.sep) || !path.resolve(adapterDataDir, fileName).startsWith(resolvedDataDir + path.sep)) {
              return error(res, 400, 'UNSAFE_METADATA', '包元数据解析后越出存储目录，已拒绝')
            }
            mkdirSync(adapterDataDir, { recursive: true })
            const relativePath = path.join('adapters', manifest.name, fileName)
            writeFileSync(path.join(dataDir, relativePath), body)
            importAdapter(db, {
              name: manifest.name, display: manifest.display || manifest.name, description: manifest.description,
              match: manifest.match || [], commands: manifest.commands || [], version: manifest.version,
              scenarios: manifest.scenarios || [],
              artifactPath: relativePath, artifactSha256: hash, artifactSize: body.length,
              manifest: { ...manifest, expandedBytes }, origin: existing ? undefined : 'user',
              publishedBy: userid, publisherRole: isAdmin(db, userid) ? 'admin' : 'owner',
            })
            if (!existing) addAdapterOwner(db, manifest.name, userid)
            return sendJson(res, 201, {
              ok: true, duplicate: false, name: manifest.name, version: manifest.version,
              sha256: hash, size: body.length, owner: userid,
            })
          } catch (cause) {
            return error(res, 400, 'INVALID_PACKAGE', cause instanceof Error ? cause.message : 'Invalid package')
          }
        })
        return
      }
      if (url.pathname === '/api/v1/adapters' && req.method === 'GET') {
        const options = queryOptions(url)
        const origin = url.searchParams.get('origin')
        if (origin === 'official' || origin === 'user') options.origin = origin
        return sendJson(res, 200, listAdapters(db, options))
      }
      // 客户端联动版本索引：轻量 [{name, version, sha256}] 清单，ETag/304 支持增量比对
      // （须在 getAdapter 单项路由之前匹配，否则 "index" 会被当作 adapter name）
      if (url.pathname === '/api/v1/adapters/index' && req.method === 'GET') {
        const items = adapterVersionIndex(db)
        const merged = items.map((i) => `${i.name}@${i.version}:${i.sha256}`).join('|')
        let h = 0
        for (let i = 0; i < merged.length; i++) { h = (h * 31 + merged.charCodeAt(i)) | 0 }
        const etag = `"idx-${items.length}-${(h >>> 0).toString(16)}"`
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { etag, 'cache-control': 'no-store' })
          return res.end()
        }
        return sendJson(res, 200, { items }, { etag })
      }
      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'adapters' && parts.length === 4 && req.method === 'GET') {
        const adapter = getAdapter(db, decodeURIComponent(parts[3]))
        return adapter ? sendJson(res, 200, adapter) : error(res, 404, 'NOT_FOUND', 'Adapter not found')
      }
      // 版本历史（发布时间倒序，过滤占位）
      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'adapters' && parts[4] === 'versions' && parts.length === 5 && req.method === 'GET') {
        const name = decodeURIComponent(parts[3])
        if (!getAdapter(db, name)) return error(res, 404, 'NOT_FOUND', 'Adapter not found')
        return sendJson(res, 200, listAdapterReleases(db, name))
      }
      // Adapter 的命令清单（v2 manifest 优先，官方站点回退 v1 冻结数据）
      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'adapters' && parts[4] === 'commands' && parts.length === 5 && req.method === 'GET') {
        const adapter = getAdapter(db, decodeURIComponent(parts[3]))
        if (!adapter) return error(res, 404, 'NOT_FOUND', 'Adapter not found')
        return sendJson(res, 200, listAdapterCommands(db, decodeURIComponent(parts[3])))
      }
      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'adapters' && parts[4] === 'download' && parts.length === 5 && ['GET','HEAD'].includes(req.method)) {
        const name = decodeURIComponent(parts[3])
        const version = url.searchParams.get('version')
        const artifact = version ? artifactForAdapterVersion(db, name, version) : artifactForAdapter(db, name)
        if (!artifact) return error(res, 404, 'NOT_FOUND', version ? `Adapter ${name} 无版本 ${version} 的可下载制品` : 'Adapter not found or not installable')
        return streamArtifact(req, res, dataDir, artifact, () => incrementAdapterDownload(db, artifact.adapterName))
      }
      // ── v1（冻结只读）：站点维度保留，命令维度下载已下线 ──
      if (url.pathname === '/api/v1/sites' && req.method === 'GET') {
        const options = queryOptions(url)
        const origin = url.searchParams.get('origin')
        if (origin === 'official' || origin === 'user') options.origin = origin
        return sendJson(res, 200, listSites(db, options))
      }
      if (url.pathname === '/api/v1/commands' && req.method === 'GET') return sendJson(res, 200, listCommands(db, queryOptions(url)))
      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'sites' && parts.length === 4 && req.method === 'GET') {
        const site = getSite(db, parts[3]); return site ? sendJson(res, 200, site) : error(res, 404, 'NOT_FOUND', 'Site not found')
      }
      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'sites' && parts[4] === 'commands' && parts.length === 5 && req.method === 'GET') {
        return sendJson(res, 200, listCommands(db, { ...queryOptions(url), siteRef: parts[3] }))
      }
      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'sites' && parts[4] === 'commands' && parts.length === 6 && req.method === 'GET') {
        const command = getCommand(db, { siteRef: parts[3], commandName: parts[5] }); return command ? sendJson(res, 200, command) : error(res, 404, 'NOT_FOUND', 'Command not found')
      }
      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'commands' && parts.length === 4 && req.method === 'GET') {
        const command = getCommand(db, { commandId: parts[3] }); return command ? sendJson(res, 200, command) : error(res, 404, 'NOT_FOUND', 'Command not found')
      }
      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'sites' && parts[4] === 'download' && ['GET','HEAD'].includes(req.method)) {
        const artifact = artifactForSite(db, parts[3]); return streamArtifact(req, res, dataDir, artifact, () => incrementSiteDownload(db, artifact.siteId))
      }
      // 命令维度下载/基座下载已下线（收口：Adapter 是唯一分发单位）
      if (url.pathname.startsWith('/api/')) return error(res, 404, 'NOT_FOUND', 'API route not found')
      if (req.method === 'GET' && staticFile(res, webDir, url.pathname)) return
      return error(res, 404, 'NOT_FOUND', 'Not found')
    } catch (cause) {
      return error(res, 400, 'BAD_REQUEST', cause instanceof Error ? cause.message : 'Invalid request')
    }
  }
}
