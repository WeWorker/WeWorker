import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureExplorationWorkspaceDirectory, getExplorationTaskDirectory } from '../exploration-workspace.js'
import { resolveAgentWorkspaceDirectory, workspaceDirectoryForContext } from '../workspace-context.js'
import { createUserFile, listUserFiles } from '../user-files.js'
import * as config from '../config.js'
import { createDevelopmentChatHandoff } from '../website-exploration-handoff.js'
import type { Work } from '../works-store.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exploration-workspace-'))
  roots.push(root)
  const userDirectory = path.join(root, 'configured-user-files')
  return { root, userDirectory, directory: path.join(userDirectory, 'website-exploration') }
}

it('creates and reuses a fixed folder under the configured user directory, preserving its files', () => {
  const { userDirectory, directory } = fixture()
  expect(ensureExplorationWorkspaceDirectory(userDirectory)).toBe(directory)
  fs.writeFileSync(path.join(directory, 'example.txt'), 'keep')
  expect(ensureExplorationWorkspaceDirectory(userDirectory)).toBe(directory)
  expect(fs.readFileSync(path.join(directory, 'example.txt'), 'utf8')).toBe('keep')
  expect(ensureExplorationWorkspaceDirectory(path.join(userDirectory, 'other-root'))).toBe(path.join(userDirectory, 'other-root', 'website-exploration'))
})

it('does not replace an existing file or follow a linked exploration folder', () => {
  const { root, userDirectory, directory } = fixture()
  fs.mkdirSync(userDirectory)
  fs.writeFileSync(directory, 'keep')
  expect(() => ensureExplorationWorkspaceDirectory(userDirectory)).toThrow()
  expect(fs.readFileSync(directory, 'utf8')).toBe('keep')
  const linkedRoot = path.join(root, 'linked-root')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(linkedRoot)
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(linkedRoot, 'website-exploration'), 'junction')
  expect(() => ensureExplorationWorkspaceDirectory(linkedRoot)).toThrow()
  expect(fs.readdirSync(outside)).toEqual([])
})

it('new handoffs reuse the pinned exploration directory and keep separate readable input attachments', () => {
  const { root, userDirectory } = fixture()
  vi.spyOn(config, 'getUserDirectory').mockReturnValue(userDirectory)
  const serviceHome = path.join(root, 'service')
  vi.stubEnv('WEBWRIGHT_HOME', serviceHome)
  const server = path.join(serviceHome, 'tasks', 'example', '.server')
  fs.mkdirSync(server, { recursive: true })
  fs.writeFileSync(path.join(server, 'task.json'), JSON.stringify({ task_id: 'example', activity_type: 'exploration' }))
  const directory = path.join(root, 'previous-user-files', 'website-exploration', 'example')
  fs.writeFileSync(path.join(server, 'artifact-workspace.json'), JSON.stringify({ version: 1, directory }))
  const createWork = vi.fn((title = '', project_id: string | null = null, workspace_directory = '', id = 'example') => ({ id, title, project_id, workspace_directory } as Work))
  const input = { schema_version: 1, site: { start_url: 'https://example.com', allowed_domains: ['example.com'] }, source_exploration: { exploration_id: 'example' } }
  const first = createDevelopmentChatHandoff(input, { createWork })
  const second = createDevelopmentChatHandoff(input, { createWork })
  expect(path.dirname(first.work.workspace_directory)).toBe(directory)
  expect(first.attachment.path).not.toBe(second.attachment.path)
  expect(JSON.parse(fs.readFileSync(first.attachment.path, 'utf8'))).toEqual(input)
  expect(JSON.parse(fs.readFileSync(second.attachment.path, 'utf8'))).toEqual(input)
})

function contextFixture() {
  const dirs = fixture()
  return {
    ...dirs,
    getWork: vi.fn((id: string) => id === 'missing' ? null : ({ workspace_directory: path.join(dirs.userDirectory, 'legacy-input') })),
    getProject: vi.fn(() => ({ folder_path: path.join(dirs.userDirectory, 'project') })),
    isExplorationWork: (id: string) => id === 'exploration-work',
    explorationIdForWork: (id: string) => id === 'exploration-work' ? 'exp_example' : null,
    userDirectory: () => dirs.userDirectory,
    explorationDirectory: (id: string) => {
      const directory = path.join(ensureExplorationWorkspaceDirectory(dirs.userDirectory), id)
      fs.mkdirSync(directory, { recursive: true })
      return directory
    },
  }
}

it.each(['full', 'ask', 'qa_only', 'no_bash', 'workspace'] as const)('exploration chat uses the fixed cwd in %s mode, including old works', mode => {
  const deps = contextFixture()
  expect(resolveAgentWorkspaceDirectory('exploration-work', mode, deps)).toBe(path.join(deps.directory, 'exp_example'))
  expect(deps.getWork).not.toHaveBeenCalled()
})

it('preserves the existing ordinary-chat permission and project directory behavior', () => {
  const deps = contextFixture()
  expect(resolveAgentWorkspaceDirectory('normal-work', 'full', deps)).toBeUndefined()
  expect(resolveAgentWorkspaceDirectory('normal-work', 'workspace', deps)).toBe(path.join(deps.userDirectory(), 'legacy-input'))
  expect(resolveAgentWorkspaceDirectory('missing', 'ask', deps)).toBe(deps.userDirectory())
  expect(workspaceDirectoryForContext('normal-work', undefined, undefined, deps)).toBe(path.join(deps.userDirectory(), 'legacy-input'))
  expect(workspaceDirectoryForContext(undefined, 'project', undefined, deps)).toBe(path.join(deps.userDirectory(), 'project'))
  expect(workspaceDirectoryForContext(undefined, undefined, undefined, deps)).toBeUndefined()
  expect(() => workspaceDirectoryForContext('missing', undefined, undefined, deps)).toThrow('work not found')
})

it('file management selects only the current exploration and rejects an unsent draft', () => {
  const deps = contextFixture()
  expect(() => workspaceDirectoryForContext(undefined, undefined, 'website-exploration', deps)).toThrow()
  const directory = workspaceDirectoryForContext(undefined, undefined, 'website-exploration:exp_example', deps)
  expect(directory).toBe(path.join(deps.directory, 'exp_example'))
  createUserFile(undefined, 'example.txt', directory)
  expect(listUserFiles(directory).directory).toBe(directory)
  expect(fs.existsSync(path.join(directory!, 'example.txt'))).toBe(true)
  expect(() => createUserFile(deps.userDirectory(), 'outside.txt', directory)).toThrow()
  const other = workspaceDirectoryForContext(undefined, undefined, 'website-exploration:exp_other', deps)
  expect(listUserFiles(other).files).toEqual([])
  expect(() => createUserFile(other, 'other.txt', directory)).toThrow()
  expect(deps.getWork).not.toHaveBeenCalled()
  expect(() => workspaceDirectoryForContext(undefined, undefined, '../other', deps)).toThrow()
  expect(() => workspaceDirectoryForContext('normal-work', undefined, 'website-exploration', deps)).toThrow()
})

it('resolves the stored task directory and does not create unknown or deleted tasks', () => {
  const { root, userDirectory, directory } = fixture()
  const serviceHome = path.join(root, 'service')
  vi.stubEnv('WEBWRIGHT_HOME', serviceHome)
  vi.spyOn(config, 'getUserDirectory').mockReturnValue(userDirectory)
  const server = path.join(serviceHome, 'tasks', 'exp_example', '.server')
  fs.mkdirSync(server, { recursive: true })
  fs.writeFileSync(path.join(server, 'task.json'), JSON.stringify({ task_id: 'exp_example', activity_type: 'exploration' }))
  const pinned = path.join(root, 'previous-user-files', 'website-exploration', 'exp_example')
  fs.mkdirSync(pinned, { recursive: true })
  fs.writeFileSync(path.join(server, 'artifact-workspace.json'), JSON.stringify({ version: 1, directory: pinned }))
  expect(getExplorationTaskDirectory('exp_example')).toBe(pinned)
  expect(() => getExplorationTaskDirectory('missing')).toThrow()
  expect(() => getExplorationTaskDirectory('../exp_other')).toThrow()
  expect(fs.existsSync(path.join(directory, 'missing'))).toBe(false)
  fs.writeFileSync(path.join(server, 'task.json'), JSON.stringify({ task_id: 'exp_example', activity_type: 'exploration', deleted_at: '2026-01-01' }))
  expect(() => getExplorationTaskDirectory('exp_example')).toThrow()
  vi.unstubAllEnvs()
})

it('opens legacy task artifacts in their own folder without copying runtime state or overwriting files', () => {
  const { root, userDirectory, directory } = fixture()
  const serviceHome = path.join(root, 'service')
  vi.stubEnv('WEBWRIGHT_HOME', serviceHome)
  vi.spyOn(config, 'getUserDirectory').mockReturnValue(userDirectory)
  const internal = path.join(serviceHome, 'tasks', 'exp_legacy')
  const server = path.join(internal, '.server')
  fs.mkdirSync(server, { recursive: true })
  fs.writeFileSync(path.join(server, 'task.json'), JSON.stringify({ task_id: 'exp_legacy', activity_type: 'exploration' }))
  fs.mkdirSync(path.join(internal, 'artifacts'), { recursive: true })
  fs.writeFileSync(path.join(internal, 'artifacts', 'report.md'), 'original')
  fs.writeFileSync(path.join(internal, 'artifacts', 'data.json'), '{}')
  fs.writeFileSync(path.join(internal, 'script.py'), '# example')
  fs.writeFileSync(path.join(internal, 'trajectory.json'), '{"private_runtime":true}')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'private.txt'), 'outside')
  fs.symlinkSync(outside, path.join(internal, 'artifacts', 'linked'), 'junction')
  const expected = path.join(directory, 'exp_legacy')
  fs.mkdirSync(path.join(expected, 'artifacts'), { recursive: true })
  fs.writeFileSync(path.join(expected, 'artifacts', 'report.md'), 'user edited')
  expect(getExplorationTaskDirectory('exp_legacy')).toBe(expected)
  expect(fs.readFileSync(path.join(expected, 'artifacts', 'report.md'), 'utf8')).toBe('user edited')
  expect(fs.readFileSync(path.join(expected, 'artifacts', 'data.json'), 'utf8')).toBe('{}')
  expect(fs.existsSync(path.join(expected, 'artifacts', 'linked'))).toBe(false)
  expect(fs.existsSync(path.join(expected, 'trajectory.json'))).toBe(false)
  expect(fs.existsSync(path.join(expected, '.server'))).toBe(false)
  expect(fs.readFileSync(path.join(internal, 'artifacts', 'report.md'), 'utf8')).toBe('original')
  expect(JSON.parse(fs.readFileSync(path.join(server, 'artifact-workspace.json'), 'utf8'))).toEqual({version: 1, directory: expected})
  vi.spyOn(config, 'getUserDirectory').mockReturnValue(path.join(root, 'changed-user-files'))
  expect(getExplorationTaskDirectory('exp_legacy')).toBe(expected)
})
