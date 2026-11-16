const isBlock = node => node.nodeType === 1 && /^(DIV|P|LI)$/.test(node.tagName)
const point = (node, offset) => ({ node, offset })

// Keep command offsets in plain text while the DOM treats each Skill as one atom.
export function readComposer(root) {
  let text = ''
  const skills = [], segments = [], positions = new Map()
  const append = (value, from, to, node = null, atomic = false) => {
    const start = text.length
    text += value
    segments.push({ start, end: text.length, from, to, node, atomic })
  }
  const walk = parent => {
    const children = [...parent.childNodes]
    const offsets = [text.length]
    positions.set(parent, offsets)
    children.forEach((child, index) => {
      const before = point(parent, index), after = point(parent, index + 1)
      if (isBlock(child) && index > 0 && (isBlock(children[index - 1]) || !text.endsWith('\n'))) append('\n', before, point(child, 0))
      if (child.nodeType === 3) {
        positions.set(child, text.length)
        append(child.data.replace(/\u00a0/g, ' '), point(child, 0), point(child, child.length), child)
      } else if (child.nodeType === 1 && child.hasAttribute('data-skill-command')) {
        const command = child.getAttribute('data-skill-command')
        const start = text.length
        append(command, before, after, child, true)
        skills.push({ start, end: text.length, name: command.slice(1), iconUrl: child.querySelector('img')?.getAttribute('src') || undefined })
      } else if (child.nodeName === 'BR') {
        // Chromium inserts a final BR solely to keep an empty last line editable.
        const precedingNodes = children.slice(0, index).filter(node => node.nodeType !== 3 || node.length)
        const followingNodes = children.slice(index + 1).filter(node => node.nodeType !== 3 || node.length)
        const placeholder = !followingNodes.length && (text.length === offsets[0] || precedingNodes.at(-1)?.nodeName === 'BR' || text.endsWith('\n'))
        if (!placeholder) append('\n', before, after)
      } else if (child.nodeType === 1) {
        walk(child)
      }
      if (isBlock(child) && index < children.length - 1 && !isBlock(children[index + 1]) && !text.endsWith('\n')) append('\n', point(child, child.childNodes.length), after)
      offsets[index + 1] = text.length
    })
  }
  walk(root)
  return { text, skills, segments, positions }
}

function offsetAt(model, node, offset) {
  const position = model.positions.get(node)
  if (typeof position === 'number') return position + Math.min(offset, node.length)
  if (position) return position[Math.min(offset, position.length - 1)]
  const token = node.nodeType === 1 ? node.closest('[data-skill-command]') : node.parentElement?.closest('[data-skill-command]')
  const segment = model.segments.find(item => item.node === token)
  return segment ? (offset === 0 ? segment.start : segment.end) : model.text.length
}

export function getComposerSelection(root) {
  const selection = root.ownerDocument.getSelection()
  const model = readComposer(root)
  if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return { start: model.text.length, end: model.text.length }
  const a = offsetAt(model, selection.anchorNode, selection.anchorOffset)
  const b = offsetAt(model, selection.focusNode, selection.focusOffset)
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

export function setComposerSelection(root, start, end = start) {
  const model = readComposer(root)
  start = Math.max(0, Math.min(start, model.text.length))
  end = Math.max(start, Math.min(end, model.text.length))
  for (const token of model.skills) {
    if (start === end && start > token.start && start < token.end) start = end = token.end
    else if (start < token.end && end > token.start) {
      start = Math.min(start, token.start)
      end = Math.max(end, token.end)
    }
  }
  const locate = offset => {
    for (const segment of model.segments) {
      if (offset < segment.start || offset > segment.end) continue
      if (segment.node?.nodeType === 3) return point(segment.node, offset - segment.start)
      return offset === segment.start ? segment.from : segment.to
    }
    return point(root, root.childNodes.length)
  }
  const from = locate(start), to = locate(end)
  const range = root.ownerDocument.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  const selection = root.ownerDocument.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
}

export function createSkillToken(document, { name, iconUrl }) {
  const token = document.createElement('span')
  token.className = 'chat-skill-token'
  token.contentEditable = 'false'
  token.setAttribute('contenteditable', 'false')
  token.dataset.skillCommand = `/${name}`
  const icon = document.createElement('span')
  icon.className = 'chat-skill-token__icon'
  icon.setAttribute('aria-hidden', 'true')
  if (typeof iconUrl === 'string' && /^data:image\/(png|svg\+xml);base64,/.test(iconUrl)) {
    const image = document.createElement('img')
    image.src = iconUrl
    image.alt = ''
    image.draggable = false
    icon.append(image)
  } else {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('fill', 'none')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', 'M3 2.5h10v11H3zM6 2.5v5l2-1 2 1v-5')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '1.3')
    svg.append(path)
    icon.append(svg)
  }
  const label = document.createElement('span')
  label.className = 'chat-skill-token__label'
  label.textContent = name
  token.append(icon, label)
  return token
}

export function composerFragment(document, text, skills = []) {
  const fragment = document.createDocumentFragment()
  let offset = 0
  for (const skill of [...skills].sort((a, b) => a.start - b.start)) {
    if (!Number.isInteger(skill.start) || !Number.isInteger(skill.end) || skill.start < offset || skill.end > text.length
      || typeof skill.name !== 'string' || !skill.name || /[\s/\\]/.test(skill.name) || text.slice(skill.start, skill.end) !== `/${skill.name}`) continue
    fragment.append(document.createTextNode(text.slice(offset, skill.start)), createSkillToken(document, skill))
    offset = skill.end
  }
  fragment.append(document.createTextNode(text.slice(offset)))
  return fragment
}

export function renderComposer(root, text, skills = []) {
  root.replaceChildren(composerFragment(root.ownerDocument, text, skills))
}
