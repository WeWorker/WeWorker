import { afterAll, describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { rmSync } from 'node:fs'
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
const FIXED_PY = "import json\nprint(json.dumps({'ok': True, 'title': 'ok'}))\n"
// extension-only 包:命令全为 extension runtime,应被 wewright 修复入口拒绝
const EXT_MANIFEST = {
  schema_version: 2, name: 'ext-only', version: '2.0.0',
  description: 'extension only fixture', match: ['demo.example.com'],
  commands: [{ id: 'list-items', runtime: 'extension', module: 'extension/commands/list-items.js',
    description: 'list items', schema: { type: 'object', properties: {} } }],
}
const EXT_CMD_JS = "export function run() { return { ok: true } }\n"

// fixture 在 beforeAll 共享,afterEach 会在首个用例后删掉后续用例的依赖;文件级一次性清理
const roots = []
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

let env, adapterRoot, home
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'repair-draft-home-'))
  roots.push(home)
  const extRoot = join(home, 'adapters', 'ext-only')
  adapterRoot = join(home, 'adapters', 'demo-fixture')
  await mkdir(join(adapterRoot, 'wewright', 'commands'), { recursive: true })
  await writeFile(join(adapterRoot, 'manifest.json'), JSON.stringify(MANIFEST, null, 2))
  await writeFile(join(adapterRoot, 'wewright', 'commands', 'get-article.py'), BROKEN_PY)
  await mkdir(join(extRoot, 'extension', 'commands'), { recursive: true })
  await writeFile(join(extRoot, 'manifest.json'), JSON.stringify(EXT_MANIFEST, null, 2))
  await writeFile(join(extRoot, 'extension', 'commands', 'list-items.js'), EXT_CMD_JS)
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
  it('adapterId 非法(路径穿越/空白)拼路径前拒绝', () => {
    expect(() => readWewrightTarget('demo/../evil', { env })).toThrow(/Invalid Adapter/)
    expect(() => readWewrightTarget('has space', { env })).toThrow(/Invalid Adapter/)
  })
  it('extension-only 包拒绝走 wewright 修复', () => {
    expect(() => readWewrightTarget('ext-only', { env })).toThrow(/请走既有/)
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
    const draft = writeRepairDraftWewright({
      adapterId: 'demo-fixture', expectedDigest: pkg.digest,
      patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY },
      // 草稿落临时目录,避免污染真实 ~/.webcli
      env, draftsRoot: join(home, 'drafts'), now: Date.parse('2026-11-23T00:00:00Z'),
    })
    expect(draft.version).toBe('1.0.1')
    expect(draft.digest).not.toBe(pkg.digest)
    const written = await readFile(join(draft.draftDir, 'wewright', 'commands', 'get-article.py'), 'utf8')
    expect(written).toContain("'ok': True")
    const manifest = JSON.parse(await readFile(join(draft.draftDir, 'manifest.json'), 'utf8'))
    expect(manifest.version).toBe('1.0.1')
  })
  it('同 now 两次写草稿自动错开秒,均成功且目录不同', () => {
    const { pkg } = readWewrightTarget('demo-fixture', { env })
    const NOW = Date.parse('2026-11-23T00:05:00Z')
    const first = writeRepairDraftWewright({
      adapterId: 'demo-fixture', expectedDigest: pkg.digest,
      patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY },
      env, draftsRoot: join(home, 'drafts'), now: NOW,
    })
    // live 安装未被改动,expectedDigest 第二轮仍有效
    const second = writeRepairDraftWewright({
      adapterId: 'demo-fixture', expectedDigest: pkg.digest,
      patchedFiles: { 'wewright/commands/get-article.py': BROKEN_PY },
      env, draftsRoot: join(home, 'drafts'), now: NOW,
    })
    expect(second.draftDir).not.toBe(first.draftDir)
    expect(second.draftDir.endsWith('demo-fixture')).toBe(true)
  })
  it('裸 hex expectedDigest 同样守护通过', () => {
    const { pkg } = readWewrightTarget('demo-fixture', { env })
    const draft = writeRepairDraftWewright({
      adapterId: 'demo-fixture', expectedDigest: pkg.digest.replace(/^sha256:/, ''),
      patchedFiles: { 'wewright/commands/get-article.py': FIXED_PY },
      env, draftsRoot: join(home, 'drafts'), now: Date.parse('2026-11-23T00:10:00Z'),
    })
    expect(draft.digest).toMatch(/^sha256:/)
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
