function pathSeparatorFor(value) {
  return String(value).includes('\\') ? '\\' : '/'
}

function joinPath(base, ...segments) {
  const separator = pathSeparatorFor(base)
  return [String(base).replace(/[\\/]+$/g, ''), ...segments.map((segment) => String(segment).replace(/^[\\/]+|[\\/]+$/g, ''))]
    .filter(Boolean)
    .join(separator)
}

export function getProjectsDirectoryPath(userDirectory) {
  if (!String(userDirectory || '').trim()) return ''
  return joinPath(userDirectory, 'projects')
}

export function createDefaultProjectFolder(userDirectory, id = globalThis.crypto?.randomUUID?.()) {
  const randomId = id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  const projectsDirectory = getProjectsDirectoryPath(userDirectory)
  return projectsDirectory ? joinPath(projectsDirectory, `workspace-${randomId}`) : ''
}
