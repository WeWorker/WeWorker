/**
 * 探索工具注册表（第 4 层执行器）。
 *
 * 为什么要一张表：第 4 层现在只有一个执行器（网站探索agent），但它被硬编码在
 * `server.ts` 的一段 if 里。第二个探索工具（API 探索、移动端探索……）接入时只能再插一段
 * if，谁先谁后由代码行序决定，于是必然出现「后接入的工具把前一个的话术吃掉」——这正是本次
 * 要防的回归。把执行器收进表里之后，新增探索工具＝加一条数据 + 实现一个 `dispatch.kind`，
 * 级联代码不再改动。
 *
 * **互斥是硬约束，且有自动闸**：任意两个 provider 的 `examples` 不得被对方的触发式命中。
 * 两个 provider 若认同一句话，谁先命中就由 `priority` 决定，而用户看到的会是「明明是 A 的
 * 指令，结果走了 B」。`validateExplorationProviders()` 在加载/测试期就把这种重叠判红。
 *
 * 触发契约本身（`siteTokens` / `queryTokens`）是**数据**，不是代码：收窄或换成结构化命令
 * （例如 `/explore`）只需改这里的一条记录，判定与接线不变。
 */
import {
  DEFAULT_EXPLORATION_TRIGGER,
  parseExplorationTrigger,
  type ExplorationTriggerTokens,
} from './exploration-trigger.js'

/** 执行器种类。新增探索工具时在这里加一个新 kind，并在 `tier4-dispatch` 接上执行。 */
export type ExplorationDispatchKind = 'webwright-task'

export interface ExplorationProvider {
  id: string
  enabled: boolean
  /** 数值小的先尝试；只影响「多个 provider 都能跑」时的次序，不改变互斥约束。 */
  priority: number
  trigger: ExplorationTriggerTokens
  /** 该执行器的独立急停开关（置 `0` 即不参与，语义与其它层一致）。 */
  killSwitchEnv: string
  dispatch: ExplorationDispatchKind
  /** 正例：这条指令**只能**由本 provider 命中（校验器会拿它去试其它 provider）。 */
  examples: string[]
  /** 负例：不该触发本 provider 的句子（同时是这条触发的适用边界）。 */
  negativeExamples: string[]
}

/** 随包的默认注册表。`webwright` 是当前唯一的执行器。 */
export const EXPLORATION_PROVIDERS: readonly ExplorationProvider[] = [
  {
    id: 'webwright',
    enabled: true,
    priority: 100,
    trigger: DEFAULT_EXPLORATION_TRIGGER,
    killSwitchEnv: 'WEWORKER_TIER4',
    dispatch: 'webwright-task',
    examples: [
      '网站 https://example.com/list 直接查询：最新公告',
      '网站 example.com 直接查询：价格',
    ],
    negativeExamples: [
      '帮我看看 https://example.com/list 有什么',
      '这个网站怎么样',
    ],
  },
]

/** 启用并按 priority 排序（同优先级按 id 稳定排序，避免注册表顺序影响决策）。 */
export function orderedExplorationProviders(
  providers: readonly ExplorationProvider[] = EXPLORATION_PROVIDERS,
): ExplorationProvider[] {
  return providers
    .filter((provider) => provider?.enabled !== false)
    .slice()
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
}

/**
 * 注册表自检。返回错误描述数组（空数组 = 通过）。
 *
 * 调用点：单测与启动期自检各一次。**宁可整层不生效并报错，不可静默让两个探索工具抢同一句话。**
 */
export function validateExplorationProviders(
  providers: readonly ExplorationProvider[] = EXPLORATION_PROVIDERS,
): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  const priorities = new Map<number, string>()

  for (const provider of providers) {
    if (!provider?.id) {
      errors.push('provider 缺少 id')
      continue
    }
    if (ids.has(provider.id)) errors.push(`provider id 重复：${provider.id}`)
    ids.add(provider.id)
    if (provider.enabled === false) continue
    if (!provider.killSwitchEnv) errors.push(`${provider.id} 缺少急停开关名`)
    if (!provider.trigger?.siteTokens?.length) errors.push(`${provider.id} 缺少站点标记词`)
    if (!provider.trigger?.queryTokens?.length) errors.push(`${provider.id} 缺少查询标记词`)
    if (!provider.examples?.length) errors.push(`${provider.id} 缺少 examples（示例即适用边界）`)
    if (!provider.negativeExamples?.length) errors.push(`${provider.id} 缺少 negativeExamples`)
    const previous = priorities.get(provider.priority)
    if (previous) errors.push(`${provider.id} 与 ${previous} 的 priority 相同（${provider.priority}）`)
    priorities.set(provider.priority, provider.id)
    for (const example of provider.negativeExamples ?? []) {
      if (parseExplorationTrigger(example, provider.trigger).ok) {
        errors.push(`${provider.id} 的负例被自己的触发式命中：${example}`)
      }
    }
  }

  // 互斥：A 的正例不得被 B 的触发式命中，反之亦然。
  const active = providers.filter((provider) => provider?.enabled !== false && provider?.id)
  for (const owner of active) {
    for (const other of active) {
      if (owner.id === other.id) continue
      for (const example of owner.examples ?? []) {
        if (parseExplorationTrigger(example, other.trigger).ok) {
          errors.push(`触发式重叠：${owner.id} 的正例被 ${other.id} 命中：${example}`)
        }
      }
    }
  }

  return errors
}
