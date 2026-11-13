import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

const originalWindow = globalThis.window
globalThis.window = { electronAPI: { getHttpAuthToken: async () => '' } }
const { useUserFilesStore: store } = await import('../store/user-files.js')
const initial = store.getState()
let requests
const originalFetch = globalThis.fetch
const scope = 'website-exploration:exp_example'
beforeEach(() => {
  store.setState(initial, true)
  requests = []
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined
    requests.push({ url: String(url), body })
    if (String(url).includes('/import-jobs')) return Response.json({ id: 'example-job', status: 'done', files: [] })
    if (body) return Response.json({ folder: {}, file: {}, item: {} })
    const selected = new URL(String(url)).searchParams.get('workspace_scope')
    const directory = selected ? '/example/user-files/website-exploration/' + selected.split(':')[1] : '/example/user-files'
    return Response.json({ directory, files: [] })
  }
})
afterEach(() => { globalThis.fetch = originalFetch; store.setState(initial, true) })
test.after(() => { globalThis.window = originalWindow })

test('exploration file sidebar opens only the selected task directory without a main-chat work', async () => {
  store.getState().setWorkspaceContext(null, null, scope)
  await store.getState().togglePanel()
  assert.equal(store.getState().open, true)
  assert.equal(store.getState().directory, '/example/user-files/website-exploration/exp_example')
  assert.equal(new URL(requests[0].url).searchParams.get('workspace_scope'), scope)
  await store.getState().load()
  assert.equal(new URL(requests[1].url).searchParams.get('workspace_scope'), scope)
  await store.getState().togglePanel()
  assert.equal(store.getState().open, false)
})

test('all file actions carry the fixed scope, with no unrelated work or project id', async () => {
  store.getState().setWorkspaceContext('background-work', 'background-project')
  store.getState().setWorkspaceContext(null, null, scope)
  await store.getState().createFolder('', 'example')
  await store.getState().createFile('', 'example.txt')
  await store.getState().renameItem('/example/old.txt', 'new.txt')
  await store.getState().pasteItem('/example/source.txt', '/example/target', 'copy')
  await store.getState().importFiles(['/example/source.txt'])
  await store.getState().deleteItem('/example/old.txt')
  const writes = requests.filter(request => request.body)
  assert.equal(writes.length, 6)
  for (const { body } of writes) {
    assert.equal(body.workspace_scope, scope)
    assert.equal(body.work_id, undefined)
    assert.equal(body.project_id, undefined)
  }
})

test('artifact updates refresh the visible matching directory without showing a loader', async () => {
  store.getState().setWorkspaceContext(null, null, scope)
  await store.getState().openPanel()
  requests.length = 0
  let showedLoader = false
  const unsubscribe = store.subscribe(state => { if (state.loading) showedLoader = true })
  await store.getState().refreshForChanges('exp_example', 'exploration')
  assert.equal(requests.length, 1)
  assert.equal(new URL(requests[0].url).searchParams.get('workspace_scope'), scope)
  assert.equal(showedLoader, false)
  requests.length = 0
  await store.getState().refreshForChanges('ordinary-chat', 'chat')
  assert.equal(requests.length, 0)
  await store.getState().refreshForChanges('exp_other', 'exploration')
  assert.equal(requests.length, 0)
  store.getState().closePanel()
  await store.getState().refreshForChanges('exp_example', 'exploration')
  assert.equal(requests.length, 0)
  unsubscribe()
})

test('switching back restores normal context and ignores late exploration responses', async () => {
  let release
  globalThis.fetch = async () => new Promise(resolve => { release = resolve })
  store.getState().setWorkspaceContext(null, null, scope)
  const pending = store.getState().load()
  // Let the authenticated request reach the fetch stub.
  await new Promise(resolve => setImmediate(resolve))
  store.getState().setWorkspaceContext(null, null)
  release(Response.json({ directory: '/example/user-files/website-exploration', files: [{ name: 'old' }] }))
  await pending
  assert.equal(store.getState().workspaceScope, null)
  assert.equal(store.getState().directory, '')
  assert.deepEqual(store.getState().files, [])
  assert.equal(store.getState().loading, false)
  globalThis.fetch = async url => { requests.push(String(url)); return Response.json({ directory: '/example/project', files: [] }) }
  store.getState().setWorkspaceContext(null, 'project')
  await store.getState().load()
  assert.equal(new URL(requests.at(-1)).search, '?project_id=project')
})

test('new unsent exploration has no directory or filesystem requests', async () => {
  store.getState().setWorkspaceContext(null, null, scope)
  await store.getState().openPanel()
  requests.length = 0
  store.getState().setWorkspaceContext(null, null, 'website-exploration')
  await store.getState().load()
  await store.getState().createFolder('', 'example')
  await store.getState().createFile('', 'example.txt')
  await store.getState().importFiles(['/example/source.txt'])
  assert.equal(store.getState().directory, '')
  assert.deepEqual(store.getState().files, [])
  assert.equal(requests.length, 0)
})

test('switching exploration immediately clears previous files and rejects their late response', async () => {
  store.getState().setWorkspaceContext(null, null, scope)
  let release
  globalThis.fetch = async () => new Promise(resolve => { release = resolve })
  const first = store.getState().load()
  await new Promise(resolve => setImmediate(resolve))
  store.getState().setWorkspaceContext(null, null, 'website-exploration:exp_other')
  release(Response.json({ directory: '/example/user-files/website-exploration/exp_example', files: [{ name: 'old.txt' }] }))
  await first
  assert.deepEqual(store.getState().files, [])
  globalThis.fetch = async () => Response.json({ directory: '/example/user-files/website-exploration/exp_other', files: [{ name: 'other.txt' }] })
  await store.getState().load()
  assert.equal(store.getState().files[0].name, 'other.txt')
  assert(store.getState().expandedPaths.includes('/example/user-files/website-exploration/exp_other'))
})
