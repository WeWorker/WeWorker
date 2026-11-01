import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { resolveOpenAiEndpoint, type LlmProtocol } from './llm-egress.js'

type JsonRecord = Record<string, any>

export interface AnthropicStreamEvent {
  event: string
  data: JsonRecord
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content)
  return content.map((block) => {
    if (block?.type === 'text') return String(block.text || '')
    if (block?.type === 'image') return '[image]'
    return JSON.stringify(block)
  }).join('\n')
}

function openAiContent(content: unknown): string | Array<JsonRecord> | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? null : String(content)
  const blocks: JsonRecord[] = content.flatMap((block: JsonRecord): JsonRecord[] => {
    if (block?.type === 'text') return [{ type: 'text', text: String(block.text || '') }]
    if (block?.type === 'image' && block.source?.type === 'base64') {
      return [{ type: 'image_url', image_url: { url: `data:${block.source.media_type || 'image/png'};base64,${block.source.data || ''}` } }]
    }
    if (block?.type === 'image' && block.source?.type === 'url') {
      return [{ type: 'image_url', image_url: { url: block.source.url } }]
    }
    return []
  })
  if (blocks.every(block => block.type === 'text')) return blocks.map((block: JsonRecord) => block.text).join('\n')
  return blocks
}

function openAiToolChoice(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined
  const choice = value as JsonRecord
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } }
  }
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  if (choice.type === 'auto') return 'auto'
  return undefined
}

export function anthropicRequestToOpenAi(request: JsonRecord): JsonRecord {
  const messages: JsonRecord[] = []
  const system = textFromContent(request.system)
  if (system) messages.push({ role: 'system', content: system })

  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content || '' }]
      const text = content.filter((block: JsonRecord) => block?.type === 'text').map((block: JsonRecord) => String(block.text || '')).join('')
      const toolCalls = content.filter((block: JsonRecord) => block?.type === 'tool_use').map((block: JsonRecord) => ({
        id: String(block.id || `call_${randomBytes(6).toString('hex')}`),
        type: 'function',
        function: { name: String(block.name || ''), arguments: JSON.stringify(block.input ?? {}) },
      }))
      if (text || toolCalls.length) messages.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) })
      continue
    }

    const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content || '' }]
    const userBlocks: JsonRecord[] = []
    for (const block of content) {
      if (block?.type === 'tool_result') {
        messages.push({ role: 'tool', tool_call_id: String(block.tool_use_id || ''), content: textFromContent(block.content) })
      } else if (block?.type !== 'thinking' && block?.type !== 'redacted_thinking') {
        userBlocks.push(block)
      }
    }
    const openAiUserContent = openAiContent(userBlocks)
    if (openAiUserContent !== null && openAiUserContent !== '') messages.push({ role: 'user', content: openAiUserContent })
  }

  const tools = Array.isArray(request.tools) ? request.tools.map((tool: JsonRecord) => ({
    type: 'function',
    function: {
      name: String(tool.name || ''),
      ...(tool.description ? { description: String(tool.description) } : {}),
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  })) : undefined
  const toolChoice = openAiToolChoice(request.tool_choice)
  return {
    model: request.model,
    ...(request.max_tokens ? { max_tokens: request.max_tokens } : {}),
    stream: request.stream !== false,
    messages,
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
    ...(typeof request.top_p === 'number' ? { top_p: request.top_p } : {}),
  }
}

function responseInputContent(blocks: JsonRecord[]): JsonRecord[] {
  const content: JsonRecord[] = []
  for (const block of blocks) {
    if (block?.type === 'text') content.push({ type: 'input_text', text: String(block.text || '') })
    else if (block?.type === 'image' && block.source?.type === 'base64') content.push({ type: 'input_image', image_url: `data:${block.source.media_type || 'image/png'};base64,${block.source.data || ''}` })
    else if (block?.type === 'image' && block.source?.type === 'url') content.push({ type: 'input_image', image_url: block.source.url })
  }
  return content
}

export function anthropicRequestToOpenAiResponses(request: JsonRecord): JsonRecord {
  const input: JsonRecord[] = []
  const system = textFromContent(request.system)
  if (system) input.push({ role: 'system', content: [{ type: 'input_text', text: system }] })
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content || '' }]
    if (message.role === 'assistant') {
      const text = blocks.filter((block: JsonRecord) => block?.type === 'text').map((block: JsonRecord) => String(block.text || '')).join('')
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
      for (const block of blocks.filter((item: JsonRecord) => item?.type === 'tool_use')) {
        input.push({ type: 'function_call', call_id: String(block.id || `call_${randomBytes(6).toString('hex')}`), name: String(block.name || ''), arguments: JSON.stringify(block.input ?? {}) })
      }
      continue
    }
    const userBlocks: JsonRecord[] = []
    for (const block of blocks) {
      if (block?.type === 'tool_result') input.push({ type: 'function_call_output', call_id: String(block.tool_use_id || ''), output: textFromContent(block.content) })
      else if (block?.type !== 'thinking' && block?.type !== 'redacted_thinking') userBlocks.push(block)
    }
    const content = responseInputContent(userBlocks)
    if (content.length) input.push({ role: 'user', content })
  }
  const tools = Array.isArray(request.tools) ? request.tools.map((tool: JsonRecord) => ({
    type: 'function', name: String(tool.name || ''),
    ...(tool.description ? { description: String(tool.description) } : {}),
    parameters: tool.input_schema || { type: 'object', properties: {} },
  })) : undefined
  const choice = request.tool_choice as JsonRecord | undefined
  const toolChoice = choice?.type === 'tool' && typeof choice.name === 'string' ? { type: 'function', name: choice.name }
    : choice?.type === 'any' ? 'required' : choice?.type === 'none' ? 'none' : choice?.type === 'auto' ? 'auto' : undefined
  return {
    model: request.model,
    ...(request.max_tokens ? { max_output_tokens: request.max_tokens } : {}),
    stream: request.stream !== false,
    input,
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(request.stop_sequences?.length ? { stop: request.stop_sequences } : {}),
    ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
    ...(typeof request.top_p === 'number' ? { top_p: request.top_p } : {}),
  }
}

export function openAiResponsesResponseToAnthropic(response: JsonRecord): JsonRecord {
  const content: JsonRecord[] = []
  for (const item of response.output || []) {
    if (item.type === 'message') {
      for (const block of item.content || []) {
        if ((block.type === 'output_text' || block.type === 'refusal') && block.text) content.push({ type: 'text', text: block.text })
      }
    } else if (item.type === 'function_call') {
      content.push({ type: 'tool_use', id: String(item.call_id || item.id || `tool_${content.length}`), name: String(item.name || ''), input: parsedToolInput(item.arguments) })
    }
  }
  const usage = response.usage || {}
  const hasTool = content.some(block => block.type === 'tool_use')
  return {
    id: `msg-${response.id || randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant', model: response.model || '', content,
    stop_reason: hasTool ? 'tool_use' : response.status === 'incomplete' ? 'max_tokens' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: Number(usage.input_tokens || 0), output_tokens: Number(usage.output_tokens || 0), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }
}

export function createOpenAiResponsesAnthropicEventTranslator() {
  let started = false
  let nextIndex = 0
  let textIndex: number | null = null
  let id = ''
  let model = ''
  let outputTokens = 0
  let finishReason = 'end_turn'
  const tools = new Map<number, { index: number; id: string; name: string }>()
  const startMessage = (): AnthropicStreamEvent => ({ event: 'message_start', data: { type: 'message_start', message: { id: `msg-${id || randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } } })
  const ensureStarted = (event?: JsonRecord) => {
    if (event?.response?.id) id = String(event.response.id)
    if (event?.response?.model) model = String(event.response.model)
    if (started) return []
    started = true
    return [startMessage()]
  }
  const startTool = (outputIndex: number, item: JsonRecord): AnthropicStreamEvent[] => {
    const current = tools.get(outputIndex) || { index: nextIndex++, id: String(item.call_id || item.id || `tool_${outputIndex}`), name: String(item.name || '') }
    current.id = String(item.call_id || current.id)
    current.name = String(item.name || current.name)
    tools.set(outputIndex, current)
    return [{ event: 'content_block_start', data: { type: 'content_block_start', index: current.index, content_block: { type: 'tool_use', id: current.id, name: current.name, input: {} } } }]
  }
  function push(event: JsonRecord): AnthropicStreamEvent[] {
    const events = ensureStarted(event)
    if ((event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') && typeof event.delta === 'string') {
      if (textIndex === null) {
        textIndex = nextIndex++
        events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } } })
      }
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: event.delta } } })
    } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      events.push(...startTool(Number(event.output_index || 0), event.item))
    } else if (event.type === 'response.function_call_arguments.delta') {
      const outputIndex = Number(event.output_index || 0)
      let tool = tools.get(outputIndex)
      if (!tool) {
        events.push(...startTool(outputIndex, { id: event.item_id, call_id: event.item_id, name: event.name }))
        tool = tools.get(outputIndex)
      }
      if (tool && event.delta) events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: tool.index, delta: { type: 'input_json_delta', partial_json: String(event.delta) } } })
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const response = event.response || {}
      id = String(response.id || id)
      model = String(response.model || model)
      outputTokens = Number(response.usage?.output_tokens || 0)
      const output = response.output || []
      finishReason = output.some((item: JsonRecord) => item.type === 'function_call') ? 'tool_use' : event.type === 'response.incomplete' ? 'max_tokens' : 'end_turn'
    }
    return events
  }
  function finish(): AnthropicStreamEvent[] {
    const events = ensureStarted()
    if (textIndex !== null) events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: textIndex } })
    for (const tool of tools.values()) events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: tool.index } })
    events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: finishReason, stop_sequence: null }, usage: { output_tokens: outputTokens } } })
    events.push({ event: 'message_stop', data: { type: 'message_stop' } })
    return events
  }
  return { push, finish }
}

function parsedToolInput(raw: unknown): JsonRecord {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as JsonRecord
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function stopReason(value: unknown): string {
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use'
  if (value === 'length') return 'max_tokens'
  return 'end_turn'
}

export function openAiResponseToAnthropic(response: JsonRecord): JsonRecord {
  const choice = response.choices?.[0] || {}
  const message = choice.message || {}
  const content: JsonRecord[] = []
  if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content })
  if (typeof message.refusal === 'string' && message.refusal) content.push({ type: 'text', text: message.refusal })
  for (const call of message.tool_calls || []) {
    content.push({
      type: 'tool_use', id: String(call.id || `tool_${content.length}`),
      name: String(call.function?.name || ''), input: parsedToolInput(call.function?.arguments),
    })
  }
  const usage = response.usage || {}
  return {
    id: `msg-${response.id || randomBytes(12).toString('hex')}`,
    type: 'message', role: 'assistant', model: response.model || '', content,
    stop_reason: stopReason(choice.finish_reason), stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens || 0),
      output_tokens: Number(usage.completion_tokens || 0),
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }
}

function contentBlockEvent(index: number, contentBlock: JsonRecord): AnthropicStreamEvent {
  return { event: 'content_block_start', data: { type: 'content_block_start', index, content_block: contentBlock } }
}

export function createOpenAiAnthropicEventTranslator() {
  let started = false
  let textIndex: number | null = null
  let nextIndex = 0
  let id = ''
  let model = ''
  let finishReason = ''
  let outputTokens = 0
  const tools = new Map<number, { index: number; id: string; name: string; arguments: string }>()
  const closed = new Set<number>()

  const startMessage = (): AnthropicStreamEvent => ({
    event: 'message_start',
    data: {
      type: 'message_start',
      message: { id: `msg-${id || randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    },
  })

  function ensureStarted(chunk?: JsonRecord): AnthropicStreamEvent[] {
    if (chunk?.id) id = String(chunk.id)
    if (chunk?.model) model = String(chunk.model)
    if (started) return []
    started = true
    return [startMessage()]
  }

  function push(chunk: JsonRecord): AnthropicStreamEvent[] {
    const events = ensureStarted(chunk)
    const choice = chunk.choices?.[0]
    const delta = choice?.delta || {}
    if (choice?.finish_reason) finishReason = String(choice.finish_reason)
    if (chunk.usage?.completion_tokens !== undefined) outputTokens = Number(chunk.usage.completion_tokens || 0)

    if (typeof delta.content === 'string' && delta.content) {
      if (textIndex === null) {
        textIndex = nextIndex++
        events.push(contentBlockEvent(textIndex, { type: 'text', text: '' }))
      }
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } } })
    }

    for (const call of delta.tool_calls || []) {
      const callIndex = Number.isInteger(call.index) ? call.index : tools.size
      let current = tools.get(callIndex)
      if (!current) {
        current = { index: nextIndex++, id: String(call.id || `tool_${callIndex}`), name: '', arguments: '' }
        tools.set(callIndex, current)
      }
      if (call.id) current.id = String(call.id)
      if (call.function?.name) current.name += String(call.function.name)
      if (call.function?.arguments) {
        const partial = String(call.function.arguments)
        current.arguments += partial
      }
    }
    return events
  }

  function finish(): AnthropicStreamEvent[] {
    const events = ensureStarted()
    if (textIndex !== null) events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: textIndex } })
    for (const [callIndex, current] of [...tools.entries()].sort((left, right) => left[0] - right[0])) {
      events.push(contentBlockEvent(current.index, { type: 'tool_use', id: current.id, name: current.name, input: {} }))
      if (current.arguments) events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: current.index, delta: { type: 'input_json_delta', partial_json: current.arguments } },
      })
      closed.add(callIndex)
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: current.index } })
    }
    events.push({
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: stopReason(finishReason), stop_sequence: null }, usage: { output_tokens: outputTokens } },
    })
    events.push({ event: 'message_stop', data: { type: 'message_stop' } })
    return events
  }

  return { push, finish }
}

export function openAiStreamToAnthropicEvents(chunks: Iterable<JsonRecord>): AnthropicStreamEvent[] {
  const translator = createOpenAiAnthropicEventTranslator()
  const events: AnthropicStreamEvent[] = []
  for (const chunk of chunks) events.push(...translator.push(chunk))
  events.push(...translator.finish())
  return events
}

async function* parseOpenAiSse(stream: NodeJS.ReadableStream): AsyncGenerator<JsonRecord> {
  const decoder = new TextDecoder()
  let buffer = ''
  let data = ''
  const emitFrame = () => {
    if (!data) return null
    const value = data.trimEnd()
    data = ''
    if (!value || value === '[DONE]') return value === '[DONE]' ? '[DONE]' : null
    return JSON.parse(value) as JsonRecord
  }

  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (!line) {
        const frame = emitFrame()
        if (frame === '[DONE]') return
        if (frame) yield frame
      } else if (line.startsWith('data:')) {
        data += `${line.slice(5).trimStart()}\n`
      }
      newline = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  if (buffer.startsWith('data:')) data += `${buffer.slice(5).trimStart()}\n`
  const frame = emitFrame()
  if (frame && frame !== '[DONE]') yield frame
}

function sendError(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'api_error', message } }))
}

export async function openOpenAiChatRelay(baseUrl: string, fullUrl = false, fetchImpl: typeof fetch = fetch, protocol: LlmProtocol = 'openai_chat_completions') {
  const responsesProtocol = protocol === 'openai_responses'
  const endpoint = resolveOpenAiEndpoint(baseUrl, fullUrl, protocol)
  const prefix = `/${randomBytes(24).toString('hex')}`
  const pending = new Set<AbortController>()
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url?.split('?')[0] !== `${prefix}/v1/messages`) {
      res.writeHead(404).end()
      return
    }
    const request = (async () => {
      let raw = ''
      for await (const chunk of req) {
        raw += chunk.toString()
        if (raw.length > 32 * 1024 * 1024) throw new Error('Request body too large')
      }
      let body: JsonRecord
      try { body = JSON.parse(raw) } catch { sendError(res, 400, 'Invalid JSON request'); return }
      const authorization = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization
      const keyHeader = Array.isArray(req.headers['x-api-key']) ? req.headers['x-api-key'][0] : req.headers['x-api-key']
      const apiKey = String(keyHeader || authorization?.replace(/^Bearer\s+/i, '') || '').trim()
      if (!apiKey) { sendError(res, 401, 'API key is required'); return }

      const controller = new AbortController()
      pending.add(controller)
      res.on('close', () => { if (!res.writableEnded) controller.abort() })
      const timeout = setTimeout(() => controller.abort(), 120_000)
      try {
        const upstream = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(responsesProtocol ? anthropicRequestToOpenAiResponses(body) : anthropicRequestToOpenAi(body)),
          signal: controller.signal,
          redirect: 'error',
        })
        if (!upstream.ok) {
          const detail = (await upstream.text()).split(apiKey).join('[已隐藏]')
          sendError(res, upstream.status, detail || `HTTP ${upstream.status}`)
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const writeEvent = (event: AnthropicStreamEvent) => {
          res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
        }
        const contentType = upstream.headers.get('content-type') || ''
        const translator = responsesProtocol ? createOpenAiResponsesAnthropicEventTranslator() : createOpenAiAnthropicEventTranslator()
        if (contentType.includes('text/event-stream') && upstream.body) {
          for await (const chunk of parseOpenAiSse(upstream.body as unknown as NodeJS.ReadableStream)) {
            if (responsesProtocol && (chunk.type === 'response.failed' || chunk.type === 'error')) throw new Error('OpenAI Responses request failed')
            for (const event of translator.push(chunk)) writeEvent(event)
          }
        } else {
          const completion = await upstream.json() as JsonRecord
          if (responsesProtocol) {
            const anthropic = openAiResponsesResponseToAnthropic(completion)
            for (const event of translator.push({ type: 'response.completed', response: completion })) writeEvent(event)
            for (const block of anthropic.content) {
              const index = anthropic.content.indexOf(block)
              writeEvent({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } } })
              if (block.type === 'text') writeEvent({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } } })
              else writeEvent({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } } })
              writeEvent({ event: 'content_block_stop', data: { type: 'content_block_stop', index } })
            }
          } else {
            const choice = completion.choices?.[0] || {}
            const message = choice.message || {}
            const delta = {
              ...(typeof message.content === 'string' ? { content: message.content } : {}),
              ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls.map((call: JsonRecord, index: number) => ({
                ...call, index, function: { ...call.function, arguments: call.function?.arguments || '' },
              })) } : {}),
            }
            for (const event of translator.push({ id: completion.id, model: completion.model, choices: [{ delta, finish_reason: choice.finish_reason }], usage: completion.usage })) writeEvent(event)
          }
        }
        for (const event of translator.finish()) writeEvent(event)
        res.end()
      } catch (error) {
        if (!res.headersSent) {
          const message = controller.signal.aborted ? 'OpenAI request was cancelled or timed out' : error instanceof Error ? error.message : 'OpenAI request failed'
          sendError(res, 502, message.split(apiKey).join('[已隐藏]'))
        } else if (!controller.signal.aborted) {
          res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'OpenAI response stream failed' } })}\n\n`)
          res.end()
        }
      } finally {
        clearTimeout(timeout)
        pending.delete(controller)
      }
    })().catch(() => sendError(res, 400, 'Invalid request'))
    void request
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  server.unref()
  const address = server.address() as import('node:net').AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}${prefix}`,
    async close() {
      for (const controller of pending) controller.abort()
      const stopped = new Promise<void>(resolve => server.close(() => resolve()))
      server.closeAllConnections()
      await stopped
    },
  }
}
