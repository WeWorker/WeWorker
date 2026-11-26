import { createHash } from 'node:crypto'
import { buildDesktopAdapterCatalog, describeDesktopAdapters, readDesktopAdapterCatalogInputs } from '../../../webcli/adapter-desktop.js'
import type { DesktopAdapter, DesktopAdapterCatalog, DesktopAdapterPaths, DesktopAdapterState } from '../../../webcli/adapter-desktop.js'
import { compareAdapterVersions, installAdapter } from '../../../webcli/adapter-install-store.js'
import { validatePackageFiles } from '../../../webcli/adapter-package-files.js'
import { createAdapterUpdateSource, isAdapterId, isUpdateVersion, readAdapterUpdateArchive } from './adapter-update-source.js'
import type { DownloadProgress, Release } from './adapter-update-source.js'

const HUB_DOWNLOAD_LIMIT = 3
const HUB_QUEUE_LIMIT = 100
type HubJob = { phase: 'queued' | 'preparing' | 'downloading' | 'verifying' | 'extracting' | 'writing'; progress?: DownloadProgress; totalBytes?: number }
type HubResult = { name: string; version: string }

type Item = { currentVersion: string; latestVersion?: string; unavailableReason?: string; status: 'available' | 'current' | 'local-newer' | 'unlisted' | 'unsupported' }
type Status = 'idle' | 'checking' | 'ready' | 'error'
type Commit = { name: string; profile: string; previousRevision: number; revision: number; hubInstall?: boolean }

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
  let catalogVersions = new Map<string, { version: string; blockedReason?: string }>()
  let checking: Promise<void> | undefined
  let applying = false
  const hubJobs = new Map<string, HubJob>()
  const hubQueue: (() => Promise<void>)[] = []
  let activeHubJobs = 0
  let hubCommitChain = Promise.resolve()

  function drainHubQueue() {
    while (activeHubJobs < HUB_DOWNLOAD_LIMIT && hubQueue.length) {
      const run = hubQueue.shift()!
      activeHubJobs++
      void run().finally(() => {
        activeHubJobs--
        drainHubQueue()
      })
    }
  }

  function hubTransfers() {
    let position = 0
    return [...hubJobs].map(([name, job]) => ({ name, status: job.phase,
      receivedBytes: job.progress?.received ?? 0, totalBytes: job.progress?.total ?? job.totalBytes,
      elapsedMs: job.progress?.elapsedMs ?? 0, bytesPerSecond: job.progress?.bytesPerSecond ?? 0,
      ...(job.phase === 'queued' ? { queuePosition: ++position } : {}),
    }))
  }

  function inventory() {
    const inputs = readInputs()
    const catalog = getCatalog(inputs)
    const builtinIds = new Set(catalog.candidates.filter((entry) => entry.source === 'builtin').map((entry) => entry.name))
    const candidateIds = new Set(catalog.candidates.map(entry => entry.name))
    return { ...inputs, ...describeDesktopAdapters({ catalog }), builtinIds, candidateIds }
  }

  function classify(adapter: DesktopAdapter, state: DesktopAdapterState, builtinIds: Set<string>, remote?: Release): Item | undefined {
    const { version, source: kind, digest, enabled, canEnable } = adapter.managed
    if (!isUpdateVersion(version)) return undefined
    const unsupported: Item = { currentVersion: version, status: 'unsupported' }
    const installed = state.installations[adapter.id]
    // Never replace a separate installed copy just because the built-in is selected.
    if (!digest || (!enabled && !canEnable)) return unsupported
    if (kind === 'builtin' ? Boolean(installed) : kind !== 'user' || installed?.origin?.kind !== 'hub'
      || installed.origin.service !== source.service || installed.digest !== digest || installed.version !== version) return unsupported
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
        const item = classify(adapter, state, builtinIds, releases.get(adapter.id))
        if (!item) continue
        const latest = catalogVersions.get(adapter.id)
        if (!item.latestVersion && latest) {
          item.latestVersion = latest.version
          const cmp = compareAdapterVersions(latest.version, item.currentVersion)
          item.status = cmp > 0 ? 'unsupported' : cmp < 0 ? 'local-newer' : 'current'
          if (cmp > 0 && latest.blockedReason) item.unavailableReason = latest.blockedReason
        }
        items[adapter.id] = item
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
        try {
          releases = await source.index()
          catalogVersions = new Map()
        } catch {
          const catalog = await source.catalog()
          releases = new Map(catalog.flatMap(entry => entry.release ? [[entry.name, entry.release] as const] : []))
          catalogVersions = new Map(catalog.map(entry => [entry.name, { version: entry.version, blockedReason: entry.blockedReason }]))
        }
        checkedAt = new Date().toISOString()
        status = 'ready'
      } catch {
        status = 'error'
      }
    }).finally(() => { checking = undefined })
    return checking
  }

  async function downloadPackage(id: string, release: Release, job?: HubJob) {
    const bytes = job ? await source.download(id, release.version, progress => { job.progress = progress })
      : await source.download(id, release.version)
    if (job) job.phase = 'verifying'
    const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
    if (digest !== release.sha256) throw new AdapterUpdateError('下载包校验失败，请刷新后再试。')
    if (job) job.phase = 'extracting'
    const files = await readAdapterUpdateArchive(bytes)
    if (job) job.phase = 'verifying'
    const pkg = validatePackageFiles(files)
    if (pkg.name !== id || pkg.manifest.version !== release.version) {
      throw new AdapterUpdateError('下载包的名称或版本与索引不一致。')
    }
    return files
  }

  async function applyRelease(id: string, version: unknown, catalogRelease?: Release) {
    if (!isUpdateVersion(version)) throw new AdapterUpdateError('更新版本无效。')
    if (applying) throw new AdapterUpdateError('已有 Adapter 正在更新，请稍后重试。')
    if (!catalogRelease && status !== 'ready') throw new AdapterUpdateError('请先检测 Adapter 最新版本。')
    const before = inventory()
    const adapter = before.adapters.find((entry) => entry.id === id)
    const release = catalogRelease ?? releases.get(id)
    const item = adapter && classify(adapter, before.state, before.builtinIds, release)
    if (item?.status !== 'available' || release?.version !== version) {
      throw new AdapterUpdateError('该版本当前不可更新，请重新检测。')
    }
    applying = true
    try {
      const files = await downloadPackage(id, release)
      const after = inventory()
      const current = after.adapters.find((entry) => entry.id === id)
      const latest = catalogRelease ?? releases.get(id)
      if ((!catalogRelease && status !== 'ready') || latest?.sha256 !== release.sha256 || latest.version !== version
        || latest.official !== release.official || after.revision !== before.revision || !current
        || current.managed.digest !== adapter?.managed.digest || classify(current, after.state, after.builtinIds, latest)?.status !== 'available') {
        throw new AdapterUpdateError('Adapter 状态已变化，请重新检测后再试。')
      }
      const installed = installAdapter({ files, origin: { kind: 'hub', service: source.service }, preserveDisabled: true, allowPermissionChange: true, uploader: release.uploader,
        expectedStateRevision: before.revision, expectedSourceDigest: adapter?.managed.enabled ? adapter.managed.digest : null,
      }, { paths: before.paths })
      onInstalled({ name: id, profile: before.paths.profile, previousRevision: before.revision, revision: installed.revision })
      return snapshot()
    } finally {
      applying = false
    }
  }

  function hubItems(catalog: Awaited<ReturnType<typeof source.catalog>>, { adapters, state, builtinIds, candidateIds }: ReturnType<typeof inventory>) {
    const byId = new Map(adapters.map(adapter => [adapter.id, adapter]))
    return catalog.map(({ name, version, official, displayName, description, release, blockedReason }) => {
      const adapter = byId.get(name)
      const installed = Object.hasOwn(state.installations, name) ? state.installations[name] : undefined
      const installedVersion = adapter?.managed.version || installed?.version
      let action: 'install' | 'update' | null = null
      if (release) {
        if (adapter && classify(adapter, state, builtinIds, release)?.status === 'available') action = 'update'
        else if (!candidateIds.has(name) && !installed && !Object.hasOwn(state.selections, name)) action = 'install'
      }
      const localIsNewer = isUpdateVersion(installedVersion) && compareAdapterVersions(installedVersion, version) > 0
      const unavailableReason = action || installedVersion === version ? undefined
        : localIsNewer ? '本地版本更新，无需降级'
        : blockedReason ?? '现有 Adapter 的来源或状态不支持在线替换'
      return { name, version, official, displayName, description, installedVersion, action, unavailableReason, totalBytes: release?.size }
    })
  }

  async function listHub() {
    return hubItems(await source.catalog(), inventory())
  }

  async function listHubPage(page: number, q: string) {
    const result = await source.catalogPage(page, q)
    return { ...result, items: hubItems(result.items, inventory()) }
  }

  // Recheck only the target across the download; other queued installs can advance the global revision.
  function targetState(id: string, local: ReturnType<typeof inventory>) {
    return JSON.stringify([local.paths.profile, local.adapters.find(adapter => adapter.id === id)?.managed,
      local.state.installations[id], local.state.selections[id], local.builtinIds.has(id)])
  }

  async function runHubInstall(id: string, version: string, job: HubJob): Promise<HubResult> {
    job.phase = 'preparing'
    const entry = (await source.catalog()).find(item => item.name === id)
    const before = inventory()
    const item = hubItems(entry ? [entry] : [], before)[0]
    const release = entry?.release
    if (!entry || !item?.action || release?.version !== version) throw new AdapterUpdateError('此版本当前不可安装，请刷新 AdapterHub。')
    job.totalBytes = release.size
    job.phase = 'downloading'
    const files = await downloadPackage(id, release, job)
    const commit = async () => {
      job.phase = 'writing'
      // Let pending progress requests observe the phase before synchronous disk work.
      await new Promise<void>(resolve => setImmediate(resolve))
      const after = inventory()
      if (targetState(id, before) !== targetState(id, after) || hubItems([entry], after)[0].action !== item.action) {
        throw new AdapterUpdateError('Adapter 状态已变化，请刷新后再试。')
      }
      const selected = after.adapters.find(adapter => adapter.id === id)
      const installed = installAdapter({ files, origin: { kind: 'hub', service: source.service },
        uploader: release.uploader,
        preserveDisabled: item.action === 'update', allowPermissionChange: item.action === 'update',
         expectedStateRevision: after.revision,
        expectedSourceDigest: selected?.managed.enabled ? selected.managed.digest : null,
      }, { paths: after.paths })
      onInstalled({ name: id, profile: after.paths.profile, previousRevision: after.revision, revision: installed.revision, hubInstall: true })
      return { name: id, version }
    }
    const result = hubCommitChain.then(commit, commit)
    hubCommitChain = result.then(() => undefined, () => undefined)
    return result
  }

  async function installFromHub(id: string, version: unknown): Promise<HubResult> {
    if (!isAdapterId(id) || !isUpdateVersion(version)) throw new AdapterUpdateError('安装版本无效。')
    if (hubJobs.has(id)) throw new AdapterUpdateError('此 Adapter 已在下载队列中。')
    if (hubJobs.size >= HUB_QUEUE_LIMIT) throw new AdapterUpdateError('下载队列已满，请稍后再试。')
    const job: HubJob = { phase: 'queued' }
    hubJobs.set(id, job)
    return new Promise((resolve, reject) => {
      hubQueue.push(async () => {
        try { resolve(await runHubInstall(id, version, job)) }
        catch (error) { reject(error) }
        finally { hubJobs.delete(id) }
      })
      drainHubQueue()
    })
  }

  return { snapshot, startCheck, apply: (id: string, version: unknown) => applyRelease(id, version), listHub, listHubPage, detail: (id: string) => source.detail(id), installFromHub, hubTransfers }
}

export function adapterUpdateErrorMessage(error: unknown) {
  if (error instanceof AdapterUpdateError) return error.message
  switch ((error as { code?: string } | null)?.code) {
    case 'ADAPTER_DOMAIN_CONFLICT':
      return '站点匹配规则与已启用的 Adapter 冲突。请在「已安装 Adapter」中停用冲突项后重试。'
    case 'ADAPTER_PERMISSION_CHANGE':
      return '更新涉及新增权限，请在可信来源中审核该版本。'
    case 'ADAPTER_ORIGIN_CHANGED':
      return '已安装 Adapter 的来源与此版本不同，无法直接更新。'
    case 'ADAPTER_BASE_CHANGED':
    case 'ADAPTER_REVIEW_CHANGED':
      return '本地 Adapter 状态已变化，请刷新列表后重试。'
    default:
      return 'Adapter 安装或更新失败，请刷新后重试。'
  }
}
