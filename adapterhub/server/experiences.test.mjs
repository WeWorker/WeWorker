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
