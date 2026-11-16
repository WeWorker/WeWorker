import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const chatView = fs.readFileSync(new URL('../components/chat/ChatView.jsx', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../workspace-refresh.css', import.meta.url), 'utf8')

describe('chat log export offers digest and full versions', () => {
  it('downloads through a chooser with both formats hitting the same route', () => {
    assert.match(chatView, /handleExportLogs = async \(format = 'digest'\)/)
    assert.match(chatView, /\/works\/\$\{workId\}\/logs\.txt\$\{suffix\}/)
    assert.match(chatView, /\?format=digest/)
    assert.match(chatView, /chat-log-export__option[\s\S]*精简版[\s\S]*chat-log-export__option[\s\S]*完整版/)
    // Choosing an option closes the dropdown again.
    assert.match(chatView, /closest\('details'\)\?\.removeAttribute\('open'\)/)
  })

  it('styles the export menu inside the existing heading popover pattern', () => {
    assert.match(css, /\.chat-log-export__option \{/)
    assert.match(css, /\.chat-heading__details--export \.chat-heading__metadata \{/)
  })
})
