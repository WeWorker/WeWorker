const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {spawnSync} = require('node:child_process')
const launcher = path.join(__dirname, '../webcli-launcher.ps1')
const quote = s => "'" + s.replaceAll("'", "''") + "'"

test('build and package include the native PowerShell launcher', () => {
  const build = fs.readFileSync(path.join(__dirname, '../bundle-webcli.cjs'), 'utf8')
  assert.match(build, /fs\.copyFileSync\(.*webcli-launcher\.ps1.*webcli\.ps1/)
  const pkg = require('../../package.json')
  assert.ok(pkg.build.extraResources.find(r=>r.to==='webcli').filter.includes('webcli.ps1'))
})

for (const shell of ['powershell.exe','pwsh.exe']) {
  const available = process.platform==='win32' && spawnSync(shell,['-NoProfile','-Command','exit 0']).status===0
  test(`${shell}: PATH launcher preserves URL metacharacters and exit status`, {skip:!available}, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'webcli-url-'))
    t.after(() => fs.rmSync(dir, {recursive:true, force:true}))
    fs.copyFileSync(launcher,path.join(dir,'webcli.ps1'))
    fs.writeFileSync(path.join(dir,'webcli.cjs'), 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(7)')
    fs.writeFileSync(path.join(dir,'webcli.cmd'), '@echo CMD_WRAPPER_MUST_NOT_RUN\r\n@exit /b 9\r\n')
    const args = ['call','browser.open','--url=https://example.com/form?flow=A&module=2','--value=a&echo INJECTED','--value=(a)|b>c','--url=https://example.com/?q=%26&name=hello world#part']
    const command = `$env:Path=${quote(dir+';'+path.dirname(process.execPath))}+';'+$env:Path; webcli ${args.map(quote).join(' ')}; exit $LASTEXITCODE`
    const r = spawnSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command],{encoding:'utf8',windowsHide:true})
    assert.equal(r.status,7,r.stderr)
    assert.deepEqual(JSON.parse(r.stdout.trim()),args)
    assert.doesNotMatch(r.stdout,/CMD_WRAPPER/)
  })
}
