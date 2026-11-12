import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { CatalogTool, ToolCatalog } from './tool-catalog.js'
import { getCatalog, isReadOnlyTool } from './tool-catalog.js'
import { normalizeRouteText } from './routes-layer.js'
import { createGuardedDispatch, resolveDispatchTimeoutMs, type RouteDispatchFn } from './route-dispatch.js'
import { runWebcliCall } from '../webcli-runner.js'
import type { RouterRenderColumn } from '../router-config/types.js'

/** Private, user-owned, versioned store. No package configuration or database migration. */
export const LOCAL_APPROVED_ROUTES_FILE = path.join(os.homedir(), '.weworker', 'local-approved-routes.v1.json')
const VERSION = 1
const MAX_FILE_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_PREVIEW_CHARS = 12_000
const SAFE_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const UNSAFE_KEY = /(?:raw|secret|token|cookie|password|authorization|credential|session|email|phone|mobile|address|identity|id_card|private|key|url|uri|path|file|html|content|body)/i
const MAX_COLUMNS = 8

export type LocalDisplay = { columns: RouterRenderColumn[]; maxRows: number }
export type LocalApprovedRoute = {
  id: string
  workspaceId: string
  question: string
  tool: string
  args: Record<string, unknown>
  contractHash: string
  display: LocalDisplay
  createdAt: string
}
type Store = { schemaVersion: 1; revision: number; routes: LocalApprovedRoute[]; checksum: string }
export type LocalRouteSnapshot = { revision: number; routes: readonly LocalApprovedRoute[]; status: 'ok' | 'invalid' }
export type LocalRouteInput = { workspaceId: string; question: string; tool: string; args: Record<string, unknown>; display: LocalDisplay }
export type LocalRoutePreview = { token: string; markdown: string; fields: readonly { key: string; type: RouterRenderColumn['type'] }[] }
export type LocalRouteContext = { catalog?: ToolCatalog; isReserved?: (question: string) => boolean }
export type LocalRoutePreviewOptions = LocalRouteContext & { workId: string; dispatch?: RouteDispatchFn; timeoutMs?: number }

export class LocalRouteError extends Error {
  constructor(public readonly reason: 'invalid' | 'stale' | 'unavailable' | 'unsafe' | 'conflict' | 'preview_required' | 'dispatch_failed') {
    super(`local approved route: ${reason}`)
  }
}

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function stable(value: unknown): string { return JSON.stringify(value) }
function validText(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value) }
function safeField(key: string): boolean { return SAFE_KEY.test(key) && !UNSAFE_KEY.test(key) }
function displayIsValid(value: unknown): value is LocalDisplay {
  if (!object(value) || !Number.isInteger(value.maxRows) || (value.maxRows as number) < 1 || (value.maxRows as number) > 30 || !Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > MAX_COLUMNS) return false
  const seen = new Set<string>()
  for (const column of value.columns) {
    if (!object(column) || Object.keys(column).some(key => !['key', 'type', 'title'].includes(key)) || typeof column.key !== 'string' || !safeField(column.key) || seen.has(column.key) || !['text', 'number', 'date', 'status'].includes(String(column.type)) || (column.title !== undefined && (!validText(column.title, 48) || UNSAFE_KEY.test(column.title) || /[\\`*_{}\[\]()#+.!|<>~]/.test(column.title)))) return false
    seen.add(column.key)
  }
  return true
}
function validateArgs(args: unknown, schema: unknown): boolean {
  if (!object(args) || !object(schema) || schema.type !== 'object' || !object(schema.properties) || schema.additionalProperties !== false || !Array.isArray(schema.required) || Object.keys(schema).some(key => !['type', 'properties', 'additionalProperties', 'required', 'description'].includes(key))) return false
  const required = schema.required
  const properties = schema.properties as Record<string, unknown>
  if (required.some(key => typeof key !== 'string' || !Object.hasOwn(properties, key) || !Object.hasOwn(args, key))) return false
  if (Object.entries(properties).some(([key, spec]) => !safeField(key) || !object(spec) || Object.keys(spec).some(field => !['type', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'description'].includes(field)) || !['string', 'integer', 'number', 'boolean'].includes(String(spec.type)))) return false
  for (const [key, value] of Object.entries(args)) {
    if (!safeField(key) || typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return false
    const spec = properties[key]
    if (!object(spec) || Object.keys(spec).some(field => !['type', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'description'].includes(field)) || !['string', 'integer', 'number', 'boolean'].includes(String(spec.type))) return false
    // Persist only declared string enums; arbitrary strings can encode identities, URLs or secrets.
    if (spec.type === 'string' && (typeof value !== 'string' || !Array.isArray(spec.enum) || !spec.enum.includes(value) || !/^[a-zA-Z0-9_-]{1,40}$/.test(value))) return false
    if (spec.type === 'integer' && (!Number.isSafeInteger(value) || typeof value !== 'number')) return false
    if (spec.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false
    if (spec.type === 'boolean' && typeof value !== 'boolean') return false
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) return false
    if (typeof value === 'number' && ((spec.minimum !== undefined && (typeof spec.minimum !== 'number' || !Number.isFinite(spec.minimum) || value < spec.minimum)) || (spec.maximum !== undefined && (typeof spec.maximum !== 'number' || !Number.isFinite(spec.maximum) || value > spec.maximum)))) return false
    if (spec.minimum !== undefined && (typeof spec.minimum !== 'number' || !Number.isFinite(spec.minimum)) || spec.maximum !== undefined && (typeof spec.maximum !== 'number' || !Number.isFinite(spec.maximum))) return false
    if (spec.minLength !== undefined && !Number.isSafeInteger(spec.minLength) || spec.maxLength !== undefined && !Number.isSafeInteger(spec.maxLength) || spec.pattern !== undefined && typeof spec.pattern !== 'string') return false
    if (typeof value === 'string' && ((spec.minLength !== undefined && (!Number.isSafeInteger(spec.minLength) || value.length < (spec.minLength as number))) || (spec.maxLength !== undefined && (!Number.isSafeInteger(spec.maxLength) || value.length > (spec.maxLength as number))) || (spec.pattern !== undefined && (typeof spec.pattern !== 'string' || !/^\^?[a-zA-Z0-9_\-]+\$?$/.test(spec.pattern))))) return false
    if (spec.default !== undefined || spec.format !== undefined || spec.$ref !== undefined || spec.oneOf !== undefined || spec.anyOf !== undefined) return false
  }
  return true
}
function currentTool(input: LocalRouteInput, catalog: ToolCatalog): CatalogTool | null {
  const tool = catalog.byName.get(input.tool)
  if (!tool || !catalog.adapterIds.has(tool.adapterId) || !tool.direct || !isReadOnlyTool(tool) || !validateArgs(input.args, tool.parameters)) return null
  return tool
}
function contract(tool: CatalogTool): string { return hash({ name: tool.name, adapterId: tool.adapterId, safety: tool.safety, direct: tool.direct, requiresConfirmation: tool.requiresConfirmation, parameters: tool.parameters, navigateBefore: tool.navigateBefore ?? null }) }
function validInput(input: LocalRouteInput): boolean {
  return validText(input.workspaceId, 256) && validText(input.question, 500) && !!normalizeRouteText(input.question) && validText(input.tool, 160) && object(input.args) && displayIsValid(input.display)
}
function validRecord(value: unknown): value is LocalApprovedRoute {
  if (!object(value)) return false
  return validInput(value as LocalRouteInput) && validText(value.id, 100) && /^[a-f0-9]{64}$/.test(String(value.contractHash)) && typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt))
}
function checksum(revision: number, routes: readonly LocalApprovedRoute[]): string { return hash({ schemaVersion: VERSION, revision, routes }) }

// Fail closed on ambiguous arrays and on unknown business-status conventions. Only an
// explicit success marker is evidence; a successful HTTP/CLI invocation is not enough.
function approvedRows(payload: unknown): Record<string, unknown>[] {
  if (!object(payload)) throw new LocalRouteError('unsafe')
  let record = payload
  let confirmed = false
  for (let depth = 0; depth < 3; depth++) {
    if ('error' in record && record.error != null && record.error !== false
      || record.ok === false || record.success === false
      || 'code' in record && record.code !== 200 && record.code !== '200'
      || 'status' in record && record.status !== 200 && record.status !== '200'
      || 'msg' in record && record.msg !== '' && record.msg !== 'success'
      || 'message' in record && record.message !== '' && record.message !== 'success') throw new LocalRouteError('unsafe')
    if (record.ok === true || record.success === true || record.code === 200 || record.code === '200'
      || record.status === 200 || record.status === '200') confirmed = true
    const arrays = Object.entries(record).filter(([, value]) => Array.isArray(value))
    const nested = ['result', 'data'].filter(key => object(record[key]))
    if (arrays.length + nested.length !== 1) throw new LocalRouteError('unsafe')
    if (nested.length) {
      record = record[nested[0]] as Record<string, unknown>
      continue
    }
    const [key, rows] = arrays[0]
    if (!confirmed || !['items', 'tickets', 'data'].includes(key) || !Array.isArray(rows) || rows.length < 1 || rows.length > 1000
      || !rows.every(object)) throw new LocalRouteError('unsafe')
    return rows as Record<string, unknown>[]
  }
  throw new LocalRouteError('unsafe')
}

const PRIVATE_VALUE = /(?:https?:\/\/|www\.|javascript:|data:|\b(?:token|password|cookie|secret|authorization|credential|session|api[_-]?key|email|phone|address|private)\b|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\b\d{3}[- .]?\d{3}[- .]?\d{4}\b|\b[a-f0-9]{24,}\b|\b[A-Za-z0-9_-]{32,}\b)/i
function safeCell(value: unknown, column: RouterRenderColumn): string {
  if (column.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new LocalRouteError('unsafe')
    return String(value)
  }
  if (typeof value !== 'string' || value.length > 80 || /[\u0000-\u001f\u007f<>]/.test(value) || PRIVATE_VALUE.test(value)) throw new LocalRouteError('unsafe')
  if (column.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new LocalRouteError('unsafe')
  // Render as plain escaped table text, never through a renderer that can reinterpret
  // status backticks, links, raw HTML or unescaped headings as Markdown.
  return value.replace(/[\\`*_{}\[\]()#+.!|~>-]/g, '\\$&')
}

/** Derive only conservatively safe scalar fields from a confirmed, unambiguous list. */
export function discoverLocalRouteFields(raw: string): readonly { key: string; type: RouterRenderColumn['type'] }[] {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new LocalRouteError('unsafe')
  let payload: unknown
  try { payload = JSON.parse(raw) } catch { throw new LocalRouteError('unsafe') }
  const rows = approvedRows(payload)
  const first = rows[0]
  const available: { key: string; type: RouterRenderColumn['type'] }[] = []
  for (const key of Object.keys(first)) {
    if (!safeField(key)) continue
    const values = rows.map(row => row[key])
    const type: RouterRenderColumn['type'] = values.every(value => typeof value === 'number') ? 'number' : 'text'
    const column = { key, type }
    try {
      if (values.some(value => value === undefined || value === null)) continue
      values.forEach(value => safeCell(value, column))
      available.push(column)
    } catch { /* A risky field is never offered for display. */ }
  }
  return available.slice(0, 8)
}

/** Shared projection and rendering for manual preview and future fast-route execution. */
export function renderLocalRouteResult(raw: string, display: LocalDisplay): string {
  if (!displayIsValid(display) || typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new LocalRouteError('unsafe')
  let payload: unknown
  try { payload = JSON.parse(raw) } catch { throw new LocalRouteError('unsafe') }
  const rows = approvedRows(payload)
  // Validate every row before showing even one; truncation must never hide unsafe data.
  const cells = rows.map(row => display.columns.map(column => {
    if (!Object.hasOwn(row, column.key)) throw new LocalRouteError('unsafe')
    return safeCell(row[column.key], column)
  }))
  const headers = display.columns.map(column => column.title ?? column.key)
  const line = (values: string[]) => `| ${values.join(' | ')} |`
  const markdown = [line(headers), line(headers.map(() => '---')),
    ...cells.slice(0, display.maxRows).map(line),
    ...(cells.length > display.maxRows ? ['', `仅显示前 ${display.maxRows} 条，共 ${cells.length} 条`] : [])].join('\n')
  if (markdown.length > MAX_PREVIEW_CHARS) throw new LocalRouteError('unsafe')
  return markdown
}
function parseStore(text: string): Store {
  let data: unknown
  try { data = JSON.parse(text) } catch { throw new LocalRouteError('invalid') }
  if (!object(data) || data.schemaVersion !== VERSION || !Number.isSafeInteger(data.revision) || (data.revision as number) < 0 || !Array.isArray(data.routes) || data.routes.length > 500 || !data.routes.every(validRecord)) throw new LocalRouteError('invalid')
  const routes = data.routes as LocalApprovedRoute[]
  const seen = new Set<string>(); const questions = new Set<string>()
  for (const route of routes) {
    const key = `${route.workspaceId}\u0000${normalizeRouteText(route.question)}`
    if (seen.has(route.id) || questions.has(key)) throw new LocalRouteError('invalid')
    seen.add(route.id); questions.add(key)
  }
  if (data.checksum !== checksum(data.revision as number, routes)) throw new LocalRouteError('invalid')
  return data as Store
}

/** Service instances hold only short-lived preview tickets; disk is reread for each new turn. */
export function createLocalApprovedRouteService(filePath = LOCAL_APPROVED_ROUTES_FILE) {
  const previews = new Map<string, { inputHash: string; contractHash: string; revision: number; workspaceId: string; expires: number }>()
  function readStore(): Store {
    try {
      const stat = fs.lstatSync(filePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES || stat.size <= 0) throw new LocalRouteError('invalid')
      return parseStore(fs.readFileSync(filePath, 'utf8'))
    } catch (error) {
      if (object(error) && error.code === 'ENOENT') {
        try {
          const directory = fs.lstatSync(path.dirname(filePath))
          if (!directory.isDirectory() || directory.isSymbolicLink()) throw new LocalRouteError('invalid')
        } catch (directoryError) {
          if (!object(directoryError) || directoryError.code !== 'ENOENT') throw new LocalRouteError('invalid')
        }
        return { schemaVersion: VERSION, revision: 0, routes: [], checksum: checksum(0, []) }
      }
      throw error instanceof LocalRouteError ? error : new LocalRouteError('invalid')
    }
  }
  function snapshot(): LocalRouteSnapshot {
    try { const store = readStore(); return { revision: store.revision, routes: structuredClone(store.routes), status: 'ok' } }
    catch { return { revision: -1, routes: [], status: 'invalid' } }
  }
  function list(workspaceId: string, context: LocalRouteContext = {}): { revision: number; status: 'ok' | 'invalid'; routes: readonly { route: LocalApprovedRoute; status: 'ready' | 'suspended'; reason: string }[] } {
    const state = snapshot()
    if (state.status === 'invalid' || !validText(workspaceId, 256)) return { revision: -1, status: 'invalid', routes: [] }
    return { revision: state.revision, status: 'ok', routes: state.routes.filter(route => route.workspaceId === workspaceId).map(route => {
      const outcome = lookup(route.question, workspaceId, context)
      return { route, status: outcome.reason === 'ready' ? 'ready' : 'suspended', reason: outcome.reason }
    }) }
  }
  function writeStore(previous: Store, routes: LocalApprovedRoute[]): void {
    const next: Store = { schemaVersion: VERSION, revision: previous.revision + 1, routes, checksum: checksum(previous.revision + 1, routes) }
    const content = `${JSON.stringify(next, null, 2)}\n`
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new LocalRouteError('invalid')
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
    try {
      fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 })
      // Recheck immediately before replace: invalid/corrupt files are NEVER overwritten.
      const current = readStore()
      if (current.revision !== previous.revision || current.checksum !== previous.checksum) throw new LocalRouteError('stale')
      fs.renameSync(temp, filePath)
      try { fs.chmodSync(filePath, 0o600) } catch { /* Windows ACL does not implement POSIX mode. */ }
    } finally { try { fs.unlinkSync(temp) } catch { /* already moved */ } }
  }
  function eligibility(input: LocalRouteInput, context: LocalRouteContext = {}): CatalogTool {
    if (!validInput(input)) throw new LocalRouteError('unsafe')
    const tool = currentTool(input, context.catalog ?? getCatalog())
    if (!tool) throw new LocalRouteError('unavailable')
    if (context.isReserved?.(input.question)) throw new LocalRouteError('conflict')
    return tool
  }
  function lookup(question: string, workspaceId: string, context: LocalRouteContext = {}): { route: LocalApprovedRoute | null; reason: string } {
    const state = snapshot()
    if (state.status !== 'ok') return { route: null, reason: 'invalid' }
    if (!validText(workspaceId, 256) || !validText(question, 500) || context.isReserved?.(question)) return { route: null, reason: 'conflict' }
    const match = state.routes.find(route => route.workspaceId === workspaceId && normalizeRouteText(route.question) === normalizeRouteText(question))
    if (!match) return { route: null, reason: 'missing' }
    const tool = currentTool(match, context.catalog ?? getCatalog())
    if (!tool || match.contractHash !== contract(tool) || !displayIsValid(match.display)) return { route: null, reason: 'suspended' }
    return { route: structuredClone(match), reason: 'ready' }
  }
  async function preview(input: LocalRouteInput, options: LocalRoutePreviewOptions): Promise<LocalRoutePreview> {
    const tool = eligibility(input, options)
    const state = snapshot()
    if (state.status !== 'ok') throw new LocalRouteError('invalid')
    if (!validText(options.workId, 256)) throw new LocalRouteError('unsafe')
    const dispatch: RouteDispatchFn = options.dispatch ?? ((name, argsJson, workId) => runWebcliCall(name, argsJson, workId, { timeoutMs: options.timeoutMs ?? resolveDispatchTimeoutMs() }))
    let raw: string
    try { raw = await createGuardedDispatch({ dispatch, workId: options.workId, timeoutMs: options.timeoutMs ?? resolveDispatchTimeoutMs() })(input.tool, JSON.stringify(input.args)) }
    catch { throw new LocalRouteError('dispatch_failed') }
    const markdown = renderLocalRouteResult(raw, input.display)
    const token = randomUUID()
    previews.set(token, { inputHash: hash(input), contractHash: contract(tool), revision: state.revision, workspaceId: input.workspaceId, expires: Date.now() + 5 * 60_000 })
    return { token, markdown, fields: input.display.columns.map(col => ({ key: col.key, type: col.type })) }
  }
  function approve(input: LocalRouteInput, token: string, expectedRevision: number, context: LocalRouteContext = {}): LocalApprovedRoute {
    const previous = readStore()
    if (previous.revision !== expectedRevision) throw new LocalRouteError('stale')
    const tool = eligibility(input, context)
    const ticket = previews.get(token)
    previews.delete(token)
    if (!ticket || ticket.expires < Date.now() || ticket.workspaceId !== input.workspaceId || ticket.inputHash !== hash(input) || ticket.contractHash !== contract(tool) || ticket.revision !== previous.revision) throw new LocalRouteError('preview_required')
    if (previous.routes.some(route => route.workspaceId === input.workspaceId && normalizeRouteText(route.question) === normalizeRouteText(input.question))) throw new LocalRouteError('conflict')
    const route: LocalApprovedRoute = { ...structuredClone(input), id: randomUUID(), contractHash: contract(tool), createdAt: new Date().toISOString() }
    writeStore(previous, [...previous.routes, route]); return route
  }
  /** Revalidate the persisted route and current tool immediately before each guarded dispatch. */
  async function execute(route: LocalApprovedRoute, options: LocalRoutePreviewOptions): Promise<string | null> {
    try {
      if (!validRecord(route) || !validText(options.workId, 256)) return null
      const current = lookup(route.question, route.workspaceId, options)
      // A caller-provided route must match the full persisted record; never dispatch forged args.
      if (!current.route || stable(current.route) !== stable(route)) return null
      const dispatch: RouteDispatchFn = options.dispatch ?? ((name, argsJson, workId) => runWebcliCall(name, argsJson, workId, { timeoutMs: options.timeoutMs ?? resolveDispatchTimeoutMs() }))
      const raw = await createGuardedDispatch({ dispatch, workId: options.workId, timeoutMs: options.timeoutMs ?? resolveDispatchTimeoutMs() })(current.route.tool, JSON.stringify(current.route.args))
      return renderLocalRouteResult(raw, current.route.display)
    } catch {
      // The caller's ordinary Agent path handles unavailable, auth, timeout, schema drift and unsafe output.
      return null
    }
  }
  function remove(id: string, workspaceId: string, expectedRevision: number): void {
    const previous = readStore()
    if (previous.revision !== expectedRevision) throw new LocalRouteError('stale')
    if (!validText(workspaceId, 256) || !previous.routes.some(route => route.id === id && route.workspaceId === workspaceId)) throw new LocalRouteError('unavailable')
    writeStore(previous, previous.routes.filter(route => !(route.id === id && route.workspaceId === workspaceId)))
  }
  return { snapshot, list, lookup, preview, approve, execute, remove }
}
