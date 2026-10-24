import { leaveWebsiteExploration } from '../../store/website-exploration.js'
import { useExplorationPageStore } from '../../store/exploration-page.js'
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useWorksStore } from '../../store/works.js'
import { useToolPackagePageStore } from '../../store/tool-package-page.js'
import { showAlert, showConfirm } from '../../store/dialog.js'
import { TrashIcon } from '../icons/PanelIcons.jsx'
import MessageSquarePlusIcon from '../icons/MessageSquarePlusIcon.jsx'

const LABEL_COLORS = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#339CFF',
  purple: '#a855f7',
}

const LABEL_OPTIONS = [
  { value: 'red', label: '红色' },
  { value: 'orange', label: '橙色' },
  { value: 'yellow', label: '黄色' },
  { value: 'green', label: '绿色' },
  { value: 'blue', label: '蓝色' },
  { value: 'purple', label: '紫色' },
]

export { LABEL_COLORS, LABEL_OPTIONS }

function getWorkFolderName(work) {
  const candidate = work?.folder_name
    || work?.folderName
    || work?.workspace_name
    || work?.workspaceName
    || work?.project_name
    || work?.projectName
    || work?.folder
    || work?.workspace
    || work?.project
  return String(candidate || '默认工作区').trim() || '默认工作区'
}

function groupWorksByFolder(works, projects = []) {
  const groups = new Map()
  for (const work of works) {
    const projectId = work?.project_id || null
    const project = projectId ? projects.find((item) => item.id === projectId) : null
    const legacyName = getWorkFolderName(work)
    const key = project ? `project:${project.id}` : (legacyName === '默认工作区' ? 'default' : `legacy:${legacyName}`)
    if (!groups.has(key)) groups.set(key, { key, id: project?.id || null, name: project?.name || legacyName, dedicatedAgent: Boolean(project?.dedicated_agent), items: [] })
    groups.get(key).items.push(work)
  }
  for (const project of projects) {
    const key = `project:${project.id}`
    if (!groups.has(key)) groups.set(key, { key, id: project.id, name: project.name, dedicatedAgent: Boolean(project.dedicated_agent), items: [] })
  }
  const defaultGroup = groups.get('default')
  const projectGroups = [...groups.values()].filter((group) => group.id)
  return [
    ...(defaultGroup ? [defaultGroup] : []),
    ...projectGroups,
  ]
}

export default function WorksList({ searchQuery = '' }) {
  const works = useWorksStore((s) => Array.isArray(s.works) ? s.works : [])
  const projects = useWorksStore((s) => Array.isArray(s.projects) ? s.projects : [])
  const activeWorkId = useWorksStore((s) => s.activeWorkId)
  const selectWork = useWorksStore((s) => s.selectWork)
  const deleteWork = useWorksStore((s) => s.deleteWork)
  const createWork = useWorksStore((s) => s.createWork)
  const renameProject = useWorksStore((s) => s.renameProject)
  const deleteProject = useWorksStore((s) => s.deleteProject)
  const labelFilter = useWorksStore((s) => s.labelFilter)
  const closeToolPackagePage = useToolPackagePageStore((s) => s.closePage)
  const closeExplorationPage = useExplorationPageStore((s) => s.closePage)
  const [collapsedFolders, setCollapsedFolders] = useState(() => {
    if (typeof localStorage === 'undefined') return {}
    try {
      const saved = JSON.parse(localStorage.getItem('weworker.collapsed-work-folders') || '{}')
      return saved && typeof saved === 'object' ? saved : {}
    } catch {
      return {}
    }
  })
  const [hoveredFolderKey, setHoveredFolderKey] = useState(null)
  const [renamingProjectId, setRenamingProjectId] = useState(null)
  const [renameProjectValue, setRenameProjectValue] = useState('')
  const renameProjectInputRef = useRef(null)

  useEffect(() => {
    if (renamingProjectId && renameProjectInputRef.current) {
      renameProjectInputRef.current.focus()
      renameProjectInputRef.current.select()
    }
  }, [renamingProjectId])

  const filtered = works.filter((w) => {
    if (labelFilter && w.label !== labelFilter) return false
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      const title = (w.title || '').toLowerCase()
      const shortId = w.id.slice(0, 8).toLowerCase()
      return title.includes(q) || shortId.includes(q)
    }
    return true
  })

  if (!works.length && !projects.length) {
    return (
      <div style={{ padding: '12px', color: 'var(--text-muted)', fontSize: 12 }}>
        暂无对话
      </div>
    )
  }

  if (filtered.length === 0) {
    return (
      <div style={{ padding: '12px', color: 'var(--text-muted)', fontSize: 12 }}>
        未找到匹配的任务
      </div>
    )
  }

  const folderGroups = groupWorksByFolder(filtered, projects)
  const toggleFolder = (folderName) => {
    setCollapsedFolders((current) => {
      const next = { ...current, [folderName]: !current[folderName] }
      try {
        localStorage.setItem('weworker.collapsed-work-folders', JSON.stringify(next))
      } catch {
        // Local storage is only a visual preference; keep the toggle usable when unavailable.
      }
      return next
    })
  }

  const startProjectRename = (group) => {
    if (!group.id) return
    setRenamingProjectId(group.id)
    setRenameProjectValue(group.name)
  }

  const commitProjectRename = async () => {
    const id = renamingProjectId
    const name = renameProjectValue.trim()
    if (!id) return
    if (!name) {
      setRenamingProjectId(null)
      return
    }
    const project = projects.find((item) => item.id === id)
    if (project?.name === name) {
      setRenamingProjectId(null)
      return
    }
    try {
      await renameProject(id, name)
      setRenamingProjectId(null)
    } catch (error) {
      showAlert(error instanceof Error ? error.message : '重命名项目失败，请稍后重试')
    }
  }

  const createProjectWork = async (projectId) => {
    if (!await leaveWebsiteExploration()) return
    closeExplorationPage()
    closeToolPackagePage()
    await createWork({ forceNew: true, projectId })
  }

  const handleDeleteProject = async (group) => {
    if (!group.id || group.items.length > 0) return
    if (!await showConfirm(`确定删除项目“${group.name}”及其空文件夹吗？`, '删除项目', { danger: true })) return
    try {
      await deleteProject(group.id)
    } catch (error) {
      showAlert(error instanceof Error ? error.message : '删除项目失败，请稍后重试')
    }
  }

  return (
    <div className="work-folder-list">
      {folderGroups.map((group) => {
        const folderKey = group.key
        const collapsed = Boolean(collapsedFolders[folderKey])
        // The default workspace has no project id. Keep it in display mode
        // instead of treating the initial null state as an active rename.
        const renaming = Boolean(group.id) && renamingProjectId === group.id
        return (
          <section
            className={`work-folder-group${collapsed ? ' is-collapsed' : ''}`}
            key={folderKey}
            onMouseEnter={() => setHoveredFolderKey(folderKey)}
            onMouseLeave={() => setHoveredFolderKey(null)}
          >
            <div className="work-folder-heading">
              <button
                type="button"
                className="work-folder-heading__toggle"
                aria-expanded={!collapsed}
                onClick={() => toggleFolder(folderKey)}
              >
                <ChevronIcon size={13} collapsed={collapsed} />
                <FolderIcon size={15} />
                {renaming ? (
                  <input
                    ref={renameProjectInputRef}
                    value={renameProjectValue}
                    onChange={(event) => setRenameProjectValue(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); commitProjectRename() }
                      if (event.key === 'Escape') { event.preventDefault(); setRenamingProjectId(null) }
                      event.stopPropagation()
                    }}
                    onBlur={commitProjectRename}
                    aria-label="项目名称"
                  />
                ) : (
                  <span className="work-folder-heading__name" title={group.dedicatedAgent ? '由专属 Agent 自动维护，改名请直接修改 Agent 名称' : undefined}>{group.name}</span>
                )}
                <span className="work-folder-heading__count">{group.items.length}</span>
              </button>
              {!renaming && (hoveredFolderKey === folderKey || group.items.length === 0) && (
                <span className="work-folder-heading__actions">
                  {/* 专属 Agent 的对话只在 Agent 页里创建，侧栏不提供入口。 */}
                  {!group.dedicatedAgent && (
                    <button type="button" title={group.id ? '项目中创建新对话' : '默认工作区中创建新对话'} aria-label={`在${group.name}中创建新对话`} onClick={() => createProjectWork(group.id)}>
                      <MessageSquarePlusIcon />
                    </button>
                  )}
                  {group.id && (
                    <button type="button" title={group.items.length ? '请先删除项目中的对话' : '删除项目'} aria-label={`删除项目${group.name}`} disabled={group.items.length > 0} onClick={() => handleDeleteProject(group)}>
                      <ProjectTrashIcon />
                    </button>
                  )}
                  {/* 专属 Agent 文件夹名由 Agent 名称生成，只能改名 Agent 来同步。 */}
                  {group.id && !group.dedicatedAgent && (
                    <button type="button" title="重命名项目" aria-label={`重命名项目${group.name}`} onClick={() => startProjectRename(group)}>
                      <RenameIcon size={12} />
                    </button>
                  )}
                </span>
              )}
            </div>
            {!collapsed && (
              <div className="work-folder-items">
                {group.items.map((w) => (
                  <WorkItem
                    key={w.id}
                    work={w}
                    active={w.id === activeWorkId}
                    onSelect={async () => {
                      if (!await leaveWebsiteExploration()) return
                      closeExplorationPage()
                      closeToolPackagePage()
                      selectWork(w.id)
                    }}
                    onDelete={() => deleteWork(w.id)}
                  />
                ))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

function FolderIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-9.5a2 2 0 0 1 2-2Z" />
      <path d="M2.5 9h18" />
    </svg>
  )
}

function ProjectTrashIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M10 4h4l1 3H9l1-3ZM7 7l1 13h8l1-13M10 10v7M14 10v7" />
    </svg>
  )
}

function ChevronIcon({ size = 13, collapsed }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className="work-folder-heading__chevron">
      <path d="m6 3.5 4 4.5-4 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: collapsed ? 'none' : 'rotate(90deg)', transformOrigin: '8px 8px' }} />
    </svg>
  )
}

function WorkItem({ work, active, onSelect, onDelete }) {
  const [hovered, setHovered] = useState(false)
  const [menuPos, setMenuPos] = useState(null)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [isSavingRename, setIsSavingRename] = useState(false)
  const updateLabel = useWorksStore((s) => s.updateLabel)
  const updateTitle = useWorksStore((s) => s.updateTitle)
  const menuRef = useRef(null)
  const renameInputRef = useRef(null)
  const skipRenameCommitRef = useRef(false)
  const deletePendingRef = useRef(false)

  const handleDelete = async () => {
    if (deletePendingRef.current) return
    deletePendingRef.current = true
    try {
      if (!await showConfirm(`确定删除对话“${work.title || '新任务'}”吗？删除后无法恢复。`, '删除对话', { danger: true })) return
      await onDelete()
    } catch {
      // The store displays the deletion error and preserves the conversation.
    } finally {
      deletePendingRef.current = false
    }
  }

  const handleContextMenu = useCallback((e) => {
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
  }, [])

  useEffect(() => {
    if (!menuPos) return
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuPos(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuPos])

  useEffect(() => {
    if (!isRenaming || !renameInputRef.current) return
    renameInputRef.current.focus()
    renameInputRef.current.select()
  }, [isRenaming])

  const startRename = useCallback(() => {
    skipRenameCommitRef.current = false
    setRenameValue(work.title || '')
    setIsRenaming(true)
    setMenuPos(null)
  }, [work.title])

  const cancelRename = useCallback((skipBlurCommit = false) => {
    skipRenameCommitRef.current = skipBlurCommit
    setIsRenaming(false)
    setRenameValue('')
  }, [])

  const commitRename = useCallback(async () => {
    if (skipRenameCommitRef.current) {
      skipRenameCommitRef.current = false
      return
    }
    if (isSavingRename) return
    const nextTitle = renameValue.trim()
    if (!nextTitle || nextTitle === work.title) {
      cancelRename()
      return
    }
    try {
      setIsSavingRename(true)
      await updateTitle(work.id, nextTitle)
      cancelRename()
    } catch (e) {
      console.error('[works] rename failed:', e)
      showAlert('重命名失败，请稍后重试')
    } finally {
      setIsSavingRename(false)
    }
  }, [cancelRename, isSavingRename, renameValue, updateTitle, work.id, work.title])

  return (
    <>
      <div
        className={`work-list-item${active ? ' is-active' : ''}`}
        role="button"
        tabIndex={isRenaming ? -1 : 0}
        onClick={() => { if (!isRenaming) onSelect() }}
        onKeyDown={(e) => {
          if (isRenaming) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect()
          }
        }}
        onContextMenu={handleContextMenu}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          padding: '7px 12px',
          cursor: isRenaming ? 'default' : 'pointer',
          background: active ? 'var(--bg-active)' : hovered ? 'var(--bg-hover)' : 'transparent',
          borderRadius: 6,
          margin: '1px 6px',
          marginLeft: 22,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          transition: 'background 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease, color 0.16s ease',
        }}
      >
        {work.label && (
          <span style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: LABEL_COLORS[work.label] || 'transparent',
          }} />
        )}
        <span style={{
          fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        }}>
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              disabled={isSavingRename}
              onChange={(e) => setRenameValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitRename()
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  cancelRename(true)
                }
                e.stopPropagation()
              }}
              onBlur={commitRename}
              style={{
                width: '100%',
                minWidth: 0,
                fontSize: 12,
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '1px 4px',
                outline: 'none',
                background: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                fontFamily: 'inherit',
              }}
            />
          ) : (
            work.title || '新任务'
          )}
        </span>
        {!isRenaming && (
          <span className="sidebar-row-actions">
            <button
              type="button"
              title="重命名"
              aria-label={`重命名 ${work.title || '新任务'}`}
              className="sidebar-row-action work-item-action"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); startRename() }}
            >
              <RenameIcon size={13} />
            </button>
            <button
              type="button"
              title="删除"
              aria-label={`删除 ${work.title || '新任务'}`}
              className="sidebar-row-action work-item-action"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); handleDelete() }}
            >
              <TrashIcon size={13} />
            </button>
          </span>
        )}
      </div>

      {menuPos && (
        <WorkContextMenu
          ref={menuRef}
          x={menuPos.x}
          y={menuPos.y}
          currentLabel={work.label}
          onRename={startRename}
          onSelect={(label) => {
            updateLabel(work.id, label)
            setMenuPos(null)
          }}
          onClose={() => setMenuPos(null)}
        />
      )}
    </>
  )
}

const WorkContextMenu = React.forwardRef(({ x, y, currentLabel, onRename, onSelect, onClose }, ref) => {
  const labelNames = useWorksStore((s) => s.labelNames)
  const saveLabelName = useWorksStore((s) => s.saveLabelName)
  const [editingColor, setEditingColor] = useState(null)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (editingColor && inputRef.current) inputRef.current.focus()
  }, [editingColor])

  return (
    <div
      ref={ref}
      className="work-context-menu motion-popover-enter"
      style={{
        position: 'fixed', left: x, top: y, zIndex: 9999,
        background: 'var(--bg-primary, #fff)', border: '1px solid var(--border, #e5e7eb)',
        borderRadius: 8, padding: '6px 0', minWidth: 160,
        boxShadow: 'none',
      }}
    >
      <button
        onClick={() => {
          onRename()
          onClose()
        }}
        style={{
          display: 'block', width: '100%', textAlign: 'left',
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '5px 12px', fontSize: 12, color: 'var(--text-secondary)',
        }}
        onMouseEnter={(e) => e.target.style.background = 'var(--bg-hover, #f3f4f6)'}
        onMouseLeave={(e) => e.target.style.background = 'none'}
      >
        重命名
      </button>
      <div style={{ borderTop: '1px solid var(--border, #e5e7eb)', margin: '4px 0' }} />
      <div style={{ padding: '4px 12px 6px', fontSize: 11, color: 'var(--text-muted)' }}>
        标记颜色
      </div>
      {LABEL_OPTIONS.map((opt) => {
        const isEditing = editingColor === opt.value
        const customName = labelNames[opt.value]
        return (
          <div
            key={opt.value}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '4px 12px', cursor: 'pointer',
              background: currentLabel === opt.value ? 'var(--bg-hover, #f3f4f6)' : 'transparent',
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover, #f3f4f6)'}
            onMouseLeave={(e) => e.currentTarget.style.background = currentLabel === opt.value ? 'var(--bg-hover, #f3f4f6)' : 'transparent'}
            onClick={() => {
              if (!isEditing) onSelect(currentLabel === opt.value ? null : opt.value)
            }}
          >
            <span style={{
              width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
              background: LABEL_COLORS[opt.value],
              outline: currentLabel === opt.value ? '2px solid var(--text-primary, #333)' : 'none',
              outlineOffset: 1,
            }} />
            {isEditing ? (
              <input
                ref={inputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    saveLabelName(opt.value, editValue)
                    setEditingColor(null)
                  }
                  if (e.key === 'Escape') setEditingColor(null)
                  e.stopPropagation()
                }}
                onBlur={() => {
                  saveLabelName(opt.value, editValue)
                  setEditingColor(null)
                }}
                onClick={(e) => e.stopPropagation()}
                placeholder={opt.label}
                style={{
                  flex: 1, fontSize: 12, border: '1px solid var(--border)',
                  borderRadius: 4, padding: '1px 4px', outline: 'none',
                  background: 'var(--bg-primary)', color: 'var(--text-primary)',
                  fontFamily: 'inherit', minWidth: 0,
                }}
              />
            ) : (
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)' }}>
                {customName || opt.label}
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation()
                setEditingColor(opt.value)
                setEditValue(customName || '')
              }}
              title="重命名"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', fontSize: 10, padding: '0 2px',
                opacity: 0.5, flexShrink: 0,
              }}
              onMouseEnter={(e) => e.target.style.opacity = '1'}
              onMouseLeave={(e) => e.target.style.opacity = '0.5'}
            >
              ✎
            </button>
          </div>
        )
      })}
      {currentLabel && (
        <>
          <div style={{ borderTop: '1px solid var(--border, #e5e7eb)', margin: '4px 0' }} />
          <button
            onClick={() => onSelect(null)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '5px 12px', fontSize: 12, color: 'var(--text-secondary)',
            }}
            onMouseEnter={(e) => e.target.style.background = 'var(--bg-hover, #f3f4f6)'}
            onMouseLeave={(e) => e.target.style.background = 'none'}
          >
            清除标记
          </button>
        </>
      )}
    </div>
  )
})
function RenameIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}
