import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { markWeWorkerCreatedSkill, readManagedSkill } from './skill-management.js'

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_ENTRY_COUNT = 512
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024

export type ImportedSkill = { name: string; createdAt: number; creationOrderKey: string; source: 'custom' }

function safeEntryPath(fileName: string): string {
  const normalized = String(fileName || '').replace(/\\/g, '/')
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('ZIP 包含不安全的文件路径')
  }
  const parts = normalized.split('/').filter(Boolean)
  if (parts.some((part) => part === '.' || part === '..')) throw new Error('ZIP 包含不安全的文件路径')
  if (parts.some((part) => part.includes(':') || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('ZIP 包含当前系统不支持的文件名')
  }
  return parts.join(path.sep)
}

export function validateSkillZipEntryPath(fileName: string): string {
  return safeEntryPath(fileName)
}

function isSymlink(entry: yauzl.Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  return (unixMode & 0o170000) === 0o120000
}

function readEntries(buffer: Buffer, stagingDir: string): Promise<void> {
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) throw new Error('ZIP 文件不能超过 50 MB')
  return new Promise((resolve, reject) => {
    let settled = false
    let entryCount = 0
    let totalBytes = 0
    const seen = new Set<string>()
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      error ? reject(error) : resolve()
    }

    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true }, (error, zipFile) => {
      if (error || !zipFile) {
        finish(error instanceof Error ? error : new Error('无法读取 ZIP 文件'))
        return
      }
      const fail = (reason: unknown) => {
        zipFile.close()
        finish(reason instanceof Error ? reason : new Error(String(reason)))
      }
      zipFile.on('error', fail)
      zipFile.on('end', () => finish())
      zipFile.on('entry', (entry) => {
        if (settled) return
        try {
          entryCount += 1
          if (entryCount > MAX_ENTRY_COUNT) throw new Error('ZIP 文件包含过多条目')
          if (isSymlink(entry)) throw new Error('ZIP 不允许包含符号链接')
          const relativePath = safeEntryPath(entry.fileName)
          const pathKey = relativePath.toLowerCase()
          if (!relativePath || seen.has(pathKey)) throw new Error('ZIP 包含重复文件路径')
          seen.add(pathKey)
          const destination = path.resolve(stagingDir, relativePath)
          if (destination !== stagingDir && !destination.startsWith(`${path.resolve(stagingDir)}${path.sep}`)) {
            throw new Error('ZIP 包含不安全的文件路径')
          }
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
          const isDirectory = entry.fileName.endsWith('/') || (unixMode & 0o170000) === 0o040000
          if (isDirectory) {
            fs.mkdirSync(destination, { recursive: true })
            zipFile.readEntry()
            return
          }
          if (entry.uncompressedSize > MAX_UNCOMPRESSED_BYTES || totalBytes + entry.uncompressedSize > MAX_UNCOMPRESSED_BYTES) {
            throw new Error('ZIP 解压后的文件不能超过 200 MB')
          }
          totalBytes += entry.uncompressedSize
          fs.mkdirSync(path.dirname(destination), { recursive: true })
          zipFile.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail(streamError instanceof Error ? streamError : new Error('无法读取 ZIP 条目'))
              return
            }
            const output = fs.createWriteStream(destination, { flags: 'wx' })
            void pipeline(stream, output).then(
              () => zipFile.readEntry(),
              (pipelineError) => fail(pipelineError),
            )
          })
        } catch (entryError) {
          fail(entryError)
        }
      })
      zipFile.readEntry()
    })
  })
}

function findSkillDirectories(root: string): string[] {
  const found: string[] = []
  const visit = (directory: string) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
    if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) found.push(directory)
    for (const entry of entries) {
      if (entry.isDirectory()) visit(path.join(directory, entry.name))
    }
  }
  visit(root)
  return found
}

function safeSkillName(name: string): string {
  const normalized = String(name || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/^\.+$/, '_').trim()
  return normalized || 'imported-skill'
}

export async function importSkillZip(buffer: Buffer, skillsDir: string, archiveName = 'imported-skill.zip'): Promise<ImportedSkill[]> {
  fs.mkdirSync(skillsDir, { recursive: true })
  const stagingDir = fs.mkdtempSync(path.join(path.dirname(skillsDir), '.skill-import-'))
  const moved: Array<{ source: string; destination: string }> = []
  try {
    await readEntries(buffer, stagingDir)
    const directories = findSkillDirectories(stagingDir)
    if (directories.length === 0) throw new Error('ZIP 中没有找到包含 SKILL.md 的 Skill 文件夹')
    const roots = new Set(directories.map((directory) => path.resolve(directory)))
    if (directories.some((directory) => {
      let parent = path.dirname(directory)
      while (parent.startsWith(`${path.resolve(stagingDir)}${path.sep}`)) {
        if (roots.has(parent)) return true
        parent = path.dirname(parent)
      }
      return false
    })) throw new Error('ZIP 中不能嵌套多个 Skill 文件夹')

    const fallbackName = path.basename(archiveName, path.extname(archiveName))
    const names = directories.map((directory) => safeSkillName(
      path.resolve(directory) === path.resolve(stagingDir) ? fallbackName : path.basename(directory),
    ))
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new Error('ZIP 中存在重复的 Skill 名称')
    const destinations = names.map((name) => path.join(skillsDir, name))
    try {
      destinations.forEach((destination) => {
        fs.mkdirSync(destination)
        moved.push({ source: '', destination })
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new Error('目标 Skills 文件夹中已存在同名 Skill')
      throw error
    }
    directories.forEach((directory, index) => {
      const destination = destinations[index]
      const entries = fs.readdirSync(directory).sort((left, right) => Number(left === 'SKILL.md') - Number(right === 'SKILL.md'))
      for (const entry of entries) fs.renameSync(path.join(directory, entry), path.join(destination, entry))
    })
    return names.map((name) => {
      markWeWorkerCreatedSkill(skillsDir, name)
      const { createdAt, creationOrderKey } = readManagedSkill(skillsDir, name)
      return { name, createdAt, creationOrderKey, source: 'custom' }
    })
  } catch (error) {
    for (const item of moved.reverse()) fs.rmSync(item.destination, { recursive: true, force: true })
    throw error instanceof Error ? error : new Error('导入 Skill ZIP 失败')
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true })
  }
}

export async function importSkillZipFile(archivePath: string, skillsDir: string): Promise<ImportedSkill[]> {
  const resolvedPath = path.resolve(String(archivePath || ''))
  if (!resolvedPath.toLowerCase().endsWith('.zip')) throw new Error('请选择 .zip 格式的 Skill 文件夹')
  const stat = fs.statSync(resolvedPath)
  if (!stat.isFile()) throw new Error('ZIP 文件不存在')
  if (stat.size > MAX_ARCHIVE_BYTES) throw new Error('ZIP 文件不能超过 50 MB')
  return importSkillZip(fs.readFileSync(resolvedPath), skillsDir, path.basename(resolvedPath))
}

export const skillZipLimits = {
  maxArchiveBytes: MAX_ARCHIVE_BYTES,
  maxEntryCount: MAX_ENTRY_COUNT,
  maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
}
