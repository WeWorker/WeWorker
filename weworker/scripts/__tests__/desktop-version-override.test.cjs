const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createElectronBuilderConfig } = require('../build-electron-current-arch.cjs')

const DEPLOYMENT = {
  officialUrl: 'https://example.com',
  downloadUrl: 'https://example.com/downloads/',
  githubUrl: 'https://github.com/example/example',
}

function fixture(t, { versionJson } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-version-override-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'weworker', version: '1.0.0' }))
  fs.writeFileSync(path.join(root, 'deployment.json'), JSON.stringify(DEPLOYMENT))
  if (versionJson !== undefined) fs.writeFileSync(path.join(root, 'version.json'), versionJson)
  return root
}

test('without version.json the packaged version comes from package.json', t => {
  const root = fixture(t)
  const config = JSON.parse(fs.readFileSync(createElectronBuilderConfig({ root, outputPath: path.join(root, 'builder.json') }), 'utf8'))
  assert.equal(config.version, undefined)
  assert.equal(config.extraMetadata, undefined)
})

test('version.json overrides the packaged and displayed version', t => {
  const root = fixture(t, { versionJson: JSON.stringify({ version: '1.0.1' }) })
  const config = JSON.parse(fs.readFileSync(createElectronBuilderConfig({ root, outputPath: path.join(root, 'builder.json') }), 'utf8'))
  assert.equal(config.version, '1.0.1')
  assert.equal(config.extraMetadata.version, '1.0.1')
})

test('invalid version.json fails closed with a clear message', t => {
  for (const content of ['not json', '{"version":"not-semver"}', '["1.0.1"]', '{"version":42}']) {
    const root = fixture(t, { versionJson: content })
    assert.throws(() => createElectronBuilderConfig({ root, outputPath: path.join(root, 'builder.json') }), /version\.json/)
  }
})
