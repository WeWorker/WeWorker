// 发布预检路由专项测试（node --test server/adapter-publish-preflight.test.mjs）
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHandler } from './app.js'

// 管理员经环境显式配置（开源默认名单为空）
process.env.ADAPTERHUB_ADMINS = 'pat-admin'
import { createAccessToken, openCatalog, syncOfficialAdapters } from './db.js'

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'adapterhub-preflight-'))
  const dataDir = path.join(root, 'data')
  const webDir = path.join(root, 'web')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(webDir, { recursive: true })
  const db = openCatalog(':memory:')
  db.prepare(`INSERT INTO sites (hub_id,domain,name,description,runtimes_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run('s-mail', 'mail.163.com', '163邮箱', '', '{}', 1, 1)
  syncOfficialAdapters(db)
  // 启用发布能力的最小认证桩（无用户体系，仅 PAT 路径）
  const auth = {
    configured: true,
    async handleRoute() { return false },
    attachUser() { return null },
    sendMe(req, res) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ logged_in: false })) },
  }
  const handler = createHandler({ db, dataDir, webDir, auth })
  const server = createServer(handler)
  return { root, db, server }
}

async function withServer(run) {
  const ctx = fixture()
  await new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${ctx.server.address().port}`
  try { await run({ ...ctx, base }) }
  finally {
    await new Promise((resolve) => ctx.server.close(resolve))
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  }
}

const sha = `sha256:${'a'.repeat(64)}`
const item = { name: 'mail.163.com', version: '1.0.0', sha256: sha, size: 123 }

async function post(base, body, token) {
  return fetch(`${base}/api/v1/adapters/publish-preflight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('publish-preflight：未启用发布能力（无认证模块）返回 404', async () => {
  // 开源默认形态（nullAuth）：发布路由不挂载
  const root = mkdtempSync(path.join(tmpdir(), 'adapterhub-preflight-off-'))
  const dataDir = path.join(root, 'data'); const webDir = path.join(root, 'web')
  mkdirSync(dataDir, { recursive: true }); mkdirSync(webDir, { recursive: true })
  const db = openCatalog(':memory:'); db.prepare(`INSERT INTO sites (hub_id,domain,name,description,runtimes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).run('s', 'a.example', 'A', '', '{}', 1, 1)
  const server = createServer(createHandler({ db, dataDir, webDir }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const res = await post(base, { items: [item] })
    assert.equal(res.status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve)); db.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('publish-preflight：无 PAT 返回 401', async () => {
  await withServer(async ({ base }) => {
    const response = await post(base, { items: [item] })
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'UNAUTHORIZED')
  })
})

test('publish-preflight：管理员 PAT 返回 publishable，且不写 release', async () => {
  await withServer(async ({ base, db }) => {
    const token = createAccessToken(db, 'pat-admin', 'test', 60_000).token
    const before = db.prepare('SELECT COUNT(*) c FROM adapter_releases').get().c
    const response = await post(base, { items: [item] }, token)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.authorized, true)
    assert.equal(body.summary.publishable, 1)
    assert.equal(body.items[0].status, 'publishable')
    assert.equal(db.prepare('SELECT COUNT(*) c FROM adapter_releases').get().c, before)
  })
})

test('publish-preflight：普通用户对 official Adapter 返回 forbidden', async () => {
  await withServer(async ({ base, db }) => {
    const token = createAccessToken(db, 'stranger', 'test', 60_000).token
    const response = await post(base, { items: [item] }, token)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.authorized, false)
    assert.equal(body.summary.forbidden, 1)
    assert.equal(body.items[0].status, 'forbidden')
  })
})

test('publish-preflight：非法 JSON、空 items 和超过 100 项返回 400', async () => {
  await withServer(async ({ base, db }) => {
    const token = createAccessToken(db, 'pat-admin', 'test', 60_000).token
    const invalidJson = await post(base, '{', token)
    assert.equal(invalidJson.status, 400)
    const empty = await post(base, { items: [] }, token)
    assert.equal(empty.status, 400)
    const tooMany = await post(base, { items: Array.from({ length: 101 }, () => item) }, token)
    assert.equal(tooMany.status, 400)
  })
})
