import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { JSDOM } from 'jsdom'

test('supplier icons render local brand assets and use the configured OpenAI color', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const server = await createServer({ configFile: false, root,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
    define: { __BUILD_PROVIDERS__: JSON.stringify([
      { id: 'openai', presentation: { color: '#123456' } },
      { id: 'bank_coding', presentation: { color: '#339CFF' } },
    ]) },
  })
  try {
    const Icon = (await server.ssrLoadModule('/src/components/icons/ProviderIcon.jsx')).default
    for (const [provider, filename] of Object.entries({
      glm: 'zhipu-color.svg', deepseek: 'deepseek-color.svg', qwen: 'qwen-color.svg',
    })) {
      const markup = renderToStaticMarkup(React.createElement(Icon, { provider, size: 18 }))
      const document = new JSDOM(markup).window.document
      const source = document.querySelector('img')?.getAttribute('src') || ''
      assert.ok(source.startsWith('data:image/svg+xml,') || source.endsWith(`/src/assets/provider-icons/${filename}`))
      assert.ok(markup.includes('aria-hidden="true"'))
      assert.ok(!markup.includes('https://'))
      const svg = fs.readFileSync(new URL(`../assets/provider-icons/${filename}`, import.meta.url), 'utf8')
      assert.ok(svg.includes('<svg'))
      assert.ok(svg.includes('<path'))
      if (source.startsWith('data:')) assert.ok(decodeURIComponent(source.split(',')[1]).includes('<svg'))
    }
    const openai = renderToStaticMarkup(React.createElement(Icon, { provider: 'openai', size: 18 }))
    assert.ok(openai.startsWith('<svg'))
    assert.ok(openai.includes('fill="currentColor"'))
    assert.ok(openai.includes('color:#123456'))
    assert.ok(openai.includes('width="18"'))
    assert.ok(!openai.includes('mask'))
    assert.ok(openai.includes('<path'))
    for (const provider of ['builtin', 'builtin_dev', 'bank_coding', 'custom']) {
      const markup = renderToStaticMarkup(React.createElement(Icon, { provider }))
      assert.ok(markup.startsWith('<svg'), `${provider} has a local fallback icon`)
    }
  } finally { await server.close() }
})
