import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { listSkillDirectoryResources, saveSkillDirectoryResources } from './custom-skills.js'

const SKILL_SOURCE_INDEX = '.weworker-skill-sources.json'

export function sanitizeSkillDirectoryName(name: string): string {
  return (name || 'custom').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/^\.+$/, '_').trim() || 'custom'
}

function skillError(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode })
}

// Only filesystems without birth time need a persisted fallback. Keep this
// outside individual Skill folders so newly created folders stay empty.
function creationTime(root: string, stat: fs.BigIntStats): number {
  const birthTime = Number(stat.birthtimeMs)
  if (birthTime > 0) return birthTime
  const metadataPath = path.join(root, '.skill-times.json')
  const key = `${stat.dev}:${stat.ino}`
  let times: Record<string, number> = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) times = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (Number.isFinite(times[key]) && times[key] > 0) return times[key]
  times[key] = Number(stat.mtimeMs) > 0 ? Number(stat.mtimeMs) : Date.now()
  const temporaryPath = `${metadataPath}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(times))
  fs.renameSync(temporaryPath, metadataPath)
  return times[key]
}

function skillIdentity(stat: fs.BigIntStats): string {
  return `${stat.dev}:${stat.ino}`
}

function readWeWorkerCreatedSkillIds(root: string): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, SKILL_SOURCE_INDEX), 'utf8'))
    return new Set(Array.isArray(parsed?.weworkerCreated) ? parsed.weworkerCreated.filter((id: unknown) => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function markWeWorkerCreatedSkillDirectory(root: string, directory: string): void {
  const stat = fs.statSync(directory, { bigint: true })
  const ids = readWeWorkerCreatedSkillIds(root)
  ids.add(skillIdentity(stat))
  const indexPath = path.join(root, SKILL_SOURCE_INDEX)
  const temporaryPath = `${indexPath}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify({ weworkerCreated: [...ids] }))
  fs.renameSync(temporaryPath, indexPath)
}

function readSkillIcon(directory: string): string | undefined {
  for (const name of ['icon.png', 'icon.svg']) {
    const file = path.join(directory, name)
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 512 * 1024) continue
      const bytes = fs.readFileSync(file)
      if (name === 'icon.png') {
        if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') continue
        return `data:image/png;base64,${bytes.toString('base64')}`
      }
      const svg = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg\s/i.test(svg)
        || /<\s*(?:script|foreignObject|iframe|object|embed)\b|<!|\bon\w+\s*=|\bhref\s*=|\burl\s*\(|@import/i.test(svg)) continue
      return `data:image/svg+xml;base64,${bytes.toString('base64')}`
    } catch { /* An absent or invalid icon falls back to the standard Skill icon. */ }
  }
  return undefined
}

function resolveDirectory(root: string, name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim()
    || /[<>:"/\\|?*\x00-\x1F]/.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    skillError('请输入有效的 Skill 文件夹名称')
  }
  const directory = path.join(root, name)
  if (fs.existsSync(directory) && (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())) {
    skillError('Skill 路径不是普通文件夹')
  }
  for (const file of ['SKILL.md', 'SKILL.md.disabled']) {
    const target = path.join(directory, file)
    try { if (!fs.lstatSync(target).isFile()) skillError('Skill 文件不可读写') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return directory
}

export function readManagedSkill(root: string, name: string, builtAt?: number) {
  const dir = resolveDirectory(root, name)
  if (!fs.existsSync(dir)) skillError('Skill not found', 404)
  const active = path.join(dir, 'SKILL.md')
  const disabled = path.join(dir, 'SKILL.md.disabled')
  const file = fs.existsSync(disabled) ? disabled : fs.existsSync(active) ? active : null
  // Directory birth time and identity survive document edits and folder renames.
  // Do not use mtime/ctime: both can change when a Skill is edited or toggled.
  const isWeWorkerDraft = file === null
  const stat = fs.statSync(dir, { bigint: true })
  return {
    name, content: file ? fs.readFileSync(file, 'utf8') : '',
    iconUrl: readSkillIcon(dir),
    source: isWeWorkerDraft || readWeWorkerCreatedSkillIds(root).has(skillIdentity(stat)) ? 'custom' : 'official',
    createdAt: builtAt && Number.isFinite(builtAt) && builtAt > 0 ? builtAt : creationTime(root, stat),
    creationOrderKey: `${stat.dev}:${stat.ino}`,
    enabled: file === active, draft: file === null,
    resources: listSkillDirectoryResources(dir),
  }
}

export function createSkillFolder(root: string, name: unknown) {
  const directory = resolveDirectory(root, name)
  fs.mkdirSync(root, { recursive: true })
  try { fs.mkdirSync(directory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') skillError('Skill 文件夹名称已存在', 409)
    throw error
  }
  markWeWorkerCreatedSkillDirectory(root, directory)
  return readManagedSkill(root, name as string)
}

export function markWeWorkerCreatedSkill(root: string, name: string): void {
  const directory = resolveDirectory(root, name)
  if (!fs.existsSync(directory)) skillError('Skill not found', 404)
  markWeWorkerCreatedSkillDirectory(root, directory)
}

export function setSkillEnabled(root: string, name: string, enabled?: boolean) {
  const skill = readManagedSkill(root, name)
  if (skill.draft) skillError('请先编写 SKILL.md，再启用此 Skill', 409)
  const next = enabled ?? !skill.enabled
  const dir = resolveDirectory(root, name)
  const active = path.join(dir, 'SKILL.md')
  const disabled = path.join(dir, 'SKILL.md.disabled')
  if (next !== skill.enabled) fs.renameSync(next ? disabled : active, next ? active : disabled)
  return { ok: true, enabled: next }
}

export function saveManagedSkill(root: string, input: { name: string; previousName?: string; content: string; resources?: unknown[] }) {
  if (typeof input.name !== 'string' || !input.name.trim() || typeof input.content !== 'string') skillError('name and content required')
  const frontmatter = input.content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
  const markdownName = frontmatter?.match(/^\s*name\s*:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '').trim()
  const name = sanitizeSkillDirectoryName(markdownName && !markdownName.includes('{{') && !markdownName.includes('}}') ? markdownName : input.name)
  const dir = resolveDirectory(root, name)
  if (input.previousName && input.previousName !== name) {
    const previous = resolveDirectory(root, input.previousName)
    if (fs.existsSync(dir)) skillError(`Skill name already exists: ${name}`, 409)
    if (!fs.existsSync(previous)) skillError('Skill not found', 404)
    fs.renameSync(previous, dir)
  }
  const existed = fs.existsSync(dir)
  const active = path.join(dir, 'SKILL.md')
  const disabled = path.join(dir, 'SKILL.md.disabled')
  const wasDraft = existed && !fs.existsSync(active) && !fs.existsSync(disabled)
  fs.mkdirSync(dir, { recursive: true })
  if (!existed || wasDraft) markWeWorkerCreatedSkillDirectory(root, dir)
  // A new empty folder stays empty until the user actually writes a document.
  // Saving a draft's first document leaves it off until explicitly enabled.
  if (input.content.trim() || fs.existsSync(active) || fs.existsSync(disabled)) {
    const destination = fs.existsSync(disabled) || (existed && !fs.existsSync(active)) ? disabled : active
    fs.writeFileSync(destination, input.content)
  }
  if (Array.isArray(input.resources)) saveSkillDirectoryResources(dir, input.resources)
  return { ok: true, ...readManagedSkill(root, name) }
}

export function createSkillManagementRouter(root: string, officialBuildTime: (name: string) => number | undefined = () => undefined) {
  const router = Router()
  router.get('/skills', (_req, res, next) => {
    try {
      fs.mkdirSync(root, { recursive: true })
      const skills = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
        try { return [readManagedSkill(root, entry.name, officialBuildTime(entry.name))] } catch { return [] }
      })
      res.json(skills)
    } catch (error) { next(error) }
  })
  router.post('/skills/folders', (req, res, next) => {
    try { res.status(201).json({ ok: true, ...createSkillFolder(root, req.body?.name) }) }
    catch (error) { next(error) }
  })
  router.post('/skills', (req, res, next) => {
    try { res.json(saveManagedSkill(root, req.body ?? {})) } catch (error) { next(error) }
  })
  router.post('/skills/:name/toggle', (req, res, next) => {
    try {
      if (req.body?.enabled !== undefined && typeof req.body.enabled !== 'boolean') skillError('enabled must be boolean')
      res.json(setSkillEnabled(root, req.params.name, req.body?.enabled))
    } catch (error) { next(error) }
  })
  router.use((error: Error & { statusCode?: number }, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
    res.status(error.statusCode ?? 500).json({ detail: error.statusCode ? error.message : 'Skill 操作失败，请重试' })
  })
  return router
}
