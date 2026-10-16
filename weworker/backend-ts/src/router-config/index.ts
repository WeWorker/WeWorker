/**
 * 智能路由配置模块对外出口。
 *
 * 消费方（路由引擎各层）只从这里取配置，不直接读文件，便于：
 * - 统一热重载语义（改文件 → 下次取配置即生效）；
 * - 统一作用域语义（配置项只对当前存在的 Adapter 生效）；
 * - 单测注入自定义目录，不触碰真实 `$HOME`。
 *
 * P0 阶段本模块只提供加载/校验/过滤能力，尚不接入路由链，零配置时行为与今天完全一致。
 */

export {
  ROUTER_CONFIG_SCHEMA_VERSION,
  ROUTER_LAYER_FILES,
  emptyRouterConfigBundle,
  type AliasEntry,
  type AliasesFile,
  type ArgExtractorRule,
  type CompiledScenarioArgSpec,
  type CompiledScenarioRoute,
  type PatternConfigEntry,
  type PatternRule,
  type PlanEntry,
  type PlanExtractRule,
  type PlanResolver,
  type PlanTerminal,
  type PlanTerminalsFile,
  type PlanTerminalWhitelistEntry,
  type PlansFile,
  type RenderersFile,
  type RouteEntry,
  type RouterConfigBundle,
  type RouterConfigManifest,
  type RouterConfigSource,
  type RouterConfigSourceLayer,
  type RouterLayerName,
  type RouterPatternSpec,
  type RouterRenderColumn,
  type RouterRenderSchema,
  type RouterRenderSpec,
  type RoutesFile,
  type ScenarioRoutesFile,
  type ShortcutEntry,
  type ShortcutExtractRule,
  type ShortcutsFile,
} from './types.js'

export {
  loadRouterConfig,
  resetRouterConfigCacheForTests,
  resolveDefaultsDir,
  resolveUserDir,
  type LoadedRouterConfig,
  type RouterConfigLoadOptions,
} from './loader.js'

export {
  applyRouterConfigScope,
  isToolInAdapterScope,
  validateAliasesFile,
  validateManifestFile,
  validatePatternsFile,
  validatePlanTerminalsFile,
  validatePlansFile,
  validateRenderersFile,
  validateRoutesFile,
  validateScenarioRoutesFile,
  validateShortcutsFile,
  type RouterConfigScopeResult,
  type ScopeAppliedBundle,
} from './validate.js'

import type { RouterConfigBundle } from './types.js'
import { loadRouterConfig, type RouterConfigLoadOptions } from './loader.js'
import { applyRouterConfigScope } from './validate.js'

export {
  computeRoutableSites,
  type RoutableSiteReport,
} from './routable.js'

import { computeRoutableSites, type RoutableSiteReport } from './routable.js'

const EMPTY_ROUTABLE_REPORT: RoutableSiteReport = { routable: new Set(), entryCount: new Map() }

/**
 * 「哪些站点当前真的被路由配置覆盖」——加载 + 作用域过滤 + 归属计算一次做完。
 *
 * 调用方（`GET /sites`）不需要知道加载细节；配置坏掉、文件缺失、目录不可读一律退化为
 * 「全部不可直达」，因为这是只读列表接口，宁可徽标不亮，也不能因为一份坏配置 500。
 */
export function computeRoutableSitesFromConfig(
  adapterIds: ReadonlySet<string>,
  options: RouterConfigLoadOptions = {},
): RoutableSiteReport {
  if (!adapterIds || adapterIds.size === 0) return EMPTY_ROUTABLE_REPORT
  try {
    return computeRoutableSites(getScopedRouterConfig(adapterIds, options).bundle, adapterIds)
  } catch {
    return EMPTY_ROUTABLE_REPORT
  }
}

/** 取当前生效的配置束（含热重载） */
export function getRouterConfig(options: RouterConfigLoadOptions = {}): RouterConfigBundle {
  return loadRouterConfig(options).bundle
}

export type ScopedRouterConfig = {
  bundle: RouterConfigBundle
  /** 因 Adapter 不在当前集合内被丢弃的条目描述，供日志排查「配置写了为什么不生效」 */
  dropped: string[]
}

/**
 * 取当前生效且限定在给定 Adapter 集合内的配置束。
 *
 * `adapterIds` 必须是当前构建/Profile 里真实存在的 Adapter id 集合；未在集合内的条目一律丢弃，
 * 避免一份通用配置在缺 Adapter 的环境里被误当作可用路由。
 */
export function getScopedRouterConfig(
  adapterIds: ReadonlySet<string>,
  options: RouterConfigLoadOptions = {},
): ScopedRouterConfig {
  const bundle = getRouterConfig(options)
  const scoped = applyRouterConfigScope(bundle, adapterIds)
  return { bundle: { ...bundle, ...scoped.bundle }, dropped: scoped.dropped }
}
