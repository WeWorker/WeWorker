import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const tab = fs.readFileSync(new URL('../components/settings/FastRoutesTab.jsx', import.meta.url), 'utf8')

test('review requires a valid same-candidate preview token and matching revision before enable', () => {
  assert.match(tab, /typeof result\.previewToken !== 'string' \|\| !result\.previewToken/)
  assert.match(tab, /result\.revision !== candidate\.revision/)
  assert.match(tab, /receipt\.candidateId !== candidate\.id/)
  assert.match(tab, /selectedKeys\.some\(\(key\) => !receipt\.fields\.includes\(key\)\)/)
  assert.match(tab, /approveFastRouteCandidate\(candidate\.id, selectedKeys, receipt\.token, receipt\.revision\)/)
  assert.match(tab, /disabled=\{Boolean\(busy\) \|\| !canEnable\}/)
})

test('checkbox edits invalidate preview and re-test selected fields, never auto approve', () => {
  assert.match(tab, /testFastRouteCandidate\(candidate\.id, chosen\)/)
  assert.match(tab, /setTested\(\(current\) => \(\{ \.\.\.current, \[candidate\.id\]: null \}\)\)/)
  assert.match(tab, /availableFields\[candidate\.id\] && !preview/)
  assert.match(tab, /chosen\.length === 0/)
  assert.match(tab, /useEffect\(\(\) => \{\s*mounted\.current = true\s*void refresh\(\)/)
})

test('local delete uses route revision and refreshes lists', () => {
  assert.match(tab, /deleteLocalFastRoute\(route\.id, route\.revision\)/)
  assert.match(tab, /'本地快捷路由已删除', true/)
})
