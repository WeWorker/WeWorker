import { clipboardMarkdown } from './formatted-body.js'
import { partitionContentBlocks } from './group-tool-blocks.js'

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'PRE', 'TR'])

function visibleText(node) {
  if (node.nodeType === 3) {
    // Markdown renderers insert newline-only nodes between block elements.
    // Layout already supplies those breaks; keep literal whitespace inside code.
    return /\n/.test(node.nodeValue) && !node.nodeValue.trim() && !node.parentElement?.closest('pre') ? '' : node.nodeValue
  }
  if (node.nodeType !== 1 && node.nodeType !== 11) return ''
  if (node.tagName === 'BR') return '\n'
  if (node.tagName === 'IMG') return node.getAttribute('alt') || ''
  let text = Array.from(node.childNodes, visibleText).join('')
  if (node.tagName === 'TR') text = text.replace(/\t$/, '')
  if (node.tagName === 'TD' || node.tagName === 'TH') return `${text}\t`
  return BLOCK_TAGS.has(node.tagName) && !text.endsWith('\n') ? `${text}\n` : text
}

function cleanContent(node) {
  node.querySelectorAll('button, .chat-shell-command-header, script, style').forEach(element => element.remove())
  return node
}

export function captureMessageSelection(root, selection) {
  if (!root || !selection?.rangeCount || selection.isCollapsed) return null
  const text = selection.toString()
  if (!text.trim()) return null
  const container = root.ownerDocument.createElement('div')
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index)
    // A selection from another message must never override this message's copy.
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
    let fragment = range.cloneContents()
    let ancestor = range.commonAncestorContainer
    if (ancestor.nodeType !== 1) ancestor = ancestor.parentElement
    // cloneContents omits the shared parent, e.g. <strong> for a partial bold selection.
    while (ancestor && ancestor !== root && !ancestor.classList.contains('message-text-selectable')) {
      const wrapper = ancestor.cloneNode(false)
      wrapper.appendChild(fragment)
      fragment = wrapper
      ancestor = ancestor.parentElement
    }
    container.appendChild(fragment)
  }
  cleanContent(container)
  return {
    plainText: text,
    markdown: root.classList.contains('message-item--user')
      ? text
      : clipboardMarkdown({ html: container.innerHTML, text, preserveCodeSource: false }, root.ownerDocument.defaultView.DOMParser),
  }
}

export function messageCopyContent(message, root, selection = null) {
  if (selection) return selection
  const markdown = partitionContentBlocks(message.content ?? [])
    .filter(item => item.kind === 'block' && item.block.type === 'text')
    .map(item => item.block.text)
    .join('\n')
  if (message.role === 'user') return { markdown, plainText: markdown }
  const blocks = Array.from(root?.querySelectorAll('.message-text-selectable') ?? [])
  const plainText = blocks.map(block => visibleText(cleanContent(block.cloneNode(true))).replace(/\n+$/, '')).join('\n\n')
  return { markdown, plainText }
}
