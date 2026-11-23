import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWewrightTarget, writeRepairDraftWewright, patchVersion } from '../repair/wewright-draft.js'

const MANIFEST = {
  schema_version: 2, name: 'demo-fixture', version: '1.0.0',
  description: 'repair fixture', runtime_allowed_hosts: ['demo.example.com'],
  commands: [{ id: 'get-article', runtime: 'wewright', module: 'wewright/commands/get-article.py',
    description: 'get article', schema: { type: 'object', properties: { keyword: { type: 'string' } } } }],
}
const BROKEN_PY = "import json\nraise TypeError('title digit check missing')\n"

let env, adapterRoot
beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), 'repair-draft-home-'))
  adapterRoot = join(home, 'adapters', 'demo-fixture')
  await mkdir(join(adapterRoot, 'wewright', 'commands'), { recursive: true })
  await writeFile(join(adapterRoot, 'manifest.json'), JSON.stringify(MANIFEST, null, 2))
  await writeFile(join(adapterRoot, 'wewright', 'commands', 'get-article.py'), BROKEN_PY)
  // 同一目录双写,规避 host/cli 覆盖冲突检查
  env = { WEWORKER_USER_ADAPTERS_DIR: join(home, 'adapters'), WEBCLI_ADAPTERS_DIR: join(home, 'adapters'), HOME: home }
})

describe('readWewrightTarget', () => {
  it('读取已装包并校验 wewright runtime', () => {
    const { adapterId, pkg } = readWewrightTarget('demo-fixture', { env })
    expect(adapterId).toBe('demo-fixture')
    expect(pkg.digest).toMatch(/^sha256:/)
    expect(pkg.commands[0].runtime).toBe('wewright')
  })
  it('包不存在报错', async () => {
    expect(() => readWewrightTarget('nope', { env })).toThrow(/未找到已装 adapter/)
  })
})

describe('patchVersion', () => {
  it('patch+1;缺段补 0', () => {
    expect(patchVersion('1.0.0')).toBe('1.0.1')
    expect(patchVersion('1.0')).toBe('1.0.1')
  })
})

describe('writeRepairDraftWewright', () => {
  it('digest 守护 + 补丁叠加 + 版本 bump + 草稿落盘', async () => {
    const { pkg } = readWewrightTarget('demo-fixture', { env })
    const FIXED_PY = "import json\nprint(json.dumps({'ok': True, 'title': 'ok'}))\n"
    const draft = writeRepairDraftWewright({
      adapterId: 'demo-fixture', expectedDigest: pkg.digest,
      patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY },
      env, now: Date.parse('2026-11-23T00:00:00Z'),
    })
    expect(draft.version).toBe('1.0.1')
    expect(draft.digest).not.toBe(pkg.digest)
    const written = await readFile(join(draft.draftDir, 'wewright', 'commands', 'get-article.py'), 'utf8')
    expect(written).toContain("'ok': True")
    const manifest = JSON.parse(await readFile(join(draft.draftDir, 'manifest.json'), 'utf8'))
    expect(manifest.version).toBe('1.0.1')
  })
  it('基线变化拒绝(ADAPTER_BASE_CHANGED)与包外文件拒绝', async () => {
    expect(() => writeRepairDraftWewright({
      adapterId: 'demo-fixture', expectedDigest: 'sha256:stale', patchedFiles: { 'wewright/commands/get-article.py': 'x' }, env,
    })).toThrow(/ADAPTER_BASE_CHANGED/)
    const { pkg } = readWewrightTarget('demo-fixture', { env })
    expect(() => writeRepairDraftWewright({
      adapterId: 'demo-fixture', expectedDigest: pkg.digest, patchedFiles: { 'nope.py': 'x' }, env,
    })).toThrow(/补丁文件不在包内/)
  })
})
