import yauzl from 'yauzl'
import profile from '../../../webcli/adapterhub-profile.json' with { type: 'json' }
import { assertPackagePath } from '../../../webcli/adapter-package-files.js'
import { adapterCatalogRoute } from '../../../webcli/adapterhub-client.js'

const MAX_INDEX_BYTES = 2 * 1024 * 1024
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
export const isUpdateVersion = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && SEMVER.test(value)
export const isAdapterId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes('..')

export interface Release {
  version: string
  sha256: string
  size?: number
  uploader?: string
  official: boolean
  displayName?: string
  description?: string
}

type CatalogEntry = Omit<Release, 'sha256'> & { name: string; release?: Release; blockedReason?: string }
const MAX_CATALOG_PAGES = 100
const SHA256 = /^sha256:[a-f0-9]{64}$/

function uploaderOf(official: boolean, publishedBy: unknown, author: unknown) {
  if (official) return '官方'
  return [publishedBy, author].find((value): value is string => typeof value === 'string' && !!value.trim())?.trim().slice(0, 100)
}

async function readJson(response: Response, label: string) {
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel()
    throw new Error(`Adapter Hub did not return ${label}.`)
  }
  return JSON.parse((await readBody(response, MAX_INDEX_BYTES)).toString('utf8'))
}

export type DownloadProgress = { received: number; total?: number; elapsedMs: number; bytesPerSecond: number }

async function readBody(response: Response, limit: number, progress?: (value: DownloadProgress) => void, started = performance.now()): Promise<Buffer> {
  const length = Number(response.headers.get('content-length'))
  const expected = !response.headers.get('content-encoding') && Number.isSafeInteger(length) && length > 0 ? length : undefined
  if (!response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error('Adapter response exceeded its size limit.')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let lastReport = -Infinity
  const report = (completed = false) => {
    const now = performance.now()
    const elapsedMs = now - started
    lastReport = now
    progress?.({ received: total, total: completed ? total : expected, elapsedMs, bytesPerSecond: total * 1000 / Math.max(elapsedMs, 1) })
  }
  try {
    if (progress) report()
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > limit) throw new Error('Adapter response exceeded its size limit.')
      chunks.push(chunk.value)
      if (progress && performance.now() - lastReport >= 200) report()
    }
    if (progress) report(true)
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks, total)
}

/** Both transports use the same build-configured Hub identity. */
export function createAdapterUpdateSource(endpoint = profile.endpoint, request = fetch) {
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Desktop AdapterHub requires an HTTP or HTTPS URL without credentials.')
  }
  const service = url.toString().replace(/\/+$/, '')
  const counterpart = new URL(service)
  counterpart.protocol = url.protocol === 'https:' ? 'http:' : 'https:'
  const other = counterpart.toString().replace(/\/+$/, '')
  const candidates = url.protocol === 'https:' ? [service, other] : [other, service]
  let activeService: string | undefined
  let cached: { service: string; etag: string; releases: Map<string, Release> } | undefined

  async function metadata<T>(read: (base: string, signal: AbortSignal) => Promise<T>, signal: AbortSignal) {
    for (const base of activeService ? [activeService] : candidates) {
      try {
        const attemptSignal = activeService ? signal : AbortSignal.any([signal, AbortSignal.timeout(3_000)])
        const result = await read(base, attemptSignal)
        if (activeService && activeService !== base) return read(activeService, signal)
        activeService = base
        return result
      } catch (error) {
        if (activeService || signal.aborted || base === candidates.at(-1)) throw error
      }
    }
    throw new Error('Adapter Hub is unavailable.')
  }

  async function catalogPage(page: number, q = '', pageSize = 24, signal = AbortSignal.timeout(10_000)) {
    return metadata(async (base, attemptSignal) => {
      const data = await readJson(await request(base + adapterCatalogRoute({ page, q, pageSize, sort: 'name' }), {
        redirect: 'error', signal: attemptSignal,
      }), 'a catalog')
      if (!Array.isArray(data?.items) || !Number.isSafeInteger(data.total) || data.total < 0
        || data.page !== page || !Number.isSafeInteger(data.pageSize) || data.pageSize < 1 || data.pageSize > 100
        || data.items.length > data.pageSize) throw new Error('Invalid Adapter catalog page.')
      const entries = new Map<string, CatalogEntry>()
      for (const item of data.items) {
        if (!isAdapterId(item?.name) || !isUpdateVersion(item.version) || entries.has(item.name)) continue
        const entry: CatalogEntry = {
          name: item.name, version: item.version, official: item.origin === 'official',
          displayName: typeof item.display === 'string' ? item.display.slice(0, 200) : undefined,
          description: typeof item.description === 'string' ? item.description.slice(0, 1000) : undefined,
        }
        const sha256 = item.artifact?.sha256
        if (item.installable !== true) entry.blockedReason = 'Hub 尚未发布安装包'
        else if (typeof sha256 !== 'string' || !SHA256.test(sha256)) entry.blockedReason = '安装包缺少有效的 SHA-256 摘要'
        else {
          const size = item.artifact?.size
          entry.release = { version: entry.version, official: entry.official && item.publisherRole === 'admin', sha256,
            uploader: uploaderOf(entry.official, item.publishedBy, item.author),
            size: Number.isSafeInteger(size) && size > 0 && size <= MAX_PACKAGE_BYTES ? size : undefined }
        }
        entries.set(entry.name, entry)
      }
      const hasMore = page * data.pageSize < data.total
      if (hasMore && data.items.length === 0) throw new Error('Incomplete Adapter catalog.')
      return { items: [...entries.values()], page, hasMore }
    }, signal)
  }
  return {
    service,
    catalogPage,
    async catalog(): Promise<CatalogEntry[]> {
      const entries = new Map<string, CatalogEntry>()
      const signal = AbortSignal.timeout(10_000)
      for (let page = 1; page <= MAX_CATALOG_PAGES; page++) {
        const result = await catalogPage(page, '', 100, signal)
        for (const entry of result.items) if (!entries.has(entry.name)) entries.set(entry.name, entry)
        if (!result.hasMore) return [...entries.values()]
      }
      throw new Error('Adapter catalog exceeded the page limit.')
    },
    async detail(name: string) {
      if (!isAdapterId(name)) throw new Error('Invalid Adapter identity.')
      return metadata(async (base, signal) => {
        const url = base + `/api/v1/adapters/${encodeURIComponent(name)}`
        const options = { redirect: 'error' as const, signal }
        const [detail, commands] = await Promise.all([
          request(url, options).then(response => readJson(response, 'adapter details')),
          request(`${url}/commands`, options).then(response => readJson(response, 'adapter commands')),
        ])
        if (detail?.name !== name || !Array.isArray(commands?.items)) throw new Error('Invalid Adapter details.')
        return { ...detail, uploader: uploaderOf(detail.origin === 'official', detail.publishedBy, detail.author), commands: commands.items }
      }, AbortSignal.timeout(10_000))
    },
    async index(): Promise<Map<string, Release>> {
      return metadata(async (base, signal) => {
      const previous = cached?.service === base ? cached : undefined
      const response = await request(base + '/api/v1/adapters/index?channel=desktop', {
        redirect: 'error', signal, headers: previous?.etag ? { 'If-None-Match': previous.etag } : undefined,
      })
      if (response.status === 304 && previous) return previous.releases
      if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel()
        throw new Error('Adapter Hub did not return a release index.')
      }
      const data = JSON.parse((await readBody(response, MAX_INDEX_BYTES)).toString('utf8'))
      if (data?.channel !== 'desktop' || !Array.isArray(data.items)) throw new Error('Invalid Adapter release index.')
      const releases = new Map<string, Release>()
      for (const item of data.items) {
        if (!isAdapterId(item?.name) || !isUpdateVersion(item.version) || typeof item.official !== 'boolean'
          || typeof item.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.sha256) || releases.has(item.name)) {
          throw new Error('Invalid Adapter release entry.')
        }
        releases.set(item.name, {
          version: item.version, sha256: item.sha256, official: item.official,
          uploader: uploaderOf(item.official || item.origin === 'official', item.publishedBy, item.author),
          ...(typeof item.displayName === 'string' ? { displayName: item.displayName } : {}),
          ...(typeof item.description === 'string' ? { description: item.description } : {}),
        })
      }
      cached = { service: base, etag: response.headers.get('etag') || '', releases }
      return releases
      }, AbortSignal.timeout(10_000))
    },
    async download(name: string, version: string, progress?: (value: DownloadProgress) => void): Promise<Buffer> {
      const started = performance.now()
      if (!activeService) throw new Error('Check the Hub release metadata before downloading.')
      if (!isAdapterId(name) || !isUpdateVersion(version)) throw new Error('Invalid Adapter release identity.')
      const response = await request(activeService + `/api/v1/adapters/${encodeURIComponent(name)}/download?version=${encodeURIComponent(version)}`, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('Adapter release download failed.')
      }
      return readBody(response, MAX_PACKAGE_BYTES, progress, started)
    },
  }
}

/** Bound the expanded ZIP data before the shared store validates the package. */
export function readAdapterUpdateArchive(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error || new Error('Invalid Adapter archive.'))
      const files = new Map<string, Buffer>()
      let expanded = 0
      const fail = (cause: unknown) => {
        zip.close()
        reject(cause)
      }
      if (!zip.entryCount || zip.entryCount > 1024) return fail(new Error('Invalid Adapter archive entry count.'))
      zip.on('error', fail)
      zip.on('end', () => resolve(files))
      zip.on('entry', (entry: yauzl.Entry) => {
        const directory = entry.fileName.endsWith('/')
        const name = directory ? entry.fileName.slice(0, -1) : entry.fileName
        try { assertPackagePath(name) } catch (cause) { return fail(cause) }
        const unixType = (entry.externalFileAttributes >>> 16) & 0o170000
        if (unixType && unixType !== (directory ? 0o040000 : 0o100000)) return fail(new Error('Invalid Adapter archive entry type.'))
        if (directory && entry.uncompressedSize === 0) return zip.readEntry()
        expanded += entry.uncompressedSize
        if (directory || expanded > MAX_PACKAGE_BYTES || files.size >= 512 || files.has(name)) {
          return fail(new Error('Invalid Adapter archive contents.'))
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError || new Error('Invalid Adapter archive entry.'))
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.on('error', fail)
          stream.on('end', () => {
            files.set(name, Buffer.concat(chunks))
            zip.readEntry()
          })
        })
      })
      zip.readEntry()
    })
  })
}
