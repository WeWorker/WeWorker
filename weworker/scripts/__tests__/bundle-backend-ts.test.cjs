const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { bundleBackend, createEsbuildDefines } = require('../bundle-backend-ts.cjs')

const PROMPT_FILES = [
  'agent.md',
  'agent-qa-only.md',
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

test('backend bundle reads and injects all six fixed prompts', (t) => {
  const promptsRoot = createPromptDirectory(t)
  const defines = createEsbuildDefines({ providers: [], defaultProvider: 'test' }, promptsRoot)
  assert.ok(JSON.parse(defines.__BUILD_TIMESTAMP__) > 0)

  assert.deepEqual(JSON.parse(defines.__BUILD_PROMPTS__), {
    agent: 'content:agent.md\n',
    'agent-qa-only': 'content:agent-qa-only.md\n',
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

test('final backend bundle contains the prompt loader and all embedded prompts', (t) => {
  assert.match(bundleBackend.toString(), /options/)

  const outDir = createTempDirectory(t, 'weworker-backend-bundle-')
  const bundlePath = path.join(outDir, 'custom-server.cjs')
  const buildStartedAt = Date.now()
  bundleBackend({ outDir, outFile: bundlePath })

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
})
