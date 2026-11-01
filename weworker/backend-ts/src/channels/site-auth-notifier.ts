import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { bridgeRpcClient, type BridgeSiteAuthEvent } from '../bridge-rpc-client.js'
import { createLogger } from '../logger.js'
import type { ChannelImage } from './channel-manager.js'

const log = createLogger('site-auth-notifier')
const LOGIN_IMAGE_ROOT = path.join(os.homedir(), '.webcli', 'login')
const MAX_LOGIN_IMAGE_BYTES = 5 * 1024 * 1024

interface WebcliCallHint {
  adapter?: string
  target: string
}

interface ActiveToolCall {
  hints: WebcliCallHint[]
  notices: Set<string>
}

interface ActiveTurn {
  channelKey: string
  closed: boolean
  sendImage: (image: ChannelImage) => Promise<void>
  sendText: (text: string) => Promise<void>
  tools: Map<string, ActiveToolCall>
}

export interface SiteAuthTurnHandle {
  close(): void
  finishToolCall(toolCallId: string): void
  observeToolCall(toolCallId: string, toolName: string | undefined, args: unknown): void
}

export interface SiteAuthTurnRegistration {
  channelKey: string
  sendImage: (image: ChannelImage) => Promise<void>
  sendText: (text: string) => Promise<void>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/** Extract only explicit `webcli call` invocations from a native shell tool. */
export function extractWebcliCallHints(toolName: string | undefined, args: unknown): WebcliCallHint[] {
  if (!['bash', 'powershell'].includes(String(toolName || '').toLowerCase())) return []
  const command = asRecord(args).command
  if (typeof command !== 'string' || !command.trim()) return []

  const hints: WebcliCallHint[] = []
  const invocation = /(?:^|[;&|(\n]\s*)("[^"]+"|'[^']+'|[^\s;&|()]+)\s+call\s+("[^"]+"|'[^']+'|[^\s;&|()]+)/gi
  for (const match of command.matchAll(invocation)) {
    const executable = unquote(match[1]).replace(/\\/g, '/').split('/').at(-1)?.toLowerCase()
    if (!['webcli', 'webcli.cmd', 'webcli.ps1'].includes(executable || '')) continue
    const target = unquote(match[2]).trim().toLowerCase()
    if (!target) continue
    if (target === 'open_browser') {
      const remainder = command.slice((match.index || 0) + match[0].length)
      const currentCommand = remainder.split(/[;&|\n]/, 1)[0]
      const adapterMatch = /(?:^|\s)--adapter(?:=|\s+)("[^"]+"|'[^']+'|[^\s;&|()]+)/i.exec(currentCommand)
      hints.push({ target, ...(adapterMatch ? { adapter: unquote(adapterMatch[1]).trim().toLowerCase() } : {}) })
    } else {
      hints.push({ target })
    }
  }
  return hints
}

function callMatchesSite(call: ActiveToolCall, site: string): boolean {
  const normalizedSite = site.toLowerCase()
  return call.hints.some((hint) => hint.adapter === normalizedSite || hint.target.startsWith(`${normalizedSite}.`))
}

function detectImage(bytes: Buffer): { extension: 'png' | 'jpg' | 'webp'; mimeType: ChannelImage['mimeType'] } | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: 'png', mimeType: 'image/png' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: 'jpg', mimeType: 'image/jpeg' }
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { extension: 'webp', mimeType: 'image/webp' }
  }
  return null
}

/** Read only Bridge-generated login images, never an arbitrary event-provided path. */
export function readSiteAuthImage(filePath: string): ChannelImage {
  if (!path.isAbsolute(filePath)) throw new Error('登录图片路径不是绝对路径')
  const root = fs.realpathSync(LOGIN_IMAGE_ROOT)
  const file = fs.realpathSync(filePath)
  const relative = path.relative(root, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('登录图片不在受控目录中')
  }
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_LOGIN_IMAGE_BYTES) {
    throw new Error('登录图片大小无效')
  }
  const data = fs.readFileSync(file)
  const detected = detectImage(data)
  if (!detected) throw new Error('登录图片格式无效')
  return {
    data,
    filename: `weworker-login-${Date.now()}.${detected.extension}`,
    mimeType: detected.mimeType,
  }
}

function displayName(event: BridgeSiteAuthEvent): string {
  return event.name?.trim() || event.site
}

function manualLoginText(event: BridgeSiteAuthEvent, imageUnavailable = false): string {
  const lines = [
    `🔐 ${displayName(event)} 需要登录。请到运行 WeWorker 的电脑，在 WeWorker 浏览器中完成登录。`,
  ]
  if (imageUnavailable) lines.push('检测到了扫码登录入口，但暂时无法安全发送二维码图片。')
  if (event.autologinMode === 'auto') {
    lines.push('如果使用固定账号密码，可在电脑端登录后通过 WeWorker 保存凭据并启用自动登录，后续机器人任务可免去重复登录。')
  }
  lines.push('请不要在聊天中发送账号或密码；WeWorker 会自动检测登录结果。')
  return lines.join('\n')
}

export class SiteAuthChannelNotifier {
  private readonly _turns = new Set<ActiveTurn>()

  constructor() {
    bridgeRpcClient.onAuthEvent((event) => {
      void this._handleEvent(event).catch((error) => {
        log.error('failed to deliver site login event:', error)
      })
    })
  }

  registerTurn(registration: SiteAuthTurnRegistration): SiteAuthTurnHandle {
    const turn: ActiveTurn = { ...registration, closed: false, tools: new Map() }
    this._turns.add(turn)
    return {
      observeToolCall: (toolCallId, toolName, args) => {
        if (turn.closed || !toolCallId) return
        const hints = extractWebcliCallHints(toolName, args)
        const current = turn.tools.get(toolCallId) || { hints: [], notices: new Set<string>() }
        if (hints.length > 0) current.hints = hints
        turn.tools.set(toolCallId, current)
      },
      finishToolCall: (toolCallId) => {
        if (toolCallId) turn.tools.delete(toolCallId)
      },
      close: () => {
        if (turn.closed) return
        turn.closed = true
        turn.tools.clear()
        this._turns.delete(turn)
      },
    }
  }

  private _matchingTurns(site: string): Array<{ call: ActiveToolCall; turn: ActiveTurn }> {
    const matches: Array<{ call: ActiveToolCall; turn: ActiveTurn }> = []
    for (const turn of this._turns) {
      if (turn.closed) continue
      const call = [...turn.tools.values()].find((candidate) => callMatchesSite(candidate, site))
      if (call) matches.push({ call, turn })
    }
    return matches
  }

  private async _handleEvent(event: BridgeSiteAuthEvent): Promise<void> {
    const matches = this._matchingTurns(event.site)
    if (matches.length !== 1) {
      if (matches.length > 1) {
        log.warn(`suppressed ambiguous login event for ${event.site}: ${matches.length} active channel turns`)
      }
      return
    }

    const { call, turn } = matches[0]
    const once = (key: string): boolean => {
      if (call.notices.has(key)) return false
      call.notices.add(key)
      return true
    }
    const sendText = async (key: string, text: string) => {
      if (!once(key) || turn.closed) return
      await turn.sendText(text)
    }

    if (event.status === 'login_required') {
      await sendText('login_required', `🔐 ${displayName(event)} 需要登录，正在准备安全的登录方式…`)
      return
    }

    if (event.status === 'waiting_user') {
      if (!once('waiting_user') || turn.closed) return
      const qr = event.qr
      const imagePath = typeof qr?.image === 'string' && qr.image
        ? qr.image
        : qr?.available === true && typeof event.screenshot === 'string'
          ? event.screenshot
          : ''
      if (imagePath) {
        await turn.sendText(`📱 请使用手机扫描下面的 ${displayName(event)} 登录二维码。请勿将账号或密码发送到聊天中；登录完成后 WeWorker 会自动继续检测。`)
        try {
          await turn.sendImage(readSiteAuthImage(imagePath))
          return
        } catch (error) {
          log.warn(`could not send login image for ${event.site} through ${turn.channelKey}: ${error instanceof Error ? error.message : String(error)}`)
          await turn.sendText(manualLoginText(event, true))
          return
        }
      }
      await turn.sendText(manualLoginText(event, qr?.available === true))
      return
    }

    if (event.status === 'logged_in') {
      await sendText('logged_in', `✅ ${displayName(event)} 登录已完成；如果当前任务仍在等待，WeWorker 将自动继续处理。`)
    } else if (event.status === 'cancelled') {
      await sendText('cancelled', `已取消 ${displayName(event)} 登录。`)
    } else if (event.status === 'timeout') {
      await sendText('timeout', `${displayName(event)} 登录等待已超时，请完成登录后重新发送任务。`)
    } else if (event.status === 'failed') {
      await sendText('failed', `${displayName(event)} 登录页无法打开，请到运行 WeWorker 的电脑上检查浏览器状态后重试。`)
    }
  }
}

export const siteAuthChannelNotifier = new SiteAuthChannelNotifier()
