import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import { featuredSiteScrollState, scrollFeaturedSitesByPage, scrollFeaturedSitesHorizontally } from '../components/welcome/welcome-utils.js'

test('website arrows track overflow and both edges, including fractional scroll positions', () => {
  const strip = { scrollWidth: 900, clientWidth: 300, scrollLeft: 0 }
  assert.deepEqual(featuredSiteScrollState(strip), { overflow: true, left: false, right: true })
  strip.scrollLeft = 240
  assert.deepEqual(featuredSiteScrollState(strip), { overflow: true, left: true, right: true })
  strip.scrollLeft = 599.5
  assert.deepEqual(featuredSiteScrollState(strip), { overflow: true, left: true, right: false })
  strip.clientWidth = 900
  strip.scrollLeft = 0
  assert.deepEqual(featuredSiteScrollState(strip), { overflow: false, left: false, right: false })
})

test('website arrows scroll by a partial page, clamp at edges and respect reduced motion', () => {
  const calls = []
  const strip = { scrollWidth: 900, clientWidth: 300, scrollLeft: 0, scrollTo: options => calls.push(options) }
  scrollFeaturedSitesByPage(strip, 1)
  assert.deepEqual(calls.pop(), { left: 240, behavior: 'smooth' })
  strip.scrollLeft = 550
  scrollFeaturedSitesByPage(strip, 1)
  assert.equal(calls.pop().left, 600)
  strip.scrollLeft = 100
  scrollFeaturedSitesByPage(strip, -1, true)
  assert.deepEqual(calls.pop(), { left: 0, behavior: 'auto' })
  scrollFeaturedSitesByPage(null, 1)
})

function wheel(element, options = {}) {
  const event = { deltaX: 0, deltaY: 80, deltaMode: 0, ctrlKey: false, prevented: false,
    preventDefault() { this.prevented = true }, ...options }
  scrollFeaturedSitesHorizontally(event, element)
  return event
}

test('scrolls overflowing website chips horizontally and handles wheel units', () => {
  const strip = { scrollWidth: 900, clientWidth: 300, scrollLeft: 0 }
  assert.ok(wheel(strip).prevented)
  assert.equal(strip.scrollLeft, 80)
  wheel(strip, { deltaY: 2, deltaMode: 1 })
  assert.equal(strip.scrollLeft, 112)
  wheel(strip, { deltaY: 1, deltaMode: 2 })
  assert.equal(strip.scrollLeft, 412)
  wheel(strip, { deltaY: -80 })
  assert.equal(strip.scrollLeft, 332)
})

test('keeps zoom, horizontal trackpad gestures and page scrolling at the strip edges native', () => {
  const strip = { scrollWidth: 900, clientWidth: 300, scrollLeft: 0 }
  assert.equal(wheel(strip, { ctrlKey: true }).prevented, false)
  assert.equal(wheel(strip, { deltaX: 90 }).prevented, false)
  assert.equal(wheel(strip, { deltaY: -80 }).prevented, false)
  assert.equal(strip.scrollLeft, 0)
  strip.scrollLeft = 580
  assert.ok(wheel(strip).prevented)
  assert.equal(strip.scrollLeft, 600)
  assert.equal(wheel(strip).prevented, false)
  assert.equal(wheel({ scrollWidth: 200, clientWidth: 300, scrollLeft: 0 }).prevented, false)
})

let server, Actions, dom
before(async () => {
  dom = new JSDOM('<div id="test"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
  Actions = (await server.ssrLoadModule('/src/components/welcome/FeaturedSiteActions.jsx')).default
})
after(async () => {
  await server?.close()
  dom?.window.close()
  delete globalThis.window
  delete globalThis.document
  delete globalThis.IS_REACT_ACT_ENVIRONMENT
})

test('the compact remove button removes only its site without opening the card', async t => {
  const host = document.getElementById('test')
  const root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()) })
  const removed = []
  let cardEvents = 0
  await act(async () => root.render(React.createElement('div', {
    onClick: () => { cardEvents++ }, onKeyDown: () => { cardEvents++ },
  }, React.createElement(Actions, {
    site: { id: 'mail.example.com', name: '示例邮箱' }, layout: 'chip', showActions: false,
    removeFeaturedSite: id => removed.push(id),
  }))))
  const button = host.querySelector('button')
  assert.equal(host.querySelectorAll('button').length, 1)
  assert.equal(button.getAttribute('aria-label'), '从常用网站移除 示例邮箱')
  assert.ok(button.hasAttribute('data-featured-action'))
  await act(async () => button.click())
  for (const key of ['Enter', ' ']) {
    const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    await act(async () => button.dispatchEvent(event))
    assert.ok(event.defaultPrevented)
  }
  assert.deepEqual(removed, ['mail.example.com', 'mail.example.com', 'mail.example.com'])
  assert.equal(cardEvents, 0)
})
