const esbuild = require('esbuild')
const path = require('path')

const projectRoot = path.resolve(__dirname, '../..')

async function main() {
await esbuild.build({
  plugins: require('./host-cli-provider-build.cjs').hostCliProviderPlugins(projectRoot),
  // 入口用 index.js（不是 bridge.js）：bridge.js 只导出类、无自启动入口，
  // 被 utilityProcess.fork 成 bridge.cjs 后什么都不做，导致 Bridge 起不来。
  // index.js 的 main() 会识别 argv['service','start'] → runServiceMode() → 启动 Bridge。
  entryPoints: [path.resolve(projectRoot, 'webcli/index.js')],
  absWorkingDir: projectRoot,
  bundle: true,
  external: ['@napi-rs/keyring'],
  platform: 'node',
  format: 'cjs',
  outfile: path.resolve(__dirname, '../build/bridge-dist/bridge.cjs'),
  define: {
    '__WEBCLI_RUNTIME_CONFIG__': JSON.stringify(require('./webcli-runtime-config.cjs').loadWebcliRuntimeConfig()),
    'import.meta.url': '__importMetaUrl',
    'import.meta.dirname': '__dirname',
  },
  banner: {
    js: 'const __importMetaUrl = require("url").pathToFileURL(__filename).href;',
  },
})

console.log('Bridge bundle created: build/bridge-dist/bridge.cjs')
require('./host-keychain-deps.cjs').copyHostKeychainDeps(path.resolve(__dirname, '../build/bridge-dist'))

}
main().catch(error => { console.error(error); process.exitCode = 1; });
