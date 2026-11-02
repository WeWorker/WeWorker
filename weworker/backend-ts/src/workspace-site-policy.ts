import { parseAllAdapters } from './adapter-parser.js'
import { getOpenBrowserAllowedOrigins, getSiteEnabled } from './config.js'
import type { AccessDecision } from './user-directory-access.js'

/** The same default Adapter origins and additional origins shown in Permissions. */
export function checkWorkspaceCommandSites(command: string): AccessDecision {
  const allowed = new Set(getOpenBrowserAllowedOrigins())
  const adapters = parseAllAdapters()
  const calls = [...command.matchAll(/\bwebcli(?:\.cmd)?\s+call\s+([^\s;|]+)/gi)].map(match => match[1])
  for (const [id, adapter] of adapters) {
    const enabled = getSiteEnabled(id, adapter.defaultEnabled, adapter.managed?.enabled)
    if (!enabled) {
      if (calls.some(call => call.startsWith(`${id}.`) || adapter.tools.some(tool => tool.name === call))) {
        return { allowed: false, reason: '站点未启用，不能在当前工作区调用该 Adapter。请在站点权限设置中授权。' }
      }
      continue
    }
    for (const host of [adapter.homepageUrl, ...(adapter.match || [])]) {
      if (!host || host.includes('*')) continue
      for (const candidate of /^https?:\/\//i.test(host) ? [host] : [`https://${host}`, `http://${host}`]) {
        try { allowed.add(new URL(candidate).origin) } catch { /* Ignore invalid manifest origins. */ }
      }
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
