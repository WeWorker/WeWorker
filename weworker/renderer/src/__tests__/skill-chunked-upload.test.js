import test from 'node:test'
import assert from 'node:assert/strict'

test('createSkill falls back to chunked upload when the whole payload is blocked by size', async () => {
  globalThis.window = { electronAPI: {
    getBackendUrl: async () => 'http://127.0.0.1:48765',
    getHttpAuthToken: async () => 'fixture-token',
    // 无 mainFetch：主进程转发兜底不可用，走纯分块路径。
  } }
  const { createSkill } = await import('../api/dedicated-agents-api.js?chunked')

  const markdown = '---\nname: big-skill\n---\n\n' + 'x'.repeat(3000)
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const bodySize = typeof options.body === 'string' ? options.body.length : 0
    calls.push(`${options.method || 'GET'} ${new URL(url).pathname} ${bodySize}B`)
    // 复现按体积拦截：>1KB 的请求在网络层被拒（1KB 是实测安全大小）。
    if (bodySize > 1024) throw new TypeError('Failed to fetch')
    const path = new URL(url).pathname
    if (path === '/dedicated-agents/skills/chunked/start') return Response.json({ upload_id: 'upload-1' })
    if (path.startsWith('/dedicated-agents/skills/chunked/upload-1/')) {
      if (path.endsWith('/complete')) return Response.json({ name: 'big-skill', scope: 'private', markdown })
      return Response.json({ received: 1, total: 4 })
    }
    return Response.json({})
  }

  const result = await createSkill('big-skill', markdown, 'private')
  assert.equal(result.name, 'big-skill')
  // 整包 POST 被拦后：start + 多个 ≤1KB 分块 + complete，全部是小请求。
  const whole = calls[0]
  assert.match(whole, /^POST \/dedicated-agents\/skills \d+B$/)
  assert.ok(Number(/\d+/.exec(whole)) > 1024, '整包请求确实超过分块大小')
  const chunkPuts = calls.filter((entry) => entry.startsWith('PUT /dedicated-agents/skills/chunked/upload-1/'))
  assert.ok(chunkPuts.length >= 3, '内容被拆成多个分块')
  for (const entry of chunkPuts) {
    const size = Number(/(\d+)B$/.exec(entry)[1])
    assert.ok(size <= 1024, `每个分块 ≤1KB（实际 ${size}B）`)
  }
  assert.match(calls.at(-1), /^POST \/dedicated-agents\/skills\/chunked\/upload-1\/complete/)
})

test('small skills and non-network failures never trigger chunking', async () => {
  globalThis.window = { electronAPI: {
    getBackendUrl: async () => 'http://127.0.0.1:48765',
    getHttpAuthToken: async () => 'fixture-token',
  } }
  const { createSkill } = await import('../api/dedicated-agents-api.js?chunked-skip')
  const paths = []
  globalThis.fetch = async (url, options = {}) => {
    paths.push(new URL(url).pathname)
    const path = paths.at(-1)
    if (path === '/dedicated-agents/skills') {
      // 小内容也网络失败 → 直接抛错，不进入分块（内容小于分块阈值）。
      if (typeof options.body === 'string' && options.body.length < 1024) throw new TypeError('Failed to fetch')
      return Response.json({ error: 'conflict' }, { status: 409 })
    }
    throw new Error('不应发起分块请求')
  }
  await assert.rejects(createSkill('small', 'tiny', 'private'), /无法连接|请求失败/)
  assert.deepEqual(paths, ['/dedicated-agents/skills'])
})
