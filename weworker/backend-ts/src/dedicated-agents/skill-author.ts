/**
 * AI-assisted authoring of a dedicated agent's private skill (SKILL.md).
 *
 * Input is what an office user can easily provide: the website, what the agent
 * should do, and the private knowledge they have. The model turns it into a
 * SKILL.md grounded in the website's real Adapter tools.
 */
import type { Settings } from '../config.js'
import { resolveAnthropicEndpoint } from '../llm-egress.js'
import { findProviderByWeWorkerBaseUrl } from '../provider-registry.js'
import { buildAnthropicAuthHeaders } from '../anthropic-auth.js'

export interface SkillAuthorAdapter {
  id: string
  name: string
  description: string
  requiresAuth: boolean
  authCheckTool: string | null
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown>; safety?: string; requiresConfirmation?: boolean }>
}

export interface GenerateSkillInput {
  adapter: SkillAuthorAdapter
  agentName: string
  goal: string
  knowledge: string
  skillName: string
}

const EXAMPLES_SEPARATOR = '===EXAMPLES==='
const MAX_INPUT_CHARS = 20_000
const GENERATION_TIMEOUT_MS = 180_000
const MAX_TOKENS = 8_000

type LlmSettings = Pick<Settings, 'api_key' | 'base_url' | 'model' | 'active_provider' | 'custom_auth_type'>
  & Partial<Pick<Settings, 'base_url_is_full' | 'active_auth_type'>>
type FetchLike = typeof fetch

function describeParams(parameters: Record<string, unknown>): string {
  const properties = (parameters?.properties ?? {}) as Record<string, { type?: string; description?: string }>
  const required = new Set(Array.isArray(parameters?.required) ? parameters.required as string[] : [])
  const entries = Object.entries(properties).filter(([name]) => name !== '__confirmed')
  if (!entries.length) return '无参数'
  return entries
    .map(([name, schema]) => `--${name}（${schema?.type || 'string'}${required.has(name) ? '，必填' : ''}）${schema?.description ? `：${schema.description}` : ''}`)
    .join('；')
}

export function describeAdapterForSkill(adapter: SkillAuthorAdapter): string {
  const lines = [
    `网站：${adapter.name}（Adapter ID：${adapter.id}）`,
    adapter.description ? `说明：${adapter.description}` : '',
    adapter.requiresAuth
      ? `需要登录：是。直接调用用户请求的业务工具；未登录时 WeWorker 会自动打开登录页并处理登录。仅在用户明确询问登录状态时，才调用 \`webcli call ${adapter.authCheckTool || `${adapter.id}.check_login_status`}\`。`
      : '需要登录：否',
    '',
    '可用工具（调用格式：webcli call <工具名> --参数名=参数值）：',
  ]
  for (const tool of adapter.tools.slice(0, 60)) {
    const safety = tool.safety === 'write'
      ? '【写操作】'
      : ''
    lines.push(`- ${tool.name}${safety}：${(tool.description || '').trim()}。参数：${describeParams(tool.parameters)}`)
  }
  return lines.filter((line, index) => line || index > 0).join('\n')
}

const SYSTEM_PROMPT = `你是 WeWorker 的 Skill 作者。WeWorker 通过 Adapter 操作网站，AI Agent 用 \`webcli call <工具名> --参数=值\` 调用 Adapter 工具。
你的任务：根据用户提供的目标和专属知识，为一个"WeWorker Bot"写一份高质量的 SKILL.md，让 Agent 拿到它之后就能稳定、正确地完成用户的网站工作。

写作要求：
1. 只使用"可用工具"中真实存在的工具名和参数，不要编造工具。
2. 领域知识只能来自用户提供的内容；不确定或缺失的信息写进「待补充（不要猜）」小节，不要编造地址、路径、账号或结论。
3. 如果用户内容里出现密码、Token、Cookie、密钥等敏感信息，不要写进 Skill，用「<请在使用时向用户确认>」代替。
4. 把用户的目标拆成具体的「常用操作配方」：每个配方说明适用场景和对应的 webcli 命令示例。
5. 写操作仅执行用户请求的动作，参数明确时使用业务参数直接调用；目标或内容不明确时先澄清。遵守命令自身的预览/提交参数；结果未知时先查询状态，不重复提交。
6. 对需要登录的网站，执行步骤应直接调用用户请求的业务工具；WeWorker 会在未登录时自动处理登录。不要把 check-login-status 或 open_browser 写成业务操作前的常规步骤，除非用户明确询问登录状态或给出的工具说明明确要求手工页面准备。
7. 用简体中文，结构清晰，避免空话；面向 AI 执行者，而不是面向人类读者。

输出格式（严格遵守）：
- 先输出完整的 SKILL.md，必须以 YAML frontmatter 开头：
---
name: <调用方给定的 skill 名称，原样使用>
description: "<一句话：在什么情况下使用这个 Skill，包含用户可能说出的关键词>"
allowed-tools: Bash(webcli call *)
---
- 正文建议包含这些小节：职责边界、领域知识、执行步骤（直接调用业务工具；未登录时由 WeWorker 处理）、常用操作配方、注意事项与约束、回答方式、待补充（不要猜）。
- SKILL.md 之后单独一行输出 ${EXAMPLES_SEPARATOR}
- 再输出 3 个用户可能直接对 Agent 说的示例问题，每行一个，不要编号。
不要输出其他解释，不要用代码块包裹整个输出。`

const REVISE_SYSTEM_PROMPT = `你是 WeWorker 的 Skill 作者。请按用户的修改要求改写给定的 SKILL.md。
要求：保留 YAML frontmatter（name 不变），只使用"可用工具"中真实存在的工具；不要编造用户没有提供的事实；不要写入密码、Token 等敏感信息。
只输出改写后的完整 SKILL.md，不要输出解释，不要用代码块包裹。`

function clamp(text: string): string {
  return String(text ?? '').slice(0, MAX_INPUT_CHARS)
}

function stripWrappingFence(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  return fenced ? fenced[1].trim() : trimmed
}

/** Force the frontmatter name and keep a required allowed-tools line. */
export function normalizeSkillMarkdown(markdown: string, skillName: string): string {
  let text = stripWrappingFence(markdown)
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!frontmatter) {
    text = `---\nname: ${skillName}\ndescription: "${skillName}"\nallowed-tools: Bash(webcli call *)\n---\n\n${text}`
    return text.trim() + '\n'
  }
  let header = frontmatter[1]
  header = /^\s*name\s*:/m.test(header)
    ? header.replace(/^\s*name\s*:.*$/m, `name: ${skillName}`)
    : `name: ${skillName}\n${header}`
  if (!/^\s*allowed-tools\s*:/m.test(header)) header += '\nallowed-tools: Bash(webcli call *)'
  const body = text.slice(frontmatter[0].length).replace(/^\s+/, '')
  return `---\n${header.trim()}\n---\n\n${body}`.trim() + '\n'
}

export function parseGeneratedSkill(raw: string, skillName: string): { markdown: string; examples: string[] } {
  const text = String(raw ?? '')
  const index = text.lastIndexOf(EXAMPLES_SEPARATOR)
  const skillPart = index >= 0 ? text.slice(0, index) : text
  const examplePart = index >= 0 ? text.slice(index + EXAMPLES_SEPARATOR.length) : ''
  const markdown = normalizeSkillMarkdown(skillPart, skillName)
  if (markdown.replace(/^---[\s\S]*?---/, '').trim().length < 8) {
    throw new Error('AI 没有生成有效的 Skill 内容，请补充更多描述后重试')
  }
  const examples = examplePart
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
    .filter((line) => line && !line.startsWith('```'))
    .slice(0, 3)
  return { markdown, examples }
}

async function callModel(settings: LlmSettings, system: string, user: string, fetchImpl: FetchLike): Promise<string> {
  if (!settings.api_key) throw new Error('尚未配置模型 API Key，请先在设置中配置')
  // Same endpoint and auth resolution as title generation (supports full-URL mode).
  const endpoint = resolveAnthropicEndpoint(settings)
  const effectiveProviderId = settings.active_provider === 'custom'
    ? findProviderByWeWorkerBaseUrl(settings.base_url)?.id || settings.active_provider
    : settings.active_provider
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      ...buildAnthropicAuthHeaders(settings.api_key, effectiveProviderId, settings.active_auth_type ?? settings.custom_auth_type),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`模型调用失败（HTTP ${response.status}），请检查模型配置后重试`)
  const data = await response.json() as { content?: Array<{ type?: string; text?: string }> }
  const text = (data.content ?? [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
  if (!text.trim()) throw new Error('模型没有返回内容，请重试')
  return text
}

export async function generateAgentSkill(
  input: GenerateSkillInput,
  settings: LlmSettings,
  fetchImpl: FetchLike = fetch,
): Promise<{ skill_name: string; markdown: string; examples: string[] }> {
  if (!input.goal.trim() && !input.knowledge.trim()) {
    throw new Error('请至少描述一下这个 Agent 要帮你做什么')
  }
  const user = [
    `skill 名称：${input.skillName}`,
    `WeWorker Bot 名称：${input.agentName || input.adapter.name}`,
    '',
    '【可用工具】',
    describeAdapterForSkill(input.adapter),
    '',
    '【用户希望 Agent 帮他做什么】',
    clamp(input.goal) || '（未填写）',
    '',
    '【用户提供的专属知识】',
    clamp(input.knowledge) || '（未填写）',
  ].join('\n')
  const raw = await callModel(settings, SYSTEM_PROMPT, user, fetchImpl)
  const parsed = parseGeneratedSkill(raw, input.skillName)
  return { skill_name: input.skillName, ...parsed }
}

export async function reviseAgentSkill(
  input: { adapter: SkillAuthorAdapter; markdown: string; instruction: string; skillName: string },
  settings: LlmSettings,
  fetchImpl: FetchLike = fetch,
): Promise<{ markdown: string }> {
  if (!input.instruction.trim()) throw new Error('请描述想怎么修改')
  const user = [
    '【可用工具】',
    describeAdapterForSkill(input.adapter),
    '',
    '【当前 SKILL.md】',
    clamp(input.markdown),
    '',
    '【修改要求】',
    clamp(input.instruction),
  ].join('\n')
  const raw = await callModel(settings, REVISE_SYSTEM_PROMPT, user, fetchImpl)
  return { markdown: normalizeSkillMarkdown(raw, input.skillName) }
}

/** Suggest a unique, valid skill directory name. */
export function suggestSkillName(siteId: string, existing: Set<string>): string {
  const base = (siteId.split('.').filter((part) => !/^(www|uat|sit|dev|com|cn|net|org)$/i.test(part))[0] || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '') || 'site'
  const stem = `${base}-agent`
  if (!existing.has(stem)) return stem
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}`
    if (!existing.has(candidate)) return candidate
  }
  return `${stem}-${Date.now()}`
}
