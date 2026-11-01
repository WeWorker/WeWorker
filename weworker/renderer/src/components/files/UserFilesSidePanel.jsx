import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUserFilesStore } from '../../store/user-files.js'
import { showAlert } from '../../store/dialog.js'
import { collectClipboardFilePaths, readClipboardFilePaths } from '../../utils/clipboard-files.js'
import Tooltip from '../Tooltip.jsx'
import { CollapseAllIcon, FilePlusIcon, FolderIcon, FolderPlusIcon, RefreshIcon, RenameIcon, SearchIcon, TrashIcon } from '../icons/PanelIcons.jsx'
import FileGlyph from './FileTypeIcon.jsx'

const ROW_HEIGHT = 27
const CONTEXT_MENU_WIDTH = 250
const CONTEXT_MENU_MARGIN = 8

const toolbarBtnStyle = {
  width: 26,
  height: 26,
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  flexShrink: 0,
}

function ChevronIcon({ open }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}

function flattenTree(items, expanded, depth = 0, rows = []) {
  for (const item of items || []) {
    rows.push({ item, depth })
    if (item.is_directory && expanded.has(item.path)) {
      flattenTree(item.children || [], expanded, depth + 1, rows)
    }
  }
  return rows
}

function collectDirectoryPaths(items, paths = new Set()) {
  for (const item of items || []) {
    if (!item.is_directory) continue
    paths.add(item.path)
    collectDirectoryPaths(item.children || [], paths)
  }
  return paths
}

function itemMatchesSearch(item, tokens) {
  const haystack = `${item.name || ''} ${item.path || ''}`.toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

function filterTreeBySearch(items, tokens) {
  if (!tokens.length) return items || []
  const filtered = []

  for (const item of items || []) {
    const selfMatches = itemMatchesSearch(item, tokens)
    const matchingChildren = item.is_directory ? filterTreeBySearch(item.children || [], tokens) : []

    if (selfMatches) {
      filtered.push(item)
    } else if (matchingChildren.length) {
      filtered.push({ ...item, children: matchingChildren })
    }
  }

  return filtered
}

function countChildren(items) {
  let count = 0
  for (const item of items || []) {
    count += 1
    if (item.is_directory) count += countChildren(item.children || [])
  }
  return count
}

function findNodeByPath(items, targetPath) {
  for (const item of items || []) {
    if (item.path === targetPath) return item
    const found = findNodeByPath(item.children || [], targetPath)
    if (found) return found
  }
  return null
}

function directoryDisplayName(directory) {
  return directory?.split(/[\\/]/).filter(Boolean).pop() || '\u7528\u6237\u76ee\u5f55'
}

function normalizeSlashes(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function toRelativeUserPath(itemPath, rootDirectory) {
  const rootNorm = normalizeSlashes(rootDirectory)
  const itemNorm = normalizeSlashes(itemPath)
  if (!rootNorm || !itemNorm) return itemNorm || ''
  if (itemNorm.toLowerCase() === rootNorm.toLowerCase()) return '.'
  const prefix = `${rootNorm}/`
  if (itemNorm.toLowerCase().startsWith(prefix.toLowerCase())) {
    return itemNorm.slice(rootNorm.length).replace(/^\/+/, '')
  }
  return itemNorm.split('/').pop() || itemNorm
}

function InlineNameRow({ depth, value, placeholder, icon, onChange, onSubmit, onCancel }) {
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const indent = 10 + depth * 18

  return (
    <div style={{ height: ROW_HEIGHT, display: 'flex', alignItems: 'center', paddingLeft: indent, paddingRight: 10, gap: 4, background: 'var(--bg-hover)', position: 'relative' }}>
      {depth > 0 && <span style={{ position: 'absolute', left: 12 + (depth - 1) * 18, top: 0, bottom: 0, width: 1, background: 'var(--border)', opacity: 0.65 }} />}
      <span style={{ width: 16, height: 16, flexShrink: 0 }} />
      <span style={{ width: 17, height: 17, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d28b26' }}>{icon}</span>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit()
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={() => { if (value.trim()) onSubmit(); else onCancel() }}
        placeholder={placeholder}
        style={{ flex: 1, minWidth: 0, height: 22, border: '1px solid var(--accent)', borderRadius: 3, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, padding: '1px 5px', outline: 'none', fontFamily: 'inherit' }}
      />
    </div>
  )
}

const rowActionBtnStyle = {
  width: 20,
  height: 20,
  border: 'none',
  borderRadius: 3,
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
}

function TreeRow({ row, rowRef, expanded, selectedPath, dragTargetPath, externalDragActive, internalDragSourcePath, internalDragTargetPath, onToggle, onSelect, onOpen, onCreateFile, onCreateFolder, onRename, onDelete, onContextMenu, onDragTarget, onInternalDragStart, onInternalDragEnd, onInternalDragOver, onInternalDrop }) {
  const { item, depth } = row
  const isRoot = !!item.is_root
  const isOpen = expanded.has(item.path)
  const isSelected = selectedPath === item.path
  const isDragTarget = externalDragActive && item.is_directory && dragTargetPath === item.path
  const isInternalDragTarget = item.is_directory && internalDragTargetPath === item.path
  const isDragging = internalDragSourcePath === item.path
  const [hovered, setHovered] = useState(false)
  const indent = 10 + depth * 18
  const nameColor = 'var(--text-secondary)'
  const rowActive = isDragTarget || isInternalDragTarget
  const rowBackground = rowActive
    ? 'color-mix(in srgb, var(--accent) 16%, var(--bg-secondary))'
    : (isSelected ? 'var(--bg-hover)' : (hovered ? 'var(--bg-tertiary)' : 'transparent'))

  const handleClick = () => {
    if (item.is_directory) onToggle(item.path)
    else onSelect(item.path)
  }

  const handleDoubleClick = () => {
    if (!item.is_directory) onOpen(item.path)
  }

  const handleDragOver = (e) => {
    if (internalDragSourcePath) {
      e.preventDefault()
      e.stopPropagation()
      if (!item.is_directory) {
        e.dataTransfer.dropEffect = 'none'
        return
      }
      e.dataTransfer.dropEffect = 'move'
      onInternalDragOver(item)
      return
    }
    if (!externalDragActive) return
    e.preventDefault()
    e.stopPropagation()
    if (!item.is_directory) return
    onDragTarget(item)
  }

  const handleDragStart = (e) => {
    if (isRoot) {
      e.preventDefault()
      return
    }
    e.stopPropagation()
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-weworker-user-file', item.path)
    e.dataTransfer.setData('text/plain', item.name)
    onInternalDragStart(item)
  }

  const handleDrop = (e) => {
    if (!internalDragSourcePath || !item.is_directory) return
    e.preventDefault()
    e.stopPropagation()
    onInternalDrop(item)
  }

  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-expanded={item.is_directory ? isOpen : undefined}
      aria-selected={isSelected}
      title={item.path}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      draggable={!isRoot}
      onDragStart={handleDragStart}
      onDragEnd={onInternalDragEnd}
      onContextMenu={(e) => onContextMenu(e, item)}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDrop={handleDrop}
      style={{
        height: ROW_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: indent,
        paddingRight: 10,
        gap: 4,
        cursor: 'pointer',
        background: rowBackground,
        color: rowActive ? 'var(--accent)' : nameColor,
        outline: rowActive ? '1px solid color-mix(in srgb, var(--accent) 62%, transparent)' : 'none',
        outlineOffset: -2,
        boxShadow: rowActive ? 'inset 3px 0 0 var(--accent)' : 'none',
        opacity: isDragging ? 0.48 : 1,
        fontSize: 13,
        lineHeight: 1,
        userSelect: 'none',
        position: 'relative',
        willChange: 'transform, opacity',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {depth > 0 && <span style={{ position: 'absolute', left: 12 + (depth - 1) * 18, top: 0, bottom: 0, width: 1, background: 'var(--border)', opacity: 0.65 }} />}
      <span style={{ width: 16, height: 16, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: item.is_directory ? 'var(--text-secondary)' : 'transparent' }}>
        {item.is_directory ? <ChevronIcon open={isOpen} /> : null}
      </span>
      <span style={{ width: 17, height: 17, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {item.is_directory ? <FolderIcon size={15} /> : <FileGlyph name={item.name} />}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
      {item.is_directory ? (
        <span className="folder-actions" style={{ display: 'flex', alignItems: 'center', gap: 1, opacity: hovered || isSelected ? 1 : 0 }} onClick={(e) => e.stopPropagation()}>
          {!isRoot && <Tooltip text={'\u91cd\u547d\u540d'}><button type="button" style={rowActionBtnStyle} onClick={() => onRename(item)} aria-label={'\u91cd\u547d\u540d'}><RenameIcon /></button></Tooltip>}
          <Tooltip text={'\u65b0\u5efa\u6587\u4ef6'}><button type="button" style={rowActionBtnStyle} onClick={() => onCreateFile(item)} aria-label={'\u65b0\u5efa\u6587\u4ef6'}><FilePlusIcon size={14} /></button></Tooltip>
          <Tooltip text={'\u65b0\u5efa\u6587\u4ef6\u5939'}><button type="button" style={rowActionBtnStyle} onClick={() => onCreateFolder(item)} aria-label={'\u65b0\u5efa\u6587\u4ef6\u5939'}><FolderPlusIcon size={14} /></button></Tooltip>
          {!isRoot && <Tooltip text={'\u5220\u9664'}><button type="button" style={rowActionBtnStyle} onClick={() => onDelete(item)} aria-label={'\u5220\u9664'}><TrashIcon /></button></Tooltip>}
        </span>
      ) : (
        <span className="file-actions" style={{ display: 'flex', alignItems: 'center', gap: 1, opacity: hovered || isSelected ? 1 : 0 }} onClick={(e) => e.stopPropagation()}>
          <Tooltip text={'\u91cd\u547d\u540d'}><button type="button" style={rowActionBtnStyle} onClick={() => onRename(item)} aria-label={'\u91cd\u547d\u540d'}><RenameIcon /></button></Tooltip>
          <Tooltip text={'\u5220\u9664'}><button type="button" style={rowActionBtnStyle} onClick={() => onDelete(item)} aria-label={'\u5220\u9664'}><TrashIcon /></button></Tooltip>
        </span>
      )}
    </div>
  )
}

function ContextMenuItem({ label, shortcut, disabled, onSelect }) {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => { if (!disabled) onSelect?.() }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        border: 'none',
        background: hovered && !disabled ? 'var(--bg-hover)' : 'transparent',
        color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 20,
        padding: '6px 14px',
        fontSize: 13,
        textAlign: 'left',
        fontFamily: 'inherit',
      }}
    >
      <span>{label}</span>
      <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{shortcut}</span>
    </button>
  )
}

function FileContextMenu({ contextMenu, items, onClose }) {
  if (!contextMenu || typeof document === 'undefined') return null
  const left = Math.min(
    contextMenu.x,
    Math.max(CONTEXT_MENU_MARGIN, window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN),
  )
  const top = Math.min(
    contextMenu.y,
    Math.max(CONTEXT_MENU_MARGIN, window.innerHeight - 320 - CONTEXT_MENU_MARGIN),
  )

  return createPortal(
    <div
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 5000,
        minWidth: CONTEXT_MENU_WIDTH,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        boxShadow: 'none',
        borderRadius: 6,
        padding: '6px 0',
        color: 'var(--text-primary)',
        fontSize: 13,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((entry, idx) => entry.sep ? (
        <div key={idx} style={{ height: 1, background: 'var(--border)', margin: '6px 0' }} />
      ) : (
        <ContextMenuItem key={idx} label={entry.label} shortcut={entry.shortcut} disabled={entry.disabled} onSelect={entry.onSelect || onClose} />
      ))}
    </div>,
    document.body,
  )
}

function DeleteConfirmDialog({ item, onConfirm, onCancel }) {
  if (!item || typeof document === 'undefined') return null
  const label = item.is_directory ? '\u6587\u4ef6\u5939' : '\u6587\u4ef6'

  return createPortal(
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 6200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(15, 23, 42, 0.16)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="\u786e\u8ba4\u5220\u9664"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 360,
          maxWidth: 'calc(100vw - 40px)',
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
          boxShadow: 'none',
          padding: 18,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 760, marginBottom: 8 }}>{'\u5220\u9664' + label}</div>
        <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
          {'\u786e\u5b9a\u5220\u9664 "' + item.name + '"\uff1f'}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button data-app-button="action" type="button" onClick={onCancel} style={confirmCancelButtonStyle}>{'\u53d6\u6d88'}</button>
          <button data-app-button="action" data-variant="danger" type="button" onClick={onConfirm} style={confirmDeleteButtonStyle}>{'\u5220\u9664'}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

const confirmCancelButtonStyle = {
  height: 32,
  padding: '0 14px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-secondary)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
}

const confirmDeleteButtonStyle = {
  ...confirmCancelButtonStyle,
  border: '1px solid rgba(248,113,113,0.45)',
  background: 'rgba(248,113,113,0.12)',
  color: 'var(--error)',
  fontWeight: 700,
}

export default function UserFilesSidePanel({ width = 340 }) {
  const { open, directory, files, expandedPaths, setExpandedPaths, loading, error, closePanel, load, importFiles, createFolder, createFile, renameItem, deleteItem, pasteItem, externalDragActive, dragTargetPath, setDragTargetPath } = useUserFilesStore()
  const [selectedPath, setSelectedPath] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [inlineAction, setInlineAction] = useState(null)
  const [inlineName, setInlineName] = useState('')
  const [contextMenu, setContextMenu] = useState(null)
  const [clipboard, setClipboard] = useState(null)
  const [pendingDeleteItem, setPendingDeleteItem] = useState(null)
  const [internalDragSource, setInternalDragSource] = useState(null)
  const [internalDragTargetPath, setInternalDragTargetPath] = useState('')
  const expandTimerRef = useRef(null)
  const treeRowRefs = useRef(new Map())
  const previousRowRects = useRef(new Map())
  const expanded = useMemo(() => new Set(expandedPaths), [expandedPaths])

  const updateExpanded = (updater) => {
    const current = new Set(expandedPaths)
    const next = typeof updater === 'function' ? updater(current) : updater
    setExpandedPaths(Array.from(next || []))
  }

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!contextMenu) return undefined
    const closeContextMenu = () => setContextMenu(null)
    const onKeyDown = (e) => { if (e.key === 'Escape') closeContextMenu() }
    window.addEventListener('mousedown', closeContextMenu)
    window.addEventListener('scroll', closeContextMenu, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', closeContextMenu)
      window.removeEventListener('scroll', closeContextMenu, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [contextMenu])

  useEffect(() => () => clearTimeout(expandTimerRef.current), [])

  const rootItem = useMemo(() => directory ? {
    name: directoryDisplayName(directory),
    path: directory,
    size: 0,
    modified_at: '',
    is_directory: true,
    is_root: true,
    children: files,
  } : null, [directory, files])
  const treeItems = useMemo(() => rootItem ? [rootItem] : [], [rootItem])
  const searchTokens = useMemo(() => searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean), [searchQuery])
  const searching = searchTokens.length > 0
  const visibleTreeItems = useMemo(() => filterTreeBySearch(treeItems, searchTokens), [treeItems, searchTokens])
  const visibleExpanded = useMemo(() => searching ? collectDirectoryPaths(visibleTreeItems) : expanded, [searching, visibleTreeItems, expanded])
  const rows = useMemo(() => flattenTree(visibleTreeItems, visibleExpanded), [visibleTreeItems, visibleExpanded])
  const rowsSignature = useMemo(() => rows.map((row) => row.item.path).join('\n'), [rows])
  const inlineParent = useMemo(() => findNodeByPath(treeItems, inlineAction?.parentPath), [treeItems, inlineAction])
  const inlineTarget = useMemo(() => findNodeByPath(treeItems, inlineAction?.targetPath), [treeItems, inlineAction])
  const inlineDepth = inlineAction?.type === 'rename'
    ? rows.find((row) => row.item.path === inlineAction.targetPath)?.depth || 0
    : inlineParent ? rows.find((row) => row.item.path === inlineParent.path)?.depth + 1 || 0 : 0
  const total = useMemo(() => countChildren(files), [files])
  const visibleTotal = useMemo(() => searching ? Math.max(rows.length - (rootItem ? 1 : 0), 0) : total, [searching, rows.length, rootItem, total])

  useLayoutEffect(() => {
    const nextRects = new Map()
    for (const [path, node] of treeRowRefs.current.entries()) {
      if (!node?.isConnected) continue
      const nextRect = node.getBoundingClientRect()
      const previousRect = previousRowRects.current.get(path)
      nextRects.set(path, nextRect)

      if (previousRect) {
        const deltaY = previousRect.top - nextRect.top
        if (Math.abs(deltaY) > 1) {
          node.animate(
            [
              { transform: `translateY(${deltaY}px)` },
              { transform: 'translateY(0)' },
            ],
            { duration: 180, easing: 'ease' },
          )
        }
      } else {
        node.animate(
          [
            { opacity: 0, transform: 'translateY(-5px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          { duration: 150, easing: 'ease-out' },
        )
      }
    }
    previousRowRects.current = nextRects
  }, [rowsSignature])

  const handleUpload = async () => {
    const paths = await window.electronAPI?.selectFiles?.()
    if (paths?.length) await importFiles(paths)
  }

  const handleDragTarget = (item) => {
    if (!item?.is_directory) return
    if (dragTargetPath === item.path) return
    setDragTargetPath(item.path)
    clearTimeout(expandTimerRef.current)
    expandTimerRef.current = null
    if (!expanded.has(item.path)) {
      expandTimerRef.current = setTimeout(() => {
        updateExpanded((prev) => new Set([...prev, item.path]))
        expandTimerRef.current = null
      }, 420)
    }
  }

  const clearDragTarget = () => {
    clearTimeout(expandTimerRef.current)
    setDragTargetPath('')
    setInternalDragTargetPath('')
  }

  const canMoveInto = (source, targetFolder) => {
    if (!source?.path || !targetFolder?.is_directory) return false
    const normalizedSource = source.path.replace(/\\/g, '/')
    const normalizedTarget = targetFolder.path.replace(/\\/g, '/')
    if (normalizedSource === normalizedTarget) return false
    if (source.is_directory && normalizedTarget.startsWith(normalizedSource + '/')) return false
    const sourceParent = normalizedSource.replace(/\/[^/]*$/, '')
    return sourceParent !== normalizedTarget
  }

  const handleInternalDragStart = (item) => {
    setInternalDragSource(item)
    setInternalDragTargetPath('')
    setSelectedPath(item.path)
    setContextMenu(null)
  }

  const handleInternalDragEnd = () => {
    setInternalDragSource(null)
    setInternalDragTargetPath('')
    clearTimeout(expandTimerRef.current)
  }

  const handleInternalDragOver = (targetFolder) => {
    if (!canMoveInto(internalDragSource, targetFolder)) {
      if (internalDragTargetPath) setInternalDragTargetPath('')
      return
    }
    if (internalDragTargetPath === targetFolder.path) return
    setInternalDragTargetPath(targetFolder.path)
    clearTimeout(expandTimerRef.current)
    expandTimerRef.current = null
    if (!expanded.has(targetFolder.path)) {
      expandTimerRef.current = setTimeout(() => {
        updateExpanded((prev) => new Set([...prev, targetFolder.path]))
        expandTimerRef.current = null
      }, 420)
    }
  }

  const handleInternalDrop = async (targetFolder) => {
    const source = internalDragSource
    handleInternalDragEnd()
    if (!canMoveInto(source, targetFolder)) return
    const item = await pasteItem(source.path, targetFolder.path, 'cut')
    if (item?.path) {
      setSelectedPath(item.path)
      updateExpanded((prev) => item.is_directory ? new Set([...prev, targetFolder.path, item.path]) : new Set([...prev, targetFolder.path]))
    }
  }

  const handleOpenDirectory = async () => {
    if (directory) await window.electronAPI?.openPath?.(directory)
  }

  const beginCreateFolder = (parentItem) => {
    const parentPath = parentItem?.path || directory
    setSearchQuery('')
    setInlineAction({ type: 'folder', parentPath })
    setInlineName('')
    setContextMenu(null)
    if (parentPath) updateExpanded((prev) => new Set([...prev, parentPath]))
  }

  const beginCreateFile = (parentItem) => {
    const parentPath = parentItem?.path || directory
    setSearchQuery('')
    setInlineAction({ type: 'file', parentPath })
    setInlineName('')
    setContextMenu(null)
    if (parentPath) updateExpanded((prev) => new Set([...prev, parentPath]))
  }

  const beginRenameItem = (item) => {
    if (item?.is_root) return
    setSearchQuery('')
    setInlineAction({ type: 'rename', targetPath: item.path })
    setInlineName(item.name)
    setSelectedPath(item.path)
    setContextMenu(null)
  }

  const submitInlineAction = async () => {
    const name = inlineName.trim()
    if (!name || !inlineAction) {
      setInlineAction(null)
      setInlineName('')
      return
    }
    const action = inlineAction
    setInlineAction(null)
    setInlineName('')
    if (action.type === 'folder') {
      const folder = await createFolder(action.parentPath, name)
      if (folder?.path) {
        setSelectedPath(folder.path)
        updateExpanded((prev) => new Set([...prev, action.parentPath, folder.path]))
      }
    } else if (action.type === 'file') {
      const file = await createFile(action.parentPath, name)
      if (file?.path) setSelectedPath(file.path)
    } else if (action.type === 'rename') {
      if (inlineTarget?.name === name) return
      const item = await renameItem(action.targetPath, name)
      if (item?.path) setSelectedPath(item.path)
    }
  }

  const cancelInlineAction = () => {
    setInlineAction(null)
    setInlineName('')
  }

  const focusChatInputAfterFileAction = () => {
    if (typeof document === 'undefined') return
    window.electronAPI?.focusWindow?.()
    const focus = () => {
      const active = document.activeElement
      if (active?.closest?.('input, textarea, [contenteditable="true"]')) return
      const textarea = document.querySelector('textarea[data-weworker-chat-input="true"]')
      if (!textarea || textarea.disabled) return
      textarea.focus()
    }
    requestAnimationFrame(focus)
    window.setTimeout(focus, 0)
    window.setTimeout(focus, 80)
  }

  const handleDeleteItem = (item) => {
    setContextMenu(null)
    if (item?.is_root) return
    setPendingDeleteItem(item)
  }

  const confirmDeleteItem = () => {
    const item = pendingDeleteItem
    setPendingDeleteItem(null)
    if (!item?.path || item?.is_root) return
    focusChatInputAfterFileAction()
    void deleteItem(item.path).then((deleted) => {
      if (!deleted) return
      if (selectedPath === item.path) setSelectedPath('')
    })
  }

  const cancelDeleteItem = () => {
    setPendingDeleteItem(null)
  }

  const handleContextMenu = (e, item) => {
    e.preventDefault()
    e.stopPropagation()
    setSelectedPath(item.path)
    setContextMenu({ x: e.clientX, y: e.clientY, item })
  }

  const handleToggle = (path) => {
    setSelectedPath(path)
    updateExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleSelect = (path) => {
    setContextMenu(null)
    setSelectedPath(path)
  }

  const handleOpen = async (path) => {
    setContextMenu(null)
    setSelectedPath(path)
    await window.electronAPI?.openPath?.(path)
  }

  const handleRevealInFileManager = async (path) => {
    setContextMenu(null)
    const result = await window.electronAPI?.revealInFileManager?.(path)
    if (result) showAlert(result)
  }

  const handleOpenTerminal = async (path) => {
    setContextMenu(null)
    const result = await window.electronAPI?.openTerminal?.(path)
    if (result) showAlert(result)
  }

  const handleCutItem = (item) => {
    setClipboard({ mode: 'cut', path: item.path, name: item.name, is_directory: item.is_directory })
    setContextMenu(null)
  }

  const handleCopyItem = (item) => {
    setClipboard({ mode: 'copy', path: item.path, name: item.name, is_directory: item.is_directory })
    setContextMenu(null)
  }

  const handlePasteItem = async (targetItem) => {
    const current = clipboard
    setContextMenu(null)
    if (!current?.path || !targetItem?.path) return
    const targetParentPath = targetItem.is_directory ? targetItem.path : targetItem.path.replace(/[\\/][^\\/]*$/, '')
    const item = await pasteItem(current.path, targetParentPath, current.mode)
    if (item?.path) {
      setSelectedPath(item.path)
      updateExpanded((prev) => item.is_directory ? new Set([...prev, targetParentPath, item.path]) : new Set([...prev, targetParentPath]))
      if (current.mode === 'cut') setClipboard(null)
    }
  }

  const resolvePasteTargetPath = (targetItem) => {
    if (!targetItem?.path) return directory
    if (targetItem.is_directory) return targetItem.path
    return targetItem.path.replace(/[\\/][^\\/]*$/, '') || directory
  }

  const importClipboardFiles = async (targetItem) => {
    const paths = await readClipboardFilePaths()
    if (!paths.length) return false
    const targetParentPath = resolvePasteTargetPath(targetItem)
    await importFiles(paths, targetParentPath === directory ? '' : targetParentPath)
    return true
  }

  const handlePanelPaste = async (e) => {
    if (inlineAction) return
    const target = findNodeByPath(treeItems, selectedPath) || rootItem
    if (!target) return

    const paths = await collectClipboardFilePaths(e)
    if (paths.length) {
      e.preventDefault()
      const targetParentPath = resolvePasteTargetPath(target)
      await importFiles(paths, targetParentPath === directory ? '' : targetParentPath)
      return
    }

    if (!clipboard?.path) return
    e.preventDefault()
    await handlePasteItem(target)
  }

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = async (e) => {
      if (contextMenu || inlineAction) return
      if (document.activeElement?.closest('input, textarea, [contenteditable="true"]')) return

      const target = findNodeByPath(treeItems, selectedPath) || rootItem
      if (!target) return
      const meta = e.ctrlKey || e.metaKey

      if (meta && !e.shiftKey && e.key.toLowerCase() === 'c') {
        if (target.is_root) return
        e.preventDefault()
        handleCopyItem(target)
        return
      }
      if (meta && !e.shiftKey && e.key.toLowerCase() === 'x') {
        if (target.is_root) return
        e.preventDefault()
        handleCutItem(target)
        return
      }
      if (meta && !e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        if (clipboard?.path) {
          await handlePasteItem(target)
        } else {
          await importClipboardFiles(target)
        }
        return
      }
      if (e.key === 'Delete') {
        if (target.is_root) return
        e.preventDefault()
        handleDeleteItem(target)
        return
      }
      if (e.key === 'F2') {
        if (target.is_root) return
        e.preventDefault()
        beginRenameItem(target)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, contextMenu, inlineAction, treeItems, selectedPath, rootItem, clipboard, directory])

  const contextMenuItems = useMemo(() => {
    if (!contextMenu?.item) return []
    const item = contextMenu.item
    const isRoot = !!item.is_root
    const items = []
    items.push(
      { label: '\u6253\u5f00', onSelect: () => handleOpen(item.path) },
    )
    if (item.is_directory) {
      items.push(
      { label: '\u65b0\u5efa\u6587\u4ef6...', onSelect: () => beginCreateFile(item) },
      { label: '\u65b0\u5efa\u6587\u4ef6\u5939...', onSelect: () => beginCreateFolder(item) },
      )
    }
    items.push(
      { label: '\u5728\u6587\u4ef6\u7ba1\u7406\u5668\u4e2d\u663e\u793a', shortcut: 'Shift+Alt+R', onSelect: () => handleRevealInFileManager(item.path) },
      { label: '\u5728\u96c6\u6210\u7ec8\u7aef\u4e2d\u6253\u5f00', onSelect: () => handleOpenTerminal(item.path) },
      { sep: true },
      { label: '\u526a\u5207', shortcut: 'Ctrl+X', disabled: isRoot, onSelect: () => handleCutItem(item) },
      { label: '\u590d\u5236', shortcut: 'Ctrl+C', disabled: isRoot, onSelect: () => handleCopyItem(item) },
      { label: '\u7c98\u8d34', shortcut: 'Ctrl+V', disabled: !clipboard, onSelect: () => handlePasteItem(item) },
      { sep: true },
      { label: '\u590d\u5236\u8def\u5f84', shortcut: 'Shift+Alt+C', onSelect: async () => { await navigator.clipboard?.writeText(item.path); setContextMenu(null) } },
      { label: '\u590d\u5236\u76f8\u5bf9\u8def\u5f84', shortcut: 'Ctrl+M Ctrl+Shift+C', onSelect: async () => { await navigator.clipboard?.writeText(toRelativeUserPath(item.path, directory)); setContextMenu(null) } },
      { sep: true },
      { label: '\u91cd\u547d\u540d...', shortcut: 'F2', disabled: isRoot, onSelect: () => beginRenameItem(item) },
      { label: '\u5220\u9664', shortcut: 'Delete', disabled: isRoot, onSelect: () => handleDeleteItem(item) },
    )
    return items
  }, [contextMenu, clipboard, directory])

  const collapseAll = () => {
    setExpandedPaths([])
  }

  return (
    <aside
      data-weworker-user-files-panel="true"
      tabIndex={-1}
      onPaste={handlePanelPaste}
      onDragOver={(e) => {
        if (internalDragSource) return
        if (!externalDragActive) return
        e.preventDefault()
        clearDragTarget()
      }}
      onDragLeave={(e) => {
        if (!externalDragActive) return
        if (!e.currentTarget.contains(e.relatedTarget)) clearDragTarget()
      }}
      style={{ width, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column', borderLeft: externalDragActive ? '1px solid var(--accent)' : '1px solid var(--border)', background: 'var(--bg-secondary)', overflow: 'hidden', boxShadow: externalDragActive ? 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent), -12px 0 34px rgba(0,0,0,0.18)' : 'none', position: 'relative', zIndex: 1300 }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 8px 0 12px', borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--bg-secondary)' }}>
        <label style={{ flex: 1, minWidth: 0, height: 26, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 7px' }}>
          <SearchIcon size={14} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && searchQuery) {
                e.stopPropagation()
                setSearchQuery('')
              }
            }}
            placeholder={'\u641c\u7d22\u6587\u4ef6\u6216\u6587\u4ef6\u5939'}
            aria-label={'\u641c\u7d22\u6587\u4ef6\u6216\u6587\u4ef6\u5939'}
            style={{ flex: 1, minWidth: 0, height: '100%', border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit' }}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label={'\u6e05\u7a7a\u641c\u7d22'}
              style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 15, lineHeight: 1, width: 16, height: 16, padding: 0, flexShrink: 0 }}
            >
              &times;
            </button>
          )}
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          <Tooltip text={'\u4e0a\u4f20\u6587\u4ef6'}><button type="button" onClick={handleUpload} style={toolbarBtnStyle} aria-label={'\u4e0a\u4f20\u6587\u4ef6'}><FilePlusIcon /></button></Tooltip>
          <Tooltip text={'\u65b0\u5efa\u6587\u4ef6\u5939'}><button type="button" onClick={() => beginCreateFolder(null)} style={toolbarBtnStyle} aria-label={'\u65b0\u5efa\u6587\u4ef6\u5939'}><FolderPlusIcon /></button></Tooltip>
          <Tooltip text={'\u5237\u65b0'}><button type="button" onClick={load} style={toolbarBtnStyle} aria-label={'\u5237\u65b0'}><RefreshIcon /></button></Tooltip>
          <Tooltip text={'\u6298\u53e0\u5168\u90e8'}><button type="button" onClick={collapseAll} style={toolbarBtnStyle} aria-label={'\u6298\u53e0\u5168\u90e8'}><CollapseAllIcon /></button></Tooltip>
          <Tooltip text={'\u5173\u95ed'}><button type="button" onClick={closePanel} style={{ ...toolbarBtnStyle, fontSize: 17, lineHeight: 1 }} aria-label={'\u5173\u95ed\u7528\u6237\u76ee\u5f55'}>&times;</button></Tooltip>
        </div>
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 8px', minHeight: 0 }} role="tree" aria-label={'\u7528\u6237\u76ee\u5f55'}>
        {error && <div style={{ border: '1px solid rgba(248,113,113,0.35)', color: 'var(--error)', background: 'rgba(248,113,113,0.08)', borderRadius: 6, padding: 8, fontSize: 12, margin: 8 }}>{error}</div>}
        {loading && !directory ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 12 }}>{'\u52a0\u8f7d\u4e2d...'}</div>
        ) : (
          <>
            {inlineAction && !inlineParent && inlineAction.type !== 'rename' && (
              <InlineNameRow depth={0} value={inlineName} placeholder={inlineAction.type === 'file' ? '\u6587\u4ef6\u540d\u79f0' : '\u6587\u4ef6\u5939\u540d\u79f0'} icon={inlineAction.type === 'file' ? <FilePlusIcon size={14} /> : <FolderIcon size={15} />} onChange={setInlineName} onSubmit={submitInlineAction} onCancel={cancelInlineAction} />
            )}
            {searching && rows.length === 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 12 }}>{'\u6ca1\u6709\u5339\u914d\u7684\u6587\u4ef6\u6216\u6587\u4ef6\u5939'}</div>
            )}
            {rows.map((row) => (
              <React.Fragment key={row.item.path}>
                {inlineAction?.type === 'rename' && inlineAction.targetPath === row.item.path ? (
                  <InlineNameRow depth={inlineDepth} value={inlineName} placeholder={inlineTarget?.is_directory ? '\u6587\u4ef6\u5939\u540d\u79f0' : '\u6587\u4ef6\u540d\u79f0'} icon={inlineTarget?.is_directory ? <FolderIcon size={15} /> : <FileGlyph name={inlineName} />} onChange={setInlineName} onSubmit={submitInlineAction} onCancel={cancelInlineAction} />
                ) : (
                  <TreeRow
                    row={row}
                    rowRef={(node) => {
                      if (node) treeRowRefs.current.set(row.item.path, node)
                      else treeRowRefs.current.delete(row.item.path)
                    }}
                    expanded={expanded}
                    selectedPath={selectedPath}
                    dragTargetPath={dragTargetPath}
                    externalDragActive={externalDragActive}
                    internalDragSourcePath={internalDragSource?.path || ''}
                    internalDragTargetPath={internalDragTargetPath}
                    onToggle={handleToggle}
                    onSelect={handleSelect}
                    onOpen={handleOpen}
                    onCreateFile={beginCreateFile}
                    onCreateFolder={beginCreateFolder}
                    onRename={beginRenameItem}
                    onDelete={handleDeleteItem}
                    onContextMenu={handleContextMenu}
                    onDragTarget={handleDragTarget}
                    onInternalDragStart={handleInternalDragStart}
                    onInternalDragEnd={handleInternalDragEnd}
                    onInternalDragOver={handleInternalDragOver}
                    onInternalDrop={handleInternalDrop}
                  />
                )}
                {inlineAction && inlineAction.type !== 'rename' && inlineAction.parentPath === row.item.path && (
                  <InlineNameRow depth={inlineDepth} value={inlineName} placeholder={inlineAction.type === 'file' ? '\u6587\u4ef6\u540d\u79f0' : '\u6587\u4ef6\u5939\u540d\u79f0'} icon={inlineAction.type === 'file' ? <FilePlusIcon size={14} /> : <FolderIcon size={15} />} onChange={setInlineName} onSubmit={submitInlineAction} onCancel={cancelInlineAction} />
                )}
              </React.Fragment>
            ))}
          </>
        )}
      </div>
      <FileContextMenu
        contextMenu={contextMenu}
        items={contextMenuItems}
        onClose={() => setContextMenu(null)}
      />
      <DeleteConfirmDialog
        item={pendingDeleteItem}
        onConfirm={confirmDeleteItem}
        onCancel={cancelDeleteItem}
      />
      <footer style={{ height: 24, flexShrink: 0, borderTop: '1px solid var(--border)', padding: '0 10px', display: 'flex', alignItems: 'center', justifyContent: 'flex-start', color: 'var(--text-muted)', fontSize: 11 }}>
        <span>{searching ? `${visibleTotal} / ${total}` : total} {'\u9879'}</span>
      </footer>
    </aside>
  )
}
