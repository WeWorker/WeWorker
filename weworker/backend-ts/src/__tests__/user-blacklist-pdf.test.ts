import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../config.js', () => ({
  getConfigDirectory: vi.fn(() => 'C:/Users/weworker-test/.weworker'),
  getUserDirectory: vi.fn(() => 'C:/Users/weworker-test/.weworker/user-files'),
  getUserDirectoryBlacklist: vi.fn(() => [{
    type: 'regex_path',
    pattern: '^folder-b/zcf \\(1\\)/BaiduSyncdisk/同步空间帮助文档\\.pdf$',
  }]),
  expandHomePath: (input: string) => input,
}))

import { evaluateToolAccess } from '../user-directory-access.js'
import { isPathBlacklisted } from '../user-directory-blacklist.js'

describe('user pdf blacklist scenario', () => {
  const root = 'C:/Users/weworker-test/.weworker/user-files'
  const pattern = '^folder-b/zcf \\(1\\)/BaiduSyncdisk/同步空间帮助文档\\.pdf$'
  const entries = [{ type: 'regex_path' as const, pattern }]
  const target = path.join(root, 'folder-b', 'zcf (1)', 'BaiduSyncdisk', '同步空间帮助文档.pdf')

  it('blocks the exact pdf path from user settings', () => {
    expect(isPathBlacklisted(target, entries, root)).toBe(true)
  })

  it('denies check_file_encryption on the pdf', () => {
    const decision = evaluateToolAccess('mcp__weworker__check_file_encryption', { file_path: target })
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toMatch(/blacklist/i)
  })

  it('denies bash read via absolute path', () => {
    const decision = evaluateToolAccess('Bash', { command: `python -c "open(r'${target.replace(/\\/g, '/')}','rb').read(16)"` })
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toMatch(/blacklist/i)
  })

  it('allows listing the parent directory', () => {
    const dir = path.join(root, 'folder-b', 'zcf (1)', 'BaiduSyncdisk')
    const decision = evaluateToolAccess('mcp__weworker__list_files', { directory: dir })
    expect(decision.allowed).toBe(true)
  })
})
