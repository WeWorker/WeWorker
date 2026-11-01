export const WEBCLI_TEMPLATE_COMMANDS = [
  {
    id: 'webcli-call',
    title: 'webcli call',
    command: "webcli call <tool_name>",
    description: '通用工具调用模板',
    searchText: "webcli call tool 调用 网站 工具".toLowerCase(),
  },
  {
    id: 'webcli-open-browser',
    title: 'webcli open_browser',
    command: 'webcli call open_browser --url=<url> --adapter=<adapter-id>',
    description: '打开已知 Adapter 网站并接入登录流程',
    searchText: "webcli call open_browser url adapter 打开 网站 skill 首页 登录".toLowerCase(),
  },
  {
    id: 'webcli-call-flags',
    title: 'webcli call + 参数',
    command: "webcli call <site.tool> --key=value",
    description: '用 --key=value 格式调用场景工具',
    searchText: "webcli call key=value 参数 场景 工具".toLowerCase(),
  },
]

export const WEBCLI_SLASH_COMMANDS = WEBCLI_TEMPLATE_COMMANDS

function requiredArgsForTool(tool) {
  const args = {}
  for (const param of tool?.parameters || []) {
    if (!param?.required || !param.name) continue
    args[param.name] = `<${param.name}>`
  }
  return args
}

function buildFlagsText(tool) {
  const flagParts = []
  for (const param of tool?.parameters || []) {
    if (param?.required && param.name) flagParts.push(`--${param.name}=<${param.name}>`)
  }
  return flagParts.length ? ` ${flagParts.join(' ')}` : ''
}

export function buildWebcliSlashCommands(sites = [], { includeTemplates = true, maxTools = 80 } = {}) {
  const commands = []
  const seen = new Set()
  for (const site of Array.isArray(sites) ? sites : []) {
    for (const tool of site?.tools || []) {
      const name = String(tool?.name || '').trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      const siteName = site?.name || site?.id || '站点工具'
      const description = tool?.description || `调用 ${siteName} 工具`
      const command = `webcli call ${name}${buildFlagsText(tool)}`
      commands.push({
        id: `webcli-tool:${name}`,
        title: name,
        command,
        description: `${siteName} · ${description}`,
        searchText: `${name} ${siteName} ${description} ${command}`.toLowerCase(),
      })
      if (commands.length >= maxTools) break
    }
    if (commands.length >= maxTools) break
  }
  return includeTemplates ? [...commands, ...WEBCLI_TEMPLATE_COMMANDS] : commands
}

export function findChatSlashTrigger(value, cursor) {
  const text = String(value || '')
  const safeCursor = Math.max(0, Math.min(cursor, text.length))
  const before = text.slice(0, safeCursor)
  const match = before.match(/(^|\s)\/([^\r\n]*)$/)
  if (!match) return null

  const slashStart = before.length - match[2].length - 1

  return {
    query: match[2] || '',
    start: slashStart,
    end: safeCursor,
  }
}

export function findChatBangTrigger(value, cursor) {
  const text = String(value || '')
  const safeCursor = Math.max(0, Math.min(cursor, text.length))
  const before = text.slice(0, safeCursor)
  const match = before.match(/^\s*!([^\r\n]*)$/)
  if (!match) return null

  const bangStart = before.indexOf('!')

  return {
    query: match[1] || '',
    start: bangStart,
    end: safeCursor,
  }
}

export function filterChatSlashCommands(commands, query) {
  const normalized = String(query || '').trim().toLowerCase()
  if (!normalized) return commands
  return commands.filter((item) => (
    item.searchText.includes(normalized)
    || item.title.toLowerCase().includes(normalized)
    || item.command.toLowerCase().includes(normalized)
  ))
}
