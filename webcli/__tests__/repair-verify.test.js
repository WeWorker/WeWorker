import { afterAll, describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertExpect, verifyStatically, verifyRepair } from '../repair/verify.js'

// mkdtemp 临时根统一登记,afterAll 一次性清理(与 repair-wewright-draft.test.js 同惯例)
const roots = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function buildDraft({ version = '1.0.1', py = "import json\nprint(json.dumps({'ok': True}))\n", second = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'repair-verify-'))
  roots.push(root)
  const dir = join(root, 'demo-fixture')
  await mkdir(join(dir, 'wewright', 'commands'), { recursive: true })
  const commands = [{ id: 'get-article', runtime: 'wewright', module: 'wewright/commands/get-article.py', description: 'd', schema: { type: 'object' } }]
  if (second) commands.push({ id: 'get-list', runtime: 'wewright', module: 'wewright/commands/get-list.py', description: 'd', schema: { type: 'object' } })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    schema_version: 2, name: 'demo-fixture', version, description: 'd', runtime_allowed_hosts: ['demo.example.com'],
    commands,
  }, null, 2))
  await writeFile(join(dir, 'wewright', 'commands', 'get-article.py'), py)
  if (second) await writeFile(join(dir, 'wewright', 'commands', 'get-list.py'), py)
  return dir
}

const TASK = { adapterId: 'demo-fixture', failures: [{ tool: 'demo-fixture.get-article', count: 3, lastErr: 'x' }] }

describe('assertExpect', () => {
  it('requiredPaths / notEmpty / equals / patterns / rowCount 各语义', () => {
    expect(assertExpect({ a: 1, b: 'x', rows: [1] }, { requiredPaths: ['a'], notEmpty: ['b'], equals: { a: 1 }, patterns: { b: '^x' }, rowCount: { rows: 1 } })).toEqual([])
  })
  it('违规逐条报错', () => {
    const errs = assertExpect({ a: null, rows: [] }, { requiredPaths: ['missing'], notEmpty: ['a'], rowCount: { rows: 2 } })
    expect(errs).toHaveLength(3)
  })
})

describe('verifyStatically', () => {
  it('manifest/模块检查;版本未 bump 记失败', async () => {
    const dir = await buildDraft({ version: '1.0.0' })
    const { checks } = verifyStatically(dir, { baseVersion: '1.0.0' })
    expect(checks.find((c) => c.name === 'version-bumped').passed).toBe(false)
    expect(checks.find((c) => c.name === 'module-exists:get-article').passed).toBe(true)
  })
})

describe('verifyRepair(无运行时,注入 replayImpl)', () => {
  it('全绿 → passed;重放失败 → passed=false 且 fixture 跳过', async () => {
    const dir = await buildDraft({})
    const good = { exitCode: 0, result: { ok: true, title: 'ok', rows: [1, 2] } }
    const fixtures = [{ id: 'f1', commandId: 'get-article', expect: { equals: { ok: true }, rowCount: { rows: 2 } } }]
    const pass = await verifyRepair({ task: TASK, draftDir: dir, baseVersion: '1.0.0', fixtures, replayImpl: async () => good, log: () => {} })
    expect(pass.passed).toBe(true)
    const bad = await verifyRepair({ task: TASK, draftDir: dir, baseVersion: '1.0.0', fixtures, replayImpl: async () => ({ exitCode: 1, result: null, stderrTail: 'boom' }), log: () => {} })
    expect(bad.passed).toBe(false)
    expect(bad.checks.find((c) => c.name === 'replay:get-article').passed).toBe(false)
    expect(bad.checks.find((c) => c.name === 'fixture:f1')).toBeUndefined()
  })
  it('双命令:冒烟通过记 ✓;冒烟失败记 ✗ 且整体 passed=false 但 primary replay 仍 ✓', async () => {
    const dir = await buildDraft({ second: true })
    const good = { exitCode: 0, result: { ok: true, rows: [1, 2] } }
    const fixtures = [{ id: 'f1', commandId: 'get-article', expect: { equals: { ok: true } } }]
    const pass = await verifyRepair({ task: TASK, draftDir: dir, baseVersion: '1.0.0', fixtures, replayImpl: async () => good, log: () => {} })
    expect(pass.passed).toBe(true)
    expect(pass.checks.find((c) => c.name === 'smoke:get-list').passed).toBe(true)
    const bad = await verifyRepair({
      task: TASK, draftDir: dir, baseVersion: '1.0.0', fixtures,
      replayImpl: async ({ commandId }) => (commandId === 'get-list' ? { exitCode: 1, result: null } : good), log: () => {},
    })
    expect(bad.passed).toBe(false)
    expect(bad.checks.find((c) => c.name === 'replay:get-article').passed).toBe(true)
    expect(bad.checks.find((c) => c.name === 'smoke:get-list').passed).toBe(false)
  })
  it('fixture 断言失败:重放成功但 expect 不满足 → fixture check 失败且整体 passed=false', async () => {
    const dir = await buildDraft({})
    const good = { exitCode: 0, result: { ok: true } }
    const fixtures = [{ id: 'f1', commandId: 'get-article', expect: { equals: { ok: false } } }]
    const out = await verifyRepair({ task: TASK, draftDir: dir, baseVersion: '1.0.0', fixtures, replayImpl: async () => good, log: () => {} })
    expect(out.passed).toBe(false)
    expect(out.checks.find((c) => c.name === 'fixture:f1').passed).toBe(false)
  })
  it('包非法(缺 manifest):不抛错,转 static:package-invalid 失败 check', async () => {
    const dir = await buildDraft({})
    await rm(join(dir, 'manifest.json'))
    const out = await verifyRepair({ task: TASK, draftDir: dir, baseVersion: '1.0.0', log: () => {} })
    expect(out.passed).toBe(false)
    expect(out.checks.find((c) => c.name === 'static:package-invalid').passed).toBe(false)
  })
})
