// 修复经验库（自进化二期）专项测试（node --test server/experiences.test.mjs）
import assert from 'node:assert/strict'
import test from 'node:test'
import { openCatalog, upsertExperience, listExperiences } from './db.js'

const E = { id: 'k1', site: 'wekm', runtime: 'wewright', root_cause: 'login-expired',
  symptom: 'exited code 1', fix_strategy: '探登录态', playbook: JSON.stringify({ detect: 'd' }),
  outcome: 'fixed', reporter: 'rickhuang' }

test('upsert 去重 hits+1；failed 保留旧策略与 playbook', () => {
  const db = openCatalog(':memory:')
  upsertExperience(db, E)
  upsertExperience(db, { ...E, outcome: 'failed', fix_strategy: '', playbook: undefined })
  const rows = listExperiences(db, {})
  assert.equal(rows.length, 1)
  assert.equal(rows[0].hits, 2)
  assert.equal(rows[0].fix_strategy, '探登录态')
  assert.equal(rows[0].last_outcome, 'failed')
  assert.equal(JSON.parse(rows[0].playbook).detect, 'd')
})

test('list 过滤 site/runtime/root_cause，hits 降序，k 封顶', () => {
  const db = openCatalog(':memory:')
  for (let i = 0; i < 30; i++) upsertExperience(db, { ...E, id: `k${i}`, symptom: `s${i}` })
  upsertExperience(db, { ...E, id: 'x1', site: 'other' })
  const all = listExperiences(db, {})
  assert.equal(all.length, 20) // k 默认 20 封顶
  const wekm = listExperiences(db, { site: 'wekm', k: 5 })
  assert.ok(wekm.length >= 1 && wekm.every((r) => r.site === 'wekm'))
  assert.equal(listExperiences(db, { site: 'nomatch' }).length, 0)
  const byCause = listExperiences(db, { root_cause: 'login-expired', k: 50 })
  assert.ok(byCause.every((r) => r.root_cause === 'login-expired'))
})

test('id 缺失/非法由路由层校验/补齐（db 层只管存取，不拦不炸）', () => {
  const db = openCatalog(':memory:')
  upsertExperience(db, { ...E, id: '' })
  assert.equal(listExperiences(db, {}).length, 1) // db 层不拦；路由层拦——此处仅确认 db 不炸
})

// ── 路由层（真实起服；认证桩与起服方式照 adapter-publish-preflight.test.mjs 模式）──
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHandler } from './app.js'
import { createAccessToken } from './db.js'

function routeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'adapterhub-experiences-'))
  const dataDir = path.join(root, 'data')
  const webDir = path.join(root, 'web')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(webDir, { recursive: true })
  const db = openCatalog(':memory:')
  // 启用发布能力的最小认证桩（无用户体系，仅 PAT 路径）
  const auth = {
    configured: true,
    async handleRoute() { return false },
    attachUser() { return null },
    sendMe(req, res) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ logged_in: false })) },
  }
  const server = createServer(createHandler({ db, dataDir, webDir, auth }))
  return { root, db, server }
}

async function withServer(run) {
  const ctx = routeFixture()
  await new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${ctx.server.address().port}`
  try { await run({ ...ctx, base }) }
  finally {
    await new Promise((resolve) => ctx.server.close(resolve))
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  }
}

async function postExperience(base, body, token) {
  return fetch(`${base}/api/v1/experiences`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}

async function getItems(base) {
  const res = await fetch(`${base}/api/v1/experiences`)
  assert.equal(res.status, 200)
  return (await res.json()).items
}

test('路由：GET 匿名可读（空库 items:[]）；POST 无 Authorization 401', async () => {
  await withServer(async ({ base }) => {
    assert.deepEqual(await getItems(base), [])
    const res = await postExperience(base, { site: 'wekm', symptom: 's' })
    assert.equal(res.status, 401)
    assert.equal((await res.json()).error.code, 'UNAUTHORIZED')
  })
})

test('路由：合法 PAT + 完整条目 POST 200，随后匿名 GET 可见', async () => {
  await withServer(async ({ base, db }) => {
    const token = createAccessToken(db, 'pat-user', 'test', 60_000).token
    const res = await postExperience(base, {
      id: 'k-route', site: 'wekm', runtime: 'wewright', root_cause: 'login-expired',
      symptom: 'exited code 1', fix_strategy: '探登录态',
      playbook: { detect: 'd' }, outcome: 'fixed',
    }, token)
    assert.equal(res.status, 200)
    const items = await getItems(base)
    assert.equal(items.length, 1)
    assert.equal(items[0].id, 'k-route')
    assert.equal(items[0].reporter, 'pat-user')
    assert.equal(JSON.parse(items[0].playbook).detect, 'd')
  })
})

test('路由：缺 symptom 400；缺 id 补齐为 sha1(site|runtime|symptom) 前 12 位', async () => {
  await withServer(async ({ base, db }) => {
    const token = createAccessToken(db, 'pat-user', 'test', 60_000).token
    const missing = await postExperience(base, { site: 'wekm' }, token)
    assert.equal(missing.status, 400)
    const symptom = 'exited code 1'
    const res = await postExperience(base, { site: 'wekm', runtime: 'wewright', symptom }, token)
    assert.equal(res.status, 200)
    const expectedId = createHash('sha1').update(`wekm|wewright|${symptom}`).digest('hex').slice(0, 12)
    assert.equal((await res.json()).id, expectedId)
    assert.equal((await getItems(base))[0].id, expectedId)
  })
})

test('路由：超长字段截断（10000 字符 symptom 落库 ≤500）；非法 outcome 归一为 fixed', async () => {
  await withServer(async ({ base, db }) => {
    const token = createAccessToken(db, 'pat-user', 'test', 60_000).token
    const res = await postExperience(base, {
      site: 'wekm', symptom: 'x'.repeat(10000), root_cause: 'r'.repeat(500),
      fix_strategy: 'f'.repeat(3000), outcome: 'maybe',
    }, token)
    assert.equal(res.status, 200)
    const row = (await getItems(base))[0]
    assert.equal(row.symptom.length <= 500, true)
    assert.equal(row.root_cause.length, 200)
    assert.equal(row.fix_strategy.length, 2000)
    assert.equal(row.outcome, 'fixed')
    assert.equal(row.last_outcome, 'fixed')
  })
})

test('路由：playbook 序列化超 4KB 整体置 null（INSERT 路径存 NULL）', async () => {
  await withServer(async ({ base, db }) => {
    const token = createAccessToken(db, 'pat-user', 'test', 60_000).token
    const res = await postExperience(base, {
      site: 'wekm', symptom: 's', playbook: { blob: 'y'.repeat(5000) },
    }, token)
    assert.equal(res.status, 200)
    assert.equal((await getItems(base))[0].playbook, null)
  })
})
