// 版本历史与指定版本下载 专项测试（node --test server/adapter-versions.test.mjs）
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  openCatalog, syncOfficialAdapters, importAdapter, getAdapter,
  listAdapterReleases, artifactForAdapterVersion, artifactForAdapter,
} from './db.js'

function freshDb() {
  const db = openCatalog(':memory:')
  db.prepare(`INSERT INTO sites (hub_id,domain,name,description,runtimes_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run('s-t1', 'pub.example.com', '示例站', '', '{}', 1, 1)
  syncOfficialAdapters(db)
  return db
}

function publish(db, version, sha, listed = true) {
  importAdapter(db, {
    name: 'pub.example.com', display: '示例站', description: '', match: [], commands: [],
    version, scenarios: [],
    artifactPath: `adapters/pub.example.com/${version}-${sha.slice(7, 23)}.adapt`,
    artifactSha256: sha, artifactSize: 1024, manifest: {}, origin: undefined,
  })
  if (!listed) db.prepare('UPDATE adapters SET listed=0 WHERE name=?').run('pub.example.com')
}

test('listAdapterReleases：发布时间倒序、过滤占位、含 size/sha256', () => {
  const db = freshDb()
  // 占位 release（syncOfficialAdapters 建的 0.0.0 placeholder-no-artifact）应被过滤
  publish(db, '1.0.0', 'sha256:' + 'a'.repeat(64))
  publish(db, '1.1.0', 'sha256:' + 'b'.repeat(64))
  publish(db, '1.2.0', 'sha256:' + 'c'.repeat(64))
  const { items, total } = listAdapterReleases(db, 'pub.example.com')
  assert.equal(total, 3)
  assert.deepEqual(items.map((i) => i.version), ['1.2.0', '1.1.0', '1.0.0'])
  assert.equal(items[0].size, 1024)
  assert.equal(items[0].sha256, 'sha256:' + 'c'.repeat(64))
  assert.ok(items[0].publishedAt !== undefined)
})

test('listAdapterReleases：不存在的 adapter 返回空（路由层由 getAdapter 判 404）', () => {
  const db = freshDb()
  const { items, total } = listAdapterReleases(db, 'nope.example.com')
  assert.equal(total, 0)
  assert.equal(items.length, 0)
})

test('artifactForAdapterVersion：命中历史版本', () => {
  const db = freshDb()
  publish(db, '1.0.0', 'sha256:' + 'a'.repeat(64))
  publish(db, '1.1.0', 'sha256:' + 'b'.repeat(64))
  const latest = artifactForAdapter(db, 'pub.example.com')
  assert.equal(latest.version ?? artifactForAdapterVersion(db, 'pub.example.com', '1.1.0').sha256, 'sha256:' + 'b'.repeat(64))
  const old = artifactForAdapterVersion(db, 'pub.example.com', '1.0.0')
  assert.equal(old.sha256, 'sha256:' + 'a'.repeat(64))
  assert.ok(old.path.includes('1.0.0'))
  assert.equal(old.filename, 'pub.example.com-1.0.0.adapt')
})

test('artifactForAdapterVersion：不存在/占位返回 null', () => {
  const db = freshDb()
  assert.equal(artifactForAdapterVersion(db, 'pub.example.com', '9.9.9'), null)
  // 仅占位（placeholder-no-artifact）时任何版本都不可下载
  assert.equal(artifactForAdapterVersion(db, 'pub.example.com', '0.0.0'), null)
})
