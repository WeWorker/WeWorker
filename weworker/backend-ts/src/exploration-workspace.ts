import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getConfigDirectory, getUserDirectory } from './config.js'

function assertUnlinked(target: string) {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('探索目录不能通过链接重定向') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (path.dirname(current) === current) break
  }
}

function copyLegacyArtifact(source: string, destination: string): void {
  let entry: fs.Stats
  try { entry = fs.lstatSync(source) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (entry.isSymbolicLink()) return
  assertUnlinked(destination)
  if (entry.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true })
    for (const name of fs.readdirSync(source)) copyLegacyArtifact(path.join(source, name), path.join(destination, name))
  } else if (entry.isFile()) {
    try { fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
}

/** Resolve only a real, undeleted exploration. No renderer-supplied filesystem root. */
export function getExplorationTaskDirectory(explorationId: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(explorationId)) throw new Error('无效的探索任务标识')
  const home = process.env.WEBWRIGHT_HOME || path.join(getConfigDirectory(), 'webwright')
  const server = path.join(home, 'tasks', explorationId, '.server')
  assertUnlinked(server)
  const taskFile = path.join(server, 'task.json')
  assertUnlinked(taskFile)
  const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'))
  if (task.task_id !== explorationId || task.activity_type !== 'exploration' || task.deleted_at) throw new Error('探索记录不存在')
  const location = path.join(server, 'artifact-workspace.json')
  assertUnlinked(location)
  let directory = path.join(getUserDirectory(), 'website-exploration', explorationId)
  if (fs.existsSync(location)) {
    const saved = JSON.parse(fs.readFileSync(location, 'utf8'))
    if (saved.version !== 1 || typeof saved.directory !== 'string' || !path.isAbsolute(saved.directory)
      || path.basename(saved.directory) !== explorationId || path.basename(path.dirname(saved.directory)) !== 'website-exploration') throw new Error('探索目录记录无效')
    directory = path.resolve(saved.directory)
  }
  assertUnlinked(directory)
  fs.mkdirSync(directory, { recursive: true })
  if (!fs.existsSync(location)) {
    // Mirror the service's one-time legacy upgrade when a record is opened
    // before its next run. Leave histories, attachments and originals intact.
    for (const name of ['artifacts', 'screenshots', 'steps', 'script.py']) {
      copyLegacyArtifact(path.join(path.dirname(server), name), path.join(directory, name))
    }
    const temporary = `${location}.${randomUUID()}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, directory }), { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, location)
  }
  return directory
}

/** User-facing host workspace; exploration-service history stays in its own data root. */
export function ensureExplorationWorkspaceDirectory(userDirectory = getUserDirectory()): string {
  const directory = path.resolve(userDirectory, 'website-exploration')
  fs.mkdirSync(userDirectory, { recursive: true })
  // Never silently redirect the fixed workspace through a link or replace user files.
  try {
    const entry = fs.lstatSync(directory)
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('网站探索目录必须是普通文件夹')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    fs.mkdirSync(directory, { recursive: true })
  }
  return directory
}
