import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const panel = fs.readFileSync(new URL('../components/chat/RouteDiagnosticsPanel.jsx', import.meta.url), 'utf8')
const detail = fs.readFileSync(new URL('../components/chat/RouteTurnDetails.jsx', import.meta.url), 'utf8')
const list = fs.readFileSync(new URL('../components/chat/MessageList.jsx', import.meta.url), 'utf8')

describe('read-only route diagnostics surface', () => {
  it('requests safe work-level projection without requesting raw conversation logs', () => {
    assert.match(panel, /backendFetch\(`\/works\/\$\{encodeURIComponent\(workId\)\}\/route-diagnostics`\)/)
    assert.doesNotMatch(panel + detail, /logs\.txt|routeArgs|JSON\.stringify\(event\)/)
    assert.match(list, /<RouteDiagnosticsPanel workId=\{workId\} streaming=\{streaming\} \/>/)
  })
  it('keeps advanced stages collapsed and avoids guessing per-message turn association', () => {
    assert.match(detail, /useState\(false\)/)
    assert.match(detail, /\{open &&/)
    assert.match(panel, /Work-level panel: message rows do not carry durable turn IDs/)
    assert.match(panel, /turn\.turnId\.slice\(0, 8\)/)
  })
})
