import yauzl from 'yauzl'
import profile from '../../../webcli/adapterhub-profile.json' with { type: 'json' }
import { assertPackagePath } from '../../../webcli/adapter-package-files.js'

const MAX_INDEX_BYTES = 2 * 1024 * 1024
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
export const isUpdateVersion = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && SEMVER.test(value)
const isAdapterId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes('..')

export interface Release {
  version: string
  sha256: string
  official: boolean
}

async function readBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error('Adapter response exceeded its size limit.')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > limit) throw new Error('Adapter response exceeded its size limit.')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks, total)
}

/** Desktop trusts the build profile's HTTPS Hub and its authenticated release metadata. */
export function createAdapterUpdateSource(endpoint = profile.endpoint, request = fetch) {
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Desktop Adapter updates require an HTTPS Hub without credentials.')
  }
  const service = url.toString().replace(/\/+$/, '')
  let cached: { etag: string; releases: Map<string, Release> } | undefined
  const get = (route: string, timeout: number, headers?: HeadersInit) => request(service + route, {
    redirect: 'error', signal: AbortSignal.timeout(timeout), headers,
  })
  return {
    service,
    async index(): Promise<Map<string, Release>> {
      const response = await get('/api/v1/adapters/index?channel=desktop', 10_000,
        cached?.etag ? { 'If-None-Match': cached.etag } : undefined)
      if (response.status === 304 && cached) return cached.releases
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
        releases.set(item.name, { version: item.version, sha256: item.sha256, official: item.official })
      }
      cached = { etag: response.headers.get('etag') || '', releases }
      return releases
    },
    async download(name: string, version: string): Promise<Buffer> {
      if (!isAdapterId(name) || !isUpdateVersion(version)) throw new Error('Invalid Adapter release identity.')
      const response = await get(`/api/v1/adapters/${encodeURIComponent(name)}/download?version=${encodeURIComponent(version)}`, 60_000)
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('Adapter release download failed.')
      }
      return readBody(response, MAX_PACKAGE_BYTES)
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
