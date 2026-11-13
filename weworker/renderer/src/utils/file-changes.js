const MUTATION_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit', 'Bash', 'PowerShell', 'weworker_powershell', 'write_file', 'edit_file', 'decrypt_file'])
export const fileChangeLabel = operation => ({ create: '新建', edit: '编辑', delete: '删除', unknown: '待确认' }[operation] || '待确认')
export const fileChangeName = filePath => String(filePath || '').split(/[\\/]/).filter(Boolean).at(-1) || '文件'
export function fileChangeToolState(content = []) {
  return JSON.stringify(content.filter(block => block.type === 'tool_use' && block.id && MUTATION_TOOLS.has((block.name || '').replace(/^mcp__weworker__/, '')))
    .map(block => [block.id, block.status || 'running']))
}
export function fileChangeEntries(records) {
  return records.flatMap(record => record.files.map((file, fileIndex) => ({ ...file, recordId: record.id, fileIndex, status: record.status, startedAt: record.startedAt })))
}
export function fileChangeTotals(records) {
  const entries = fileChangeEntries(records)
  return { files: new Set(entries.map(entry => entry.path)).size, edits: entries.length,
    added: entries.reduce((sum, entry) => sum + entry.added, 0), removed: entries.reduce((sum, entry) => sum + entry.removed, 0) }
}
