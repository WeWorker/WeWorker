/**
 * Resolve user-facing scenarios for /sites API.
 * Primary source: adapter manifest.json `scenarios` (registry.json is generated for compatibility).
 * Fallback: synthesize from i18n description.
 */
import type { ParsedAdapter } from './adapter-parser.js'

export interface RegistryScenarioPrompt {
  text: string
  reply?: string
}

/**
 * 卡片路由声明（manifest `scenarios[].route`）。三形态互斥：
 * - `tool`：本卡片的推荐话术可由某个只读直调工具直接回答；
 * - `plan`：本卡片是多跳入口（终点工具由 `plan-terminals.json` 白名单约束）；
 * - `direct:false`：本卡片**不做直连**，同时抑制下层宽泛层抢答（`reason` 必填）。
 *
 * 编译与校验见 `api-query-router/scenario-route-compiler.ts`；产物 `router-config/scenario-routes.json`。
 */
export interface ScenarioRouteDecl {
  tool?: string
  args?: Record<string, unknown>
  plan?: { terminal?: string; input?: Record<string, string> }
  direct?: boolean
  reason?: string
  enabled?: boolean
  guard?: { negative?: string[] }
}

/** Registry optional field — do not rename existing registry keys. */
export interface RegistryScenarioDef {
  id?: string
  title: string
  summary: string
  steps?: string[]
  tool_names?: string[]
  /** Suggested user prompts for this scenario. Each prompt can carry its own AI reply preview. */
  prompts?: RegistryScenarioPrompt[]
  /** 卡片路由声明（可选）；无声明且话术含占位符时 `gen:routes` 会报错。 */
  route?: ScenarioRouteDecl
  updated_at?: string
}

export interface ResolvedScenario {
  id: string
  title: string
  summary: string
  steps?: string[]
  toolNames?: string[]
  prompts: RegistryScenarioPrompt[]
  updated_at?: string
  source: 'registry' | 'fallback' | 'user'
}

function parseDescriptionPhrases(description: string): string[] {
  const tail = description.includes('：')
    ? description.split('：').slice(1).join('：')
    : description.includes(':')
      ? description.split(':').slice(1).join(':')
      : description
  return tail
    .split(/[，,、]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 32)
}

function synthesizeFallback(adapter: ParsedAdapter): RegistryScenarioDef[] {
  const defs: RegistryScenarioDef[] = []
  const seen = new Set<string>()

  for (const phrase of parseDescriptionPhrases(adapter.description)) {
    if (seen.has(phrase)) continue
    seen.add(phrase)
    defs.push({
      id: `desc-${phrase}`,
      title: phrase,
      summary: `在${adapter.name}完成「${phrase}」`,
    })
  }

  if (defs.length === 0) {
    defs.push({
      id: 'default',
      title: '通用操作',
      summary: adapter.description,
    })
  }
  return defs
}

/** Registry scenarios when present; otherwise the same fallback defs shown in /sites. */
export function getOfficialScenarioDefs(adapter: ParsedAdapter): RegistryScenarioDef[] {
  const registry = adapter.registryScenarios || []
  return registry.length ? registry : synthesizeFallback(adapter)
}

function normalizeScenarioPrompts(prompts: RegistryScenarioPrompt[] | undefined): RegistryScenarioPrompt[] {
  if (!Array.isArray(prompts)) return []
  return prompts
    .map((prompt) => {
      const text = typeof prompt?.text === 'string' ? prompt.text.trim() : ''
      if (!text) return null
      const reply = typeof prompt.reply === 'string' ? prompt.reply.trim() : ''
      return {
        text,
        ...(reply ? { reply } : {}),
      }
    })
    .filter((prompt): prompt is RegistryScenarioPrompt => !!prompt)
}

export function resolveSiteScenarios(
  adapter: ParsedAdapter,
  registryScenarios?: RegistryScenarioDef[],
): ResolvedScenario[] {
  const defs = registryScenarios?.length ? registryScenarios : synthesizeFallback(adapter)
  return defs.map((def) => {
    const prompts = normalizeScenarioPrompts(def.prompts)

    return {
      id: def.id || def.title,
      title: def.title,
      summary: def.summary,
      steps: def.steps,
      toolNames: Array.isArray(def.tool_names) ? def.tool_names : undefined,
      prompts,
      updated_at: def.updated_at,
      source: registryScenarios?.length ? 'registry' : 'fallback',
    }
  })
}
