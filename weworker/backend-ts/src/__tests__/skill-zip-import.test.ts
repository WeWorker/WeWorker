import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import yazl from 'yazl'
import { importSkillZip, validateSkillZipEntryPath } from '../skill-zip-import.js'
import { readManagedSkill } from '../skill-management.js'

function makeZip(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile()
    const chunks: Buffer[] = []
    zip.outputStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    zip.outputStream.on('error', reject)
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), name)
    zip.end()
  })
}

describe('skill ZIP import', () => {
  it('rejects traversal and absolute ZIP paths', () => {
    expect(() => validateSkillZipEntryPath('../outside.txt')).toThrow()
    expect(() => validateSkillZipEntryPath('/outside.txt')).toThrow()
    expect(() => validateSkillZipEntryPath('C:/outside.txt')).toThrow()
    expect(() => validateSkillZipEntryPath('demo/SKILL.md:payload')).toThrow()
    expect(() => validateSkillZipEntryPath('demo/NUL.txt')).toThrow()
    expect(validateSkillZipEntryPath('demo/assets/readme.txt')).toContain(path.sep)
  })

  it('extracts a skill folder and returns its name', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-skill-import-test-'))
    try {
      const zip = await makeZip({
        'bundle/demo/SKILL.md': '---\nname: demo\n---\n\n# Demo',
        'bundle/demo/assets/example.txt': 'example',
      })
      const startedAt = Date.now()
      const imported = await importSkillZip(zip, root)
      expect(imported).toMatchObject([{ name: 'demo', source: 'custom', createdAt: expect.any(Number) }])
      expect(imported[0].createdAt).toBeGreaterThanOrEqual(startedAt)
      expect(imported[0].createdAt).toBeLessThanOrEqual(Date.now())
      expect(readManagedSkill(root, 'demo').createdAt).toBe(imported[0].createdAt)
      expect(readManagedSkill(root, 'demo').source).toBe('custom')
      expect(fs.readFileSync(path.join(root, 'demo', 'SKILL.md'), 'utf8')).toContain('# Demo')
      expect(fs.readFileSync(path.join(root, 'demo', 'assets', 'example.txt'), 'utf8')).toBe('example')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not overwrite an existing skill', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-skill-import-test-'))
    fs.mkdirSync(path.join(root, 'demo'))
    try {
      const zip = await makeZip({ 'demo/SKILL.md': '# Demo' })
      await expect(importSkillZip(zip, root)).rejects.toThrow('同名 Skill')
      expect(fs.readdirSync(root)).toEqual(['demo'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('cleans the staging directory when the archive contains an unsafe path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-skill-import-test-'))
    const parent = path.dirname(root)
    const stagingBefore = new Set(fs.readdirSync(parent).filter((name) => name.startsWith('.skill-import-')))
    try {
      const zip = await makeZip({
        'demo/SKILL.md': '# Demo',
        'foo/xy': 'blocked',
      })
      const safePath = Buffer.from('foo/xy')
      const unsafePath = Buffer.from('../xyx')
      let offset = zip.indexOf(safePath)
      while (offset >= 0) {
        unsafePath.copy(zip, offset)
        offset = zip.indexOf(safePath, offset + unsafePath.length)
      }
      await expect(importSkillZip(zip, root)).rejects.toThrow(/不安全的文件路径|invalid relative path/)
      expect(fs.readdirSync(root)).toEqual([])
      expect(fs.readdirSync(parent).filter((name) => name.startsWith('.skill-import-'))).toEqual([...stagingBefore])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
