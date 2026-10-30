import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { useWorksStore } from '../store/works.js'

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.window = originalWindow
})

test('repeated new-conversation requests for one workspace share the in-flight creation', async () => {
  globalThis.window = {}
  useWorksStore.setState({ works: [], messages: {}, activeWorkId: null })
  let resolveFetch
  let postCount = 0
  globalThis.fetch = (_url, options) => {
    if (options.method === 'POST') postCount += 1
    return new Promise((resolve) => {
      resolveFetch = () => resolve(Response.json({ id: 'fixture-created-work', title: '', project_id: null }))
    })
  }

  const options = { forceNew: true, projectId: null }
  const first = useWorksStore.getState().createWork(options)
  const second = useWorksStore.getState().createWork(options)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(postCount, 1)
  resolveFetch()
  const works = await Promise.all([first, second])
  assert.equal(works[0].id, works[1].id)
  assert.equal(useWorksStore.getState().works.length, 1)
})

test('closely spaced new-conversation clicks do not create another empty conversation', async () => {
  globalThis.window = {}
  useWorksStore.setState({ works: [], messages: {}, activeWorkId: null })
  let postCount = 0
  globalThis.fetch = async (_url, options) => {
    if (options.method !== 'POST') return Response.json({ messages: [] })
    if (options.method === 'POST') postCount += 1
    return Response.json({ id: `fixture-created-work-${postCount}`, title: '', project_id: 'fixture-project' })
  }

  const options = { forceNew: true, projectId: 'fixture-project' }
  const first = await useWorksStore.getState().createWork(options)
  const second = await useWorksStore.getState().createWork(options)

  assert.equal(postCount, 1)
  assert.equal(first.id, second.id)
  assert.equal(useWorksStore.getState().works.length, 1)
})

test('new-conversation action reuses an existing empty conversation in the same workspace', async () => {
  globalThis.window = {}
  const emptyWork = { id: 'fixture-existing-empty-work', title: '', project_id: 'fixture-reuse-empty-project' }
  useWorksStore.setState({ works: [emptyWork], messages: { [emptyWork.id]: [] }, activeWorkId: null })
  let postCount = 0
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'POST') postCount += 1
    return Response.json({ id: 'fixture-unexpected-new-work', title: '', project_id: emptyWork.project_id })
  }

  const result = await useWorksStore.getState().createWork({ forceNew: true, projectId: emptyWork.project_id })

  assert.equal(postCount, 0)
  assert.equal(result.id, emptyWork.id)
  assert.equal(useWorksStore.getState().works.length, 1)
})
