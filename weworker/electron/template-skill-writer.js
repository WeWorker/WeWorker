import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_SKILL_BYTES = 200_000
const TEMPLATE_SKILL_BASE_NAMES = Object.freeze({
  'invoice-self-check-helper': 'invoice-self-check-helper',
  'apikey-usage-helper': 'apikey-usage-helper',
})

export class TemplateSkillWriteError extends Error {
  constructor(message, code = 'INVALID_TEMPLATE_SKILL') {
    super(message)
    this.name = 'TemplateSkillWriteError'
    this.code = code
  }
}

function templateSkillName(templateId, value) {
  const baseName = TEMPLATE_SKILL_BASE_NAMES[String(templateId || '')]
  const name = String(value || '').trim()
  if (!baseName || !name) throw new TemplateSkillWriteError('内置模板 Skill 参数无效')
  if (name === baseName) return name
  const prefix = `${baseName}-`
  const suffix = name.startsWith(prefix) ? name.slice(prefix.length) : ''
  const sequence = /^\d+$/.test(suffix) ? Number(suffix) : 0
  if (!Number.isInteger(sequence) || sequence < 2 || sequence > 99) {
    throw new TemplateSkillWriteError('内置模板 Skill 名称无效')
  }
  return name
}

function stripWrappingFence(markdown) {
  const trimmed = String(markdown ?? '').trim()
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  return fenced ? fenced[1].trim() : trimmed
}

/** Keep this temporary writer compatible with backend normalizeSkillMarkdown(). */
export function normalizeTemplateSkillMarkdown(markdown, skillName) {
  let text = stripWrappingFence(markdown)
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!frontmatter) {
    text = `---\nname: ${skillName}\ndescription: "${skillName}"\nallowed-tools: Bash(webcli call *)\n---\n\n${text}`
    return text.trim() + '\n'
  }
  let header = frontmatter[1]
  header = /^\s*name\s*:/m.test(header)
    ? header.replace(/^\s*name\s*:.*$/m, `name: ${skillName}`)
    : `name: ${skillName}\n${header}`
  if (!/^\s*allowed-tools\s*:/m.test(header)) header += '\nallowed-tools: Bash(webcli call *)'
  const body = text.slice(frontmatter[0].length).replace(/^\s+/, '')
  return `---\n${header.trim()}\n---\n\n${body}`.trim() + '\n'
}

function defaultLocations() {
  const configDir = path.join(os.homedir(), '.weworker')
  return {
    libraryDir: process.env.WEWORKER_AGENT_SKILL_LIBRARY_DIR
      || path.join(configDir, 'dedicated-agents', 'skill-library'),
    runtimeSkillsDir: path.join(configDir, 'claude-config', 'skills'),
  }
}

function skillExists(root, name) {
  return fs.existsSync(path.join(root, name))
}

function conflict(name) {
  return new TemplateSkillWriteError(`Skill「${name}」已存在，请换一个名称`, 'SKILL_EXISTS')
}

/**
 * Temporary local channel used only by built-in template quick-create.
 *
 * Some managed Windows environments reject large loopback request bodies from
 * WeWorker/Electron. Keep the destination fixed, private-only and inaccessible
 * to the Renderer; remove this exception when a unified Backend IPC exists.
 */
export function writeTemplateSkillLocally(payload, locations = defaultLocations()) {
  const name = templateSkillName(payload?.templateId, payload?.name)
  const markdown = normalizeTemplateSkillMarkdown(payload?.markdown, name)
  if (Buffer.byteLength(markdown, 'utf8') > MAX_SKILL_BYTES) {
    throw new TemplateSkillWriteError('Skill 内容过长', 'SKILL_TOO_LARGE')
  }

  const libraryDir = path.resolve(locations.libraryDir)
  const runtimeSkillsDir = path.resolve(locations.runtimeSkillsDir)
  if (skillExists(libraryDir, name) || skillExists(runtimeSkillsDir, name)) throw conflict(name)

  fs.mkdirSync(libraryDir, { recursive: true })
  const target = path.join(libraryDir, name)
  const temporary = fs.mkdtempSync(path.join(libraryDir, `.${name}-`))
  try {
    fs.writeFileSync(path.join(temporary, 'SKILL.md'), markdown, { encoding: 'utf8', flag: 'wx' })
    // Recheck immediately before the atomic rename so concurrent quick-create
    // attempts preserve the backend's cross-scope uniqueness rule.
    if (fs.existsSync(target) || skillExists(runtimeSkillsDir, name)) throw conflict(name)
    fs.renameSync(temporary, target)
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') throw conflict(name)
    throw error
  }
  return { name, scope: 'private', markdown }
}
