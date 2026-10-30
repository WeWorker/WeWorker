import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config.js', () => ({
  getUserDirectory: vi.fn(),
  getUserDirectoryBlacklist: vi.fn(() => []),
  getConfigDirectory: vi.fn(() => path.join(os.tmpdir(), 'weworker-config-test')),
  expandHomePath: (input: string) => input,
}))

import { getUserDirectory, getUserDirectoryBlacklist } from '../config.js'
import {
  assertPathInsideUserDirectory,
  isPathInsideUserDirectory,
  resolveDirectoryInsideUserDirectory,
} from '../user-directory-guard.js'
import { listFiles, readFileText } from '../file-tools.js'
import { checkFilesystemPath, checkShellCommand } from '../user-directory-access.js'

describe('user-directory guard', () => {
  const root = path.join(os.tmpdir(), 'weworker-user-dir-test')

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    vi.mocked(getUserDirectoryBlacklist).mockReturnValue([])
  })

  it('rejects blacklisted paths inside the user directory', () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    vi.mocked(getUserDirectoryBlacklist).mockReturnValue([{ type: 'regex_path', pattern: '^secrets/key\\.txt$' }])
    fs.mkdirSync(path.join(root, 'secrets'), { recursive: true })
    const blocked = path.join(root, 'secrets', 'key.txt')
    fs.writeFileSync(blocked, 'secret')

    expect(() => readFileText(blocked)).toThrow(/blocked/)
    expect(listFiles('secrets').files).toHaveLength(0)

    fs.rmSync(blocked, { force: true })
  })

  it('allows paths inside the configured user directory', () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
    const inside = path.join(root, 'docs', 'note.txt')
    fs.writeFileSync(inside, 'hello')

    expect(isPathInsideUserDirectory(inside)).toBe(true)
    expect(resolveDirectoryInsideUserDirectory(path.join(root, 'docs'))).toBe(path.resolve(root, 'docs'))
    expect(listFiles('docs').files).toHaveLength(1)
    expect(readFileText(inside).content).toBe('hello')
  })

  it('allows paths inside the runtime skills directory', () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    const runtimeSkills = path.join(os.tmpdir(), 'weworker-config-test', 'claude-config', 'skills')
    fs.mkdirSync(path.join(runtimeSkills, 'site-skill'), { recursive: true })
    const skillFile = path.join(runtimeSkills, 'site-skill', 'SKILL.md')
    fs.writeFileSync(skillFile, 'skill content')

    expect(isPathInsideUserDirectory(skillFile)).toBe(false)
    expect(readFileText(skillFile).content).toBe('skill content')
    expect(assertPathInsideUserDirectory(skillFile)).toBe(path.resolve(skillFile))
  })

  it('rejects paths outside the configured user directory', () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    fs.mkdirSync(root, { recursive: true })
    const outside = path.join(os.tmpdir(), 'outside-note.txt')
    fs.writeFileSync(outside, 'secret')

    expect(isPathInsideUserDirectory(outside)).toBe(false)
    expect(() => assertPathInsideUserDirectory(outside)).toThrow(/must stay inside user directory/)
    expect(() => listFiles(outside)).toThrow(/must stay inside user directory/)
    expect(() => readFileText(outside)).toThrow(/must stay inside user directory/)

    fs.rmSync(outside, { force: true })
  })

  it('confines work tools to the active project folder, including external bindings', () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    const workspace = path.join(os.tmpdir(), 'weworker-bound-project')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'note.txt'), 'hello')
    const outside = path.join(os.tmpdir(), 'weworker-outside-project.txt')

    expect(checkFilesystemPath(path.join(workspace, 'note.txt'), 'Read', workspace).allowed).toBe(true)
    expect(checkFilesystemPath(outside, 'Read', workspace).allowed).toBe(false)
    expect(checkShellCommand('cat note.txt', workspace).allowed).toBe(true)
    expect(checkShellCommand(`cat "${outside}"`, workspace).allowed).toBe(false)

    fs.rmSync(workspace, { recursive: true, force: true })
  })
})
