import fs from 'node:fs/promises'
import path from 'node:path'
import { getMaxChatAttachments } from './config.js'

export const EXPLORATION_ATTACHMENT_BYTES = 20 * 1024 * 1024

// The host reads only explicitly selected files. Python receives their contents,
// never a host path or access to the user's main workspace.
export async function readExplorationAttachments(value: unknown, maxFiles = getMaxChatAttachments()) {
  if (!Array.isArray(value) || value.length > maxFiles) throw new Error(`最多可添加 ${maxFiles} 个附件`)
  const result: Array<{ name: string; data: string }> = []
  let total = 0
  for (const item of value) {
    if (!item || typeof item.path !== 'string' || !path.isAbsolute(item.path)) throw new Error('请选择有效的本地文件')
    const file = await fs.open(item.path, 'r').catch(() => { throw new Error('附件无法读取，请重新选择') })
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw new Error('附件必须是文件')
      if (stat.size + total > EXPLORATION_ATTACHMENT_BYTES) throw new Error('附件总大小不能超过 20 MB')
      // Bound the read even if another program grows the file after stat().
      const buffer = Buffer.alloc(Math.min(stat.size + 1, EXPLORATION_ATTACHMENT_BYTES - total + 1))
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > stat.size || total + length > EXPLORATION_ATTACHMENT_BYTES) throw new Error('附件已发生变化，请重新选择')
      total += length
      result.push({ name: path.basename(item.path), data: buffer.subarray(0, length).toString('base64') })
    } finally { await file.close() }
  }
  return result
}
