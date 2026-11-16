const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'get_file_changes', 'TodoWrite', 'ToolSearch', 'AskUserQuestion', 'ask_user', 'list_files', 'list_scheduled_tasks'])
export const fileChangeLabel = operation => ({ create: '新建', edit: '编辑', delete: '删除', unknown: '待确认' }[operation] || '待确认')
export const fileChangeName = filePath => String(filePath || '').split(/[\\/]/).filter(Boolean).at(-1) || '文件'
export function fileChangeToolState(content = []) {
  return JSON.stringify(content.filter(block => block.type === 'tool_use' && block.id && !READ_TOOLS.has((block.name || '').replace(/^mcp__weworker__/, '')))
    .map(block => [block.id, block.status || 'running']))
}
export const fileChangeBase = (id, scope = 'chat') => scope === 'exploration'
  ? `/api/website-exploration/explorations/${encodeURIComponent(id)}/file-changes`
  : `/works/${encodeURIComponent(id)}/file-changes`
export function fileSizeLabel(size) {
  if (!Number.isFinite(size)) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
export function fileChangeEntries(records) {
  return records.flatMap(record => record.files.map((file, fileIndex) => ({ ...file, recordId: record.id, fileIndex, status: record.status, startedAt: record.startedAt })))
}
export function fileChangeTotals(records) {
  const entries = fileChangeEntries(records)
  return { files: new Set(entries.map(entry => entry.path)).size, edits: entries.length,
    added: entries.reduce((sum, entry) => sum + entry.added, 0), removed: entries.reduce((sum, entry) => sum + entry.removed, 0) }
}
