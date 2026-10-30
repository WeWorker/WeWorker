import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ registeredTools: new Map<string, (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>(), userDir: '' }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) => {
    mocks.registeredTools.set(name, handler)
    return { name, handler }
  },
  createSdkMcpServer: (config: unknown) => config,
}))
vi.mock('../config.js', () => ({
  getUserDirectory: () => mocks.userDir,
  ensureUserDirectory: () => mocks.userDir,
}))
vi.mock('../user-directory-guard.js', () => ({
  assertPathInsideWorkspaceDirectory: (value: string, directory: string) => {
    const resolved = path.resolve(value)
    const relative = path.relative(directory, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('路径不在用户目录内')
    return resolved
  },
}))

const { buildMcpServer } = await import('../tools.js')
const { createChannelUserMedia, createDesktopUserMedia } = await import('../user-media.js')

let root = ''
let workspace = ''
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-user-media-'))
  workspace = path.join(root, 'default')
  fs.mkdirSync(workspace, { recursive: true })
  mocks.userDir = root
  mocks.registeredTools.clear()
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const call = async (name: string, input: Record<string, unknown>) => JSON.parse((await mocks.registeredTools.get(name)!(input)).content[0].text)

describe('send_image_to_user / send_file_to_user', () => {
  it('delivers only to the current conversation; without a sink nothing is sent anywhere', async () => {
    const image = path.join(workspace, 'qr.png')
    fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    buildMcpServer({ channelPermissionMode: 'full' })
    const refused = await call('send_image_to_user', { file_path: image })
    expect(refused.success).toBe(false)
    expect(refused.error).toMatch(/没有发送给任何人/)
    expect(await call('send_file_to_user', { file_path: image })).toMatchObject({ success: false })
  })

  it('desktop conversations show the image inline and the file as an attachment', async () => {
    const image = path.join(workspace, 'qr.png')
    const doc = path.join(workspace, 'report.pdf')
    fs.writeFileSync(image, Buffer.from('fixture-image'))
    fs.writeFileSync(doc, 'fixture-pdf')
    const blocks: unknown[] = []
    const events: Array<Record<string, unknown>> = []
    const sink = createDesktopUserMedia({ append: (block) => blocks.push(block), send: (event) => events.push(event as Record<string, unknown>) })
    let current = sink
    buildMcpServer({ channelPermissionMode: 'full', userMedia: () => current })

    expect(await call('send_image_to_user', { file_path: image })).toMatchObject({ success: true, delivered_to: 'current_conversation', name: 'qr.png' })
    expect(events[0]).toMatchObject({ type: 'tool_call_image', data: Buffer.from('fixture-image').toString('base64') })
    expect(blocks[0]).toMatchObject({ type: 'tool_use', name: 'send_image_to_user', id: events[0].id, image: Buffer.from('fixture-image').toString('base64') })

    expect(await call('send_file_to_user', { file_path: doc })).toMatchObject({ success: true, name: 'report.pdf' })
    expect(events[1]).toMatchObject({ type: 'user_file', attachment: { type: 'file_attachment', name: 'report.pdf', path: doc } })

    // The sink is resolved per call: a later turn without one cannot deliver.
    current = null as unknown as typeof sink
    expect(await call('send_image_to_user', { file_path: image })).toMatchObject({ success: false })
  })

  it('bot conversations queue the image for the chat the message came from', async () => {
    const image = path.join(workspace, 'shot.jpg')
    fs.writeFileSync(image, Buffer.from('fixture-jpg'))
    const images: string[] = []
    const blocks: unknown[] = []
    buildMcpServer({ channelPermissionMode: 'full', userMedia: () => createChannelUserMedia(images, blocks as never[]) })
    expect(await call('send_image_to_user', { file_path: image })).toMatchObject({ success: true })
    expect(images).toEqual([Buffer.from('fixture-jpg').toString('base64')])
    // Channels without file support say so instead of sending elsewhere.
    expect(await call('send_file_to_user', { file_path: image })).toMatchObject({ success: false })
  })

  it('rejects non-images, empty files and paths outside the user directory', async () => {
    const text = path.join(workspace, 'notes.txt')
    const empty = path.join(workspace, 'empty.png')
    fs.writeFileSync(text, 'x')
    fs.writeFileSync(empty, '')
    const images: string[] = []
    buildMcpServer({ channelPermissionMode: 'full', userMedia: () => createChannelUserMedia(images, []) })
    expect((await call('send_image_to_user', { file_path: text })).error).toMatch(/只支持/)
    expect((await call('send_image_to_user', { file_path: empty })).error).toMatch(/为空/)
    expect((await call('send_image_to_user', { file_path: path.join(os.tmpdir(), 'outside.png') })).error).toMatch(/用户目录/)
    expect(images).toEqual([])
  })
})
