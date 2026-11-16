import fs from 'node:fs'
import path from 'node:path'
import { getConfigDirectory } from './config.js'
import * as works from './works-store.js'
import { createDevelopmentChatHandoff, DEVELOPMENT_CHAT_PROMPT } from './website-exploration-handoff.js'

// Host-owned metadata, not exploration-service data. No database migration and
// no separate chat runtime: memory, permissions and tools use the normal pipeline.
interface Entry { explorationId: string; runId: string | null; workId: string }
interface Index { version: 1; entries: Entry[]; deletedExplorations: string[] }
const indexPath = () => path.join(getConfigDirectory(), 'exploration-conversations.json')
function read(file = indexPath()): Index {
  if (!fs.existsSync(file)) return { version: 1, entries: [], deletedExplorations: [] }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (data?.version !== 1 || !Array.isArray(data.entries) || data.entries.some((e: Entry) =>
    !e || typeof e.explorationId !== 'string' || typeof e.workId !== 'string' || (e.runId !== null && typeof e.runId !== 'string'))) {
    throw new Error('网站适配器会话索引无效')
  }
  const deletedExplorations = data.deletedExplorations ?? []
  if (!Array.isArray(deletedExplorations) || deletedExplorations.some(id => typeof id !== 'string')) throw new Error('探索记录索引无效')
  return { version: 1, entries: data.entries, deletedExplorations }
}
function write(index: Index, file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(temporary, JSON.stringify(index) + '\n', { mode: 0o600 })
  fs.renameSync(temporary, file)
}
export function isExplorationConversation(workId: string, file = indexPath()): boolean {
  return read(file).entries.some(entry => entry.workId === workId)
}
export function explorationIdForConversation(workId: string, file = indexPath()): string | null {
  return read(file).entries.find(entry => entry.workId === workId)?.explorationId || null
}
export function excludeExplorationConversations<T extends { id: string }>(items: T[], file = indexPath()): T[] {
  const owned = new Set(read(file).entries.map(e => e.workId))
  return items.filter(item => !owned.has(item.id))
}
export function listExplorationConversations({ file = indexPath(), getWork = works.getWork, hasMessages = works.hasWorkMessages } = {}) {
  const index = read(file)
  return index.entries.filter(entry => !index.deletedExplorations.includes(entry.explorationId)).flatMap(entry => {
    const work = getWork(entry.workId)
    if (!work) return [] // Retain ownership tombstones; never expose a deleted work as main chat.
    return [{ ...entry, work, attachment: { path: path.join(work.workspace_directory, 'input.json'), name: 'input.json' },
      prompt: DEVELOPMENT_CHAT_PROMPT, needsInitialMessage: !hasMessages(entry.workId) }]
  })
}
export function markExplorationDeleted(explorationId: string, file = indexPath()) {
  const index = read(file)
  if (!index.deletedExplorations.includes(explorationId)) {
    write({ ...index, deletedExplorations: [...index.deletedExplorations, explorationId] }, file)
  }
}
export function prepareExplorationConversation(input: unknown, {
  file = indexPath(), getWork = works.getWork, hasMessages = works.hasWorkMessages, create = createDevelopmentChatHandoff,
} = {}) {
  const source = (input as { source_exploration?: { exploration_id?: string; run_id?: string | null } })?.source_exploration
  if (!source?.exploration_id || !/^[A-Za-z0-9_-]+$/.test(source.exploration_id)) throw new Error('网站适配器生成输入缺少探索标识')
  if (read(file).deletedExplorations.includes(source.exploration_id)) throw new Error('探索记录已删除')
  const runId = source.run_id ?? null
  if (runId !== null && (typeof runId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(runId))) throw new Error('网站适配器生成输入轮次无效')
  // Synchronous create + atomic index update: parallel HTTP retries cannot create
  // two works for the same trusted exploration run.
  const existing = listExplorationConversations({ file, getWork, hasMessages }).find(e => e.explorationId === source.exploration_id && e.runId === runId)
  if (existing) return existing
  const explorationId = source.exploration_id
  const result = create(input, { beforeCreate: workId => {
    const index = read(file)
    write({ ...index, entries: [...index.entries, { explorationId, runId, workId }] }, file)
  } })
  const entry = { explorationId, runId, workId: result.work.id }
  return { ...entry, ...result, needsInitialMessage: true }
}
