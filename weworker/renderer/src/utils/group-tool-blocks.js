/**
 * Group consecutive tool_use blocks for compact list rendering.
 * Skill and plan-management tools stay as standalone blocks.
 */
import { isPlanManagementTool } from './todowrite-state.js'

export function isGroupableToolUse(block) {
  if (!block || block.type !== 'tool_use' || block.image) return false
  if (block.name === 'Skill') return false
  if (isPlanManagementTool(block.name)) return false
  return true
}

export function partitionContentBlocks(content) {
  if (!content?.length) return []

  const items = []
  let i = 0

  while (i < content.length) {
    const block = content[i]
    if (block.type === 'text') {
      const startIndex = i
      const fragments = []
      // Transport chunks can split Markdown syntax, including whitespace and table rows.
      while (i < content.length && content[i].type === 'text') {
        fragments.push(content[i].text ?? '')
        i += 1
      }
      items.push({
        kind: 'block',
        block: { ...block, text: fragments.join('') },
        key: block.id ?? `block-${startIndex}`,
      })
      continue
    }
    if (isGroupableToolUse(block)) {
      const startIndex = i
      const blocks = []
      while (i < content.length && isGroupableToolUse(content[i])) {
        blocks.push(content[i])
        i += 1
      }
      items.push({
        kind: 'tool_exec_group',
        blocks,
        // Appending streamed commands must not remount the group and reset disclosure state.
        key: `tool-group-${block.id ?? startIndex}`,
      })
      continue
    }

    items.push({
      kind: 'block',
      block,
      key: block.id ?? `block-${i}`,
    })
    i += 1
  }

  return items
}
