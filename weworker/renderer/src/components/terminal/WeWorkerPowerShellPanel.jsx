import AppDropdownInput from '../common/AppDropdownInput.jsx'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTerminalStore } from '../../store/terminal.js'
import { useSitesStore } from '../../store/sites.js'
import { useUserFilesStore } from '../../store/user-files.js'
import { isNaturalLanguageInput } from '../../utils/terminal-command-detection.js'
import { scrollElementIntoContainer } from '../../utils/terminal-scroll.js'
import {
  acceptTerminalCompletion,
  completeTerminalCommand,
  getTerminalCommandCompletionCandidates,
  getTerminalCompletionCandidates,
  getTerminalHistoryCompletionCandidates,
  getWebcliCompletionCandidates,
  shouldUsePathCompletionForCommand,
} from '../../utils/terminal-completion.js'
import { PanelExpandIcon } from '../welcome/WelcomeIcons.jsx'

const DEFAULT_PROMPT = '~\\.weworker\\user-files'
const OUTPUT_ENCODING_OPTIONS = ['utf-8', 'gbk', 'gb18030', 'big5', 'shift_jis']

function promptPath(cwd) {
  return String(cwd || DEFAULT_PROMPT).replace(/\//g, '\\')
}

function sourceText(source) {
  return source === 'user' ? 'User' : 'AI'
}

function normalizeShell(shell) {
  return shell === 'powershell' ? 'powershell' : 'bash'
}

function shellPrompt(shell) {
  return normalizeShell(shell) === 'powershell' ? '>' : '$'
}

function isWindowsPlatform() {
  if (typeof navigator === 'undefined') return false
  const platform = String(navigator.userAgentData?.platform || navigator.platform || '').toLowerCase()
  return platform.includes('win')
}

function buildTranscript(sessions) {
  if (!sessions.length) return 'Shell console ready.\n'
  return [...sessions].reverse().map((session) => {
    const shell = normalizeShell(session.shell)
    const lines = [`[${sourceText(session.source)}:${shell}] ${promptPath(session.cwd)} ${shellPrompt(shell)} ${session.command}`]
    if (session.output) lines.push(session.output.trimEnd())
    if (session.error) lines.push(session.error)
    if (session.status !== 'running') lines.push(`[exit ${session.exitCode ?? 'error'}]`)
    return lines.filter(Boolean).join('\n')
  }).join('\n\n')
}

function sessionTime(session) {
  return Date.parse(session.startedAt || session.endedAt || '') || 0
}

function replyTime(reply) {
  return Date.parse(reply.createdAt || '') || 0
}

function buildTerminalContext(sessions, replies) {
  const sessionLines = sessions.slice(0, 6).map((session) => [
    `[${sourceText(session.source)}:${normalizeShell(session.shell)}] ${promptPath(session.cwd)} ${shellPrompt(session.shell)} ${session.command}`,
    session.output ? session.output.trimEnd().slice(-1200) : '',
    session.error || '',
    session.status !== 'running' ? `[exit ${session.exitCode ?? 'error'}]` : '',
  ].filter(Boolean).join('\n'))
  const replyLines = replies.slice(0, 4).map((reply) => [
    `[AI:${normalizeShell(reply.shell)}] ${promptPath(reply.cwd)} ${shellPrompt(reply.shell)} ${reply.input}`,
    reply.title,
    reply.message,
    reply.command ? `suggested: ${reply.command}` : '',
  ].filter(Boolean).join('\n'))
  return [...sessionLines, ...replyLines].join('\n\n').slice(-3000)
}

function formatCommandHistory(history) {
  const items = [...(history || [])].reverse()
  if (!items.length) return ''
  return items.map((item, index) => `${String(index + 1).padStart(5)}  ${item}`).join('\n')
}

export default function WeWorkerPowerShellPanel({ width = 420 }) {
  const sessions = useTerminalStore((s) => s.sessions)
  const assistantReplies = useTerminalStore((s) => s.assistantReplies)
  const commandHistory = useTerminalStore((s) => s.commandHistory)
  const closePanel = useTerminalStore((s) => s.closePanel)
  const maximized = useTerminalStore((s) => s.maximized)
  const toggleMaximized = useTerminalStore((s) => s.toggleMaximized)
  const clear = useTerminalStore((s) => s.clear)
  const rememberCommand = useTerminalStore((s) => s.rememberCommand)
  const addLocalSession = useTerminalStore((s) => s.addLocalSession)
  const runCommand = useTerminalStore((s) => s.runCommand)
  const stopCommand = useTerminalStore((s) => s.stopCommand)
  const assistTerminal = useTerminalStore((s) => s.assistTerminal)
  const running = useTerminalStore((s) => s.running)
  const error = useTerminalStore((s) => s.error)
  const shell = useTerminalStore((s) => s.shell)
  const setShell = useTerminalStore((s) => s.setShell)
  const outputEncoding = useTerminalStore((s) => s.outputEncoding)
  const setOutputEncoding = useTerminalStore((s) => s.setOutputEncoding)
  const sites = useSitesStore((s) => s.sites)
  const loadSites = useSitesStore((s) => s.load)
  const userFilesRoot = useUserFilesStore((s) => s.directory)
  const userFiles = useUserFilesStore((s) => s.files)
  const loadUserFiles = useUserFilesStore((s) => s.load)
  const [command, setCommand] = useState('')
  const [promptCwd, setPromptCwd] = useState('')
  const [completionItems, setCompletionItems] = useState([])
  const [activeCompletionIndex, setActiveCompletionIndex] = useState(0)
  const [completionPlacement, setCompletionPlacement] = useState('above')
  const [completionSourceOverride, setCompletionSourceOverride] = useState(null)
  const [contextMenu, setContextMenu] = useState(null)
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [historyDraft, setHistoryDraft] = useState('')
  const supportsPowerShell = isWindowsPlatform()
  const scrollRef = useRef(null)
  const inputWrapRef = useRef(null)
  const completionsRef = useRef(null)
  const completionsListRef = useRef(null)
  const inputRef = useRef(null)
  const promptRef = useRef(null)
  const screenRef = useRef(null)
  const [promptWidth, setPromptWidth] = useState(0)

  const latestSession = sessions[0] || null
  const activeCwd = latestSession?.cwd || promptCwd || userFilesRoot || ''
  const currentPrompt = promptPath(activeCwd || DEFAULT_PROMPT)
  const transcript = useMemo(() => buildTranscript(sessions), [sessions])
  const timeline = useMemo(() => {
    const commandItems = sessions.map((session) => ({ type: 'command', id: session.id, time: sessionTime(session), session }))
    const assistantItems = assistantReplies.map((reply) => ({ type: 'assistant', id: reply.id, time: replyTime(reply), reply }))
    return [...commandItems, ...assistantItems].sort((a, b) => a.time - b.time)
  }, [sessions, assistantReplies])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [transcript, timeline.length, latestSession?.output, latestSession?.status])

  useEffect(() => {
    if (sites.length > 0) return
    loadSites()
  }, [loadSites, sites.length])

  useEffect(() => {
    if (userFilesRoot) return
    loadUserFiles()
  }, [loadUserFiles, userFilesRoot])

  useEffect(() => {
    const platformShell = supportsPowerShell ? 'powershell' : 'bash'
    if (shell === platformShell) return
    setShell(platformShell)
  }, [setShell, shell, supportsPowerShell])

  useEffect(() => {
    if (!completionItems.length) return
    const wrap = inputWrapRef.current
    const scroll = scrollRef.current
    const menu = completionsRef.current
    if (!wrap || !scroll || !menu) return

    const wrapRect = wrap.getBoundingClientRect()
    const scrollRect = scroll.getBoundingClientRect()
    const menuHeight = Math.min(menu.scrollHeight || 0, 220) + 6
    const spaceAbove = wrapRect.top - scrollRect.top
    const spaceBelow = scrollRect.bottom - wrapRect.bottom
    const nextPlacement = spaceAbove >= menuHeight || spaceAbove >= spaceBelow ? 'above' : 'below'
    setCompletionPlacement((current) => current === nextPlacement ? current : nextPlacement)
  }, [completionItems.length, activeCompletionIndex, command, timeline.length])

  useEffect(() => {
    if (!completionItems.length) return
    const frame = requestAnimationFrame(() => {
      const menu = completionsRef.current
      const list = completionsListRef.current
      const scroll = scrollRef.current
      if (!menu || !scroll) return
      const activeItem = menu.querySelector('button.is-active')
      scrollElementIntoContainer(list || menu, activeItem, 4)
      scrollElementIntoContainer(scroll, menu, 10)
    })
    return () => cancelAnimationFrame(frame)
  }, [completionItems.length, activeCompletionIndex, completionPlacement])

  useEffect(() => {
    if (latestSession?.cwd) setPromptCwd(latestSession.cwd)
  }, [latestSession?.cwd])

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.max(24, input.scrollHeight)}px`
  }, [command, shell, activeCwd])

  useEffect(() => {
    const prompt = promptRef.current
    if (!prompt) return undefined
    const updatePromptWidth = () => {
      setPromptWidth(Math.ceil(prompt.getBoundingClientRect().width || 0))
    }
    updatePromptWidth()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(updatePromptWidth)
    observer.observe(prompt)
    return () => observer.disconnect()
  }, [currentPrompt, shell])

  useEffect(() => {
    if (!contextMenu) return undefined
    const close = () => setContextMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [contextMenu])

  const clearTerminal = () => {
    setPromptCwd(activeCwd)
    clear()
    setCompletionItems([])
    setActiveCompletionIndex(0)
    setCompletionSourceOverride(null)
    setHistoryIndex(-1)
    setHistoryDraft('')
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    const nextCommand = command.trim()
    if (!nextCommand || running) return
    if (/^(clear|cls)$/i.test(nextCommand)) {
      rememberCommand(nextCommand)
      setCommand('')
      clearTerminal()
      return
    }
    if (/^history$/i.test(nextCommand)) {
      const nextHistory = [nextCommand, ...commandHistory.filter((item) => item !== nextCommand)]
      addLocalSession({
        command: nextCommand,
        cwd: activeCwd || userFilesRoot || '',
        shell,
        output: formatCommandHistory(nextHistory),
        exitCode: 0,
      })
      setCompletionItems([])
      setActiveCompletionIndex(0)
      setCompletionSourceOverride(null)
      setHistoryIndex(-1)
      setHistoryDraft('')
      setCommand('')
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
    setCompletionItems([])
    setActiveCompletionIndex(0)
    setCompletionSourceOverride(null)
    setHistoryIndex(-1)
    setHistoryDraft('')
    setCommand('')
    if (isNaturalLanguageInput(nextCommand)) {
      await assistTerminal({
        input: nextCommand,
        cwd: activeCwd || '',
        shell,
        context: buildTerminalContext(sessions, assistantReplies),
      })
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
    await runCommand(nextCommand, activeCwd, shell, outputEncoding)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const runSuggestedCommand = async (nextCommand, cwd, nextShell) => {
    if (!nextCommand || running) return
    setCompletionItems([])
    setActiveCompletionIndex(0)
    setCompletionSourceOverride(null)
    await runCommand(nextCommand, cwd || activeCwd, nextShell || shell, outputEncoding)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const getPathCompletionItems = async (nextCommand, cursor, { force = false } = {}) => {
    if (!force && !shouldUsePathCompletionForCommand({ command: nextCommand, cursor })) return []
    if (!userFilesRoot) await loadUserFiles()
    const state = useUserFilesStore.getState()
    let candidates = getTerminalCompletionCandidates({
      command: nextCommand,
      cursor,
      cwd: latestSession?.cwd || promptCwd || state.directory,
      root: state.directory,
      files: state.files,
    })
    if (!candidates.length) {
      candidates = getTerminalHistoryCompletionCandidates({ command: nextCommand, cursor, sessions })
    }
    return candidates
  }

  const getCommandCompletionItems = (nextCommand, cursor) => {
    const commandCandidates = getTerminalCommandCompletionCandidates({ command: nextCommand, cursor })
    if (commandCandidates.length) return commandCandidates
    return getWebcliCompletionCandidates({ command: nextCommand, cursor, sites, shell })
  }

  const refreshCompletionItems = async (nextCommand, cursor, sourceOverride = completionSourceOverride) => {
    if (!String(nextCommand || '').trim()) {
      setCompletionItems([])
      setActiveCompletionIndex(0)
      setCompletionSourceOverride(null)
      return
    }

    if (sourceOverride === 'files') {
      const pathCandidates = await getPathCompletionItems(nextCommand, cursor, { force: true })
      setCompletionItems(pathCandidates)
      setActiveCompletionIndex(0)
      return
    }

    const commandCandidates = getCommandCompletionItems(nextCommand, cursor)
    if (commandCandidates.length || sourceOverride === 'commands') {
      setCompletionItems(commandCandidates)
      setActiveCompletionIndex(0)
      return
    }

    const candidates = await getPathCompletionItems(nextCommand, cursor)
    setCompletionItems(candidates)
    setActiveCompletionIndex(0)
  }

  const acceptCompletion = async (candidate = completionItems[activeCompletionIndex]) => {
    if (!candidate) return false
    const cursor = inputRef.current?.selectionStart ?? command.length
    const completion = acceptTerminalCompletion({ command, cursor, candidate })
    if (!completion.completed) return false
    setCommand(completion.command)
    setActiveCompletionIndex(0)
    if (['cmd', 'webcli', 'subcommand', 'option', 'tool', 'site'].includes(candidate.kind)) {
      setCompletionSourceOverride(null)
      setCompletionItems([])
      const nextCandidates = getWebcliCompletionCandidates({ command: completion.command, cursor: completion.cursor, sites, shell })
      if (!nextCandidates.length) {
        const pathCandidates = await getPathCompletionItems(completion.command, completion.cursor)
        setCompletionItems(pathCandidates)
        setActiveCompletionIndex(0)
        requestAnimationFrame(() => {
          inputRef.current?.focus()
          inputRef.current?.setSelectionRange(completion.cursor, completion.cursor)
        })
        return true
      }
      setCompletionItems(nextCandidates)
      setActiveCompletionIndex(0)
    } else {
      setCompletionSourceOverride(null)
      setCompletionItems([])
    }
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(completion.cursor, completion.cursor)
    })
    return true
  }

  const applyHistoryCommand = (nextCommand) => {
    setCommand(nextCommand)
    setCompletionItems([])
    setActiveCompletionIndex(0)
    setCompletionSourceOverride(null)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(nextCommand.length, nextCommand.length)
    })
  }

  const navigateCommandHistory = (direction) => {
    if (!commandHistory.length) return false
    const goingUp = direction < 0
    const nextIndex = goingUp
      ? (historyIndex < 0 ? 0 : Math.min(historyIndex + 1, commandHistory.length - 1))
      : (historyIndex <= 0 ? -1 : historyIndex - 1)

    if (goingUp && historyIndex < 0) setHistoryDraft(command)
    setHistoryIndex(nextIndex)
    applyHistoryCommand(nextIndex < 0 ? historyDraft : commandHistory[nextIndex])
    return true
  }

  const handleKeyDown = async (event) => {
    if (event.key === 'Enter' && /^(clear|cls)$/i.test(command.trim())) {
      event.preventDefault()
      if (!running) {
        rememberCommand(command.trim())
        setCommand('')
        clearTerminal()
      }
      return
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
      event.preventDefault()
      if (!running) event.currentTarget.form?.requestSubmit()
      return
    }

    if ((event.key === 'Tab' && event.shiftKey) || (event.key === ' ' && event.ctrlKey)) {
      event.preventDefault()
      const cursor = event.currentTarget.selectionStart ?? command.length
      const hasCommandItems = completionItems.some((item) => item.kind)
        || getCommandCompletionItems(command, cursor).length > 0
      const nextSource = completionSourceOverride
        ? (completionSourceOverride === 'files' ? 'commands' : 'files')
        : (hasCommandItems ? 'files' : 'commands')
      setCompletionSourceOverride(nextSource)
      await refreshCompletionItems(command, cursor, nextSource)
      return
    }

    if (event.key === 'Escape' && completionItems.length) {
      event.preventDefault()
      setCompletionItems([])
      setActiveCompletionIndex(0)
      setCompletionSourceOverride(null)
      return
    }

    if (event.key === 'ArrowDown' && completionItems.length) {
      event.preventDefault()
      setActiveCompletionIndex((index) => (index + 1) % completionItems.length)
      return
    }

    if (event.key === 'ArrowUp' && completionItems.length) {
      event.preventDefault()
      setActiveCompletionIndex((index) => (index - 1 + completionItems.length) % completionItems.length)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      navigateCommandHistory(-1)
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      navigateCommandHistory(1)
      return
    }

    if (event.key !== 'Tab') return
    event.preventDefault()
    const cursor = event.currentTarget.selectionStart ?? command.length

    if (completionItems.length) {
      const visibleCandidate = completionItems[activeCompletionIndex] || completionItems[0]
      if (await acceptCompletion(visibleCandidate)) return
    }

    const commandCandidates = getTerminalCommandCompletionCandidates({ command, cursor })
    if (commandCandidates.length) {
      setCompletionItems(commandCandidates)
      setActiveCompletionIndex(0)
      if (await acceptCompletion(commandCandidates[activeCompletionIndex] || commandCandidates[0])) return
    }

    const webcliCandidates = getWebcliCompletionCandidates({ command, cursor, sites, shell })
    if (webcliCandidates.length) {
      setCompletionItems(webcliCandidates)
      setActiveCompletionIndex(0)
      if (await acceptCompletion(webcliCandidates[activeCompletionIndex] || webcliCandidates[0])) return
    }

    const candidates = await getPathCompletionItems(command, cursor)
    const state = useUserFilesStore.getState()
    const completion = completeTerminalCommand({
      command,
      cursor,
      cwd: latestSession?.cwd || promptCwd || state.directory,
      root: state.directory,
      files: state.files,
    })
    setCompletionItems(candidates)
    setActiveCompletionIndex(0)
    if (candidates.length && await acceptCompletion(candidates[activeCompletionIndex] || candidates[0])) return
    if (completion.completed) {
      setCommand(completion.command)
      requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(completion.cursor, completion.cursor)
      })
    }
  }

  const getSelectedTerminalText = () => {
    const input = inputRef.current
    if (document.activeElement === input && input.selectionStart !== input.selectionEnd) {
      return command.slice(input.selectionStart, input.selectionEnd)
    }
    return String(window.getSelection?.()?.toString?.() || '')
  }

  const openTerminalContextMenu = (event) => {
    event.preventDefault()
    event.stopPropagation()
    const selectedText = getSelectedTerminalText()
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      selectedText,
    })
  }

  const handleTerminalMouseDown = (event) => {
    if (event.button === 2) {
      openTerminalContextMenu(event)
      return
    }
    inputRef.current?.focus()
  }

  const copySelection = async () => {
    const selectedText = contextMenu?.selectedText || ''
    if (!selectedText) return
    await navigator.clipboard?.writeText(selectedText)
    setContextMenu(null)
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  const pasteClipboard = async () => {
    let clipboardText = ''
    try {
      clipboardText = await navigator.clipboard?.readText?.()
    } catch (error) {
      console.warn('[terminal] read clipboard failed:', error)
    }
    if (!clipboardText) {
      setContextMenu(null)
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
    const input = inputRef.current
    const start = input?.selectionStart ?? command.length
    const end = input?.selectionEnd ?? start
    const nextCommand = `${command.slice(0, start)}${clipboardText}${command.slice(end)}`
    const nextCursor = start + clipboardText.length
    setCommand(nextCommand)
    setContextMenu(null)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(nextCursor, nextCursor)
      refreshCompletionItems(nextCommand, nextCursor)
    })
  }
  const handleContextMenu = (event) => {
    openTerminalContextMenu(event)
  }

  useEffect(() => {
    const screen = screenRef.current
    if (!screen) return undefined

    const openFromNativeEvent = (event) => {
      if (!screen.contains(event.target)) return
      if (event.target?.closest?.('.weworker-terminal-context-menu')) return
      if (event.type === 'pointerdown' && event.button !== 2) return
      openTerminalContextMenu(event)
    }

    document.addEventListener('pointerdown', openFromNativeEvent, true)
    document.addEventListener('contextmenu', openFromNativeEvent, true)
    return () => {
      document.removeEventListener('pointerdown', openFromNativeEvent, true)
      document.removeEventListener('contextmenu', openFromNativeEvent, true)
    }
  }, [command])

  const updateCommand = (event) => {
    const nextCommand = event.target.value
    const cursor = event.target.selectionStart ?? nextCommand.length
    setHistoryIndex(-1)
    setHistoryDraft('')
    setCommand(nextCommand)
    refreshCompletionItems(nextCommand, cursor, completionSourceOverride)
  }
  const updateCompletionsFromCursor = (event) => {
    refreshCompletionItems(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)
  }

  useEffect(() => {
    if (!String(command || '').trim()) return
    const cursor = inputRef.current?.selectionStart ?? command.length
    refreshCompletionItems(command, cursor)
  }, [sites.length, shell])

  const contextMenuNode = contextMenu && typeof document !== 'undefined'
    ? createPortal(
      <div
        className="weworker-terminal-context-menu"
        style={{
          left: Math.min(contextMenu.x, window.innerWidth - 120),
          top: Math.min(contextMenu.y, window.innerHeight - 72),
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <button type="button" disabled={!contextMenu.selectedText} onClick={copySelection}>复制</button>
        <button type="button" onClick={pasteClipboard}>粘贴</button>
      </div>,
      document.body,
    )
    : null

  return (
    <aside className="weworker-terminal-panel" style={{ width }}>
      <header className="weworker-terminal-panel__header">
        <div className="weworker-terminal-panel__title">
          <button
            type="button"
            className={`weworker-terminal-panel__maximize-button${maximized ? ' is-maximized' : ''}`}
            onClick={toggleMaximized}
            aria-label={maximized ? '恢复 Shell 面板' : '展开 Shell 面板'}
            aria-pressed={maximized}
            title={maximized ? '恢复' : '展开'}
          >
            <PanelExpandIcon size={15} />
          </button>
          <span className="weworker-terminal-panel__icon" aria-hidden="true"><TerminalGlyph /></span>
          <span>
            <strong>Shell</strong>
            <small>{supportsPowerShell ? 'PowerShell' : 'bash'}</small>
          </span>
        </div>
        <div className="weworker-terminal-panel__actions">
          <div className="weworker-terminal-encoding">
            <span>编码</span>
            <AppDropdownInput ariaLabel="Shell 输出编码" value={outputEncoding} options={OUTPUT_ENCODING_OPTIONS.map(value => ({ value, label: value }))} onChange={event => setOutputEncoding(event.target.value)} onBlur={event => setOutputEncoding(event.target.value)} spellCheck={false} autoComplete="off" />
          </div>
          <div className="weworker-terminal-shell-switch" role="tablist" aria-label="Shell 类型">
            {supportsPowerShell ? (
              <button
                type="button"
                className={shell === 'powershell' ? 'is-active' : ''}
                onClick={() => setShell('powershell')}
                aria-selected={shell === 'powershell'}
              >
                PowerShell
              </button>
            ) : (
              <button
                type="button"
                className={shell === 'bash' ? 'is-active' : ''}
                onClick={() => setShell('bash')}
                aria-selected={shell === 'bash'}
              >
                bash
              </button>
            )}
          </div>
          {running ? (
            <button type="button" onClick={stopCommand}>停止</button>
          ) : (
            <button type="button" onClick={clearTerminal} disabled={!sessions.length && !assistantReplies.length}>清空</button>
          )}
          <button type="button" onClick={closePanel} aria-label="关闭 Shell">×</button>
        </div>
      </header>

      <section ref={screenRef} className="weworker-terminal-screen" onMouseDown={handleTerminalMouseDown} onContextMenu={handleContextMenu} aria-label="Shell terminal">
        <div ref={scrollRef} className="weworker-terminal-screen__scroll">
          {timeline.length === 0 ? (
            <pre className="weworker-terminal-screen__output">Shell console ready.</pre>
          ) : (
            timeline.map((item) => item.type === 'assistant'
              ? <TerminalAssistantCard key={item.id} reply={item.reply} running={running} onRun={runSuggestedCommand} />
              : <TerminalCommandBlock key={item.id} session={item.session} />
            )
          )}
          {error && <div className="weworker-terminal-screen__error">{error}</div>}
          <div ref={inputWrapRef} className="weworker-terminal-input-wrap">
            <form className="weworker-terminal-line" onSubmit={handleSubmit} style={{ '--terminal-prompt-width': `${promptWidth}px` }}>
              <span ref={promptRef} className="weworker-terminal-line__prompt">{currentPrompt} {shellPrompt(shell)}</span>
              <textarea
                ref={inputRef}
                value={command}
                onChange={updateCommand}
                onKeyDown={handleKeyDown}
                onClick={updateCompletionsFromCursor}
                onKeyUp={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') updateCompletionsFromCursor(event)
                }}
                disabled={running}
                spellCheck={false}
                autoComplete="off"
                rows={1}
                placeholder="输入自然语言或命令"
              />
            </form>
            {completionItems.length > 0 && (
              <div
                ref={completionsRef}
                className={`weworker-terminal-completions is-${completionPlacement}`}
                aria-live="polite"
              >
                <div ref={completionsListRef} className="weworker-terminal-completions__list">
                  {completionItems.slice(0, 12).map((item, index) => (
                    <button
                      key={item.value}
                      type="button"
                      className={`${item.isDirectory ? 'is-directory' : ''}${item.kind === 'cmd' ? ' is-command' : ''}${item.kind === 'webcli' || item.kind === 'subcommand' ? ' is-webcli' : ''}${item.kind === 'option' ? ' is-option' : ''}${item.kind === 'tool' ? ' is-tool' : ''}${item.kind === 'site' ? ' is-site' : ''}${item.kind === 'value' ? ' is-value' : ''}${index === activeCompletionIndex ? ' is-active' : ''}`}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        void acceptCompletion(item)
                      }}
                      title={item.description || item.value}
                    >
                      <span className="weworker-terminal-completions__name">{item.value}</span>
                      <span className="weworker-terminal-completions__kind">{item.kind === 'cmd' ? 'cmd' : item.kind === 'webcli' ? 'webcli' : item.kind === 'subcommand' ? 'sub' : item.kind === 'option' ? 'arg' : item.kind === 'tool' ? 'tool' : item.kind === 'site' ? 'site' : item.kind === 'value' ? 'arg' : (item.isDirectory ? 'dir' : 'file')}</span>
                    </button>
                  ))}
                  {completionItems.length > 12 && <div className="weworker-terminal-completions__more">+{completionItems.length - 12} more</div>}
                </div>
                <div className="weworker-terminal-completions__hint">Tab 补全 · Shift+Tab 切换文件/命令 · ↑↓ 选择 · Esc 关闭</div>
              </div>
            )}
          </div>
        </div>
      </section>
      {contextMenuNode}
    </aside>
  )
}

function TerminalCommandBlock({ session }) {
  const shell = normalizeShell(session.shell)
  const lines = [`[${sourceText(session.source)}:${shell}] ${promptPath(session.cwd)} ${shellPrompt(shell)} ${session.command}`]
  if (session.output) lines.push(session.output.trimEnd())
  if (session.error) lines.push(session.error)
  if (session.status !== 'running') lines.push(`[exit ${session.exitCode ?? 'error'}]`)

  return (
    <pre className="weworker-terminal-screen__output">{lines.filter(Boolean).join('\n')}</pre>
  )
}

function TerminalAssistantCard({ reply, running, onRun }) {
  const shell = normalizeShell(reply.shell)
  const prompt = shellPrompt(shell)
  return (
    <div className={`weworker-terminal-agent-turn${reply.loading ? ' is-loading' : ''}${reply.error ? ' has-error' : ''}`}>
      <div className="weworker-terminal-natural-line">
        <span className="weworker-terminal-line__prompt">{promptPath(reply.cwd)} {prompt}</span>
        <span>{reply.input}</span>
      </div>
      <div className="weworker-terminal-agent-card">
        <div className="weworker-terminal-agent-card__body">
          <span className="weworker-terminal-agent-card__dot" aria-hidden="true" />
          <div className="weworker-terminal-agent-card__content">
            <div className="weworker-terminal-agent-card__meta">
              <span>WeWorker Shell</span>
              {reply.loading && <span>thinking</span>}
            </div>
            <div className="weworker-terminal-agent-card__title">{reply.title}</div>
            {reply.bullets?.length > 0 && (
              <ul>
                {reply.bullets.map((item) => <li key={item}>{item}</li>)}
              </ul>
            )}
            {reply.message && <p>{reply.message}</p>}
            {reply.command && (
              <div className="weworker-terminal-agent-card__command">
                <span>{prompt}</span>
                <code>{reply.command}</code>
              </div>
            )}
          </div>
        </div>
        {reply.command && (
          <div className="weworker-terminal-agent-card__actions">
            <button data-app-button="action"
              type="button"
              className="weworker-terminal-agent-card__run"
              onClick={() => onRun(reply.command, reply.cwd, shell)}
              disabled={running}
            >
              执行建议命令
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function TerminalGlyph({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16v12H4z" />
      <path d="m7 10 3 2-3 2" />
      <path d="M12 15h5" />
    </svg>
  )
}
