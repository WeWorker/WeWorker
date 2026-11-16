import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as commands from '../utils/chat-slash-commands.js'
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

describe('Skill slash completion', () => {
  it('keeps the icon supplied by the managed Skill catalog', () => {
    const iconUrl = 'data:image/svg+xml;base64,PHN2ZyAvPg=='
    const items = commands.buildSkillSlashCommands([
      { name: 'with-icon', enabled: true, content: '# Example', iconUrl },
      { name: 'no-icon', enabled: true, content: '# Example' },
    ])
    assert.equal(items[0].iconUrl, iconUrl)
    assert.equal(items[1].iconUrl, undefined)
  })
  it('lists enabled Skills by their full invocation name and searchable description', () => {
    assert.equal(typeof commands.buildSkillSlashCommands, 'function')
    const items = commands.buildSkillSlashCommands([
      { name: 'report-folder', enabled: true, content: '---\nname: webcli-report\ndescription: >\n  Summarize reports\n  for a chosen period\n---\nInstructions' },
      { name: 'notes', enabled: true, content: '# Notes skill' },
      { name: 'disabled', enabled: false, content: '---\nname: disabled\n---\nInstructions' },
      { name: 'draft', enabled: false, draft: true, content: '' },
      { name: 'hidden', enabled: true, content: '---\nname: hidden\nuser-invocable: false\n---\nInstructions' },
      { name: 'manual', enabled: true, content: '---\nname: manual\ndisable-model-invocation: true\n---\nInstructions' },
    ])
    assert.deepEqual(items.map(item => item.title).sort(), ['manual', 'notes', 'webcli-report'])
    const report = filterChatSlashCommands(items, 'chosen period')[0]
    assert.equal(report.command, '/webcli-report ')
    assert.equal(report.description, 'Summarize reports for a chosen period')
    assert.equal(filterChatSlashCommands(items, 'report-folder')[0], report)
    assert.equal(filterChatSlashCommands(items, 'WEBCLI')[0], report)
  })

  it('deduplicates invocation names and excludes empty or malformed Skill entries', () => {
    assert.equal(typeof commands.buildSkillSlashCommands, 'function')
    const content = '---\nname: example\ndescription: Example skill\n---\nInstructions'
    const items = commands.buildSkillSlashCommands([
      null, {}, { name: '', enabled: true, content },
      { name: 'empty', enabled: true, content: '' },
      { name: 'example', enabled: true, content },
      { name: 'same-name', enabled: true, content },
    ])
    assert.equal(items.length, 1)
    assert.equal(items[0].command, '/example ')
  })

  it('opens only at a slash token and closes before arguments, URLs and nested paths', () => {
    assert.equal(typeof commands.findChatSkillTrigger, 'function')
    assert.deepEqual(commands.findChatSkillTrigger('/', 1), { query: '', start: 0, end: 1 })
    assert.deepEqual(commands.findChatSkillTrigger('use /rep next', 8), { query: 'rep', start: 4, end: 8 })
    assert.deepEqual(commands.findChatSkillTrigger('use /report next', 8), { query: 'rep', start: 4, end: 11 })
    for (const value of ['https://example.com/', '/tmp/file', 'C:/files/', 'abc/report', '/report ', '1 / 2', '//server']) {
      assert.equal(commands.findChatSkillTrigger(value, value.length), null, value)
    }
  })
})
