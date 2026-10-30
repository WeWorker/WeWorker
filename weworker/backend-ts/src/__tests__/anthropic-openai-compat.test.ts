import { describe, expect, it } from 'vitest'
import type { Settings } from '../config.js'
import { prepareModelRuntime } from '../anthropic-endpoint-relay.js'
import {
  anthropicRequestToOpenAi,
  anthropicRequestToOpenAiResponses,
  createOpenAiResponsesAnthropicEventTranslator,
  openOpenAiChatRelay,
  openAiResponsesResponseToAnthropic,
  openAiResponseToAnthropic,
  openAiStreamToAnthropicEvents,
} from '../anthropic-openai-compat.js'

describe('Anthropic to OpenAI Chat Completions compatibility', () => {
  it('maps system prompts, conversation messages, tool results and tool schemas', () => {
    const body = anthropicRequestToOpenAi({
      model: 'fixture-model',
      max_tokens: 1234,
      system: 'fixture system prompt',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Inspect the page' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__weworker__webcli_result', input: { id: 7 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'page data' }] }] },
      ],
      tools: [{ name: 'mcp__weworker__webcli_result', description: 'Read page data', input_schema: { type: 'object', properties: { id: { type: 'number' } } } }],
      tool_choice: { type: 'auto' },
      stream: true,
    })

    expect(body).toEqual({
      model: 'fixture-model',
      max_tokens: 1234,
      stream: true,
      messages: [
        { role: 'system', content: 'fixture system prompt' },
        { role: 'user', content: 'Inspect the page' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'mcp__weworker__webcli_result', arguments: '{"id":7}' } }] },
        { role: 'tool', tool_call_id: 'tool-1', content: 'page data' },
      ],
      tools: [{ type: 'function', function: { name: 'mcp__weworker__webcli_result', description: 'Read page data', parameters: { type: 'object', properties: { id: { type: 'number' } } } } }],
      tool_choice: 'auto',
    })
  })

  it('maps OpenAI assistant text and function calls to an Anthropic message', () => {
    expect(openAiResponseToAnthropic({
      id: 'chatcmpl-fixture', model: 'fixture-model',
      choices: [{ finish_reason: 'tool_calls', message: {
        content: 'I will inspect this.',
        tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'run', arguments: '{"safe":true}' } }],
      } }],
      usage: { prompt_tokens: 17, completion_tokens: 5 },
    })).toEqual({
      id: 'msg-chatcmpl-fixture', type: 'message', role: 'assistant', model: 'fixture-model',
      content: [
        { type: 'text', text: 'I will inspect this.' },
        { type: 'tool_use', id: 'tool-1', name: 'run', input: { safe: true } },
      ],
      stop_reason: 'tool_use', stop_sequence: null,
      usage: { input_tokens: 17, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    })
  })

  it('converts streamed text, streamed function arguments and final usage to Anthropic events', () => {
    const events = openAiStreamToAnthropicEvents([
      { id: 'chatcmpl-fixture', model: 'fixture-model', choices: [{ delta: { content: 'Working ' }, finish_reason: null }] },
      { id: 'chatcmpl-fixture', model: 'fixture-model', choices: [{ delta: { content: 'now.', tool_calls: [{ index: 0, id: 'tool-1', type: 'function', function: { name: 'run', arguments: '{"safe":' } }] }, finish_reason: null }] },
      { id: 'chatcmpl-fixture', model: 'fixture-model', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'true}' } }] }, finish_reason: null }] },
      { id: 'chatcmpl-fixture', model: 'fixture-model', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 17, completion_tokens: 5 } },
    ])

    expect(events).toEqual([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'msg-chatcmpl-fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working ' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'now.' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'run', input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"safe":true}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ])
  })

  it('runs the compatibility relay against a real local HTTP caller and returns Anthropic SSE', async () => {
    let call: { url: string; authorization: string | null; body: Record<string, unknown> } | undefined
    const relay = await openOpenAiChatRelay('https://gateway.example/v1', false, async (url, init) => {
      call = {
        url: String(url),
        authorization: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)),
      }
      return new Response([
        'data: {"id":"chatcmpl-loopback","model":"fixture-model","choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-loopback","model":"fixture-model","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
        'data: [DONE]',
        '',
      ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
    })
    try {
      const response = await fetch(`${relay.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-secret' },
        body: JSON.stringify({ model: 'fixture-model', max_tokens: 40, system: 'be concise', messages: [{ role: 'user', content: 'hello' }], stream: true }),
      })
      const result = await response.text()
      expect(response.status).toBe(200)
      expect(call).toMatchObject({
        url: 'https://gateway.example/v1/chat/completions',
        authorization: 'Bearer fixture-secret',
        body: { model: 'fixture-model', max_tokens: 40, stream: true },
      })
      expect(result).toContain('event: content_block_delta')
      expect(result).toContain('"text":"ok"')
      expect(result).toContain('"stop_reason":"end_turn"')
    } finally {
      await relay.close()
    }
  })

  it('installs the OpenAI relay for an active OpenAI WeWorker configuration', async () => {
    const settings = {
      base_url: 'https://gateway.example/v1', base_url_is_full: false,
      active_weworker_protocol: 'openai_chat_completions',
    } as Settings
    const runtime = await prepareModelRuntime(settings)
    try {
      expect(runtime.settings).toMatchObject({
        active_weworker_protocol: 'openai_chat_completions',
        base_url_is_full: false,
      })
      expect(runtime.settings.base_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
      expect(runtime.settings.base_url).not.toBe(settings.base_url)
    } finally {
      await runtime.close()
    }
  })
})

describe('Anthropic to OpenAI Responses compatibility', () => {
  it('maps messages, tool calls and limits to the Responses request shape', () => {
    expect(anthropicRequestToOpenAiResponses({
      model: 'fixture-model', max_tokens: 80, system: 'fixture system',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'run', input: { ok: true } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }] },
      ],
      tools: [{ name: 'run', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'run' }, stream: true,
    })).toEqual({
      model: 'fixture-model', max_output_tokens: 80, stream: true,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: 'fixture system' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'call-1', name: 'run', arguments: '{"ok":true}' },
        { type: 'function_call_output', call_id: 'call-1', output: 'done' },
      ],
      tools: [{ type: 'function', name: 'run', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'run' },
    })
  })

  it('translates Responses output and streamed text/tool events into Anthropic messages', () => {
    expect(openAiResponsesResponseToAnthropic({
      id: 'resp-fixture', model: 'fixture-model', status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }, { type: 'function_call', call_id: 'call-1', name: 'run', arguments: '{"ok":true}' }],
      usage: { input_tokens: 12, output_tokens: 3 },
    })).toMatchObject({
      id: 'msg-resp-fixture', stop_reason: 'tool_use', usage: { input_tokens: 12, output_tokens: 3 },
      content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'call-1', name: 'run', input: { ok: true } }],
    })
    const translator = createOpenAiResponsesAnthropicEventTranslator()
    const events = [
      ...translator.push({ type: 'response.created', response: { id: 'resp-fixture', model: 'fixture-model' } }),
      ...translator.push({ type: 'response.output_text.delta', delta: 'hello' }),
      ...translator.push({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call-1', name: 'run' } }),
      ...translator.push({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"ok":true}' }),
      ...translator.push({ type: 'response.completed', response: { id: 'resp-fixture', model: 'fixture-model', output: [{ type: 'function_call' }], usage: { output_tokens: 3 } } }),
      ...translator.finish(),
    ]
    expect(events[0].event).toBe('message_start')
    expect(events.some(event => event.data.delta?.text === 'hello')).toBe(true)
    expect(events.some(event => event.data.delta?.partial_json === '{"ok":true}')).toBe(true)
    expect(events.at(-1)?.event).toBe('message_stop')
  })

  it('posts to /responses and translates non-streaming Responses results to Anthropic SSE', async () => {
    let call: { url: string; body: Record<string, unknown> } | undefined
    const relay = await openOpenAiChatRelay('https://gateway.example/v1', false, async (url, init) => {
      call = { url: String(url), body: JSON.parse(String(init?.body)) }
      return Response.json({ id: 'resp-fixture', model: 'fixture-model', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 2, output_tokens: 1 } })
    }, 'openai_responses')
    try {
      const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-key' }, body: JSON.stringify({ model: 'fixture-model', max_tokens: 20, messages: [{ role: 'user', content: 'hello' }], stream: true }) })
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(call).toMatchObject({ url: 'https://gateway.example/v1/responses', body: { model: 'fixture-model', max_output_tokens: 20, stream: true } })
      expect(body).toContain('"text":"ok"')
      expect(body).toContain('"stop_reason":"end_turn"')
    } finally { await relay.close() }
  })
})
