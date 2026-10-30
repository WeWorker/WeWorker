import routeAliases from '../../config/route-aliases.json'
import React, { useRef, useEffect, useState, useMemo, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { ExclamationCircleOutlined, FolderOpenOutlined, UnlockOutlined } from '@ant-design/icons'
import { useChatInputFillStore } from '../../store/chat-input-fill.js'
import { useSettingsStore } from '../../store/settings.js'
import { useSitesStore } from '../../store/sites.js'
import { useTerminalStore } from '../../store/terminal.js'
import { useUserFilesStore } from '../../store/user-files.js'
import {
  buildWebcliSlashCommands,
  filterChatSlashCommands,
  findChatBangTrigger,
} from '../../utils/chat-slash-commands.js'
import { basename, getPathsFromPasteEvent, mergeAttachmentPaths } from '../../utils/clipboard-files.js'
import { localFileUrl } from '../../utils/local-file-url.js'
import {
  acceptTerminalCompletion,
  getChatBangCompletionCandidates,
} from '../../utils/terminal-completion.js'
import FileGlyph, { getFileTypeLabel, getFileTypeMeta } from '../files/FileTypeIcon.jsx'
import { getChatCompletionPlacement } from '../../utils/chat-completion-placement.js'
import ContextPanel from './ContextPanel.jsx'
import ModelSelector from './ModelSelector.jsx'
import AppDropdownSelect from '../common/AppDropdownSelect.jsx'
import { normalizeThinkingEffort, THINKING_EFFORT_STORAGE_KEY } from '../../utils/thinking-effort.js'
import { shouldWarmupOnTextChange } from '../../utils/chat-warmup.js'
import { confirmChatPermissionMode } from '../../utils/chat-permission-confirmation.js'

const COLLAPSED_ATTACHMENT_COUNT = 10
const ATTACHMENT_CHIP_HEIGHT = 62
const DEFAULT_MAX_ATTACHMENTS = 60
const DEFAULT_PASTE_TEXT_ATTACHMENT_THRESHOLD = 20000
const CHAT_PERMISSION_MODE_STORAGE_KEY = 'weworker.chat.permission-mode'
const CHAT_PERMISSION_MODES = [
  { value: 'ask', label: '修改询问', icon: ExclamationCircleOutlined },
  { value: 'workspace', label: '工作区内修改', icon: FolderOpenOutlined },
  { value: 'full', label: '完全权限', icon: UnlockOutlined },
]

function readChatPermissionMode() {
  try {
    const value = window.localStorage.getItem(CHAT_PERMISSION_MODE_STORAGE_KEY)
    return CHAT_PERMISSION_MODES.some((mode) => mode.value === value) ? value : 'workspace'
  } catch { return 'workspace' }
}

// 命令路由友好别名。**生效口径以后端 `/router/aliases` 为准**（它读的是
// `router-config/aliases.json` + 用户覆盖层，经 Adapter 作用域过滤）；随包的
// `config/route-aliases.json` 只是后端暂不可用时的兜底，不再需要手工与后端对齐。
// !<工具全名> 与 !<友好别名> 直接点名工具 → 发聊天走智能路由；其余 !xxx 仍是 shell 命令。
const BUNDLED_ROUTER_BANG_ALIASES = new Set(routeAliases)

function isKnownRouterToolName(command) {
  const token = String(command || '').trim().split(/\s+/)[0]
  if (!token) return false
  const state = useSitesStore.getState()
  const configuredAliases = Array.isArray(state.routerAliases) ? state.routerAliases : []
  const aliasPool = configuredAliases.length > 0
    ? new Set(configuredAliases)
    : BUNDLED_ROUTER_BANG_ALIASES
  if (aliasPool.has(token)) return true
  for (const site of state.sites || []) {
    for (const tool of site?.tools || []) {
      if (tool?.name === token) return true
    }
  }
  return false
}

function getPlatformShell() {
  if (typeof navigator === 'undefined') return 'bash'
  const platform = String(navigator.userAgentData?.platform || navigator.platform || '').toLowerCase()
  return platform.includes('win') ? 'powershell' : 'bash'
}

export default function InputBar({
  onSend,
  onStop,
  disabled,
  streaming,
  text,
  onTextChange,
  attachments = [],
  onAttachmentsChange,
  onShellCommand,
  maxAttachments = DEFAULT_MAX_ATTACHMENTS,
  variant,
  embedded,
  attachmentTarget = 'welcome',
  contextSnapshot = null,
  historyMessages = [],
  onWarmup,
  allowQueue = false,
  queuePanel,
}) {
  const textareaRef = useRef(null)
  const composerRef = useRef(null)
  const inputSurfaceRef = useRef(null)
  const slashMenuRef = useRef(null)
  const composingRef = useRef(false)
  const attachmentsRef = useRef(attachments)
  const bangFilesLoadRequestedRef = useRef(false)
  const fillSeq = useChatInputFillStore((s) => s.seq)
  const isWelcome = variant === 'welcome'
  const maxTaHeight = isWelcome ? 220 : 120
  const hasAttachments = attachments.length > 0
  const attachmentLimit = Math.max(1, Number(maxAttachments) || DEFAULT_MAX_ATTACHMENTS)
  const pasteTextAttachmentThreshold = useSettingsStore((s) => s.pasteTextAttachmentThreshold)
  const contextLimit = useSettingsStore((s) => s.contextLimit)
  const textAttachmentThreshold = Math.max(1, Number(pasteTextAttachmentThreshold) || DEFAULT_PASTE_TEXT_ATTACHMENT_THRESHOLD)
  const overAttachmentLimit = attachments.length > attachmentLimit
  const [modelSelectionPending, setModelSelectionPending] = useState(false)
  const [thinkingEffort, setThinkingEffort] = useState(() => {
    try { return normalizeThinkingEffort(window.localStorage.getItem(THINKING_EFFORT_STORAGE_KEY)) } catch { return 'off' }
  })
  const [permissionMode, setPermissionMode] = useState(readChatPermissionMode)
  const handlePermissionModeChange = useCallback(async (value) => {
    const next = CHAT_PERMISSION_MODES.some((mode) => mode.value === value) ? value : 'workspace'
    if (!await confirmChatPermissionMode(next)) return
    setPermissionMode(next)
    try { window.localStorage.setItem(CHAT_PERMISSION_MODE_STORAGE_KEY, next) } catch {}
  }, [])
  const handleThinkingEffortChange = useCallback((value) => {
    const next = normalizeThinkingEffort(value)
    setThinkingEffort(next)
    try { window.localStorage.setItem(THINKING_EFFORT_STORAGE_KEY, next) } catch {}
  }, [])
  const inputDisabled = !!disabled || (!!streaming && !allowQueue) || modelSelectionPending
  const isCommandMode = String(text || '').trimStart().startsWith('!')
  const [attachmentNotice, setAttachmentNotice] = useState('')
  const [slashMenuState, setSlashMenuState] = useState(null)
  const [slashMenuPlacement, setSlashMenuPlacement] = useState(null)
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)
  const [bangCompletionSource, setBangCompletionSource] = useState(null)
  const [historyIndex, setHistoryIndex] = useState(-1)
  const historyDraftRef = useRef('')
  const historyNavigationRef = useRef(false)
  const minLineHeight = 22
  const chatAttachmentSeq = useUserFilesStore((s) => s.chatAttachmentSeq)
  const pendingChatAttachmentTarget = useUserFilesStore((s) => s.pendingChatAttachmentTarget)
  const pendingChatAttachments = useUserFilesStore((s) => s.pendingChatAttachments)
  const clearPendingChatAttachments = useUserFilesStore((s) => s.clearPendingChatAttachments)
  const userFilesRoot = useUserFilesStore((s) => s.directory)
  const userFiles = useUserFilesStore((s) => s.files)
  const loadUserFiles = useUserFilesStore((s) => s.load)
  const terminalSessions = useTerminalStore((s) => s.sessions)
  const commandHistory = useTerminalStore((s) => s.commandHistory)
  const sites = useSitesStore((s) => Array.isArray(s.sites) ? s.sites : [])
  const routerAliases = useSitesStore((s) => Array.isArray(s.routerAliases) ? s.routerAliases : [])
  const webcliSlashCommands = useMemo(() => buildWebcliSlashCommands(sites), [sites])
  const buildBangSlashItems = useCallback((query) => {
    const command = query || ''
    const cursor = command.length
    const candidates = getChatBangCompletionCandidates({
      command,
      cursor,
      sites,
      shell: getPlatformShell(),
      cwd: userFilesRoot,
      root: userFilesRoot,
      files: userFiles,
      sessions: terminalSessions,
      source: bangCompletionSource || 'auto',
      includeEmpty: true,
    })
    const items = candidates.map((candidate) => ({
      id: `bang:${candidate.kind || 'file'}:${candidate.value || candidate.name}`,
      title: candidate.name || candidate.value || 'command',
      command: candidate.value || candidate.name || '',
      description: candidate.description || commandCompletionKindLabel(candidate),
      kind: candidate.kind,
      isDirectory: candidate.isDirectory,
      candidate,
    }))
    // 路由别名属于命令，只在命令首词补全；文件页和参数位置不追加快捷指令。
    if (bangCompletionSource === 'files' || /\s/.test(command.trimStart())) return items
    const seen = new Set(items.map((item) => item.command.trim().replace(/\s+/g, '').toLowerCase()))
    const queryKey = command.trim().replace(/\s+/g, '').toLowerCase()
    for (const alias of routerAliases) {
      const text = String(alias || '').replace(/^!/, '').trim()
      if (!text || seen.has(text.toLowerCase())) continue
      if (queryKey && !text.toLowerCase().startsWith(queryKey)) continue
      seen.add(text.toLowerCase())
      items.push({
        id: `bang:alias:${text}`,
        title: `!${text}`,
        command: `${text} `,
        description: '智能路由直达别名',
        kind: 'alias',
        isDirectory: false,
        // 值为「去掉 `!` 的别名 + 空格」：applySlashItem 会补回 `!` 前缀。
        candidate: { name: `!${text}`, value: `${text} `, kind: 'alias' },
      })
    }
    return items
  }, [bangCompletionSource, routerAliases, sites, terminalSessions, userFiles, userFilesRoot])
  const slashItems = useMemo(() => {
    if (!slashMenuState) return []
    if (slashMenuState.kind === 'bang') return buildBangSlashItems(slashMenuState.query)
    return filterChatSlashCommands(webcliSlashCommands, slashMenuState.query)
  }, [buildBangSlashItems, slashMenuState, webcliSlashCommands])

  const inputHistory = useMemo(() => {
    const entries = []
    const seen = new Set()
    const add = (value) => {
      const textValue = String(value || '').trim()
      if (!textValue || seen.has(textValue)) return
      seen.add(textValue)
      entries.push(textValue)
    }

    for (const message of historyMessages || []) {
      if (message?.role !== 'user') continue
      const value = (message.content || [])
        .filter((block) => block?.type === 'text' && block.text)
        .map((block) => block.text)
        .join('')
      add(value)
    }
    for (const session of [...(terminalSessions || [])].reverse()) {
      const command = String(session?.command || '').trim()
      if (command) add(command.startsWith('!') ? command : `!${command}`)
    }
    for (const command of [...(commandHistory || [])].reverse()) {
      const value = String(command || '').trim()
      if (value) add(value.startsWith('!') ? value : `!${value}`)
    }
    return entries
  }, [commandHistory, historyMessages, terminalSessions])

  const navigateHistory = (direction) => {
    if (!inputHistory.length) return
    if (historyIndex < 0) historyDraftRef.current = text || ''
    const nextIndex = Math.max(-1, Math.min(inputHistory.length - 1, historyIndex + direction))
    if (nextIndex === historyIndex) return
    historyNavigationRef.current = true
    setHistoryIndex(nextIndex)
    onTextChange(nextIndex < 0 ? historyDraftRef.current : inputHistory[inputHistory.length - 1 - nextIndex])
    setSlashMenuState(null)
    setBangCompletionSource(null)
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    })
  }

  const syncSlashMenuPlacement = useCallback(() => {
    const composer = composerRef.current
    const surface = inputSurfaceRef.current
    if (!composer || !surface || !slashMenuState) {
      setSlashMenuPlacement(null)
      return
    }
    const composerRect = composer.getBoundingClientRect()
    const surfaceRect = surface.getBoundingClientRect()
    setSlashMenuPlacement(getChatCompletionPlacement({
      anchor: { top: composerRect.top, bottom: composerRect.bottom, left: surfaceRect.left, width: surfaceRect.width },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }))
  }, [slashMenuState])

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => {
    if (!pendingChatAttachments.length) return
    if (pendingChatAttachmentTarget !== attachmentTarget) return
    onAttachmentsChange?.([...attachmentsRef.current, ...pendingChatAttachments])
    clearPendingChatAttachments(chatAttachmentSeq)
  }, [attachmentTarget, chatAttachmentSeq, pendingChatAttachmentTarget, pendingChatAttachments, onAttachmentsChange, clearPendingChatAttachments])

  useEffect(() => {
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      const contentH = Math.max(ta.scrollHeight, isWelcome ? 100 : minLineHeight)
      ta.style.height = `${Math.min(contentH, maxTaHeight)}px`
    }
  }, [text, maxTaHeight, isWelcome])

  useEffect(() => {
    if (fillSeq > 0) requestAnimationFrame(() => textareaRef.current?.focus())
  }, [fillSeq])

  useEffect(() => {
    if (attachments.length < attachmentLimit && attachmentNotice) setAttachmentNotice('')
  }, [attachments.length, attachmentLimit, attachmentNotice])

  useEffect(() => {
    if (!slashMenuState) return undefined
    setSlashActiveIndex((current) => {
      if (slashItems.length === 0) return 0
      return Math.min(current, slashItems.length - 1)
    })
  }, [slashItems.length, slashMenuState])

  useEffect(() => {
    if (slashMenuState?.kind !== 'bang') return
    const mayNeedFiles = bangCompletionSource === 'files' || /\s/.test(slashMenuState.query || '')
    if (!mayNeedFiles || bangFilesLoadRequestedRef.current) return
    bangFilesLoadRequestedRef.current = true
    void loadUserFiles()
  }, [bangCompletionSource, loadUserFiles, slashMenuState])

  useEffect(() => {
    if (!slashMenuState || !slashMenuRef.current) return
    const active = slashMenuRef.current.querySelector('.chat-slash-menu-item.is-active')
    active?.scrollIntoView({ block: 'nearest' })
  }, [slashActiveIndex, slashMenuState])

  useLayoutEffect(() => {
    if (!slashMenuState) {
      setSlashMenuPlacement(null)
      return undefined
    }
    syncSlashMenuPlacement()
    const observer = new ResizeObserver(syncSlashMenuPlacement)
    observer.observe(composerRef.current)
    window.addEventListener('resize', syncSlashMenuPlacement)
    window.addEventListener('scroll', syncSlashMenuPlacement, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncSlashMenuPlacement)
      window.removeEventListener('scroll', syncSlashMenuPlacement, true)
    }
  }, [slashMenuState, text, syncSlashMenuPlacement])

  const syncSlashMenuFromText = (nextText, cursor) => {
    if (inputDisabled) {
      setSlashMenuState(null)
      setBangCompletionSource(null)
      return
    }
    const bangTrigger = findChatBangTrigger(nextText, cursor)
    const trigger = bangTrigger ? { ...bangTrigger, kind: 'bang' } : null
    if (!trigger) {
      setSlashMenuState(null)
      setBangCompletionSource(null)
      return
    }
    setSlashMenuState(trigger)
    setSlashActiveIndex(0)
  }

  const applySlashItem = (item) => {
    const textarea = textareaRef.current
    if (!textarea || !slashMenuState || !item) return
    const current = text || ''
    let replacement = item.command
    let keepMenuOpen = false
    if (slashMenuState.kind === 'bang' && item.candidate) {
      const completion = acceptTerminalCompletion({
        command: slashMenuState.query || '',
        cursor: String(slashMenuState.query || '').length,
        candidate: item.candidate,
      })
      if (!completion.completed) return
      replacement = `!${completion.command}`
      keepMenuOpen = item.candidate.isDirectory
        || ['cmd', 'webcli', 'subcommand', 'option', 'tool', 'site'].includes(item.candidate.kind)
    }
    const nextText = `${current.slice(0, slashMenuState.start)}${replacement}${current.slice(slashMenuState.end)}`
    const nextCursor = slashMenuState.start + replacement.length
    onTextChange(nextText)
    if (keepMenuOpen) {
      setSlashMenuState({
        kind: 'bang',
        query: replacement.slice(1),
        start: slashMenuState.start,
        end: nextCursor,
      })
    } else {
      setSlashMenuState(null)
    }
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const handleTextChange = (event) => {
    const nextText = event.target.value
    if (historyNavigationRef.current) {
      historyNavigationRef.current = false
    } else if (historyIndex >= 0) {
      setHistoryIndex(-1)
    }
    // Starting to type a message: let the Backend start its model process now.
    if (onWarmup && !streaming && !inputDisabled && shouldWarmupOnTextChange(text, nextText)) onWarmup(thinkingEffort)
    onTextChange(nextText)
    syncSlashMenuFromText(nextText, event.target.selectionStart ?? nextText.length)
  }

  const syncSlashMenuFromTextarea = () => {
    const textarea = textareaRef.current
    if (!textarea) return
    syncSlashMenuFromText(textarea.value, textarea.selectionStart ?? textarea.value.length)
  }

  const handleTextareaKeyUp = (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return
    syncSlashMenuFromTextarea()
  }

  const handlePaste = async (e) => {
    const attachClipboardImage = async () => {
      if (attachmentsRef.current.length >= attachmentLimit) {
        setAttachmentNotice(`最多只能添加 ${attachmentLimit} 个文件`)
        return true
      }
      try {
        const saved = await window.electronAPI?.saveClipboardImage?.()
        if (!saved?.path) return false
        onAttachmentsChange?.([...attachmentsRef.current, { path: saved.path, name: saved.name || basename(saved.path) }])
        setAttachmentNotice('')
        return true
      } catch (error) {
        console.error('[input] save clipboard image failed:', error)
        setAttachmentNotice('剪切板图片添加失败')
        return true
      }
    }

    const attachPastedText = async (content) => {
      if (attachmentsRef.current.length >= attachmentLimit) {
        setAttachmentNotice(`最多只能添加 ${attachmentLimit} 个文件`)
        return true
      }
      try {
        const saved = await window.electronAPI?.savePastedText?.(content)
        if (!saved?.path) return false
        onAttachmentsChange?.([...attachmentsRef.current, { path: saved.path, name: saved.name || basename(saved.path) }])
        setAttachmentNotice(`粘贴文本较长，已转换为 ${saved.name || 'txt'} 附件`)
        return true
      } catch (error) {
        console.error('[input] save pasted text failed:', error)
        setAttachmentNotice('粘贴文本转换失败')
        return true
      }
    }

    const filePaths = getPathsFromPasteEvent(e)
    if (filePaths.length) {
      e.preventDefault()
      const { attachments: next, notice } = mergeAttachmentPaths(attachments, filePaths, attachmentLimit)
      onAttachmentsChange?.(next)
      if (notice) setAttachmentNotice(notice)
      return
    }

    const hasClipboardImage = Array.from(e.clipboardData?.items || [])
      .some((item) => String(item?.type || '').startsWith('image/'))
    if (hasClipboardImage) {
      e.preventDefault()
      await attachClipboardImage()
      return
    }

    const pasted = e.clipboardData?.getData('text/plain') ?? ''
    if (!pasted) {
      if (await attachClipboardImage()) e.preventDefault()
      return
    }

    e.preventDefault()
    const cleaned = pasted.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
    if (cleaned.length > textAttachmentThreshold) {
      await attachPastedText(cleaned)
      return
    }
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart ?? 0
    const end = ta.selectionEnd ?? 0
    const current = text || ''
    const newText = current.slice(0, start) + cleaned + current.slice(end)
    onTextChange(newText)
    requestAnimationFrame(() => {
      const pos = start + cleaned.length
      ta.selectionStart = pos
      ta.selectionEnd = pos
    })
  }

  const handleKeyDown = (e) => {
    if (composingRef.current || e.nativeEvent?.isComposing || e.keyCode === 229) return
    if (slashMenuState) {
      if (
        slashMenuState.kind === 'bang'
        && ((e.key === 'Tab' && e.shiftKey) || (e.key === ' ' && e.ctrlKey))
      ) {
        e.preventDefault()
        const hasCommandItems = slashItems.some((item) => Boolean(item.kind))
        const nextSource = bangCompletionSource
          ? (bangCompletionSource === 'files' ? 'commands' : 'files')
          : (hasCommandItems ? 'files' : 'commands')
        setBangCompletionSource(nextSource)
        setSlashActiveIndex(0)
        return
      }
      if (e.key === 'ArrowDown' && slashItems.length > 0) {
        e.preventDefault()
        setSlashActiveIndex((current) => (current + 1) % slashItems.length)
        return
      }
      if (e.key === 'ArrowUp' && slashItems.length > 0) {
        e.preventDefault()
        setSlashActiveIndex((current) => (current - 1 + slashItems.length) % slashItems.length)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        const items = slashItems.length > 0
          ? slashItems
          : slashMenuState.kind === 'bang'
            ? buildBangSlashItems(slashMenuState.query)
            : filterChatSlashCommands(webcliSlashCommands, slashMenuState.query)
        if (items.length) {
          e.preventDefault()
          applySlashItem(items[Math.min(slashActiveIndex, items.length - 1)])
          return
        }
        if (e.key === 'Tab') {
          e.preventDefault()
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashMenuState(null)
        setBangCompletionSource(null)
        return
      }
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey) {
      const textarea = textareaRef.current
      const isSingleLine = !String(text || '').includes('\n')
      const atStart = textarea ? textarea.selectionStart === 0 && textarea.selectionEnd === 0 : true
      const atEnd = textarea ? textarea.selectionStart === textarea.value.length && textarea.selectionEnd === textarea.value.length : true
      if (isSingleLine && ((e.key === 'ArrowUp' && atStart) || (e.key === 'ArrowDown' && atEnd))) {
        e.preventDefault()
        navigateHistory(e.key === 'ArrowUp' ? 1 : -1)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (composingRef.current) return
      e.preventDefault()
      submit()
    }
  }

  const handleUpload = async () => {
    const paths = await window.electronAPI?.selectFiles?.()
    if (!paths?.length) return

    const remainingSlots = Math.max(attachmentLimit - attachments.length, 0)
    if (remainingSlots <= 0) {
      setAttachmentNotice(`\u6700\u591a\u53ea\u80fd\u6dfb\u52a0 ${attachmentLimit} \u4e2a\u6587\u4ef6`)
      return
    }

    const acceptedPaths = paths.slice(0, remainingSlots)
    const next = acceptedPaths.map((p) => ({ path: p, name: basename(p) }))
    onAttachmentsChange?.([...attachments, ...next])
    setAttachmentNotice(paths.length > remainingSlots
      ? `\u5df2\u8fbe\u5230 ${attachmentLimit} \u4e2a\u4e0a\u9650\uff0c\u53ea\u6dfb\u52a0\u4e86\u524d ${remainingSlots} \u4e2a`
      : '')
  }

  const submit = async () => {
    const trimmed = (text || '').trim()
    if ((!trimmed && !hasAttachments) || inputDisabled) return
    if (overAttachmentLimit) {
      setAttachmentNotice(`\u5df2\u9009 ${attachments.length}/${attachmentLimit}\uff0c\u8bf7\u5220\u51cf\u5230 ${attachmentLimit} \u4e2a\u4ee5\u5185`)
      return
    }
    if (trimmed.startsWith('!') && trimmed.slice(1).trim()) {
      const command = trimmed.slice(1).trim()
      // 命令路由：!<工具全名> / !<友好别名> 直接点名工具 → 发聊天走智能路由（llmMs=0 直调）；
      // 其余 !xxx 仍走 shell 命令（shell 优先，仅放行已知工具名）。
      if (isKnownRouterToolName(command)) {
        setSlashMenuState(null)
        setBangCompletionSource(null)
        onTextChange('')
        onAttachmentsChange?.([])
        setAttachmentNotice('')
        onSend(trimmed, attachments, thinkingEffort, permissionMode)
        textareaRef.current?.focus()
        return
      }
      setSlashMenuState(null)
      setBangCompletionSource(null)
      onTextChange('')
      onAttachmentsChange?.([])
      setAttachmentNotice('')
      await onShellCommand?.(command, trimmed)
      textareaRef.current?.focus()
      return
    }
    onSend(trimmed, attachments, thinkingEffort, permissionMode)
    onTextChange('')
    onAttachmentsChange?.([])
    setAttachmentNotice('')
    setSlashMenuState(null)
    setBangCompletionSource(null)
    textareaRef.current?.focus()
  }

  const focusTextarea = () => {
    if (inputDisabled) return
    window.electronAPI?.focusWindow?.()
    const focus = () => {
      const textarea = textareaRef.current
      if (!textarea || textarea.disabled) return
      textarea.focus()
    }
    focus()
    requestAnimationFrame(focus)
    window.setTimeout(focus, 0)
  }

  const handleInputSurfacePointerDown = (event) => {
    if (inputDisabled) return
    if (event.target?.closest?.('button, select, input, a, [role="button"], [data-chat-input-ignore-focus]')) return
    focusTextarea()
  }

  const outerStyle = embedded
    ? {
        padding: '12px 16px 14px',
        borderTop: 'none',
        background: 'transparent',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
      }
    : isWelcome
      ? {
          padding: '12px 20px 16px',
          borderTop: 'none',
          background: 'transparent',
          maxWidth: 680,
          width: '100%',
          margin: '0 auto',
          flexShrink: 0,
        }
      : {
          padding: '12px 32px 16px',
          borderTop: 'none',
          background: 'transparent',
          maxWidth: 1184,
          width: '100%',
          margin: '0 auto',
          boxSizing: 'border-box',
          pointerEvents: 'none',
        }

  const innerStyle = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 0,
    minHeight: hasAttachments ? 132 : (isWelcome ? 112 : 104),
    background: 'var(--bg-secondary)',
    border: '1px solid color-mix(in srgb, var(--border) 68%, var(--text-muted))',
    borderRadius: 16,
    padding: 0,
    boxShadow: 'none',
    pointerEvents: 'auto',
    overflow: 'hidden',
  }

  const buttonBase = {
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    flexShrink: 0,
    transition: 'background 0.15s',
  }

  const textareaEl = (
    <textarea
      data-weworker-chat-input="true"
      ref={textareaRef}
      value={text || ''}
      onChange={handleTextChange}
      onKeyDown={handleKeyDown}
      onClick={syncSlashMenuFromTextarea}
      onKeyUp={handleTextareaKeyUp}
      onPaste={handlePaste}
      onCompositionStart={() => { composingRef.current = true }}
      onCompositionEnd={() => { composingRef.current = false }}
      placeholder={streaming && allowQueue ? '输入后续消息...' : streaming ? '正在处理...' : inputDisabled ? '暂时无法输入...' : '输入消息...'}
      disabled={inputDisabled}
      rows={isWelcome ? 4 : 1}
      style={{
        width: '100%',
        flex: '1 1 auto',
        minWidth: 0,
        minHeight: isWelcome ? 58 : 48,
        padding: '14px 16px 12px',
        background: 'none',
        border: 'none',
        outline: 'none',
        color: 'var(--text-primary)',
        fontSize: 14,
        resize: 'none',
        maxHeight: maxTaHeight,
        overflowY: 'auto',
        lineHeight: 1.45,
        fontFamily: 'inherit',
        boxSizing: 'border-box',
      }}
      onInput={(e) => {
        const ta = e.target
        ta.style.height = 'auto'
        const contentH = Math.max(ta.scrollHeight, isWelcome ? 100 : minLineHeight)
        ta.style.height = `${Math.min(contentH, maxTaHeight)}px`
        syncSlashMenuFromText(ta.value, ta.selectionStart ?? ta.value.length)
      }}
    />
  )

  const uploadBtn = (
    <button
      type="button"
      onClick={handleUpload}
      disabled={inputDisabled}
      title="上传文件"
      aria-label="上传文件"
      style={{
        width: 28,
        height: 28,
        borderRadius: 7,
        border: 'none',
        background: 'transparent',
        color: 'var(--text-secondary)',
        cursor: inputDisabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 21, lineHeight: 1, fontWeight: 300 }}>+</span>
    </button>
  )

  const stopButton = (
    <button
      className="chat-input-action chat-input-action-stop"
      onClick={onStop}
      title="停止生成"
      style={{
        ...buttonBase,
        width: 30,
        height: 30,
        borderRadius: 8,
        background: '#8f8f93',
        border: 'none',
        color: '#fff',
        cursor: 'pointer',
        padding: 0,
        alignSelf: 'center',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 0,
      }}
    >
      Stop
    </button>
  )
  const sendButton = (
    <button
      className="chat-input-action chat-input-action-send"
      onClick={submit}
      title={streaming ? '发送消息，当前回复结束后发送' : '发送消息'}
      aria-label="发送消息"
      disabled={inputDisabled || (!(text || '').trim() && !hasAttachments) || overAttachmentLimit}
      style={{
        ...buttonBase,
        width: 30,
        height: 30,
        borderRadius: 8,
        background: (inputDisabled || (!(text || '').trim() && !hasAttachments) || overAttachmentLimit) ? '#8f8f93' : 'var(--text-primary)',
        border: 'none',
        color: 'var(--bg-secondary)',
        cursor: (inputDisabled || (!(text || '').trim() && !hasAttachments) || overAttachmentLimit) ? 'not-allowed' : 'pointer',
        padding: 0,
        alignSelf: 'center',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: (inputDisabled || (!(text || '').trim() && !hasAttachments) || overAttachmentLimit) ? 0.9 : 1,
        fontSize: 0,
      }}
    >
      Send
    </button>
  )
  const hasDraft = Boolean((text || '').trim() || hasAttachments)
  const actionBtn = streaming
    ? allowQueue && hasDraft ? sendButton : stopButton
    : sendButton

  const toolbarEl = (
    <div className="chat-input-toolbar" style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
      width: '100%',
      minHeight: 38,
      borderTop: '1px solid var(--border)',
      padding: '4px 10px',
      background: 'var(--bg-secondary)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
        {uploadBtn}
        <div
          className="chat-permission-picker-tooltip"
          title={`权限模式：${CHAT_PERMISSION_MODES.find(mode => mode.value === permissionMode)?.label || '工作区内修改'}`}
        >
          <AppDropdownSelect
            ariaLabel="权限模式"
            value={permissionMode}
            options={CHAT_PERMISSION_MODES}
            onChange={handlePermissionModeChange}
            renderOptionPrefix={option => option?.icon ? React.createElement(option.icon) : null}
            disabled={!!disabled}
            minMenuWidth={156}
            placement="top"
            className="chat-permission-picker"
          />
        </div>
      </div>
      <div className="chat-input-toolbar-actions">
        <ContextPanel snapshot={contextSnapshot} contextLimit={contextLimit} />
        <ModelSelector
          disabled={!!disabled || !!streaming}
          onPendingChange={setModelSelectionPending}
          thinkingEffort={thinkingEffort}
          onThinkingEffortChange={handleThinkingEffortChange}
        />
        {actionBtn}
      </div>
    </div>
  )

  const renderSlashMenu = () => {
    if (!slashMenuState || !slashMenuPlacement || typeof document === 'undefined') return null

    const panelStyle = {
      position: 'fixed',
      ...slashMenuPlacement,
      zIndex: 4000,
    }

    if (slashMenuState.kind === 'bang') {
      if (slashItems.length === 0) {
        return createPortal(
          <div className="skill-slash-menu chat-slash-menu chat-slash-menu--empty" style={panelStyle}>
            没有匹配的 Shell 命令
          </div>,
          document.body,
        )
      }

      return createPortal(
        <div className="skill-slash-menu chat-slash-menu" style={panelStyle}>
          <div className="chat-slash-menu-header">
            <span>{bangCompletionSource === 'files' ? '文件补全' : '命令补全'}</span>
            <span className="chat-slash-menu-shortcut"><kbd>Shift Tab</kbd> 切换命令 / 文件</span>
          </div>
          <div
            ref={slashMenuRef}
            className="skill-slash-menu-scroll chat-slash-menu-scroll scrollbar-hover-only"
            role="listbox"
            aria-label="Shell 命令提示"
          >
            <div className="chat-slash-menu-list">
              {slashItems.map((item, index) => {
                const active = index === slashActiveIndex
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`skill-slash-menu-item chat-slash-menu-item chat-slash-menu-item--terminal${active ? ' is-active' : ''}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setSlashActiveIndex(index)}
                    onClick={() => applySlashItem(item)}
                  >
                    <span className="chat-slash-menu-item__icon" aria-hidden="true">
                      <TerminalCommandIcon />
                    </span>
                    <span className="chat-slash-menu-item__body">
                      <span className="chat-slash-menu-item__title">{item.title}</span>
                      <span className="chat-slash-menu-item__hint">{item.description}</span>
                    </span>
                    <span className="chat-slash-menu-item__command">{commandCompletionKindLabel(item)}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="chat-slash-menu-footer">
            <span><kbd>↑</kbd> <kbd>↓</kbd> 选择</span>
            <span><kbd>Enter</kbd> / <kbd>Tab</kbd> 补全</span>
            <span><kbd>Esc</kbd> 关闭</span>
          </div>
        </div>,
        document.body,
      )
    }

    if (slashItems.length === 0) {
      return createPortal(
        <div className="skill-slash-menu chat-slash-menu chat-slash-menu--empty" style={panelStyle}>
          没有匹配的 webcli 命令
        </div>,
        document.body,
      )
    }

    return createPortal(
      <div className="skill-slash-menu chat-slash-menu" style={panelStyle}>
        <div
          ref={slashMenuRef}
          className="skill-slash-menu-scroll chat-slash-menu-scroll scrollbar-hover-only"
          role="listbox"
          aria-label="webcli 命令调用"
        >
          <div className="skill-slash-menu-group-title">webcli 命令调用</div>
          <div className="chat-slash-menu-list">
            {slashItems.map((item, index) => {
              const active = index === slashActiveIndex
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`skill-slash-menu-item chat-slash-menu-item${active ? ' is-active' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setSlashActiveIndex(index)}
                  onClick={() => applySlashItem(item)}
                >
                  <span className="chat-slash-menu-item__icon" aria-hidden="true">
                    <WebcliCommandIcon />
                  </span>
                  <span className="chat-slash-menu-item__body">
                    <span className="chat-slash-menu-item__title">{item.title}</span>
                    <span className="chat-slash-menu-item__hint">{item.description}</span>
                  </span>
                  <code className="chat-slash-menu-item__command">{item.command}</code>
                </button>
              )
            })}
          </div>
        </div>
      </div>,
      document.body,
    )
  }

  return (
    <div ref={composerRef} className="chat-input-composer" style={outerStyle}>
      {queuePanel}
      <div
        ref={inputSurfaceRef}
        data-chat-input-surface
        data-chat-command-mode={isCommandMode ? 'true' : 'false'}
        className={`chat-input-surface${isCommandMode ? ' chat-input-surface--command' : ''}`}
        style={innerStyle}
        onPointerDownCapture={handleInputSurfacePointerDown}
      >
        {hasAttachments && (
          <div style={{ padding: '12px 14px 0' }}>
            <AttachmentTray
              attachments={attachments}
              maxAttachments={attachmentLimit}
              notice={attachmentNotice}
              disabled={inputDisabled}
              onRemove={(idx) => onAttachmentsChange?.(attachments.filter((_, i) => i !== idx))}
            />
          </div>
        )}
        <div>
          {textareaEl}
        </div>
        {toolbarEl}
      </div>
      {renderSlashMenu()}
    </div>
  )
}

function WebcliCommandIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.75 4.25h10.5v7.5H2.75z" stroke="currentColor" strokeWidth="1.45" strokeLinejoin="round" />
      <path d="M4.75 6.25 6.25 8 4.75 9.75" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.5 9.75h3.25" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  )
}

function TerminalCommandIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4h11v8h-11z" stroke="currentColor" strokeWidth="1.45" strokeLinejoin="round" />
      <path d="M4.5 6.25 6.25 8 4.5 9.75" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.5 9.75h3.5" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  )
}

function commandCompletionKindLabel(item) {
  if (item?.kind === 'cmd') return '命令'
  if (item?.kind === 'webcli') return '命令'
  if (item?.kind === 'subcommand') return '子命令'
  if (item?.kind === 'option') return '参数'
  if (item?.kind === 'tool') return '工具'
  if (item?.kind === 'site') return '站点'
  if (item?.kind === 'alias') return '快捷指令'
  if (item?.isDirectory) return '文件夹'
  return '文件'
}

function AttachmentTray({ attachments, maxAttachments, notice, onRemove, disabled = false }) {
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (attachments.length <= COLLAPSED_ATTACHMENT_COUNT) setExpanded(false)
  }, [attachments.length])

  const overLimit = attachments.length > maxAttachments
  const hiddenCount = Math.max(attachments.length - COLLAPSED_ATTACHMENT_COUNT, 0)
  const visibleAttachments = expanded ? attachments : attachments.slice(0, COLLAPSED_ATTACHMENT_COUNT)

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', width: '100%', maxHeight: expanded ? 148 : 'none', overflowY: expanded ? 'auto' : 'visible', alignContent: 'flex-start' }}>
      <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 1 }}>
        <span style={{ fontSize: 11, fontWeight: 650, color: overLimit ? 'var(--error)' : 'var(--text-muted)' }}>
          {`\u5df2\u9009 ${attachments.length}/${maxAttachments} \u4e2a\u6587\u4ef6`}
        </span>
        {(notice || overLimit) && (
          <span style={{ fontSize: 11, color: overLimit ? 'var(--error)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {notice || `\u8bf7\u5220\u51cf\u5230 ${maxAttachments} \u4e2a\u4ee5\u5185`}
          </span>
        )}
      </div>
      {visibleAttachments.map((file, idx) => (
        <div key={`${file.path}-${idx}`} title={file.path} className="chat-attachment-card">
          <AttachmentPreview file={file} />
          <div className="chat-attachment-card__content">
            <div className="chat-attachment-card__name">{file.name}</div>
            <div className="chat-attachment-card__type">{getFileTypeLabel(file.name || file.path)}</div>
          </div>
          <button type="button" className="chat-attachment-card__remove" onClick={() => { if (!disabled) onRemove(idx) }} disabled={disabled} title="移除文件" aria-label="移除文件" />
        </div>
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? '\u6536\u8d77\u9644\u4ef6' : `\u5c55\u5f00\u5269\u4f59 ${hiddenCount} \u4e2a\u9644\u4ef6`}
          aria-label={expanded ? '\u6536\u8d77\u9644\u4ef6' : '\u5c55\u5f00\u66f4\u591a\u9644\u4ef6'}
          style={{ height: ATTACHMENT_CHIP_HEIGHT, minWidth: 58, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-primary)', color: 'var(--text-secondary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '0 9px', fontSize: 11, fontWeight: 650, fontFamily: 'inherit', flexShrink: 0 }}
        >
          <AttachmentToggleIcon expanded={expanded} />
          <span>{expanded ? '\u6536\u8d77' : `+${hiddenCount}`}</span>
        </button>
      )}
    </div>
  )
}

function AttachmentPreview({ file }) {
  const [failed, setFailed] = useState(false)
  const [thumbnailSrc, setThumbnailSrc] = useState('')
  const name = file.name || file.path
  const isImage = getFileTypeMeta(name).kind === 'image'

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    setThumbnailSrc('')
    if (!isImage || !file.path) return undefined

    window.electronAPI?.readLocalImageThumbnail?.(file.path)
      .then((src) => {
        if (cancelled) return
        setThumbnailSrc(src || localFileUrl(file.path))
      })
      .catch(() => {
        if (!cancelled) setThumbnailSrc(localFileUrl(file.path))
      })

    return () => {
      cancelled = true
    }
  }, [file.path, isImage])

  const src = isImage ? (thumbnailSrc || localFileUrl(file.path)) : ''

  if (src && !failed) {
    return (
      <span className="chat-attachment-card__thumb">
        <img src={src} alt="" onError={() => setFailed(true)} />
      </span>
    )
  }

  return (
    <span className="chat-attachment-card__icon" aria-hidden="true">
      <FileGlyph name={name} size={22} />
    </span>
  )
}

function AttachmentToggleIcon({ expanded }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.12s' }} aria-hidden="true">
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
