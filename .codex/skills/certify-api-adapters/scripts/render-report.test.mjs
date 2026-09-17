import assert from 'node:assert/strict'
import test from 'node:test'

import { renderReport } from './render-report.mjs'

test('report groups conditional tools and escapes tool names', () => {
  const html = renderReport({
    adapterCount: 1,
    toolCount: 3,
    callPath: 'webcli call -> Bridge -> Extension -> Adapter',
    summary: {
      adapters: { FAIL: 1 },
      tools: { CONDITIONAL: 2, FAIL: 1 },
    },
    adapters: [{
      id: 'example.test',
      result: 'FAIL',
      summary: { CONDITIONAL: 2, FAIL: 1 },
      tools: [
        { name: 'example.auth', result: 'CONDITIONAL', reasonCode: 'LIVE_AUTH' },
        { name: 'example.<permission>', result: 'CONDITIONAL', reasonCode: 'LIVE_PERMISSION' },
        { name: 'example.fail', result: 'FAIL', reasonCode: 'LIVE_HTTP_ERROR' },
      ],
    }],
  })
  assert.match(html, /登录限制：1/)
  assert.match(html, /权限限制：1/)
  assert.match(html, /example\.&lt;permission&gt;/)
  assert.match(html, /FAIL 工具：1/)
  assert.doesNotMatch(html, /example\.<permission>/)
})
