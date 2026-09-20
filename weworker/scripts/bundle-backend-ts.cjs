const esbuild = require('esbuild')
const path = require('path')
const fs = require('fs')

const BACKEND_TS_ROOT = path.resolve(__dirname, '../backend-ts')
const OUT_DIR = path.resolve(__dirname, '../build/backend-ts-dist')
const OUT_FILE = path.join(OUT_DIR, 'server.cjs')
const PROFILE_ENTRY = process.env.WEWORKER_BACKEND_PROFILE_ENTRY
  ? path.resolve(process.env.WEWORKER_BACKEND_PROFILE_ENTRY)
  : null
const PROMPTS_ROOT = path.join(BACKEND_TS_ROOT, 'prompts')

const PROMPT_FILES = {
  agent: 'agent.md',
  'agent-qa-only': 'agent-qa-only.md',
  'memory-output': 'memory-output.md',
  'api-router': 'api-router.md',
  terminal: 'terminal.md',
  title: 'title.md',
}
const NO_VARIABLE_PROMPTS = new Set(['agent-qa-only', 'terminal'])
const EXACT_PROMPT_PLACEHOLDER = /^{{([a-z][a-z0-9]*(?:_[a-z0-9]+)*)}}$/
const PROMPT_BRACE_EXPRESSION = /{+[^{}]*}+/g
const QUERY_ROUTES_CONFIG = process.env.WEWORKER_QUERY_ROUTES_CONFIG
  ? path.resolve(process.env.WEWORKER_QUERY_ROUTES_CONFIG)
  : path.resolve(__dirname, '../query-routes.public.json')

const KEYRING_PLATFORM_PACKAGES = {
  'win32-x64': '@napi-rs/keyring-win32-x64-msvc',
  'win32-arm64': '@napi-rs/keyring-win32-arm64-msvc',
  'win32-ia32': '@napi-rs/keyring-win32-ia32-msvc',
  'darwin-arm64': '@napi-rs/keyring-darwin-arm64',
  'darwin-x64': '@napi-rs/keyring-darwin-x64',
  'linux-x64': '@napi-rs/keyring-linux-x64-gnu',
  'linux-arm64': '@napi-rs/keyring-linux-arm64-gnu',
}

function copyTreeSync(src, dest) {
  const stat = fs.lstatSync(src)
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true })
    for (const name of fs.readdirSync(src)) {
      copyTreeSync(path.resolve(src, name), path.resolve(dest, name))
    }
    return
  }
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
  }
}

function copyScopedPackage(packageName, srcRoot, destRoot) {
  const [scope, name] = packageName.split('/')
  const src = path.join(srcRoot, scope, name)
  if (!fs.existsSync(src)) {
    throw new Error(`[bundle-backend-ts] Missing native dependency: ${packageName}`)
  }
  const dest = path.join(destRoot, scope, name)
  copyTreeSync(src, dest)
}

function copyKeyringNativeDeps(outDir = OUT_DIR) {
  const platformKey = `${process.platform}-${process.arch}`
  const platformPackage = KEYRING_PLATFORM_PACKAGES[platformKey]
  const packages = ['@napi-rs/keyring']
  if (platformPackage) packages.push(platformPackage)

  const srcRoot = path.join(BACKEND_TS_ROOT, 'node_modules')
  const destRoot = path.join(outDir, 'node_modules')
  for (const packageName of packages) {
    copyScopedPackage(packageName, srcRoot, destRoot)
  }
  console.log(`[bundle-backend-ts] Copied native deps: ${packages.join(', ')}`)
}

function loadBuildPrompts(promptsRoot = PROMPTS_ROOT) {
  return Object.fromEntries(Object.entries(PROMPT_FILES).map(([id, fileName]) => {
    const promptPath = path.join(promptsRoot, fileName)
    if (!fs.existsSync(promptPath)) {
      throw new Error(`[bundle-backend-ts] Missing prompt: ${promptPath}`)
    }
    const content = fs.readFileSync(promptPath, 'utf8')
    const declaredVariables = new Set()
    for (const match of content.matchAll(PROMPT_BRACE_EXPRESSION)) {
      const expression = match[0]
      if (!expression.includes('{{') && !expression.includes('}}')) continue
      const placeholder = expression.match(EXACT_PROMPT_PLACEHOLDER)
      if (!placeholder) {
        throw new Error(`[bundle-backend-ts] Unsupported prompt placeholder in ${id}: ${expression}`)
      }
      declaredVariables.add(placeholder[1])
    }
    const unmatchedBoundary = content.replace(PROMPT_BRACE_EXPRESSION, '').match(/{{|}}/)
    if (unmatchedBoundary) {
      throw new Error(`[bundle-backend-ts] Unsupported prompt placeholder in ${id}: ${unmatchedBoundary[0]}`)
    }
    if (NO_VARIABLE_PROMPTS.has(id) && declaredVariables.size > 0) {
      throw new Error(`[bundle-backend-ts] Unexpected prompt variable in ${id}: ${[...declaredVariables].join(', ')}`)
    }
    return [id, content]
  }))
}

function createEsbuildDefines(currentBuildDefines, promptsRoot = PROMPTS_ROOT) {
  return {
    'import.meta.url': '__importMetaUrl',
    'import.meta.dirname': '__dirname',
    '__BUILD_PROVIDERS__': JSON.stringify(currentBuildDefines.providers),
    '__BUILD_DEFAULT_PROVIDER__': JSON.stringify(currentBuildDefines.defaultProvider),
    '__BUILD_PROMPTS__': JSON.stringify(loadBuildPrompts(promptsRoot)),
  }
}

// Read .build-defines.json for provider injection; fall back to defaults for dev mode
const definesPath = path.resolve(__dirname, '../build/.build-defines.json')
let buildDefines
try {
  buildDefines = JSON.parse(fs.readFileSync(definesPath, 'utf-8'))
} catch {
  console.warn('[bundle-backend-ts] .build-defines.json not found, using built-in defaults (dev mode)')
  buildDefines = {
    providers: [
      { id: 'anthropic', name: 'Anthropic', models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'], defaultModel: 'claude-sonnet-4-6', weworker: { protocol: 'anthropic_messages', baseUrl: 'https://api.anthropic.com' }, webwright: { protocol: 'anthropic_messages', modelClass: 'anthropic', baseUrl: 'https://api.anthropic.com', structuredOutput: 'anthropic_json_schema' } },
      { id: 'glm', name: '智谱 coding plan', models: ['glm-5.2', 'glm-4.7'], defaultModel: 'glm-5.2', weworker: { protocol: 'anthropic_messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic' }, webwright: { protocol: 'openai_chat_completions', modelClass: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', structuredOutput: 'openai_json_object' } },
      { id: 'deepseek', name: 'DeepSeek', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], defaultModel: 'deepseek-v4-flash', weworker: { protocol: 'anthropic_messages', baseUrl: 'https://api.deepseek.com/anthropic' }, webwright: { protocol: 'openai_chat_completions', modelClass: 'openai_chat', baseUrl: 'https://api.deepseek.com', structuredOutput: 'openai_json_object' } },
      { id: 'custom', name: '自定义', models: [], defaultModel: '', weworker: { protocol: 'anthropic_messages', baseUrl: '' }, webwright: { protocol: 'openai_chat_completions', modelClass: 'openai_chat', baseUrl: '', structuredOutput: 'openai_json_object' } },
    ],
    defaultProvider: 'anthropic',
  }
}

function bundleBackend(options = {}) {
  const outFile = options.outFile ?? (options.outDir ? path.join(options.outDir, 'server.cjs') : OUT_FILE)
  const outDir = options.outDir ?? path.dirname(outFile)
  const profileEntry = options.profileEntry === undefined ? PROFILE_ENTRY : options.profileEntry
  const currentBuildDefines = options.buildDefines ?? buildDefines
  const keyringExternals = ['@napi-rs/keyring']
  const platformPackage = KEYRING_PLATFORM_PACKAGES[`${process.platform}-${process.arch}`]
  if (platformPackage) keyringExternals.push(platformPackage)

  esbuild.buildSync({
    ...(profileEntry
      ? {
          stdin: {
            contents: `import ${JSON.stringify(profileEntry.replace(/\\/g, '/'))};\nimport ${JSON.stringify(path.resolve(BACKEND_TS_ROOT, 'src/server.ts').replace(/\\/g, '/'))};`,
            loader: 'ts',
            resolveDir: path.dirname(profileEntry),
            sourcefile: 'backend-profile-entry.ts',
          },
        }
      : { entryPoints: [path.resolve(BACKEND_TS_ROOT, 'src/server.ts')] }),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: outFile,
    // node:sqlite is a built-in only available in Node 22+; mark as external
    // @napi-rs/keyring ships platform-specific .node binaries — keep external and copy beside server.cjs
    external: ['node:sqlite', 'node:*', ...keyringExternals],
    define: createEsbuildDefines(currentBuildDefines, options.promptsRoot),
    banner: {
      js: 'const __importMetaUrl = require("url").pathToFileURL(__filename).href;',
    },
  })

  copyKeyringNativeDeps(outDir)

  if (fs.existsSync(QUERY_ROUTES_CONFIG)) {
    fs.copyFileSync(QUERY_ROUTES_CONFIG, path.join(outDir, 'query-routes.json'))
    console.log(`[bundle-backend-ts] Copied query routes: ${QUERY_ROUTES_CONFIG}`)
  }

  fs.writeFileSync(
    path.join(outDir, '.profile.json'),
    JSON.stringify({
      profile: profileEntry ? (process.env.WEWORKER_BUILD_PROFILE || 'custom') : 'public',
      entry: profileEntry ? path.basename(profileEntry) : null,
    }, null, 2) + '\n',
    'utf-8',
  )

  console.log(`Backend-TS bundle created: ${outFile} (profile=${profileEntry ? path.basename(profileEntry) : 'public'})`)
}

module.exports = { bundleBackend, createEsbuildDefines, loadBuildPrompts }

if (require.main === module) bundleBackend()
