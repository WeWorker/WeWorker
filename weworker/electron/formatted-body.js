import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export function saveFormattedBody(body, directory = path.join(os.tmpdir(), 'weworker-formatted-body')) {
  if (!body || typeof body.content !== 'string' || typeof body['markdown-content'] !== 'string'
    || !body.content.trim() || !body['markdown-content'].trim()) throw new Error('Invalid formatted body')
  const serialized = JSON.stringify({ content: body.content, 'markdown-content': body['markdown-content'] }, null, 2)
  if (Buffer.byteLength(serialized, 'utf8') > 2 * 1024 * 1024) throw new Error('Formatted body exceeds 2 MiB')
  fs.mkdirSync(directory, { recursive: true })
  const name = `body-args-${randomUUID()}.json`
  const target = path.join(directory, name)
  fs.writeFileSync(target, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return { path: target, name }
}
