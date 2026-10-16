import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const inputBarSource = fs.readFileSync(path.resolve(testDir, '../components/chat/InputBar.jsx'), 'utf8')
const sitesStoreSource = fs.readFileSync(path.resolve(testDir, '../store/sites.js'), 'utf8')

test('known router bang commands are sent to chat before the shell fallback', () => {
  assert.match(inputBarSource, /tool\?\.name === token/)

  const routerBranch = inputBarSource.indexOf('if (isKnownRouterToolName(command))')
  const shellFallback = inputBarSource.indexOf('onShellCommand?.(command, trimmed)')
  assert.ok(routerBranch >= 0)
  assert.ok(shellFallback > routerBranch)
})

test('router bang aliases come from the backend config, not a hand-maintained list', () => {
  // 别名生效口径必须与后端同源（`/router/aliases` ← router-config/aliases.json + 用户覆盖层）：
  // 若退回「只读随包静态清单」，改配置后输入框不跟着变，两边会漂移。
  assert.match(inputBarSource, /state\.routerAliases/)
  assert.match(inputBarSource, /BUNDLED_ROUTER_BANG_ALIASES/)
  assert.match(sitesStoreSource, /fetchRouterAliases\(\)/)
  // 后端不可用时必须回退，不能让 `!` 命令整体失灵（catch 后取空数组 → 走随包清单）。
  assert.match(sitesStoreSource, /fetchRouterAliases\(\)\.catch\(\(\) => \[\]\)/)
})

test('configured aliases are listed in the bang menu alongside sites and tools', () => {
  assert.match(inputBarSource, /bang:alias:/)
  assert.match(inputBarSource, /if \(item\?\.kind === 'alias'\) return 'route'/)
})
