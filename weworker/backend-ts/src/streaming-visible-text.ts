import { MEMORY_BLOCK_CLOSE, MEMORY_BLOCK_OPEN } from './memory/memory-extractor.js'

/** Filters display-only data; the caller retains the original text for memory extraction. */
export class StreamingVisibleText {
  private pending = ''
  private hidden: 'memory' | 'image' | 'thinking' | undefined
  private whitespace = ''
  private started = false

  push(delta: string): string {
    this.pending += delta
    let visible = ''
    while (this.pending) {
      if (this.hidden) {
        const end = this.hidden === 'memory'
          ? MEMORY_BLOCK_CLOSE
          : this.hidden === 'image' ? ')' : '</think>'
        const haystack = this.hidden === 'thinking' ? this.pending.toLowerCase() : this.pending
        const index = haystack.indexOf(end)
        if (index < 0) {
          let keep = 0
          for (let length = 1; length < end.length; length++) {
            if (haystack.endsWith(end.slice(0, length))) keep = length
          }
          this.pending = keep ? this.pending.slice(-keep) : ''
          break
        }
        this.pending = this.pending.slice(index + end.length)
        this.hidden = undefined
        continue
      }
      if (this.pending.startsWith(MEMORY_BLOCK_OPEN)) {
        this.pending = this.pending.slice(MEMORY_BLOCK_OPEN.length)
        this.hidden = 'memory'
        continue
      }
      if (MEMORY_BLOCK_OPEN.startsWith(this.pending)) break
      const lowerPending = this.pending.toLowerCase()
      if (lowerPending.startsWith('<think>')) {
        this.pending = this.pending.slice('<think>'.length)
        this.hidden = 'thinking'
        continue
      }
      if ('<think>'.startsWith(lowerPending)) break
      if (lowerPending.startsWith('</think>')) {
        this.pending = this.pending.slice('</think>'.length)
        continue
      }
      if (this.pending.startsWith('![')) {
        const labelEnd = this.pending.indexOf(']')
        if (labelEnd < 0) break
        const target = this.pending.slice(labelEnd + 1)
        const prefix = '(data:image/'
        if (prefix.startsWith(target)) break
        if (target.startsWith(prefix)) {
          this.pending = target.slice(prefix.length)
          this.hidden = 'image'
          continue
        }
      } else if (this.pending === '!') break
      // Stop at the next possible marker, retaining only ambiguous suffixes.
      const next = this.pending.slice(1).search(/[<!]/u)
      const length = next < 0 ? this.pending.length : next + 1
      visible += this.pending.slice(0, length)
      this.pending = this.pending.slice(length)
    }
    return this.emit(visible)
  }

  finish(): string {
    // An incomplete hidden tag/body must never flash in the UI.
    const incompleteMarker = this.pending && (
      MEMORY_BLOCK_OPEN.startsWith(this.pending)
      || '<think>'.startsWith(this.pending.toLowerCase())
    )
    const visible = this.hidden || incompleteMarker ? '' : this.pending
    this.pending = ''
    const result = this.emit(visible)
    this.whitespace = ''
    return result
  }

  private emit(text: string): string {
    let value = this.whitespace + text
    if (!this.started) value = value.trimStart()
    const trimmed = value.trimEnd()
    this.whitespace = value.slice(trimmed.length)
    if (trimmed) this.started = true
    return trimmed
  }
}

/** Remove provider-emitted reasoning tags from a complete assistant block. */
export function stripThinkingTags(text: string): string {
  return String(text || '')
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<\/think>/gi, '')
}
