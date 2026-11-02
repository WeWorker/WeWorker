import { parseAllAdapters } from './adapter-parser.js'
import { getOpenBrowserAllowedOrigins, getSiteEnabled } from './config.js'
import type { AccessDecision } from './user-directory-access.js'

/** The same default Adapter origins and additional origins shown in Permissions. */
export function getWorkspaceAllowedOrigins(): Set<string> {
  const allowed = new Set(getOpenBrowserAllowedOrigins())
  const adapters = parseAllAdapters()
  for (const [id, adapter] of adapters) {
    const enabled = getSiteEnabled(id, adapter.defaultEnabled, adapter.managed?.enabled)
    if (!enabled) continue
    for (const host of [adapter.homepageUrl, ...(adapter.match || [])]) {
      if (!host || host.includes('*')) continue
      for (const candidate of /^https?:\/\//i.test(host) ? [host] : [`https://${host}`, `http://${host}`]) {
        try { allowed.add(new URL(candidate).origin) } catch { /* Ignore invalid manifest origins. */ }
      }
    }
  }
  return allowed
}

export function checkWorkspaceCommandSites(command: string): AccessDecision {
  const allowed = getWorkspaceAllowedOrigins()
  const adapters = parseAllAdapters()
  const calls = [...command.matchAll(/\bwebcli(?:\.cmd)?\s+call\s+([^\s;|]+)/gi)].map(match => match[1])
  for (const [id, adapter] of adapters) {
    if (getSiteEnabled(id, adapter.defaultEnabled, adapter.managed?.enabled)) continue
    if (calls.some(call => call.startsWith(`${id}.`) || adapter.tools.some(tool => tool.name === call))) {
      return { allowed: false, reason: '站点未启用，不能在当前工作区调用该 Adapter。请在站点权限设置中授权。' }
    }
  }
  // Inspect explicit destinations, including --url=... and JSON command arguments.
  for (const match of command.matchAll(/https?:\/\/[^\s"'`<>\\]+/gi)) {
    let origin: string
    try { origin = new URL(match[0].replace(/[),;\]}]+$/, '')).origin } catch {
      return { allowed: false, reason: '站点 URL 无效，无法校验站点白名单。' }
    }
    if (!allowed.has(origin)) return { allowed: false, reason: `站点不在白名单中：${origin}。请在权限设置中添加该站点。` }
  }
  return { allowed: true }
}

export function checkWorkspaceToolSites(toolName: string, input: Record<string, unknown>): AccessDecision & { updatedInput?: Record<string, unknown> } {
  if (toolName === 'WebFetch') return checkWorkspaceCommandSites(String(input.url ?? ''))
  if (toolName !== 'WebSearch') return { allowed: true }

  const allowedDomains = [...new Set([...getWorkspaceAllowedOrigins()].flatMap(origin => {
    try { return [new URL(origin).hostname] } catch { return [] }
  }))]
  if (!allowedDomains.length) return { allowed: false, reason: '站点白名单为空，不能执行网络搜索。请在权限设置中添加允许的站点。' }
  const requested = Array.isArray(input.allowed_domains)
    ? input.allowed_domains.filter((domain): domain is string => typeof domain === 'string')
    : allowedDomains
  const narrowedDomains = requested.filter(domain => allowedDomains.includes(domain.toLowerCase()))
  if (!narrowedDomains.length) return { allowed: false, reason: '搜索范围与站点白名单不匹配。请在权限设置中添加允许的站点。' }
  return { allowed: true, updatedInput: { ...input, allowed_domains: narrowedDomains } }
}
