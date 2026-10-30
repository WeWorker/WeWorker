export function handleFolderHeadingClick(event, onToggle) {
  if (event.target?.closest?.('.work-folder-heading__toggle, .work-folder-heading__actions')) return false
  onToggle?.()
  return true
}
