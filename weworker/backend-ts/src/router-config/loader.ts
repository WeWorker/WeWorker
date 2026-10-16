/**
 * 智能路由配置加载器（详见 docs/intelligent_routing_design.md §3、§4）。
 *
 * 职责：
 * - 按层读取配置文件，bundled（随包默认）＋ user（`~/.weworker/router/`）两层叠加；
 * - 逐层校验，坏配置只回退该层到上一份可用版本，绝不让整条路由链失效；
 * - 基于 mtime+size 签名做热重载：「改文件 → 下次取配置即生效」，无需重启进程。
 *
 * 设计约束：
 * - 零配置（文件为空/不存在）时返回空结构，引擎据此不命中任何路由，行为与今天一致；
 * - 本模块不做 Adapter 作用域过滤（见 validate.ts `applyRouterConfigScope`），由调用方带着
 *   当前 Adapter 集合调用，保证「配置项只对当前配置的 Adapter 生效」；
 * - 目录可注入，测试不得触碰真实 `$HOME`。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getConfigDirectory } from '../config.js'
import { createLogger, type Logger } from '../logger.js'
import { expandAdapterGroupedField, expandAdapterGroupedRecordField } from './adapter-grouped.js'
import { parseJsonc } from './jsonc.js'
import {
  ROUTER_CONFIG_SCHEMA_VERSION,
  ROUTER_LAYER_FILES,
  emptyRouterConfigBundle,
  type RouterConfigBundle,
  type RouterConfigManifest,
  type RouterConfigSource,
  type RouterLayerName,
} from './types.js'
import {
  validateAliasesFile,
  validateManifestFile,
  validatePatternsFile,
  validatePlanTerminalsFile,
  validatePlansFile,
  validateRenderersFile,
  validateRoutesFile,
  validateScenarioRoutesFile,
  validateShortcutsFile,
} from './validate.js'

const MANIFEST_FILE = 'manifest.json'

type LayerValidator = (raw: unknown) => string[]

const LAYER_VALIDATORS: Record<RouterLayerName, LayerValidator> = {
  routes: validateRoutesFile,
  aliases: validateAliasesFile,
  shortcuts: validateShortcutsFile,
  patterns: validatePatternsFile,
  plans: validatePlansFile,
  renderers: validateRenderersFile,
  planTerminals: validatePlanTerminalsFile,
  scenarioRoutes: validateScenarioRoutesFile,
}

/** 数组型层：按 id 逐条合并 */
const ID_MERGED_LAYERS: ReadonlySet<RouterLayerName> = new Set<RouterLayerName>([
  'routes',
  'aliases',
  'shortcuts',
  'plans',
  'scenarioRoutes',
])
/** 记录型层：按 key 逐项合并；用户侧值为 null 表示删除该项 */
const KEY_MERGED_LAYERS: ReadonlySet<RouterLayerName> = new Set<RouterLayerName>([
  'patterns',
  'renderers',
  'planTerminals',
])
/** 数组型层里承载条目的字段名 */
const ARRAY_FIELD: Partial<Record<RouterLayerName, string>> = {
  routes: 'routes',
  aliases: 'aliases',
  shortcuts: 'shortcuts',
  plans: 'plans',
  scenarioRoutes: 'routes',
}
/** 记录型层里承载条目的字段名 */
const RECORD_FIELD: Partial<Record<RouterLayerName, string>> = {
  patterns: 'configs',
  renderers: 'schemas',
  planTerminals: 'adapters',
}
/**
 * 记录型层里支持「按 Adapter 分节」书写的字段名。
 *
 * 只有 `patterns`：`renderers.schemas` 的 key 是跨工具复用的 schemaId（不归任何 adapter），
 * `planTerminals.adapters` 本来就已按 adapter 分节（再套一层只是把同一个信息写两遍）。
 */
const GROUPED_RECORD_FIELD: Partial<Record<RouterLayerName, string>> = {
  patterns: 'configs',
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

export type RouterConfigLoadOptions = {
  /** 随包默认配置目录；缺省按候选路径自动探测 */
  defaultsDir?: string
  /** 用户覆盖层目录；缺省 `<配置目录>/router` */
  userDir?: string
  log?: Logger
}

export type LoadedRouterConfig = {
  bundle: RouterConfigBundle
  /** 参与热重载判定的目录，便于日志与测试断言 */
  defaultsDir: string
  userDir: string
  /** 本次加载的 mtime 签名 */
  signature: string
}

/** 打包后 router-config 与 server.cjs 同目录；开发态在 weworker/router-config */
export function resolveDefaultsDir(): string {
  const envDir = process.env.WEWORKER_ROUTER_CONFIG_DIR
  if (envDir) return path.resolve(envDir)

  const candidates = [
    path.join(MODULE_DIR, 'router-config'),
    path.resolve(MODULE_DIR, '..', '..', '..', 'router-config'),
    path.join(process.cwd(), 'router-config'),
    path.resolve(process.cwd(), '..', 'router-config'),
    ...(process.env.WEWORKER_RESOURCES_PATH
      ? [path.join(process.env.WEWORKER_RESOURCES_PATH, 'backend-ts', 'router-config')]
      : []),
  ]
  for (const dir of candidates) {
    if (hasAnyConfigFile(dir)) return dir
  }
  return candidates[0]
}

export function resolveUserDir(): string {
  const envDir = process.env.WEWORKER_ROUTER_CONFIG_USER_DIR
  if (envDir) return path.resolve(envDir)
  return path.join(getConfigDirectory(), 'router')
}

function hasAnyConfigFile(dir: string): boolean {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false
    return fs.readdirSync(dir).some((name) => name.endsWith('.json'))
  } catch {
    return false
  }
}

function layerFilePath(dir: string, layer: RouterLayerName): string {
  return path.join(dir, `${ROUTER_LAYER_FILES[layer]}.json`)
}

/**
 * 读一个配置文件。三种结局必须分开，不能都塌成 `null`：
 * 「文件不存在」是正常的（层本来就可选），而「文件在、却读不懂」会让这一层**静默变空**——
 * 必须把原因带出去写进 `sources[].rejected`。否则「层是空的」和「层里的条目都没匹配上」
 * 在用户侧长得一模一样，排查时什么都查不到（真发生过：改动前的引擎用裸 `JSON.parse` 读
 * 带注释的新配置，8 个层全空、一个 rejected 都没有，表现就是「路由突然不生效了」）。
 */
type JsonReadOutcome = { kind: 'ok'; raw: unknown } | { kind: 'missing' } | { kind: 'error'; detail: string }

function readJsonFile(filePath: string, log: Logger): JsonReadOutcome {
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' }
    log.warn(`router-config read failed: ${filePath}`, error)
    return { kind: 'error', detail: `读取失败：${(error as Error)?.message ?? String(error)}` }
  }
  try {
    // JSONC：允许 `//` / `/* */` 注释与尾逗号，便于在配置里就地写说明与成功示例。
    return { kind: 'ok', raw: parseJsonc(text) }
  } catch (error) {
    log.warn(`router-config parse failed: ${filePath}`, error)
    return { kind: 'error', detail: `解析失败：${(error as Error)?.message ?? String(error)}` }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 数组型层：同 id 覆盖，新 id 追加，其余保持默认顺序 */
function mergeEntriesById(base: unknown, overlay: unknown, field: string): { merged: unknown; overriddenIds: string[] } {
  const baseList = isPlainObject(base) && Array.isArray(base[field]) ? (base[field] as unknown[]) : []
  const overlayList = isPlainObject(overlay) && Array.isArray(overlay[field]) ? (overlay[field] as unknown[]) : []
  const overriddenIds: string[] = []
  if (overlayList.length === 0) return { merged: base, overriddenIds }

  const merged = [...baseList]
  const indexById = new Map<string, number>()
  merged.forEach((item, index) => {
    if (isPlainObject(item) && typeof item.id === 'string') indexById.set(item.id, index)
  })

  for (const item of overlayList) {
    if (!isPlainObject(item) || typeof item.id !== 'string') {
      // 校验层已给出具体错误；这里保守丢弃，绝不引入无法索引的匿名条目
      continue
    }
    const existing = indexById.get(item.id)
    if (existing === undefined) {
      indexById.set(item.id, merged.length)
      merged.push(item)
    } else {
      merged[existing] = item
    }
    overriddenIds.push(item.id)
  }

  const baseObject = isPlainObject(base) ? base : {}
  return { merged: { ...baseObject, [field]: merged }, overriddenIds }
}

/** 记录型层：同 key 覆盖，值为 null 时删除该 key；整个字段为 null 表示清空该层 */
function mergeEntriesByKey(base: unknown, overlay: unknown, field: string): { merged: unknown; overriddenIds: string[] } {
  const baseObject = isPlainObject(base) ? base : {}
  const baseRecord = isPlainObject(baseObject[field]) ? (baseObject[field] as Record<string, unknown>) : {}
  const overriddenIds: string[] = []

  if (isPlainObject(overlay) && field in overlay && overlay[field] === null) {
    return { merged: { ...baseObject, [field]: {} }, overriddenIds: Object.keys(baseRecord) }
  }

  const overlayRecord = isPlainObject(overlay) && isPlainObject(overlay[field]) ? (overlay[field] as Record<string, unknown>) : {}
  const merged: Record<string, unknown> = { ...baseRecord }

  for (const [key, value] of Object.entries(overlayRecord)) {
    if (value === null) {
      delete merged[key]
    } else {
      merged[key] = value
    }
    overriddenIds.push(key)
  }

  return { merged: { ...baseObject, [field]: merged }, overriddenIds }
}

type LayerLoadResult = {
  raw: unknown
  origin: RouterConfigSource['origin']
  filePath?: string
  overriddenIds?: string[]
  rejected?: string
}

function loadLayer(
  layer: RouterLayerName,
  defaultsDir: string,
  userDir: string,
  previous: unknown,
  log: Logger,
): LayerLoadResult {
  const validator = LAYER_VALIDATORS[layer]
  const bundledPath = layerFilePath(defaultsDir, layer)
  const bundledRead = readJsonFile(bundledPath, log)

  let baseRaw: unknown = emptyLayerShape(layer)
  let filePath: string | undefined
  let origin: RouterConfigSource['origin'] = 'default'
  let rejected: string | undefined

  if (bundledRead.kind === 'error') {
    // 读不懂 = 这一层整层不可用。与「校验不过」同权处理（回退上一份可用配置 + 记 rejected），
    // 绝不只打一行 WARN 就让它悄悄变空。
    rejected = `${ROUTER_LAYER_FILES[layer]}.json: ${bundledRead.detail}`
  } else if (bundledRead.kind === 'ok') {
    const normalized = normalizeLayer(layer, bundledRead.raw)
    const errors = [...normalized.errors, ...validator(normalized.raw)]
    if (errors.length > 0) {
      rejected = `${ROUTER_LAYER_FILES[layer]}.json: ${errors.join('; ')}`
      log.warn(`router-config bundled layer rejected: ${layer}`, errors)
    } else {
      baseRaw = normalized.raw
      filePath = bundledPath
      origin = 'bundled'
    }
  }

  const userPath = layerFilePath(userDir, layer)
  const userRead = readJsonFile(userPath, log)
  if (userRead.kind !== 'ok') {
    if (userRead.kind === 'error') {
      const detail = `${ROUTER_LAYER_FILES[layer]}.json (user): ${userRead.detail}`
      rejected = rejected ? `${rejected}; ${detail}` : detail
    }
    if (rejected && previous !== undefined) {
      return { raw: previous, origin: 'default', rejected: `${rejected} (kept previous ${layer})` }
    }
    return { raw: baseRaw, origin, filePath, rejected }
  }

  // 先合并再校验：记录型层的 null 是删除标记，必须先被合并消费掉才轮到校验
  const userNormalized = normalizeLayer(layer, userRead.raw)
  const merged = mergeLayerRaw(layer, baseRaw, userNormalized.raw)
  const mergedErrors = [...userNormalized.errors, ...validator(merged.raw)]

  if (mergedErrors.length > 0) {
    if (previous !== undefined) {
      log.warn(`router-config user layer rejected, keeping previous: ${layer}`, mergedErrors)
      return {
        raw: previous,
        origin: 'user',
        filePath: userPath,
        rejected: `${ROUTER_LAYER_FILES[layer]}.json (user): ${mergedErrors.join('; ')} (kept previous)`,
      }
    }
    log.warn(`router-config user layer rejected, falling back to bundled: ${layer}`, mergedErrors)
    return {
      raw: baseRaw,
      origin,
      filePath: filePath ?? userPath,
      rejected: `${ROUTER_LAYER_FILES[layer]}.json (user): ${mergedErrors.join('; ')} (fell back to bundled)`,
    }
  }

  return {
    raw: merged.raw,
    origin: 'user',
    filePath: userPath,
    overriddenIds: merged.overriddenIds,
    rejected,
  }
}

/**
 * 各层支持「按 Adapter 分节」书写（数组型 `{ "<adapterId>": [ 条目… ] }`、记录型
 * `{ "<adapterId>": { "<工具名>": 配置 } }`）；此处统一展开为扁平结构。旧形态原样通过，
 * 因此外部注入配置与历史覆盖层不受影响。
 *
 * 分节归属错误与 schema 错误同权：都走「坏配置只回退该层」的通道，绝不让一条手误
 * 让整条路由链失效。
 */
function normalizeLayer(layer: RouterLayerName, raw: unknown): { raw: unknown; errors: string[] } {
  const arrayField = ARRAY_FIELD[layer]
  if (arrayField) {
    const expansion = expandAdapterGroupedField(raw, arrayField)
    return { raw: expansion.raw, errors: expansion.errors }
  }
  const recordField = GROUPED_RECORD_FIELD[layer]
  if (recordField) {
    const expansion = expandAdapterGroupedRecordField(raw, recordField)
    return { raw: expansion.raw, errors: expansion.errors }
  }
  return { raw, errors: [] }
}

function mergeLayerRaw(
  layer: RouterLayerName,
  baseRaw: unknown,
  overlayRaw: unknown,
): { raw: unknown; overriddenIds: string[] } {
  if (ID_MERGED_LAYERS.has(layer) && ARRAY_FIELD[layer]) {
    const { merged, overriddenIds } = mergeEntriesById(baseRaw, overlayRaw, ARRAY_FIELD[layer]!)
    return { raw: merged, overriddenIds }
  }
  if (KEY_MERGED_LAYERS.has(layer) && RECORD_FIELD[layer]) {
    const { merged, overriddenIds } = mergeEntriesByKey(baseRaw, overlayRaw, RECORD_FIELD[layer]!)
    return { raw: merged, overriddenIds }
  }
  return { raw: overlayRaw, overriddenIds: [] }
}

function emptyLayerShape(layer: RouterLayerName): unknown {
  const field = ARRAY_FIELD[layer] ?? RECORD_FIELD[layer]
  if (!field) return {}
  return ARRAY_FIELD[layer] ? { [field]: [] } : { [field]: {} }
}

function layerSignatureDir(dir: string): string {
  const parts: string[] = []
  for (const name of [MANIFEST_FILE, ...Object.values(ROUTER_LAYER_FILES).map((file) => `${file}.json`)]) {
    const filePath = path.join(dir, name)
    try {
      const stat = fs.statSync(filePath)
      // mtime + size：同秒内的改写也能被 size 变化捕捉到
      parts.push(`${name}:${stat.mtimeMs}:${stat.size}`)
    } catch {
      parts.push(`${name}:-`)
    }
  }
  return parts.join(',')
}

type CacheState = {
  signature: string
  bundle: RouterConfigBundle
  /** 上一份通过校验的层内容，用于坏配置回退 */
  lastGoodLayers: Partial<Record<RouterLayerName, unknown>>
  /** 上一份通过校验的 manifest */
  lastGoodManifest?: RouterConfigManifest
  defaultsDir: string
  userDir: string
}

let cache: CacheState | null = null

export function loadRouterConfig(options: RouterConfigLoadOptions = {}): LoadedRouterConfig {
  const log = options.log ?? createLogger('router-config')
  const defaultsDir = options.defaultsDir ?? resolveDefaultsDir()
  const userDir = options.userDir ?? resolveUserDir()
  const signature = `${defaultsDir}|${layerSignatureDir(defaultsDir)}||${userDir}|${layerSignatureDir(userDir)}`

  if (cache && cache.signature === signature && cache.defaultsDir === defaultsDir && cache.userDir === userDir) {
    return { bundle: cache.bundle, defaultsDir, userDir, signature }
  }

  // 只有同一组目录才允许沿用上一份可用配置；换目录（例如切 Profile Overlay）必须从头加载
  const sameDirs = cache?.defaultsDir === defaultsDir && cache?.userDir === userDir
  const previousLayers = sameDirs ? cache?.lastGoodLayers ?? {} : {}
  const sources: RouterConfigSource[] = []

  const manifestResult = loadManifest(defaultsDir, userDir, sameDirs ? cache?.lastGoodManifest : undefined, log)
  sources.push(manifestResult.source)

  const layerEntries: Array<[RouterLayerName, unknown]> = []
  for (const layer of Object.keys(ROUTER_LAYER_FILES) as RouterLayerName[]) {
    // 逐层开关：manifest 里显式写 false 的层直接返回空结构（不读文件、不校验）
    if (manifestResult.manifest.layers?.[layer] === false) {
      sources.push({ layer, origin: 'default', rejected: `disabled by manifest.layers.${layer}` })
      layerEntries.push([layer, emptyLayerShape(layer)])
      continue
    }
    const loaded = loadLayer(layer, defaultsDir, userDir, previousLayers[layer], log)
    sources.push({
      layer,
      origin: loaded.origin,
      filePath: loaded.filePath,
      overriddenIds: loaded.overriddenIds,
      rejected: loaded.rejected,
    })
    layerEntries.push([layer, loaded.raw])
  }

  const byLayer = new Map(layerEntries)
  const bundle: RouterConfigBundle = {
    ...emptyRouterConfigBundle(),
    schemaVersion: manifestResult.manifest.schemaVersion ?? ROUTER_CONFIG_SCHEMA_VERSION,
    manifest: manifestResult.manifest,
    routes: byLayer.get('routes') as RouterConfigBundle['routes'],
    aliases: byLayer.get('aliases') as RouterConfigBundle['aliases'],
    shortcuts: byLayer.get('shortcuts') as RouterConfigBundle['shortcuts'],
    patterns: byLayer.get('patterns') as RouterConfigBundle['patterns'],
    plans: byLayer.get('plans') as RouterConfigBundle['plans'],
    renderers: byLayer.get('renderers') as RouterConfigBundle['renderers'],
    planTerminals: byLayer.get('planTerminals') as RouterConfigBundle['planTerminals'],
    scenarioRoutes: byLayer.get('scenarioRoutes') as RouterConfigBundle['scenarioRoutes'],
    sources,
  }

  const lastGoodLayers: Partial<Record<RouterLayerName, unknown>> = {}
  for (const [layer, raw] of layerEntries) lastGoodLayers[layer] = raw

  cache = { signature, bundle, lastGoodLayers, lastGoodManifest: manifestResult.manifest, defaultsDir, userDir }
  return { bundle, defaultsDir, userDir, signature }
}

function loadManifest(
  defaultsDir: string,
  userDir: string,
  previous: RouterConfigManifest | undefined,
  log: Logger,
): { manifest: RouterConfigManifest; source: RouterConfigSource } {
  let manifest: RouterConfigManifest = previous ?? {}
  let origin: RouterConfigSource['origin'] = previous ? 'user' : 'default'
  let filePath: string | undefined
  let rejected: string | undefined

  const bundledPath = path.join(defaultsDir, MANIFEST_FILE)
  const bundledRead = readJsonFile(bundledPath, log)
  if (bundledRead.kind === 'error') {
    rejected = `${MANIFEST_FILE}: ${bundledRead.detail}`
    log.warn('router-config manifest unreadable, keeping previous')
  } else if (bundledRead.kind === 'ok') {
    const errors = validateManifestFile(bundledRead.raw)
    if (errors.length > 0) {
      rejected = `${MANIFEST_FILE}: ${errors.join('; ')}`
      log.warn('router-config manifest rejected', errors)
    } else {
      manifest = bundledRead.raw as RouterConfigManifest
      origin = 'bundled'
      filePath = bundledPath
    }
  }

  const userPath = path.join(userDir, MANIFEST_FILE)
  const userRead = readJsonFile(userPath, log)
  if (userRead.kind === 'error') {
    rejected = `${rejected ? `${rejected}; ` : ''}${MANIFEST_FILE} (user): ${userRead.detail}`
  } else if (userRead.kind === 'ok') {
    const errors = validateManifestFile(userRead.raw)
    if (errors.length > 0) {
      rejected = `${rejected ? `${rejected}; ` : ''}${MANIFEST_FILE} (user): ${errors.join('; ')}`
      log.warn('router-config user manifest rejected', errors)
    } else {
      // 用户层只覆盖显式给出的开关，未给出的沿用随包默认
      const userManifest = userRead.raw as RouterConfigManifest
      manifest = {
        ...manifest,
        ...userManifest,
        layers: { ...manifest.layers, ...userManifest.layers },
      }
      origin = 'user'
      filePath = userPath
    }
  }

  return { manifest, source: { layer: 'manifest', origin, filePath, rejected } }
}

/** 测试用：清空模块级缓存，避免用例间互相污染 */
export function resetRouterConfigCacheForTests(): void {
  cache = null
}
