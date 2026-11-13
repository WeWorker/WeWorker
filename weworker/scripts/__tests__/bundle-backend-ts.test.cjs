const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { bundleBackend, createEsbuildDefines } = require('../bundle-backend-ts.cjs')

const PROMPT_FILES = [
  'agent.md',
  'agent-qa-only.md',
  'context-window.md',
  'memory-output.md',
  'api-router.md',
  'terminal.md',
  'title.md',
]

function createTempDirectory(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function createPromptDirectory(t, files = PROMPT_FILES) {
  const root = createTempDirectory(t, 'weworker-prompts-')
  for (const file of files) {
    fs.writeFileSync(path.join(root, file), `content:${file}\n`, 'utf8')
  }
  return root
}

test('backend bundle reads and injects all fixed prompts', (t) => {
  const promptsRoot = createPromptDirectory(t)
  const defines = createEsbuildDefines({ providers: [], defaultProvider: 'test' }, promptsRoot)
  assert.ok(JSON.parse(defines.__BUILD_TIMESTAMP__) > 0)

  assert.deepEqual(JSON.parse(defines.__BUILD_PROMPTS__), {
    agent: 'content:agent.md\n',
    'agent-qa-only': 'content:agent-qa-only.md\n',
    'context-window': 'content:context-window.md\n',
    'memory-output': 'content:memory-output.md\n',
    'api-router': 'content:api-router.md\n',
    terminal: 'content:terminal.md\n',
    title: 'content:title.md\n',
  })
})

test('backend bundle fails when any fixed prompt is missing', (t) => {
  const promptsRoot = createPromptDirectory(t, PROMPT_FILES.slice(0, -1))

  assert.throws(
    () => createEsbuildDefines({ providers: [], defaultProvider: 'test' }, promptsRoot),
    /Missing prompt:.*title\.md/,
  )
})

test('backend bundle fails when a fixed prompt contains invalid placeholder syntax', (t) => {
  const promptsRoot = createPromptDirectory(t)
  fs.writeFileSync(path.join(promptsRoot, 'terminal.md'), 'Invalid: {{bad-name}}\n', 'utf8')

  assert.throws(
    () => createEsbuildDefines({ providers: [], defaultProvider: 'test' }, promptsRoot),
    /Unsupported prompt placeholder in terminal:.*bad-name/,
  )
})

test('backend bundle rejects variables in no-variable prompts', (t) => {
  const promptsRoot = createPromptDirectory(t)
  fs.writeFileSync(path.join(promptsRoot, 'agent-qa-only.md'), 'Unexpected: {{unexpected_value}}\n', 'utf8')

  assert.throws(
    () => createEsbuildDefines({ providers: [], defaultProvider: 'test' }, promptsRoot),
    /Unexpected prompt variable in agent-qa-only: unexpected_value/,
  )
})

test('final backend bundle contains embedded prompts and serves initialization configuration', { timeout: 30000 }, async (t) => {
  assert.match(bundleBackend.toString(), /options/)

  const outDir = createTempDirectory(t, 'weworker-backend-bundle-')
  const bundlePath = path.join(outDir, 'custom-server.cjs')
  const buildStartedAt = Date.now()
  bundleBackend({ outDir, outFile: bundlePath, buildDefines: { providers: [], defaultProvider: 'test' } })

  // A fresh output must not contain the retired profile configuration.
  assert.equal(fs.existsSync(path.join(outDir, 'query-routes.json')), false)
  const bundleSource = fs.readFileSync(bundlePath, 'utf8')
  assert.doesNotMatch(bundleSource, /profile-query-route|WEWORKER_QUERY_ROUTES_CONFIG/)
  const builtAt = Number(bundleSource.match(/SKILL_BUILD_TIME = true \? ([\d.e+]+)/)?.[1])
  assert.ok(builtAt >= buildStartedAt && builtAt <= Date.now(), 'final bundle must embed this compilation timestamp')
  assert.doesNotMatch(bundleSource, /typeof __BUILD_TIMESTAMP__/)
  assert.match(bundleSource, /Unknown prompt ID:/)
  assert.match(bundleSource, /Missing embedded prompt:/)

  const defineSection = bundleSource.match(
    /\/\/ <define:__BUILD_PROMPTS__>[\s\S]*?\n\s*\w+ = (\{.*\});\r?$/m,
  )
  assert.ok(defineSection, 'missing __BUILD_PROMPTS__ object in final bundle')
  const embeddedPrompts = JSON.parse(vm.runInNewContext(`JSON.stringify(${defineSection[1]})`))
  const promptsRoot = path.resolve(__dirname, '../../backend-ts/prompts')
  const expectedPrompts = Object.fromEntries(PROMPT_FILES.map((file) => [
    path.basename(file, '.md'),
    fs.readFileSync(path.join(promptsRoot, file), 'utf8'),
  ]))
  assert.deepEqual(embeddedPrompts, expectedPrompts)

  const home = path.join(outDir, 'fixture-home')
  fs.mkdirSync(home)
  fs.mkdirSync(path.join(outDir, 'adapters'))
  fs.writeFileSync(path.join(outDir, 'adapters', '.profile.json'), JSON.stringify({
    schema_version: 1, profile: 'public', adapters: [],
  }))
  fs.mkdirSync(path.join(outDir, 'webcli'))
  fs.writeFileSync(path.join(outDir, 'webcli', 'webcli.cjs'), 'process.exit(0)')
  const preload = path.join(outDir, 'fixture-home.cjs')
  fs.writeFileSync(preload, `require('node:os').homedir = () => ${JSON.stringify(home)};`)
  const reservation = net.createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  // Keep the production port and host validation together while isolating this
  // fixture from any desktop client already running on the test machine.
  assert.match(bundleSource, /LOCAL_HTTP_PORT = 8765;/)
  fs.writeFileSync(bundlePath, bundleSource.replace('LOCAL_HTTP_PORT = 8765;', `LOCAL_HTTP_PORT = ${port};`))
  const child = spawn(process.execPath, ['--experimental-sqlite', '--require', preload, bundlePath], {
    cwd: outDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: outDir,
      TMP: outDir,
      HOME: home,
      USERPROFILE: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      WEWORKER_PACKAGED: '1',
      WEWORKER_RESOURCES_PATH: outDir,
      WEWORKER_HTTP_TOKEN: 'fixture-http-token',
      WEWORKER_TEST_MASTER_KEY: '0123456789abcdef0123456789abcdef',
    },
  })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  let spawnError
  child.on('error', error => { spawnError = error })
  try {
    let ready = false
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && child.exitCode === null && !spawnError) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/status`, {
          headers: { 'X-WeWorker-Auth': 'fixture-http-token' },
          signal: AbortSignal.timeout(500),
        })
        ready = response.ok
        if (ready) break
      } catch { /* Wait for the packaged backend to listen. */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(ready, true, `bundled backend did not start: ${spawnError || output}`)
    for (const endpoint of ['/settings', '/settings/channels']) {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        headers: { 'X-WeWorker-Auth': 'fixture-http-token' },
        signal: AbortSignal.timeout(2000),
      })
      assert.equal(response.status, 200, `${endpoint} must initialize successfully`)
      assert.equal(typeof await response.json(), 'object')
    }
  } finally {
    if (child.exitCode === null && !spawnError) {
      child.kill()
      await once(child, 'exit')
    }
  }
})
