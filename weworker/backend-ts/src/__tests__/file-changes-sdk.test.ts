import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { expect, it } from 'vitest'
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { FileChangeStore } from '../file-changes.js'
import { createFileChangeHooks } from '../file-change-hooks.js'
import { readFileChangesForModel } from '../file-change-access.js'
import { spawnManagedClaudeCodeProcess } from '../claude-process.js'

const cli = path.resolve('node_modules', '@anthropic-ai', 'claude-code', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')

// Exercise native Edit and SDK hooks against a loopback model; never use a real account.
it.skipIf(!fs.existsSync(cli))('records a real SDK edit and gives its before/after versions to the next model call', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-change-sdk-'))
  const workspace = path.join(directory, 'workspace')
  fs.mkdirSync(workspace)
  const file = path.join(workspace, 'example.txt')
  fs.writeFileSync(file, 'Original title\n')
  const store = new FileChangeStore(path.join(directory, 'records'))
  const recordId = store.recordId('edit-example')
  const hooks = createFileChangeHooks({ store,
    binding: () => ({ workId: 'example-work', turnId: 'example-turn', cwd: workspace }), canRead: async () => true })
  const requests: any[] = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    if (!req.url?.startsWith('/v1/messages')) { res.writeHead(404).end(); return }
    const request = JSON.parse(body || '{}')
    if (!request.stream) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'example-title', type: 'message', role: 'assistant', model: 'test-model', content: [{ type: 'text', text: 'Example' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
      return
    }
    requests.push(request)
    const calls = [
      { id: 'read-example', name: 'Read', input: { file_path: file } },
      { id: 'edit-example', name: 'Edit', input: { file_path: file, old_string: 'Original title', new_string: 'Updated title' } },
      { id: 'review-example', name: 'mcp__weworker__get_file_changes', input: { change_id: recordId } },
    ]
    const call = calls[requests.length - 1]
    res.setHeader('Content-Type', 'text/event-stream')
    const send = (type: string, event: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...event })}\n\n`)
    send('message_start', { message: { id: `example-${requests.length}`, type: 'message', role: 'assistant', model: 'test-model', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
    send('content_block_start', { index: 0, content_block: call ? { type: 'tool_use', id: call.id, name: call.name, input: {} } : { type: 'text', text: '' } })
    send('content_block_delta', { index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } : { type: 'text_delta', text: 'Recorded the change.' } })
    send('content_block_stop', { index: 0 })
    send('message_delta', { delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })
    send('message_stop', {})
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as import('node:net').AddressInfo).port
  const children: import('node:child_process').ChildProcess[] = []
  let handle: ReturnType<typeof query> | undefined
  try {
    const mcp = createSdkMcpServer({ name: 'weworker', tools: [tool('get_file_changes', 'Read recorded file changes', { change_id: z.string() }, async input => ({
      content: [{ type: 'text', text: JSON.stringify(await readFileChangesForModel(store, 'example-work', input, async () => true)) }],
    }))] })
    async function* prompt() {
      yield { type: 'user' as const, session_id: '', parent_tool_use_id: null, message: { role: 'user' as const, content: 'Update the example title, then inspect the change record.' } }
    }
    handle = query({ prompt: prompt(), options: {
      pathToClaudeCodeExecutable: cli, model: 'test-model', systemPrompt: 'Isolated test assistant',
      tools: ['Read', 'Edit'], settingSources: [], mcpServers: { weworker: mcp }, persistSession: false,
      permissionMode: 'default', canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }), cwd: workspace, maxTurns: 6,
      hooks: { PreToolUse: [{ hooks: [hooks.preToolUse] }], PostToolUse: [{ hooks: [hooks.postToolUse] }], PostToolUseFailure: [{ hooks: [hooks.postToolUseFailure] }], UserPromptSubmit: [{ hooks: [hooks.userPromptSubmit] }] },
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(directory, 'config'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: 'test-placeholder-key', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDECODE: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      spawnClaudeCodeProcess: args => { const child = spawnManagedClaudeCodeProcess(args); children.push(child); return child as any },
    } })
    const events = []
    for await (const event of handle) events.push(event)
    expect(events.some(event => event.type === 'result' && event.subtype === 'success')).toBe(true)
    expect(requests).toHaveLength(4)
    expect(store.list('example-work')).toHaveLength(1)
    expect(store.read('example-work', recordId)?.files[0]).toMatchObject({ before: { text: 'Original title\n' }, after: { text: 'Updated title\n' } })
    expect(JSON.stringify(requests[2].messages)).toContain(`文件修改记录已保存：${recordId}`)
    const reviewResult = requests[3].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
      .find((block: any) => block.type === 'tool_result' && block.tool_use_id === 'review-example')
    expect(JSON.stringify(reviewResult)).toContain('Original title')
    expect(JSON.stringify(reviewResult)).toContain('Updated title')
    expect(fs.readFileSync(file, 'utf8')).toBe('Updated title\n')
  } finally {
    handle?.close()
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
        child.kill()
        await exited
      }
    }
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    catch (error) { if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error }
  }
}, 30_000)
