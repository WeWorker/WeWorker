const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const root = path.resolve(__dirname, '../..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('desktop builds expose no obsolete Python backend or standalone packaging scripts', () => {
  assert.equal(packageJson.scripts['build:backend'], undefined)
  for (const script of ['build-win.bat', 'build-mac.sh']) {
    assert.equal(fs.existsSync(path.join(root, 'scripts', script)), false, script)
  }
})

// Exercise the real npm command chains with lightweight build-stage stand-ins.
// A stale backend is present initially: packaging must only see a rebuilt one.
function runBuild(t, platform, failBackend) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-build-entry-'))
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }))
  fs.mkdirSync(path.join(fixture, 'scripts'))
  fs.mkdirSync(path.join(fixture, 'renderer'))
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
    name: 'weworker-build-fixture', version: '1.0.0', scripts: packageJson.scripts,
  }))
  fs.writeFileSync(path.join(fixture, 'backend-stamp.txt'), 'stale')
  fs.writeFileSync(path.join(fixture, 'step.cjs'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const assert = require('node:assert/strict');
    module.exports = (step) => {
      fs.appendFileSync(path.join(__dirname, 'steps.txt'), step + '\\n');
      if (step === 'backend-ts') {
        if (process.env.WEWORKER_TEST_FAIL_BACKEND === '1') process.exit(23);
        fs.writeFileSync(path.join(__dirname, 'backend-stamp.txt'), 'fresh');
      }
      if (step === 'package') {
        assert.equal(fs.readFileSync(path.join(__dirname, 'backend-stamp.txt'), 'utf8'), 'fresh');
        fs.writeFileSync(path.join(__dirname, 'packaged.txt'), process.argv[2]);
      }
    };
  `)
  const stages = {
    'prepare-build': 'prepare',
    'build-webwright': 'exploration-runtime',
    'bundle-backend-ts': 'backend-ts',
    'bundle-bridge': 'bridge',
    'bundle-webcli': 'webcli',
    'build-decrypt': 'decrypt',
    'build-electron-current-arch': 'package',
  }
  for (const [file, stage] of Object.entries(stages)) {
    fs.writeFileSync(path.join(fixture, 'scripts', `${file}.cjs`), `require('../step.cjs')('${stage}')`)
  }
  fs.writeFileSync(path.join(fixture, 'renderer', 'package.json'), JSON.stringify({
    name: 'renderer-fixture', version: '1.0.0', scripts: { build: 'node build.cjs' },
  }))
  fs.writeFileSync(path.join(fixture, 'renderer', 'build.cjs'), "require('../step.cjs')('renderer')")
  const windows = process.platform === 'win32'
  const result = spawnSync(windows ? 'cmd.exe' : 'npm',
    windows ? ['/d', '/s', '/c', `npm run build:${platform}`] : ['run', `build:${platform}`], {
      cwd: fixture, encoding: 'utf8', timeout: 60000, windowsHide: true,
      env: { ...process.env, WEWORKER_TEST_FAIL_BACKEND: failBackend ? '1' : '0' },
    })
  assert.ifError(result.error)
  const steps = fs.readFileSync(path.join(fixture, 'steps.txt'), 'utf8').trim().split('\n')
  return { result, steps, fixture }
}

for (const platform of ['win', 'mac']) {
  test(`${platform}: rebuilds stale backend before packaging`, (t) => {
    const { result, steps, fixture } = runBuild(t, platform, false)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.deepEqual(steps, [
      'prepare', 'exploration-runtime', 'renderer', 'backend-ts', 'bridge', 'webcli',
      ...(platform === 'win' ? ['decrypt'] : []), 'package',
    ])
    assert.equal(fs.readFileSync(path.join(fixture, 'packaged.txt'), 'utf8'), `--${platform}`)
  })

  test(`${platform}: backend failure prevents packaging stale output`, (t) => {
    const { result, steps, fixture } = runBuild(t, platform, true)
    assert.notEqual(result.status, 0)
    assert.deepEqual(steps, ['prepare', 'exploration-runtime', 'renderer', 'backend-ts'])
    assert.equal(fs.existsSync(path.join(fixture, 'packaged.txt')), false)
  })
}
