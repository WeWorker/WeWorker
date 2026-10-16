import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const viewSource = fs.readFileSync(
  path.resolve(testDir, '../components/capabilities/SitesCapabilitiesView.jsx'),
  'utf8'
)

test('routable badge is driven by the backend field, not recomputed in the renderer', () => {
  // 口径唯一来源是后端 `/sites` 的 `routable`（＝当前配置里有没有覆盖该站点的启用条目）。
  // 渲染层若自己再算一遍，会与热重载后的配置漂移，所以这里钉住「只读字段」。
  assert.match(viewSource, /site\.routable/)
  assert.match(viewSource, /site\.routeEntryCount/)
  assert.doesNotMatch(viewSource, /routerAliases/)
})

test('both the list and the grid view carry the routable marker', () => {
  // 徽标文案在列表行（放得下文字），网格缩略图用角标（放不下），两处都要有。
  assert.match(viewSource, /cap-site-row-badge/)
  assert.match(viewSource, /cap-site-mini-badge/)
  assert.match(viewSource, /路由直达/)
})
