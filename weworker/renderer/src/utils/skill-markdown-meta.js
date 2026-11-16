function normalizeSkillNameFromMeta(rawName, preserveNamePrefix) {
  if (!rawName) return undefined
  const trimmed = String(rawName).trim().replace(/^['"]|['"]$/g, '')
  if (!trimmed || trimmed.includes('{{')) return undefined
  return !preserveNamePrefix && trimmed.startsWith('webcli-') ? trimmed.slice('webcli-'.length) : trimmed
}

function readYamlBlockScalar(lines, startIndex, folded) {
  const parts = []
  let index = startIndex
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      const next = lines[index + 1]
      if (next && /^\s/.test(next)) {
        if (!folded) parts.push('')
        index += 1
        continue
      }
      break
    }
    if (!/^\s/.test(line)) break
    parts.push(line.trim())
    index += 1
  }
  return {
    value: folded ? parts.join(' ') : parts.join('\n'),
    nextIndex: index - 1,
  }
}

export function parseSkillMarkdownMeta(markdown, { preserveNamePrefix = false } = {}) {
  const match = String(markdown || '').match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return {}
  const meta = {}
  const lines = match[1].split('\n')

  for (let i = 0; i < lines.length; i += 1) {
    const pair = lines[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!pair) continue

    const key = pair[1]
    let value = pair[2].trim()

    if (value === '>' || value === '|') {
      const block = readYamlBlockScalar(lines, i + 1, value === '>')
      value = block.value
      i = block.nextIndex
    } else {
      value = value.replace(/^['"]|['"]$/g, '')
    }

    if (!value || value.includes('{{')) continue
    meta[key] = value
  }

  return {
    name: normalizeSkillNameFromMeta(meta.name, preserveNamePrefix),
    description: meta.description,
    userInvocable: !/^false(?:\s+#.*)?$/i.test(meta['user-invocable'] || ''),
  }
}
