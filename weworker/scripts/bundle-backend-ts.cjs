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
// 智能路由分层配置：随包默认目录，可被 Profile Overlay 指向内部配置目录
const ROUTER_CONFIG_DIR = process.env.WEWORKER_ROUTER_CONFIG_DIR
  ? path.resolve(process.env.WEWORKER_ROUTER_CONFIG_DIR)
  : path.resolve(__dirname, '../router-config')

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
    '__BUILD_MODEL_CONFIG__': 'true',
    '__BUILD_PROVIDERS__': JSON.stringify(publicProviders(currentBuildDefines.providers)),
    '__BUILD_PROVIDER_CREDENTIALS__': JSON.stringify(Object.fromEntries(currentBuildDefines.providers.filter(p => p.builtin && p.encryptedApiKey).map(p => [p.id, p.encryptedApiKey]))),
    '__BUILD_DEFAULT_PROVIDER__': JSON.stringify(currentBuildDefines.defaultProvider),
    '__BUILD_PROMPTS__': JSON.stringify(loadBuildPrompts(promptsRoot)),
    '__BUILD_TIMESTAMP__': JSON.stringify(Date.now()),
  }
}

const { loadBuildDefines, publicProviders } = require('./model-provider-config.cjs')

function bundleBackend(options = {}) {
  const outFile = options.outFile ?? (options.outDir ? path.join(options.outDir, 'server.cjs') : OUT_FILE)
  const outDir = options.outDir ?? path.dirname(outFile)
  const profileEntry = options.profileEntry === undefined ? PROFILE_ENTRY : options.profileEntry
  const currentBuildDefines = options.buildDefines ?? loadBuildDefines()
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
    // The UMD entry passes require through a factory, hiding its dependencies
    // from esbuild. Use the library's ESM entry so they are bundled as well.
    alias: {
      'jsonc-parser': require.resolve('jsonc-parser/lib/esm/main.js', { paths: [BACKEND_TS_ROOT] }),
    },
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

  // An incremental build can leave a legacy query-routes.json in outDir. Do not
  // remove files implicitly: package.json excludes it from shipped resources.
  // 分层配置文件与 server.cjs 同目录，运行时按 MODULE_DIR/router-config 命中
  if (fs.existsSync(ROUTER_CONFIG_DIR)) {
    const routerOutDir = path.join(outDir, 'router-config')
    fs.mkdirSync(routerOutDir, { recursive: true })
    const copied = fs.readdirSync(ROUTER_CONFIG_DIR).filter((name) => name.endsWith('.json'))
    for (const name of copied) {
      fs.copyFileSync(path.join(ROUTER_CONFIG_DIR, name), path.join(routerOutDir, name))
    }
    console.log(`[bundle-backend-ts] Copied router config (${copied.length} files): ${ROUTER_CONFIG_DIR}`)
  } else {
    console.warn(`[bundle-backend-ts] Router config dir not found, skipping: ${ROUTER_CONFIG_DIR}`)
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
