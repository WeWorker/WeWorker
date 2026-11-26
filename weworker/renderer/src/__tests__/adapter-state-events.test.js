import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(testDir, '..')
const backendRoot = path.resolve(testDir, '../../../backend-ts')
const appSource = fs.readFileSync(path.join(sourceRoot, 'App.jsx'), 'utf8')
const serverSource = fs.readFileSync(path.join(backendRoot, 'src/server.ts'), 'utf8')

test('renderer refreshes Adapter capabilities from backend state events', () => {
  assert.match(appSource, /import \{ useSitesStore \} from '\.\/store\/sites\.js'/)
  assert.match(appSource, /parsed\.type === 'adapter_state_changed'/)
  assert.match(appSource, /parsed\.sites\.forEach\(sites\.addInstalledSite\)/)
  assert.match(appSource, /else sites\.refreshSites\(\)/)
})

test('backend delegates state refresh to the retrying serialized handler', () => {
  assert.match(serverSource, /createAdapterStateRefreshHandler/)
  assert.doesNotMatch(serverSource, /refreshSkills: \(\) =>/)
  assert.match(serverSource, /\(\) => refreshDesktopAdapterSkillsIfStale\(SKILLS_DIR\)/)
  assert.match(serverSource, /broadcastSSE\(\{ \.\.\.event, sites: describeSites\(new Set\(event\.adapters\)\) \}\)/)
  assert.match(serverSource, /bridgeStatus\.onAdapterStateChanged\(handleAdapterStateRefresh\)/)
})
