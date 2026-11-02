export const isFormattedBody = file => typeof file?.formattedBody?.markdown === 'string'

// Visibility is derived from the current draft, not a sticky "was pasted"
// flag, so deleting formatting and switching conversations cannot leave it on.
export function hasBodyFormatting(text) {
  if (typeof text !== 'string' || !text.trim()) return false
  if (/^(?: {0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+|`{3,}|~{3,})|\t| {4}\S)/m.test(text)) return true
  if (/^ {0,3}(?:[-*_]\s*){3,}$/m.test(text)) return true
  if (/\S.*\n {0,3}(?:=+|-+)\s*(?:\n|$)/.test(text)) return true
  if (/\|[^\n]*\n\s*\|?\s*:?-{3,}:?\s*\|/.test(text)) return true
  if (/(?<!\\)(?:\*\*\S[^\n]*?\*\*|__\S[^\n]*?__|~~\S[^\n]*?~~|`[^`\n]+`|\[[^\]\n]+\]\([^\n)]+\))/.test(text)) return true
  if (/(?<![\w\\])([*_])(?=\S)[^\n]+?\1(?!\w)/.test(text)) return true
  return /(?: {2}|(?<!\\)\\)\n/.test(text)
}

export function restoreBodyToInput(text, file) {
  const markdown = file.formattedBody.draft ?? file.formattedBody.markdown
  return text ? `${text}\n\n${markdown}` : markdown
}

// Commit only to the draft we saved. Other attachments added while IPC was
// pending are retained; changes to the source text invalidate the operation.
export function finishBodySave(start, current, saved, limit) {
  if (start.target !== current.target) return null
  const existing = start.path && current.attachments.find(file => file.path === start.path)
  if (start.path && (!isFormattedBody(existing) || existing.formattedBody.draft !== start.markdown)) return null
  if (!start.path && (current.text !== start.markdown || current.attachments.some(isFormattedBody) || current.attachments.length >= limit)) return null
  const file = { path: saved.path, name: saved.name, formattedBody: { markdown: start.markdown } }
  return {
    text: start.path ? current.text : '',
    attachments: start.path ? current.attachments.map(item => item === existing ? file : item) : [...current.attachments, file],
  }
}
