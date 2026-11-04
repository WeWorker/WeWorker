import fs from 'node:fs'
import path from 'node:path'
import { ensureProjectDirectory } from './config.js'
import * as works from './works-store.js'

export const DEVELOPMENT_CHAT_PROMPT = '请读取附件 input.json，运行 `webcli skills read adapter-development`，并按照该 Skill 开发和调试 Adapter。'

/** Only the host writes into the chat workspace. The exploration service returns data, never paths. */
export function createDevelopmentChatHandoff(input: unknown, {
  workspaceRoot = () => ensureProjectDirectory('default'),
  createWork = works.createWork,
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('开发输入无效')
  const prepared = input as { schema_version?: number; site?: { start_url?: string; allowed_domains?: string[] }; source_exploration?: { exploration_id?: string } }
  if (prepared.schema_version !== 1 || !prepared.source_exploration?.exploration_id || !prepared.site?.start_url || !Array.isArray(prepared.site.allowed_domains) || !prepared.site.allowed_domains.length) throw new Error('开发输入缺少探索或站点信息')
  const siteUrl = new URL(prepared.site.start_url)
  if (!['http:', 'https:'].includes(siteUrl.protocol) || siteUrl.username || siteUrl.password || !prepared.site.allowed_domains.includes(siteUrl.hostname)) throw new Error('开发输入站点无效')
  const content = JSON.stringify(input, null, 2) + '\n'
  // A unique directory prevents two handoffs (or existing user files) sharing input.json.
  const directory = fs.mkdtempSync(path.join(workspaceRoot(), 'adapter-development-'))
  const file = path.join(directory, 'input.json')
  fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const work = createWork(`开发 Adapter · ${siteUrl.hostname}`, null, directory)
  return { work, attachment: { path: file, name: 'input.json' }, prompt: DEVELOPMENT_CHAT_PROMPT }
}
