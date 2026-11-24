import { createHash } from 'node:crypto'
import { buildDesktopAdapterCatalog, describeDesktopAdapters, readDesktopAdapterCatalogInputs } from '../../../webcli/adapter-desktop.js'
import type { DesktopAdapter, DesktopAdapterCatalog, DesktopAdapterPaths, DesktopAdapterState } from '../../../webcli/adapter-desktop.js'
import { compareAdapterVersions, installAdapter } from '../../../webcli/adapter-install-store.js'
import { validatePackageFiles } from '../../../webcli/adapter-package-files.js'
import { createAdapterUpdateSource, isUpdateVersion, readAdapterUpdateArchive } from './adapter-update-source.js'
import type { Release } from './adapter-update-source.js'

type Item = { currentVersion: string; latestVersion?: string; status: 'available' | 'current' | 'local-newer' | 'unlisted' | 'unsupported' }
type Status = 'idle' | 'checking' | 'ready' | 'error'
type Commit = { name: string; profile: string; previousRevision: number; revision: number }

class AdapterUpdateError extends Error {}

export function createAdapterUpdates({
  source = createAdapterUpdateSource(),
  readInputs = readDesktopAdapterCatalogInputs,
  getCatalog = (inputs): DesktopAdapterCatalog => buildDesktopAdapterCatalog(inputs),
  onInstalled = (_commit: Commit) => {},
}: {
  source?: ReturnType<typeof createAdapterUpdateSource>
  readInputs?: () => { paths: DesktopAdapterPaths; state: DesktopAdapterState }
  getCatalog?: (inputs: { paths: DesktopAdapterPaths; state: DesktopAdapterState }) => DesktopAdapterCatalog
  onInstalled?: (commit: Commit) => void
} = {}) {
  let status: Status = 'idle'
  let checkedAt: string | undefined
  let releases = new Map<string, Release>()
  let checking: Promise<void> | undefined
  let applying = false

  function inventory() {
    const inputs = readInputs()
    const catalog = getCatalog(inputs)
    const builtinIds = new Set(catalog.candidates.filter((entry) => entry.source === 'builtin').map((entry) => entry.name))
    return { ...inputs, ...describeDesktopAdapters({ catalog }), builtinIds }
  }

  function classify(adapter: DesktopAdapter, state: DesktopAdapterState, builtinIds: Set<string>): Item | undefined {
    const { version, source: kind, digest, enabled, canEnable } = adapter.managed
    if (!isUpdateVersion(version)) return undefined
    const unsupported: Item = { currentVersion: version, status: 'unsupported' }
    const installed = state.installations[adapter.id]
    // Never replace a separate installed copy just because the built-in is selected.
    if (!digest || (!enabled && !canEnable)) return unsupported
    if (kind === 'builtin' ? Boolean(installed) : kind !== 'user' || installed?.origin?.kind !== 'hub'
      || installed.origin.service !== source.service || installed.digest !== digest || installed.version !== version) return unsupported
    const remote = releases.get(adapter.id)
    if (!remote || (builtinIds.has(adapter.id) && !remote.official)) return { currentVersion: version, status: 'unlisted' }
    const cmp = compareAdapterVersions(remote.version, version)
    return { currentVersion: version, latestVersion: remote.version, status: cmp > 0 ? 'available' : cmp < 0 ? 'local-newer' : 'current' }
  }

  function snapshot() {
    const items: Record<string, Item> = Object.create(null)
    if (status !== 'ready') return { status, checkedAt, items, ...(status === 'error' ? { error: '无法获取 Adapter 最新版本，请稍后重试。' } : {}) }
    try {
      const { adapters, state, builtinIds } = inventory()
      for (const adapter of adapters) {
        const item = classify(adapter, state, builtinIds)
        if (item) items[adapter.id] = item
      }
      return { status, checkedAt, items }
    } catch {
      return { status: 'error' as const, checkedAt, items, error: '无法读取本地 Adapter 清单。' }
    }
  }

  function startCheck() {
    if (checking) return checking
    status = 'checking'
    checking = Promise.resolve().then(async () => {
      try {
        releases = await source.index()
        checkedAt = new Date().toISOString()
        status = 'ready'
      } catch {
        status = 'error'
      }
    }).finally(() => { checking = undefined })
    return checking
  }

  async function apply(id: string, version: unknown) {
    if (!isUpdateVersion(version)) throw new AdapterUpdateError('更新版本无效。')
    if (applying) throw new AdapterUpdateError('已有 Adapter 正在更新，请稍后重试。')
    if (status !== 'ready') throw new AdapterUpdateError('请先检测 Adapter 最新版本。')
    const before = inventory()
    const adapter = before.adapters.find((entry) => entry.id === id)
    const item = adapter && classify(adapter, before.state, before.builtinIds)
    const release = releases.get(id)
    if (item?.status !== 'available' || release?.version !== version) {
      throw new AdapterUpdateError('该版本当前不可更新，请重新检测。')
    }
    applying = true
    try {
      const bytes = await source.download(id, version)
      const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
      if (digest !== release.sha256) throw new AdapterUpdateError('更新包校验失败，请重新检测后再试。')
      const files = await readAdapterUpdateArchive(bytes)
      const pkg = validatePackageFiles(files)
      if (pkg.name !== id || pkg.manifest.version !== version) throw new AdapterUpdateError('更新包的名称或版本与检测结果不一致。')
      const after = inventory()
      const current = after.adapters.find((entry) => entry.id === id)
      if (status !== 'ready' || releases.get(id)?.sha256 !== release.sha256 || releases.get(id)?.version !== version
        || releases.get(id)?.official !== release.official || after.revision !== before.revision || !current
        || current.managed.digest !== adapter?.managed.digest || classify(current, after.state, after.builtinIds)?.status !== 'available') {
        throw new AdapterUpdateError('Adapter 状态已变化，请重新检测后再试。')
      }
      const installed = installAdapter({ files, origin: { kind: 'hub', service: source.service }, preserveDisabled: true,
        expectedStateRevision: before.revision, expectedSourceDigest: adapter?.managed.enabled ? adapter.managed.digest : null,
      }, { paths: before.paths })
      onInstalled({ name: id, profile: before.paths.profile, previousRevision: before.revision, revision: installed.revision })
      return snapshot()
    } finally {
      applying = false
    }
  }

  return { snapshot, startCheck, apply }
}

export function adapterUpdateErrorMessage(error: unknown) {
  if (error instanceof AdapterUpdateError) return error.message
  if ((error as { code?: string } | null)?.code === 'ADAPTER_PERMISSION_CHANGE') return '更新涉及新增权限，请在可信来源中审核该版本。'
  return 'Adapter 更新失败，请重新检测后再试。'
}
