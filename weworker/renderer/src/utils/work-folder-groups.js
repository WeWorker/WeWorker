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

export function groupWorksByFolder(works, projects = []) {
  const groups = new Map()
  // Creation order is independent of message activity and project renames.
  const orderedProjects = [...projects].sort((a, b) => (
    (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0)
  ))
  for (const project of orderedProjects) {
    const key = `project:${project.id}`
    groups.set(key, { key, id: project.id, name: project.name, dedicatedAgent: Boolean(project.dedicated_agent), items: [] })
  }
  for (const work of works) {
    const projectId = work?.project_id || null
    const project = projectId ? projects.find((item) => item.id === projectId) : null
    const legacyName = getWorkFolderName(work)
    const key = project ? `project:${project.id}` : (legacyName === '默认工作区' ? 'default' : `legacy:${legacyName}`)
    if (!groups.has(key)) groups.set(key, { key, id: project?.id || null, name: project?.name || legacyName, dedicatedAgent: Boolean(project?.dedicated_agent), items: [] })
    groups.get(key).items.push(work)
  }
  const defaultGroup = groups.get('default')
  const projectGroups = [...groups.values()].filter((group) => group.id)
  return [
    ...projectGroups,
    ...(defaultGroup ? [defaultGroup] : []),
  ]
}
