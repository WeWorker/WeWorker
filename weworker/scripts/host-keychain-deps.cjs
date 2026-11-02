'use strict';
const fs = require('node:fs');
const path = require('node:path');
function copyHostKeychainDeps(outDir, { platform = process.platform, arch = process.arch, source = path.resolve(__dirname, '../../webcli/node_modules') } = {}) {
  if (platform !== 'darwin') return [];
  if (!['x64','arm64'].includes(arch)) throw new Error('Unsupported Keychain architecture.');
  const packages = ['@napi-rs/keyring', `@napi-rs/keyring-darwin-${arch}`];
  for (const name of packages) {
    const src = path.join(source,name);
    if (!fs.existsSync(path.join(src,'package.json'))) throw new Error('Install host Keychain dependencies before bundling.');
    fs.cpSync(src,path.join(outDir,'node_modules',name),{recursive:true,dereference:false});
  }
  return packages;
}
module.exports = { copyHostKeychainDeps };
