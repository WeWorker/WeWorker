import React, { useEffect, useState } from 'react'
import { useCapabilitiesPanelStore } from '../../store/capabilities-panel.js'
import { useUserFilesStore } from '../../store/user-files.js'
import { useWorksStore } from '../../store/works.js'
import { useScheduledTasksStore } from '../../store/scheduled-tasks.js'
import { FilePlusIcon, TrashIcon } from '../icons/PanelIcons.jsx'

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files')
}

function isInsideUserFilesPanel(event) {
  return !!event.target?.closest?.('[data-weworker-user-files-panel="true"]')
}

function getDroppedPaths(event) {
  const nativePaths = window.electronAPI?.getLastDroppedFilePaths?.() || []
  if (nativePaths.length) return nativePaths
  return Array.from(event.dataTransfer?.files || [])
    .map((file) => file.path || window.electronAPI?.getPathForFile?.(file))
    .filter(Boolean)
}

function basename(filePath) {
  return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || ''
}

function getChatAttachmentTarget() {
  const activeWorkId = useWorksStore.getState().activeWorkId
  if (activeWorkId) return `work:${activeWorkId}`
  const activeTaskId = useScheduledTasksStore.getState().activeTaskId
  return activeTaskId ? null : 'welcome'
}

function CloseIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

const progressCloseButtonStyle = {
  width: 24,
  height: 24,
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  pointerEvents: 'auto',
}

export default function GlobalFileDropLayer() {
  const importUserFiles = useUserFilesStore((s) => s.importFiles)
  const externalDragActive = useUserFilesStore((s) => s.externalDragActive)
  const setExternalDragActive = useUserFilesStore((s) => s.setExternalDragActive)
  const dragTargetPath = useUserFilesStore((s) => s.dragTargetPath)
  const userFilesDirectory = useUserFilesStore((s) => s.directory)
  const importProgress = useUserFilesStore((s) => s.importProgress)
  const dismissImportProgress = useUserFilesStore((s) => s.dismissImportProgress)
  const deleteProgress = useUserFilesStore((s) => s.deleteProgress)
  const dismissDeleteProgress = useUserFilesStore((s) => s.dismissDeleteProgress)
  const [dragHint, setDragHint] = useState({ x: 0, y: 0 })
  const [dropToChat, setDropToChat] = useState(false)

  useEffect(() => {
    let dragIdleTimer = null

    const hideDragState = () => {
      if (dragIdleTimer) {
        clearTimeout(dragIdleTimer)
        dragIdleTimer = null
      }
      setExternalDragActive(false)
      setDragHint({ x: 0, y: 0 })
      setDropToChat(false)
    }

    const showDragState = (event) => {
      if (dragIdleTimer) clearTimeout(dragIdleTimer)
      dragIdleTimer = setTimeout(hideDragState, 350)
      if (event) {
        setDragHint({ x: event.clientX, y: event.clientY })
        setDropToChat(!isInsideUserFilesPanel(event))
      }
      setExternalDragActive(true)
      useCapabilitiesPanelStore.getState().closePanel()
      const state = useUserFilesStore.getState()
      if (!state.open && !state.loading) state.openPanel()
    }

    const onDragEnter = (event) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (!isInsideUserFilesPanel(event)) event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
      showDragState(event)
    }

    const onDragOver = (event) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (!isInsideUserFilesPanel(event)) event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
      showDragState(event)
    }

    const onDragLeave = (event) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (!isInsideUserFilesPanel(event)) event.stopPropagation()
      if (!event.relatedTarget) hideDragState()
    }

    const onDrop = async (event) => {
      if (!hasFiles(event)) return
      const insideUserFilesPanel = isInsideUserFilesPanel(event)
      event.preventDefault()
      if (!insideUserFilesPanel) event.stopPropagation()
      const paths = getDroppedPaths(event)
      const targetPath = insideUserFilesPanel
        ? (useUserFilesStore.getState().dragTargetPath || dragTargetPath)
        : ''
      const chatAttachmentTarget = insideUserFilesPanel ? null : getChatAttachmentTarget()
      hideDragState()
      if (paths.length) {
        const importedFiles = await importUserFiles(paths, targetPath)
        if (!insideUserFilesPanel) {
          if (chatAttachmentTarget) useUserFilesStore.getState().queueChatAttachments(importedFiles, chatAttachmentTarget)
        }
      } else {
        useUserFilesStore.setState({ error: '未能获取拖拽文件路径', open: true })
      }
    }

    window.addEventListener('dragenter', onDragEnter, true)
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('dragleave', onDragLeave, true)
    window.addEventListener('drop', onDrop, true)
    window.addEventListener('blur', hideDragState)
    return () => {
      if (dragIdleTimer) clearTimeout(dragIdleTimer)
      window.removeEventListener('dragenter', onDragEnter, true)
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('dragleave', onDragLeave, true)
      window.removeEventListener('drop', onDrop, true)
      window.removeEventListener('blur', hideDragState)
    }
  }, [dragTargetPath, importUserFiles, setExternalDragActive])

  if (!externalDragActive && !importProgress && !deleteProgress) return null

  const dragTargetName = dragTargetPath
    ? basename(dragTargetPath)
    : (basename(userFilesDirectory) || '项目目录')
  const title = dropToChat ? '松开导入文件到工作区与对话' : '松开导入文件'
  const subtitle = dropToChat ? `到 ${dragTargetName} 与当前对话` : `到 ${dragTargetName}`

  return (
    <>
      {externalDragActive && (
        <>
          <div style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1200,
            pointerEvents: 'none',
            background: 'color-mix(in srgb, var(--accent) 7%, rgba(18, 22, 28, 0.24))',
          }} />
          <div style={{
            position: 'fixed',
            left: Math.min(window.innerWidth - 260, Math.max(12, dragHint.x + 18)),
            top: Math.min(window.innerHeight - 82, Math.max(12, dragHint.y + 18)),
            zIndex: 1400,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            minWidth: 210,
            maxWidth: 250,
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid color-mix(in srgb, var(--accent) 32%, var(--border))',
            background: 'color-mix(in srgb, var(--bg-secondary) 94%, var(--accent))',
            color: 'var(--text-primary)',
            boxShadow: 'none',
          }}>
            <span style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              color: 'var(--accent)',
              background: 'color-mix(in srgb, var(--accent) 13%, transparent)',
            }}><FilePlusIcon size={17} /></span>
            <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.15 }}>{title}</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</span>
            </span>
          </div>
        </>
      )}
      {importProgress && (
        <ImportProgressDialog progress={importProgress} onClose={dismissImportProgress} bottom={deleteProgress ? 114 : 18} />
      )}
      {deleteProgress && (
        <DeleteProgressDialog progress={deleteProgress} onClose={dismissDeleteProgress} />
      )}
    </>
  )
}

function ImportProgressDialog({ progress, onClose, bottom = 18 }) {
  const done = progress.status === 'done'
  const error = progress.status === 'error'
  const percent = computeProgressPercent(progress)
  const statusText = error
    ? '导入失败'
    : done
      ? '导入完成'
      : '正在导入文件'
  const detailText = error
    ? (progress.error || '导入用户目录失败')
    : progress.currentFile
      ? progress.currentFile
      : `${progress.copiedFiles}/${progress.totalFiles || 0} 个文件`

  return (
    <div style={{
      position: 'fixed',
      right: 18,
      bottom,
      zIndex: 1500,
      width: 360,
      maxWidth: 'calc(100vw - 36px)',
      border: '1px solid color-mix(in srgb, var(--border) 78%, var(--text-muted))',
      borderRadius: 8,
      background: 'var(--bg-secondary)',
      color: 'var(--text-primary)',
      boxShadow: 'none',
      padding: 14,
      boxSizing: 'border-box',
      pointerEvents: 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: error ? 'var(--error)' : 'var(--accent)',
          background: error ? 'rgba(248,113,113,0.12)' : 'color-mix(in srgb, var(--accent) 13%, transparent)',
        }}><FilePlusIcon size={17} /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.25 }}>{statusText}</div>
          <div title={detailText} style={{ marginTop: 2, fontSize: 12, color: error ? 'var(--error)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {detailText}
          </div>
        </div>
        {(done || error) && (
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭导入进度"
            style={progressCloseButtonStyle}
          >
            <CloseIcon />
          </button>
        )}
      </div>
      <div style={{ height: 7, borderRadius: 999, background: 'var(--bg-tertiary)', overflow: 'hidden' }}>
        <div style={{
          height: '100%',
          width: `${percent}%`,
          minWidth: percent > 0 && percent < 4 ? 10 : 0,
          borderRadius: 999,
          background: error ? 'var(--error)' : 'var(--accent)',
          transition: 'width 0.18s ease',
        }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        <span>{progress.copiedFiles}/{progress.totalFiles || 0} 个文件</span>
        <span>{formatBytes(progress.copiedBytes)} / {formatBytes(progress.totalBytes)}</span>
      </div>
    </div>
  )
}

function DeleteProgressDialog({ progress, onClose }) {
  const done = progress.status === 'done'
  const error = progress.status === 'error'
  const refreshing = progress.status === 'refreshing'
  const percent = Math.max(8, Math.min(100, Number(progress.percent || (done ? 100 : refreshing ? 76 : 18))))
  const statusText = error
    ? '删除失败'
    : done
      ? '删除完成'
      : '正在删除'
  const detailText = error
    ? (progress.error || '删除失败')
    : progress.targetName || '文件'

  const displayStatusText = refreshing ? '\u6b63\u5728\u5237\u65b0\u6587\u4ef6\u5217\u8868' : statusText

  return (
    <div style={{
      position: 'fixed',
      right: 18,
      bottom: 18,
      zIndex: 1500,
      width: 360,
      maxWidth: 'calc(100vw - 36px)',
      border: '1px solid color-mix(in srgb, var(--border) 78%, var(--text-muted))',
      borderRadius: 8,
      background: 'var(--bg-secondary)',
      color: 'var(--text-primary)',
      boxShadow: 'none',
      padding: 14,
      boxSizing: 'border-box',
      pointerEvents: 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: error ? 'var(--error)' : 'var(--accent)',
          background: error ? 'rgba(248,113,113,0.12)' : 'color-mix(in srgb, var(--accent) 13%, transparent)',
        }}><TrashIcon size={17} /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.25 }}>{displayStatusText}</div>
          <div title={detailText} style={{ marginTop: 2, fontSize: 12, color: error ? 'var(--error)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {detailText}
          </div>
        </div>
        {(done || error) && (
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭删除进度"
            style={progressCloseButtonStyle}
          >
            <CloseIcon />
          </button>
        )}
      </div>
      <div style={{ height: 7, borderRadius: 999, background: 'var(--bg-tertiary)', overflow: 'hidden', marginTop: 10 }}>
        <div style={{
          height: '100%',
          width: `${percent}%`,
          minWidth: 24,
          borderRadius: 999,
          background: error ? 'var(--error)' : 'var(--accent)',
          transition: 'width 0.18s ease',
        }} />
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        {error ? '请稍后重试，或检查文件是否正在被其他程序占用' : done ? '文件列表已刷新' : '删除过程中请稍候'}
      </div>
    </div>
  )
}

function computeProgressPercent(progress) {
  if (progress.status === 'done') return 100
  if (progress.totalBytes > 0) {
    return Math.max(0, Math.min(100, Math.round((progress.copiedBytes / progress.totalBytes) * 100)))
  }
  if (progress.totalFiles > 0) {
    return Math.max(0, Math.min(100, Math.round((progress.copiedFiles / progress.totalFiles) * 100)))
  }
  return progress.status === 'running' ? 5 : 0
}

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unitIndex]}`
}
