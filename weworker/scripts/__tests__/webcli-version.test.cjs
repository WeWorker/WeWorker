const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const esbuild = require('esbuild')

test('bundled CLI reports the source CLI version from another cwd', () => {
  const repo = path.resolve(__dirname, '../../..')
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'webcli/package.json'))).version
  const script = fs.readFileSync(path.join(__dirname, '../bundle-webcli.cjs'), 'utf8')
  let options
  const captured = new Error('build configuration captured')
  assert.throws(() => vm.runInNewContext(script, {
    __dirname: path.join(repo, 'weworker/scripts'), process, console,
    require(name) {
      if (name === 'esbuild') return { buildSync(value) { options = value; throw captured } }
      if (name === 'fs') return { ...fs, existsSync: () => false }
      if (name === 'node:child_process') return { execFileSync() {} }
      return require(name)
    },
  }), error => error === captured)
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-version-'))
  esbuild.buildSync({ ...options, outfile: path.join(output, 'webcli.cjs') })
  for (const args of [[path.join(repo, 'webcli/index.js'), '--version'], [path.join(output, 'webcli.cjs'), '--version']]) {
    const result = spawnSync(process.execPath, args, { cwd: os.tmpdir(), encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), `webcli ${version}`)
  }
})
