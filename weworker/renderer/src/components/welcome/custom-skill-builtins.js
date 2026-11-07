/** Built-in {{placeholder}} variables & slash-menu items for custom skill SKILL.md authoring. */

export const BUILTIN_PLACEHOLDER_USAGE = '在 SKILL.md 任意位置写入 {{变量名}}；安装 skill 时会自动替换为当前值。也可在任意位置输入 / 快速插入占位符、内置工具或场景工具。'

export const STATIC_BUILTIN_VARIABLES = [
  {
    key: 'site.id',
    description: '当前站点 ID',
    example: 'mail.qq.com',
  },
  {
    key: 'site.name',
    description: '当前站点名称',
    example: 'QQ邮箱',
  },
  {
    key: 'site.description',
    description: '站点简介',
  },
  {
    key: 'skill.name',
    description: '当前 skill 标识',
    example: 'custom.send.email',
  },
  {
    key: 'skill.description',
    description: '当前 skill 描述',
  },
  {
    key: 'skill.path',
    description: '当前 skill 安装目录（与 webcli-{站点} 同级）；随附资源位于此目录下',
    example: '~/.weworker/claude-config/skills/webcli-custom.send.email/',
  },
]

function resourceBasename(relativePath) {
  const parts = String(relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || relativePath || 'file'
}

export function toSkillPlaceholder(key) {
  return `{{${key}}}`
}

function sanitizeSkillPathSegment(value) {
  return (value || 'custom')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/^\.+$/, '_')
    .trim() || 'custom'
}

function formatInstalledSkillPath(skillName) {
  if (!skillName) return ''
  return `~/.weworker/claude-config/skills/webcli-${sanitizeSkillPathSegment(skillName)}/`
}

function resolveStaticValue(key, { site, tool }) {
  switch (key) {
    case 'site.id': return site?.id || ''
    case 'site.name': return site?.name || ''
    case 'site.description': return site?.description || ''
    case 'skill.name': return tool?.name || ''
    case 'skill.description': return tool?.description || ''
    case 'skill.path': return formatInstalledSkillPath(tool?.name)
    default: return ''
  }
}

export function buildOfficialAdapterToolSection(tool) {
  const lines = [
    `### ${tool.name || '未命名工具'}`,
    '',
  ]
  if (tool.description) {
    lines.push(tool.description, '')
  }
  if (tool.parameters?.length) {
    lines.push('Parameters:', '')
    for (const param of tool.parameters) {
      const required = param.required ? ' **(required)**' : ''
      const desc = param.description ? ` - ${param.description}` : ''
      lines.push(`- \`${param.name || 'param'}\`: ${param.type || 'string'}${required}${desc}`)
    }
    lines.push('')
  }
  const required = (tool.parameters || []).filter(param => param.required)
  const flags = []
  const fileArgs = {}
  for (const { name, type } of required) {
    if (type === 'array') fileArgs[name] = []
    else if (type === 'object') fileArgs[name] = {}
    else if (type === 'number' || type === 'integer') fileArgs[name] = 1
    else flags.push('--' + name + '=' + (type === 'boolean' ? 'true' : 'example-value'))
  }
  if (Object.keys(fileArgs).length) {
    lines.push('按实际值填写 UTF-8 文件 `args.json`：', '', '```json', JSON.stringify(fileArgs, null, 2), '```', '')
    flags.push('--args-file=./args.json')
  }
  lines.push('```bash', [`webcli call ${tool.name}`, ...flags].join(' '), '```')
  return lines.join('\n')
}

export function buildBuiltinVariableHelpEntries({ site, tool }) {
  const entries = STATIC_BUILTIN_VARIABLES.map((def) => ({
    ...def,
    placeholder: toSkillPlaceholder(def.key),
    preview: resolveStaticValue(def.key, { site, tool }) || def.example || '',
  }))

  for (const resource of tool?.resources || []) {
    if (resource.is_directory) continue
    const relativePath = String(resource.relativePath || '').replace(/\\/g, '/')
    if (!relativePath) continue
    const key = `resource.${resourceBasename(relativePath)}`
    const skillPath = formatInstalledSkillPath(tool?.name)
    entries.push({
      key,
      placeholder: toSkillPlaceholder(key),
      description: '随附资源绝对路径（基于 skill.path）',
      preview: skillPath ? `${skillPath}${relativePath}` : `./${relativePath}`,
    })
  }

  return entries
}

export function buildSkillSlashMenuItems({ site, tool, officialTools = [], systemTools = [] }) {
  const entries = buildBuiltinVariableHelpEntries({ site, tool })
  const builtinItems = entries.map((entry) => ({
    group: 'builtin',
    groupLabel: '内置变量',
    id: entry.key,
    label: entry.placeholder,
    menuTitle: entry.placeholder,
    menuHint: entry.description,
    title: entry.placeholder,
    description: entry.description,
    preview: entry.preview,
    insert: entry.placeholder,
    searchText: `${entry.key} ${entry.placeholder} ${entry.description} ${entry.preview}`.toLowerCase(),
  }))

  const systemToolItems = (systemTools || []).map((systemTool) => {
    const section = buildOfficialAdapterToolSection(systemTool)
    const name = systemTool.name || '未命名工具'
    const description = systemTool.description || ''
    const hint = truncateMenuHint(description ? `内置 · ${name} — ${description}` : `内置 · ${name}`)
    return {
      group: 'system',
      groupLabel: '内置工具',
      id: `system:${name}`,
      label: name,
      menuTitle: '内置',
      menuHint: hint,
      title: `内置工具 ${name}`,
      description,
      preview: description,
      insert: `${section}\n`,
      searchText: `${name} ${description} 内置工具 内置 system`.toLowerCase(),
    }
  })

  const siteIds = new Set((officialTools || []).map((adapterTool) => adapterTool.siteId).filter(Boolean))
  const toolGroupLabel = siteIds.size > 1 ? '场景工具' : '工具说明'

  const toolItems = (officialTools || []).map((adapterTool) => {
    const section = buildOfficialAdapterToolSection(adapterTool)
    const name = adapterTool.name || '未命名工具'
    const description = adapterTool.description || ''
    const sitePrefix = adapterTool.siteName ? `${adapterTool.siteName} · ` : ''
    const hint = truncateMenuHint(description ? `${sitePrefix}${name} — ${description}` : `${sitePrefix}${name}`)
    return {
      group: 'tool',
      groupLabel: toolGroupLabel,
      id: adapterTool.siteId ? `${adapterTool.siteId}:${name}` : name,
      label: name,
      menuTitle: siteIds.size > 1 ? adapterTool.siteName || '工具说明' : '工具说明',
      menuHint: hint,
      title: `工具说明 ${name}`,
      description,
      preview: description,
      insert: `${section}\n`,
      searchText: `${name} ${description} ${adapterTool.siteName || ''} tool 工具说明 场景工具`.toLowerCase(),
    }
  })

  return [...builtinItems, ...systemToolItems, ...toolItems]
}

export function findSkillSlashTrigger(value, cursor) {
  const safeCursor = Math.max(0, Math.min(cursor, String(value || '').length))
  const before = String(value || '').slice(0, safeCursor)
  const match = before.match(/\/([^\s/]*)$/)
  if (!match) return null
  const slashStart = before.length - match[0].length
  if (slashStart >= 2 && before.slice(slashStart - 2, slashStart) === '://') return null
  const query = match[1] || ''
  return { query, start: slashStart, end: safeCursor }
}

export function filterSkillSlashMenuItems(items, query) {
  const normalized = String(query || '').trim().toLowerCase()
  if (!normalized) return items
  return items.filter((item) => item.searchText.includes(normalized))
}

function truncateMenuHint(text, max = 88) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}
