import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createHandler } from './app.js'
import { importAdapter, openCatalog, syncOfficialAdapters } from './db.js'

const sha256 = 'sha256:' + 'a'.repeat(64)

test('desktop index exposes trusted release metadata and supports conditional requests', async () => {
  const db = openCatalog(':memory:')
  const server = createServer(createHandler({ db }))
  try {
    for (const name of ['first.example.com', 'second.example.com', 'placeholder.example.com']) {
      db.prepare(`INSERT INTO sites (hub_id,domain,name,description,runtimes_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(name, name, name, '', '{}', 1, 1)
    }
    syncOfficialAdapters(db)
    const publish = (name, publisherRole, origin) => importAdapter(db, {
      name, version: '1.0.0', artifactPath: `${name}.adapt`, artifactSha256: sha256,
      artifactSize: 100, manifest: {}, publishedBy: 'test-publisher', publisherRole, origin,
    })
    publish('first.example.com', 'admin')
    publish('second.example.com', 'owner')
    publish('third.example.com', 'admin', 'user')
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/api/v1/adapters/index`
    const desktop = await fetch(url + '?channel=desktop')
    assert.equal(desktop.status, 200)
    assert.deepEqual(await desktop.json(), {
      channel: 'desktop',
      items: ['first', 'second', 'third'].map((label, index) => ({
        name: `${label}.example.com`, version: '1.0.0', sha256, official: index === 0,
      })),
    })
    const etag = desktop.headers.get('etag')
    assert.ok(etag)
    const unchanged = await fetch(url + '?channel=desktop', { headers: { 'If-None-Match': etag } })
    assert.equal(unchanged.status, 304)
    const legacy = await fetch(url, { headers: { 'If-None-Match': etag } })
    assert.equal(legacy.status, 200)
    assert.equal((await legacy.json()).items[0].official, undefined)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
})
