import { randomInt } from 'node:crypto'

export function generatePairingCode(previous = ''): string {
  let code: string
  do { code = String(randomInt(100000, 1000000)) } while (code === previous)
  return code
}

/** Shared by WeWorker Bot and the main channel: 绑定 123456, /bind or digits. */
export function extractPairingCode(text: string): string | null {
  const normalized = String(text ?? '').replace(/\s+/g, '').toLowerCase()
  const match = normalized.match(/^(?:绑定|配对|\/bind|bind|\/绑定)?[:：]?(\d{6})$/)
  return match ? match[1] : null
}
