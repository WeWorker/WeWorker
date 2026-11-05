const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {copyHostKeychainDeps}=require('../host-keychain-deps.cjs');
test('desktop includes only the target Mac Keychain native package next to each CLI bundle',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'keychain-package-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const arch of ['x64','arm64']){
    const source=path.join(root,'source-'+arch),out=path.join(root,'out-'+arch);
    for(const name of ['@napi-rs/keyring','@napi-rs/keyring-darwin-'+arch]){fs.mkdirSync(path.join(source,name),{recursive:true});fs.writeFileSync(path.join(source,name,'package.json'),'{}');}
    assert.equal(copyHostKeychainDeps(out,{platform:'darwin',arch,source}).length,2);
    assert.ok(fs.existsSync(path.join(out,'node_modules/@napi-rs/keyring-darwin-'+arch+'/package.json')));
  }
  assert.deepEqual(copyHostKeychainDeps(root,{platform:'win32'}),[]);
  assert.throws(()=>copyHostKeychainDeps(root,{platform:'darwin',arch:'arm64',source:path.join(root,'missing')}),/Install/);
});
