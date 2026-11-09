// 管理员动态配置 + 客户端联动版本索引 专项测试（node --test server/admin-config-index.test.mjs）
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  openCatalog, syncOfficialAdapters, importAdapter,
  isAdmin, adapterVersionIndex,
} from './db.js'

const savedEnv = { config: process.env.ADAPTERHUB_CONFIG, dataDir: process.env.ADAPTERHUB_DATA_DIR }

test.afterEach(() => {
  if (savedEnv.config === undefined) delete process.env.ADAPTERHUB_CONFIG
  else process.env.ADAPTERHUB_CONFIG = savedEnv.config
  if (savedEnv.dataDir === undefined) delete process.env.ADAPTERHUB_DATA_DIR
  else process.env.ADAPTERHUB_DATA_DIR = savedEnv.dataDir
})

function freshDb() {
  const db = openCatalog(':memory:')
  db.prepare(`INSERT INTO sites (hub_id,domain,name,description,runtimes_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run('s-t1', 'pub.example.com', '示例站', '', '{}', 1, 1)
  syncOfficialAdapters(db)
  return db
}

function publish(db, name, version) {
  const sha = 'sha256:' + version.padEnd(64, '0')
  importAdapter(db, {
    name, display: name, description: '', match: [], commands: [], version, scenarios: [],
    artifactPath: `adapters/${name}/${version}.adapt`, artifactSha256: sha, artifactSize: 1024,
    manifest: {}, origin: undefined,
  })
}

test('isAdmin：config.json admins 优先且动态生效（改文件免重启）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adapterhub-config-'))
  const configFile = path.join(dir, 'config.json')
  process.env.ADAPTERHUB_CONFIG = configFile
  delete process.env.ADAPTERHUB_DATA_DIR

  const db = freshDb()
  // 开源默认名单为空：未配置且无 env → 无人是管理员
  delete process.env.ADAPTERHUB_ADMINS
  assert.equal(isAdmin(db, 'alice'), false)
  assert.equal(isAdmin(db, 'nobody'), false)

  // env 配置 → 生效
  process.env.ADAPTERHUB_ADMINS = 'alice'
  assert.equal(isAdmin(db, 'alice'), true)
  assert.equal(isAdmin(db, 'nobody'), false)

  // config.json 优先于 env，配置后动态生效（改文件免重启）
  writeFileSync(configFile, JSON.stringify({ admins: ['nobody'] }))
  assert.equal(isAdmin(db, 'nobody'), true)
  assert.equal(isAdmin(db, 'alice'), false)

  writeFileSync(configFile, JSON.stringify({ admins: ['alice', 'nobody'] }))
  assert.equal(isAdmin(db, 'alice'), true)

  // 非法 JSON → 安全回退（env）
  writeFileSync(configFile, '{broken json')
  assert.equal(isAdmin(db, 'alice'), true)
  assert.equal(isAdmin(db, 'nobody'), false)

  process.env.ADAPTERHUB_ADMINS = ''

  rmSync(dir, { recursive: true, force: true })
})

test('adapterVersionIndex：只含已上架且有制品的，占位 0.0.0 过滤', () => {
  const db = freshDb()
  // syncOfficialAdapters 只建占位 → 索引应为空
  assert.deepEqual(adapterVersionIndex(db), [])
  publish(db, 'pub.example.com', '1.0.0')
  publish(db, 'beta.example.com', '2.1.0')
  // 未上架的 adapter 不进索引
  publish(db, 'hidden.example.com', '0.1.0')
  db.prepare('UPDATE adapters SET listed=0 WHERE name=?').run('hidden.example.com')

  const items = adapterVersionIndex(db)
  assert.deepEqual(items, [
    { name: 'beta.example.com', version: '2.1.0', sha256: 'sha256:' + '2.1.0'.padEnd(64, '0') },
    { name: 'pub.example.com', version: '1.0.0', sha256: 'sha256:' + '1.0.0'.padEnd(64, '0') },
  ])
})
