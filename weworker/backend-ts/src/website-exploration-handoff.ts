import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { ensureProjectDirectory } from './config.js'
import * as works from './works-store.js'

export const DEVELOPMENT_CHAT_PROMPT = '请分析附件 input.json 中的探索结果，生成可复用的网站适配器，以便下次直接操作网站。先运行 `webcli skills read adapter-development`，再按照该 Skill 判断复用、完善已有适配器或生成新适配器，并完成验证。请用非技术用户易懂的语言说明进展和结果，重点说明适配器能帮助用户完成哪些网站操作，围绕网站操作与适配器复用进行沟通，无需用户理解实现细节。'

/** Only the host writes into the chat workspace. The exploration service returns data, never paths. */
export function createDevelopmentChatHandoff(input: unknown, {
  workspaceRoot = () => ensureProjectDirectory('default'),
  createWork = works.createWork,
  beforeCreate = (_workId: string) => {},
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('网站适配器生成输入无效')
  const prepared = input as { schema_version?: number; site?: { start_url?: string; allowed_domains?: string[] }; source_exploration?: { exploration_id?: string } }
  if (prepared.schema_version !== 1 || !prepared.source_exploration?.exploration_id || !prepared.site?.start_url || !Array.isArray(prepared.site.allowed_domains) || !prepared.site.allowed_domains.length) throw new Error('网站适配器生成输入缺少探索或站点信息')
  const siteUrl = new URL(prepared.site.start_url)
  if (!['http:', 'https:'].includes(siteUrl.protocol) || siteUrl.username || siteUrl.password || !prepared.site.allowed_domains.includes(siteUrl.hostname)) throw new Error('网站适配器生成输入站点无效')
  const content = JSON.stringify(input, null, 2) + '\n'
  // A unique directory prevents two handoffs (or existing user files) sharing input.json.
  const directory = fs.mkdtempSync(path.join(workspaceRoot(), 'adapter-development-'))
  const file = path.join(directory, 'input.json')
  fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const workId = randomUUID()
  // Reserve ownership before inserting a work: a failed index write must never
  // leak an exploration conversation into the main list.
  beforeCreate(workId)
  const work = createWork(`网站适配器 · ${siteUrl.hostname}`, null, directory, workId)
  return { work, attachment: { path: file, name: 'input.json' }, prompt: DEVELOPMENT_CHAT_PROMPT }
}
