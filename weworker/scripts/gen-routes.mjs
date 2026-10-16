#!/usr/bin/env node
/**
 * `gen:routes` 薄启动器：把编译 adapter manifest 场景路由的 TS 实现打成一次性 ESM 再执行。
 *
 * 存在的理由：CLI 与运行时的加载器**必须共用同一份编译器**，否则「脚本写出来的产物」和
 * 「运行时会认的产物」会各自漂移。真正的逻辑在
 * `backend-ts/src/api-query-router/scenario-route-cli.ts`，本文件只负责解析打包器、
 * 提供仓库级默认路径、透传退出码。
 *
 * 用法：
 *   node scripts/gen-routes.mjs                 # 写 weworker/router-config/scenario-routes.json
 *   node scripts/gen-routes.mjs --check         # CI 硬门：产物与 manifest 不一致即退出 1
 *   node scripts/gen-routes.mjs --json          # 机器可读输出
 *   npm run gen:routes / npm run gen:routes:check
 *
 * 打包器从 `backend-ts/node_modules` 解析（根 `node_modules` 不含 esbuild）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const WORKER_DIR = path.resolve(SCRIPT_DIR, '..')
const REPO_ROOT = path.resolve(WORKER_DIR, '..')
const BACKEND_TS_DIR = path.join(WORKER_DIR, 'backend-ts')
const CLI_ENTRY = path.join(BACKEND_TS_DIR, 'src', 'api-query-router', 'scenario-route-cli.ts')
// 产物放在 backend-ts/ 内：打包结果里 `@napi-rs/keyring` 保持 external，需要从这里向上
// 找到 backend-ts/node_modules。放在 weworker/ 下会解析不到。
const OUT_DIR = path.join(BACKEND_TS_DIR, 'build', 'gen-routes')
const BUNDLE_PATH = path.join(OUT_DIR, 'gen-routes.mjs')

/** 与 bundle-backend-ts.cjs 同口径：平台原生模块必须外置，否则 esbuild 无需 loader 可打。 */
const KEYRING_PLATFORM_PACKAGES = {
  'darwin-arm64': '@napi-rs/keyring-darwin-arm64',
  'darwin-x64': '@napi-rs/keyring-darwin-x64',
  'linux-x64': '@napi-rs/keyring-linux-x64-gnu',
  'win32-x64': '@napi-rs/keyring-win32-x64-msvc',
  'win32-arm64': '@napi-rs/keyring-win32-arm64-msvc',
}

function nativeExternals() {
  const externals = ['node:*', '@napi-rs/keyring']
  const platformPackage = KEYRING_PLATFORM_PACKAGES[`${process.platform}-${process.arch}`]
  if (platformPackage) externals.push(platformPackage)
  return externals
}

/** 路由配置目录：Profile Overlay 可用环境变量换到内部目录。 */
export const ROUTER_CONFIG_DIR =
  process.env.WEWORKER_ROUTER_CONFIG_DIR || path.join(WORKER_DIR, 'router-config')

function resolveEsbuild() {
  const candidates = [
    createRequire(path.join(BACKEND_TS_DIR, 'package.json')),
    createRequire(path.join(WORKER_DIR, 'package.json')),
    createRequire(import.meta.url),
  ]
  for (const requireFrom of candidates) {
    try {
      return requireFrom('esbuild')
    } catch {
      // 换下一个解析起点：workspace 布局下依赖可能挂在任一层的 node_modules。
    }
  }
  throw new Error(
    `cannot resolve esbuild from ${BACKEND_TS_DIR} or ${WORKER_DIR}; run npm install in weworker/backend-ts first`,
  )
}

async function bundleCli() {
  const esbuild = resolveEsbuild()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await esbuild.build({
    entryPoints: [CLI_ENTRY],
    outfile: BUNDLE_PATH,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // 内建模块与平台原生模块外置；其余依赖全量内联，产物自包含。
    external: nativeExternals(),
    banner: { js: "import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);" },
    logLevel: 'warning',
  })
  return BUNDLE_PATH
}

async function main() {
  if (!fs.existsSync(CLI_ENTRY)) {
    process.stderr.write(`[gen:routes] missing CLI entry: ${CLI_ENTRY}\n`)
    process.exit(2)
  }

  let cli
  try {
    const outfile = await bundleCli()
    cli = await import(pathToFileURL(outfile).href)
  } catch (error) {
    process.stderr.write(`[gen:routes] bundle failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }

  const code = cli.main(process.argv.slice(2), {
    adaptersDir: path.join(REPO_ROOT, 'adapters'),
    outFile: path.join(ROUTER_CONFIG_DIR, 'scenario-routes.json'),
    planTerminalsFile: path.join(ROUTER_CONFIG_DIR, 'plan-terminals.json'),
  })
  process.exit(code)
}

main()
