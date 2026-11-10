import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getWebwrightPresentation } from '../utils/webwright-status.js'

describe('Webwright status presentation', () => {
  it('only enables the browser entry while running', () => {
    assert.deepEqual(getWebwrightPresentation('running'), {
      label: '打开Adapter工坊',
      enabled: true,
      tone: 'success',
    })
    for (const status of ['starting', 'error', 'port_in_use', 'version_mismatch', 'stopped', 'unknown']) {
      assert.equal(getWebwrightPresentation(status).enabled, false)
    }
  })

  it('shows explicit failure states', () => {
    assert.equal(getWebwrightPresentation('error').label, '探索服务启动失败')
    assert.equal(getWebwrightPresentation('port_in_use').label, '端口 8766 被占用')
    assert.equal(getWebwrightPresentation('version_mismatch').label, '探索服务版本不匹配')
  })
})
