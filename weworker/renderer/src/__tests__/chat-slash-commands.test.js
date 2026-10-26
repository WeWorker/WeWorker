import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  WEBCLI_SLASH_COMMANDS,
  buildWebcliSlashCommands,
  filterChatSlashCommands,
  findChatBangTrigger,
  findChatSlashTrigger,
} from '../utils/chat-slash-commands.js'

describe('chat slash commands', () => {
  it('opens on slash at the beginning or after whitespace', () => {
    assert.deepEqual(findChatSlashTrigger('/', 1), { query: '', start: 0, end: 1 })
    assert.deepEqual(findChatSlashTrigger('run /web', 8), { query: 'web', start: 4, end: 8 })
    assert.deepEqual(findChatSlashTrigger('/webcli cal', 11), { query: 'webcli cal', start: 0, end: 11 })
  })

  it('does not open for URLs or path-like text', () => {
    assert.equal(findChatSlashTrigger('https://example.com/', 17), null)
    assert.equal(findChatSlashTrigger('abc/web', 7), null)
  })

  it('opens shell command completion only for a leading bang command', () => {
    assert.deepEqual(findChatBangTrigger('!', 1), { query: '', start: 0, end: 1 })
    assert.deepEqual(findChatBangTrigger('  !webcli ca', 12), { query: 'webcli ca', start: 2, end: 12 })
    assert.equal(findChatBangTrigger('run !webcli ca', 14), null)
    assert.equal(findChatBangTrigger('hello!', 6), null)
  })

  it('only exposes webcli command templates', () => {
    assert.ok(WEBCLI_SLASH_COMMANDS.length > 0)
    for (const item of WEBCLI_SLASH_COMMANDS) {
      assert.match(item.command, /^webcli call\b/)
    }
    assert.equal(filterChatSlashCommands(WEBCLI_SLASH_COMMANDS, 'open')[0].id, 'webcli-open-browser')
    assert.equal(filterChatSlashCommands(WEBCLI_SLASH_COMMANDS, 'webcli cal')[0].id, 'webcli-call')
  })

  it('builds concrete webcli commands from site tools before fallback templates', () => {
    const commands = buildWebcliSlashCommands([
      {
        id: 'expense.example.com',
        name: 'ExpenseDemo费用管理示例',
        tools: [
          {
            name: 'expense.example.com.create_budget',
            description: '创建预算',
            parameters: [
              { name: 'amount', required: true },
              { name: 'remark', required: false },
            ],
          },
        ],
      },
    ])

    assert.equal(commands[0].title, 'expense.example.com.create_budget')
    assert.equal(commands[0].command, 'webcli call expense.example.com.create_budget --amount=<amount>')
    assert.equal(filterChatSlashCommands(commands, 'create_budget')[0].id, 'webcli-tool:expense.example.com.create_budget')
  })
})
