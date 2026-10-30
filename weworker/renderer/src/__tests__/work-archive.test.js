import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { useWorksStore } from '../store/works.js'

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.window = originalWindow
})

test('archiving updates the conversation through Backend and preserves its history', async () => {
  globalThis.window = {}
  const work = { id: 'fixture-work', title: 'Example conversation', archived: false }
  useWorksStore.setState({ works: [work], activeWorkId: null })
  globalThis.fetch = async (url, options) => {
    assert.match(url, /\/works\/fixture-work\/archive$/)
    assert.equal(options.method, 'PATCH')
    assert.deepEqual(JSON.parse(options.body), { archived: true })
    return Response.json({ ...work, archived: true })
  }

  await useWorksStore.getState().setWorkArchived(work.id, true)

  assert.deepEqual(useWorksStore.getState().works, [{ ...work, archived: true }])
})

test('a failed archive request leaves the conversation visible', async () => {
  globalThis.window = {}
  const work = { id: 'fixture-work', title: 'Example conversation', archived: false }
  useWorksStore.setState({ works: [work], activeWorkId: null })
  globalThis.fetch = async () => Response.json({ detail: 'Fixture failure' }, { status: 500 })

  await assert.rejects(useWorksStore.getState().setWorkArchived(work.id, true), /Fixture failure/)
  assert.deepEqual(useWorksStore.getState().works, [work])
})

test('repeated archive calls for one conversation share the in-flight request', async () => {
  globalThis.window = {}
  const work = { id: 'fixture-rapid-archive', title: 'Example conversation', archived: false }
  useWorksStore.setState({ works: [work], activeWorkId: null })
  let resolveFetch
  let fetchCount = 0
  globalThis.fetch = () => {
    fetchCount += 1
    return new Promise((resolve) => { resolveFetch = () => resolve(Response.json({ ...work, archived: true })) })
  }

  const first = useWorksStore.getState().setWorkArchived(work.id, true)
  const second = useWorksStore.getState().setWorkArchived(work.id, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fetchCount, 1)
  resolveFetch()
  await Promise.all([first, second])
  assert.deepEqual(useWorksStore.getState().works, [{ ...work, archived: true }])
})

test('the conversation row exposes archive action and memory settings expose restore', () => {
  const sidebar = fs.readFileSync(new URL('../components/sidebar/WorksList.jsx', import.meta.url), 'utf8')
  const memory = fs.readFileSync(new URL('../components/settings/MemoryTab.jsx', import.meta.url), 'utf8')
  assert.match(sidebar, /aria-label=\{`归档 \$\{work\.title \|\| '新任务'\}`\}/)
  assert.match(sidebar, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); handleArchive\(\) \}\}/)
  assert.match(memory, /已归档对话/)
  assert.match(memory, /restoreArchivedWork\(work\.id\)/)
})
