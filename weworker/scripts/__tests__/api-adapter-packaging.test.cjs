const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')

const repoRoot = path.resolve(__dirname, '../../..')
const weworkerRoot = path.join(repoRoot, 'weworker')

test('packaged Extension and WebCLI preserve the certified API Adapter scope', async () => {
  const { loadShippedApiInventory } = await import(pathToFileURL(
    path.join(repoRoot, 'webcli', 'api-adapter-certification.js')
  ))
  const profile = JSON.parse(fs.readFileSync(path.join(weworkerRoot, 'build-profile.json'), 'utf8'))
  const packageJson = JSON.parse(fs.readFileSync(path.join(weworkerRoot, 'package.json'), 'utf8'))
  const inventory = await loadShippedApiInventory({ repoRoot })

  assert.equal(inventory.adapterCount, inventory.adapters.length)
  assert.equal(inventory.toolCount, inventory.adapters.reduce((sum, adapter) => sum + adapter.tools.length, 0))
  assert.equal(inventory.webcliDiscoverableToolCount, inventory.toolCount)
  assert.equal(inventory.errors.length, 0)
  assert.equal(
    inventory.adapters.every((adapter) => profile.adapters.includes(adapter.id)),
    true,
  )

  const extensionResource = packageJson.build.extraResources.find((entry) => entry.to === 'extension')
  assert.ok(extensionResource)
  assert.equal(extensionResource.from, 'build/extension-dist/')

  for (const buildCommand of [packageJson.scripts['build:mac'], packageJson.scripts['build:win']]) {
    assert.ok(buildCommand.startsWith('node scripts/prepare-build.cjs &&'))
    assert.ok(buildCommand.includes('npm run build:webcli'))
  }

  const prepareBuild = fs.readFileSync(path.join(weworkerRoot, 'scripts', 'prepare-build.cjs'), 'utf8')
  assert.match(prepareBuild, /const requestedIds = profile\.adapters/)
  assert.match(prepareBuild, /copyTreeSync\(srcDir, destDir\)/)
  assert.match(prepareBuild, /ADAPTERS_DIST_DIR, 'index\.json'/)
  assert.match(prepareBuild, /copyTreeSync\(EXTENSION_SRC_DIR, EXTENSION_DIST_DIR\)/)
  assert.match(prepareBuild, /copyTreeSync\(ADAPTERS_DIST_DIR, extensionAdaptersDir\)/)
})
