import React, { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { useChatDraftStore } from '../../store/chat-drafts.js'
import { composerFragment, createSkillToken, getComposerSelection, readComposer, renderComposer, setComposerSelection } from '../../utils/composer-dom.js'

const SKILL_CLIPBOARD_TYPE = 'application/x-weworker-skill-fragments'

// The browser owns edits and undo history; React only replaces externally changed drafts.
const ChatComposerInput = forwardRef(function ChatComposerInput({ value = '', draftKey, onChange, onInput, onKeyDown, onClick, onCompositionStart, onCompositionEnd, disabled, placeholder, rows: _rows, ...props }, ref) {
  const elementRef = useRef(null)
  const composing = useRef(false)
  const editing = useRef(false)
  const latest = useRef(null)
  latest.current = { disabled, onChange, onInput, draftKey }

  const emitInput = event => {
    const root = elementRef.current
    const model = readComposer(root)
    const callbacks = latest.current
    callbacks.onChange?.({ target: root, currentTarget: root, nativeEvent: event.nativeEvent || event })
    useChatDraftStore.getState().setSkillTokens(callbacks.draftKey, model.text, model.skills)
    callbacks.onInput?.({ target: root, currentTarget: root, nativeEvent: event.nativeEvent || event })
  }

  useLayoutEffect(() => {
    const root = elementRef.current
    Object.defineProperties(root, {
      value: { configurable: true, get: () => readComposer(root).text },
      selectionStart: { configurable: true, get: () => getComposerSelection(root).start, set: start => setComposerSelection(root, start, Math.max(start, getComposerSelection(root).end)) },
      selectionEnd: { configurable: true, get: () => getComposerSelection(root).end, set: end => setComposerSelection(root, Math.min(end, getComposerSelection(root).start), end) },
      disabled: { configurable: true, get: () => latest.current.disabled },
    })
    root.setSelectionRange = (start, end) => setComposerSelection(root, start, end)
    root.isSkillAtCursor = cursor => readComposer(root).skills.some(skill => skill.start < cursor && cursor <= skill.end)
    root.insertSkill = (item, start, end, replacement) => {
      root.focus()
      setComposerSelection(root, start, end)
      const container = root.ownerDocument.createElement('div')
      const command = item.command.trimEnd()
      container.append(createSkillToken(root.ownerDocument, { name: command.slice(1), iconUrl: item.iconUrl }), replacement.slice(command.length))
      return root.ownerDocument.execCommand('insertHTML', false, container.innerHTML)
    }
    root.pasteSkillFragment = clipboard => {
      try {
        const data = JSON.parse(clipboard.getData(SKILL_CLIPBOARD_TYPE) || 'null')
        if (!data || typeof data.text !== 'string' || data.text !== clipboard.getData('text/plain') || !Array.isArray(data.skills) || !data.skills.length) return false
        const container = root.ownerDocument.createElement('div')
        container.append(composerFragment(root.ownerDocument, data.text, data.skills))
        return root.ownerDocument.execCommand('insertHTML', false, container.innerHTML)
      } catch { return false }
    }
    const beforeInput = event => {
      if (event.inputType?.startsWith('format')) { event.preventDefault(); return }
      if (editing.current || composing.current || event.isComposing || !event.inputType?.startsWith('delete')) return
      const model = readComposer(root)
      let { start, end } = getComposerSelection(root)
      const backward = event.inputType.endsWith('Backward')
      const forward = event.inputType.endsWith('Forward')
      const selected = model.skills.filter(skill => start < skill.end && end > skill.start)
      if (start === end) {
        const adjacent = model.skills.find(skill => backward
          ? skill.end === start || (skill.end + 1 === start && model.text[skill.end] === ' ')
          : forward && (skill.start === end || (skill.start === end + 1 && model.text[end] === ' ')))
        if (adjacent) selected.push(adjacent)
      }
      if (!selected.length) return
      for (const skill of selected) { start = Math.min(start, skill.start); end = Math.max(end, skill.end) }
      event.preventDefault()
      editing.current = true
      try {
        setComposerSelection(root, start, end)
        root.ownerDocument.execCommand('delete')
      } finally { editing.current = false }
    }
    root.addEventListener('beforeinput', beforeInput)
    return () => root.removeEventListener('beforeinput', beforeInput)
  }, [])
  useImperativeHandle(ref, () => elementRef.current, [])

  useLayoutEffect(() => {
    const root = elementRef.current
    if (composing.current || readComposer(root).text === value) return
    const selection = getComposerSelection(root)
    const snapshot = useChatDraftStore.getState().drafts[draftKey]?.skillTokens
    renderComposer(root, value, snapshot?.text === value ? snapshot.items : [])
    if (root.ownerDocument.activeElement === root) setComposerSelection(root, Math.min(selection.start, value.length), Math.min(selection.end, value.length))
  }, [value, draftKey])

  const copySkills = event => {
    const root = elementRef.current
    const model = readComposer(root)
    const { start, end } = getComposerSelection(root)
    const selected = model.skills.filter(skill => skill.start >= start && skill.end <= end)
    if (!selected.length || !event.clipboardData) return
    const text = model.text.slice(start, end)
    event.clipboardData.setData('text/plain', text)
    event.clipboardData.setData(SKILL_CLIPBOARD_TYPE, JSON.stringify({ text, skills: selected.map(skill => ({ ...skill, start: skill.start - start, end: skill.end - start })) }))
    event.preventDefault()
    if (event.type === 'cut') root.ownerDocument.execCommand('delete')
  }

  return <div {...props} ref={elementRef} role="textbox" aria-label="消息输入" aria-multiline="true"
    aria-disabled={!!disabled} contentEditable={!disabled} suppressContentEditableWarning
    className="chat-composer-editor" data-placeholder={placeholder} data-empty={!value}
    onInput={emitInput} onKeyDown={onKeyDown} onCopy={copySkills} onCut={copySkills}
    onCompositionStart={event => { composing.current = true; onCompositionStart?.(event) }}
    onCompositionEnd={event => { composing.current = false; onCompositionEnd?.(event); emitInput(event) }}
    onClick={event => {
      // Hit testing stays on the editable host so Electron's native edit menu
      // remains available over an atom; resolve left-click selection by bounds.
      const token = [...elementRef.current.querySelectorAll('[data-skill-command]')].find(token => {
        const rect = token.getBoundingClientRect()
        return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
      })
      if (token) {
        const range = token.ownerDocument.createRange()
        range.selectNode(token)
        const selection = token.ownerDocument.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      }
      onClick?.(event)
    }}
    onErrorCapture={event => {
      const token = event.target.closest?.('[data-skill-command]')
      if (token && event.target.tagName === 'IMG') {
        const fallback = createSkillToken(token.ownerDocument, { name: token.dataset.skillCommand.slice(1) })
        event.target.parentElement.replaceChildren(...fallback.firstChild.childNodes)
      }
    }}
  />
})

export default ChatComposerInput
