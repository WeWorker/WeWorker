// v4 迁移 + origin/归属人 专项测试（node --test server/db-v4.test.mjs）
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  openCatalog, syncOfficialAdapters, listAdapters, listSites, checkAdapterPublish, preflightAdapterPublish,
  addFavorite, listFavorites, listManagedAdapters,
  isAdapterOwner, canManageAdapter, isAdmin,
} from './db.js'

// 管理员经环境显式配置（开源默认名单为空，不内置任何人）
const ADMINS = Array.from({ length: 10 }, (_, i) => `admin${i + 1}`)
process.env.ADAPTERHUB_ADMINS = ADMINS.join(',')

function freshDb() {
  const db = openCatalog(':memory:')
  db.prepare(`INSERT INTO sites (hub_id,domain,name,description,runtimes_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run('s-t1', 'mail.163.com', '163邮箱', '测试站点', '{}', 1, 1)
  db.prepare(`INSERT INTO sites (hub_id,domain,name,description,runtimes_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run('s-t2', 'example.com', '示例站点', '', '{"extension":{}}', 1, 1)
  syncOfficialAdapters(db)
  return db
}

test('官方站点 backfill 为 official adapter 且立即可见', () => {
  const db = freshDb()
  const items = listAdapters(db, {}).items
  assert.equal(items.length, 2)
  assert.ok(items.every((i) => i.origin === 'official'))
  assert.ok(items.every((i) => !Object.hasOwn(i, 'author')))
  assert.ok(items.every((i) => i.version === '0.0.0'))
  // 占位 release 无 artifact：installable=false 且 artifactForAdapter 返回 null
  assert.ok(items.every((i) => i.installable === false))
})

test('origin 筛选：official/user', () => {
  const db = freshDb()
  assert.equal(listAdapters(db, { origin: 'official' }).items.length, 2)
  assert.equal(listAdapters(db, { origin: 'user' }).items.length, 0)
})

test('syncOfficialAdapters 幂等：不重复建 release、不重复挂归属人', () => {
  const db = freshDb()
  syncOfficialAdapters(db)
  syncOfficialAdapters(db)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM adapter_releases').get().c, 2)
  const owners = db.prepare('SELECT COUNT(*) c FROM adapter_owners').get().c
  assert.equal(owners, 2 * 10) // 2 站点 × 10 管理员
})

test('收藏：官方站点以 domain 为键收藏成功并回显站点信息', () => {
  const db = freshDb()
  addFavorite(db, ADMINS[0], 'mail.163.com')
  const favs = listFavorites(db, ADMINS[0])
  assert.equal(favs.length, 1)
  assert.equal(favs[0].adapterName, 'mail.163.com')
  assert.equal(favs[0].display, '163邮箱')
  assert.equal(favs[0].siteId, 's-t1')
})

test('归属人：管理员可管理官方站点，普通用户不可', () => {
  const db = freshDb()
  assert.ok(canManageAdapter(db, ADMINS[0], 'mail.163.com'))
  assert.ok(!canManageAdapter(db, 'stranger', 'mail.163.com'))
  assert.ok(!isAdmin(db, 'stranger'))
  // 管理员名单可用 ADAPTERHUB_ADMINS 覆盖
  process.env.ADAPTERHUB_ADMINS = 'custom-admin'
  try {
    assert.ok(isAdmin(db, 'custom-admin'))
    assert.ok(!isAdmin(db, ADMINS[0]))
  } finally { process.env.ADAPTERHUB_ADMINS = ADMINS.join(',') }
})

test('用户上传 adapter 成为归属人（模拟）', () => {
  const db = freshDb()
  db.prepare(`INSERT INTO adapters (name,display,description,match_json,runtimes_json,origin,created_at,updated_at)
    VALUES (?,?,?,?,?,'user',?,?)`).run('my-team-tool.internal', '团队工具', '用户上传', '["my-team-tool.internal"]', '[]', Date.now(), Date.now())
  db.prepare(`INSERT INTO adapter_releases (adapter_name,version,artifact_path,artifact_sha256,artifact_size,manifest_json,published_at)
    VALUES (?,?,?,?,?,?,?)`).run('my-team-tool.internal', '1.0.0', '/data/x.adapt', 'abc', 123, '{"commands":[]}', Date.now())
  db.prepare('UPDATE adapters SET current_release_id=(SELECT id FROM adapter_releases WHERE adapter_name=?) WHERE name=?')
    .run('my-team-tool.internal', 'my-team-tool.internal')
  assert.ok(isAdapterOwner(db, 'uploader', 'my-team-tool.internal') === false)
  db.prepare('INSERT INTO adapter_owners (adapter_name,userid,created_at) VALUES (?,?,?)').run('my-team-tool.internal', 'uploader', Date.now())
  assert.ok(isAdapterOwner(db, 'uploader', 'my-team-tool.internal'))
  assert.ok(canManageAdapter(db, 'uploader', 'my-team-tool.internal'))
  // 管理员也能管理用户上传的 adapter
  assert.ok(canManageAdapter(db, ADMINS[0], 'my-team-tool.internal'))
  const uploaded = listAdapters(db, { origin: 'user' }).items
  assert.equal(uploaded.length, 1)
  assert.equal(uploaded[0].author, 'uploader')
})

test('listSites 返回 origin 字段且支持 origin 筛选（含 site_releases 完整数据）', () => {
  const db = freshDb()
  for (const [hubId, domain] of [['s-t1', 'mail.163.com'], ['s-t2', 'example.com']]) {
    db.prepare(`INSERT INTO site_releases (site_id,version,base_hash,base_path,base_sha256,site_path,site_sha256,site_size,published_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(hubId, '1.0.0', 'h', '/p', 'sha1', '/s', 'sha2', 1, 1)
    db.prepare('UPDATE sites SET current_release_id=(SELECT id FROM site_releases WHERE site_id=?) WHERE hub_id=?').run(hubId, hubId)
  }
  assert.equal(listSites(db, { origin: 'official' }).items.length, 2)
  assert.equal(listSites(db, { origin: 'user' }).items.length, 0)
  assert.ok(listSites(db, {}).items.every((s) => s.origin === 'official'))
})

test('checkAdapterPublish：版本规则（幂等/冲突/降级拒绝/多位版本号）', () => {
  const db = freshDb()
  db.prepare(`INSERT INTO adapters (name,display,description,match_json,runtimes_json,origin,created_at,updated_at)
    VALUES (?,?,?,?,?,'user',?,?)`).run('pub.internal', 'p', 'd', '[]', '[]', Date.now(), Date.now())
  db.prepare(`INSERT INTO adapter_releases
    (adapter_name,version,artifact_path,artifact_sha256,artifact_size,manifest_json,published_at)
    VALUES (?,?,?,?,?,?,?)`).run('pub.internal', '1.2.0', '/p', 'sha256:aaa', 1, '{}', Date.now())
  assert.deepEqual(checkAdapterPublish(db, 'pub.internal', '1.2.0', 'sha256:aaa'), { ok: true, duplicate: true })
  assert.equal(checkAdapterPublish(db, 'pub.internal', '1.2.0', 'sha256:bbb').ok, false)
  assert.ok(checkAdapterPublish(db, 'pub.internal', '1.10.0', 'sha256:ccc').ok)
  assert.equal(checkAdapterPublish(db, 'pub.internal', '1.1.0', 'sha256:ddd').ok, false)
  assert.ok(checkAdapterPublish(db, 'pub.internal', '2.0.0', 'sha256:eee').ok)
})

test('listManagedAdapters 只返回归属人的 listed adapter', () => {
  const db = freshDb()
  assert.deepEqual(listManagedAdapters(db, ADMINS[0]).sort(), ['example.com', 'mail.163.com'])
  assert.deepEqual(listManagedAdapters(db, 'stranger'), [])
})

test('preflightAdapterPublish：publishable/forbidden/invalid 且零写入', () => {
  const db = freshDb()
  const beforeReleases = db.prepare('SELECT COUNT(*) c FROM adapter_releases').get().c
  const beforeAdapters = db.prepare('SELECT COUNT(*) c FROM adapters').get().c
  const sha = `sha256:${'a'.repeat(64)}`
  const admin = preflightAdapterPublish(db, ADMINS[0], [
    { name: 'mail.163.com', version: '1.0.0', sha256: sha, size: 123 },
    { name: 'new.internal', version: '1.0.0', sha256: sha, size: 456 },
    { name: '../bad', version: '1.0.0', sha256: sha, size: 1 },
  ])
  assert.deepEqual(admin.items.map((item) => item.status), ['publishable', 'publishable', 'invalid'])
  assert.equal(admin.authorized, false)
  assert.equal(admin.summary.publishable, 2)
  assert.equal(admin.summary.invalid, 1)
  const stranger = preflightAdapterPublish(db, 'stranger', [{ name: 'mail.163.com', version: '1.0.0', sha256: sha, size: 123 }])
  assert.equal(stranger.items[0].status, 'forbidden')
  assert.equal(stranger.authorized, false)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM adapter_releases').get().c, beforeReleases)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM adapters').get().c, beforeAdapters)
})

test('preflightAdapterPublish：duplicate/conflict/downgrade 分类', () => {
  const db = freshDb()
  const shaA = `sha256:${'a'.repeat(64)}`
  const shaB = `sha256:${'b'.repeat(64)}`
  db.prepare(`INSERT INTO adapter_releases
    (adapter_name,version,artifact_path,artifact_sha256,artifact_size,manifest_json,published_at)
    VALUES (?,?,?,?,?,?,?)`).run('mail.163.com', '1.2.0', '/p', shaA, 1, '{}', Date.now())
  const result = preflightAdapterPublish(db, ADMINS[0], [
    { name: 'mail.163.com', version: '1.2.0', sha256: shaA, size: 1 },
    { name: 'mail.163.com', version: '1.2.0', sha256: shaB, size: 1 },
    { name: 'mail.163.com', version: '1.1.0', sha256: shaB, size: 1 },
    { name: 'mail.163.com', version: '1.3.0', sha256: shaB, size: 1 },
  ])
  assert.deepEqual(result.items.map((item) => item.status), ['duplicate', 'conflict', 'downgrade-blocked', 'publishable'])
  assert.deepEqual(result.summary, { publishable: 1, duplicate: 1, forbidden: 0, conflict: 1, downgradeBlocked: 1, invalid: 0 })
  assert.equal(result.authorized, false)
})
