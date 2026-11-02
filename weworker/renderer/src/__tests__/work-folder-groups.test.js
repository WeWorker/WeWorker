import test from 'node:test'
import assert from 'node:assert/strict'
import { groupWorksByFolder, isWorkFolderActive } from '../utils/work-folder-groups.js'

test('new empty project precedes older active projects and default workspace', () => {
  const projects = [
    { id: 'old', name: 'Old project', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' },
    { id: 'new', name: 'New project', created_at: '2026-02-01T00:00:00Z' },
  ]
  const works = [{ id: 'default-work' }, { id: 'old-work', project_id: 'old' }]
  const groups = groupWorksByFolder(works, projects)
  assert.deepEqual(groups.map(g => g.key), ['project:new', 'project:old', 'default'])
  assert.deepEqual(groups[0].items, [])
  assert.deepEqual(groups[1].items, [works[1]])
  assert.equal(projects[0].id, 'old')
})

test('message order and refreshed project order do not change creation ordering', () => {
  const projects = [
    { id: 'new', name: 'New project', created_at: '2026-02-01T00:00:00Z' },
    { id: 'old', name: 'Renamed project', created_at: '2026-01-01T00:00:00Z' },
  ]
  const works = [{ id: 'old-work', project_id: 'old' }, { id: 'new-work', project_id: 'new' }]
  for (const list of [projects, [...projects].reverse()]) {
    assert.deepEqual(groupWorksByFolder(works, list).map(g => g.id), ['new', 'old'])
  }
})

test('scheduled task projects retain managed protections after grouping', () => {
  const [group] = groupWorksByFolder([{ id: 'task-work', project_id: 'tasks' }], [{ id: 'tasks', name: '定时任务' }])
  assert.equal(group.systemManaged, true)
  assert.equal(group.items[0].id, 'task-work')
  assert.equal(groupWorksByFolder([], [{ id: 'ordinary', name: 'Example' }])[0].systemManaged, false)
})

test('folder focus follows the pending draft destination, including default workspace', () => {
  const works = [{ id: 'default-work' }, { id: 'project-work', project_id: 'project-a' }]
  const groups = groupWorksByFolder(works, [{ id: 'project-a', name: 'Project A' }])
  const [project, defaultWorkspace] = groups

  assert.equal(isWorkFolderActive(project, { activeWorkId: null, draftFolderKey: 'default', selectedFolderKey: null }), false)
  assert.equal(isWorkFolderActive(defaultWorkspace, { activeWorkId: null, draftFolderKey: 'default', selectedFolderKey: null }), true)
  assert.equal(isWorkFolderActive(project, { activeWorkId: null, draftFolderKey: 'project:project-a', selectedFolderKey: null }), true)
  assert.equal(isWorkFolderActive(defaultWorkspace, { activeWorkId: null, draftFolderKey: 'project:project-a', selectedFolderKey: null }), false)
})
