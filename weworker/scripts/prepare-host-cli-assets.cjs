'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Desktop builds only verify already restored, locked offline dependencies.
// Dependency acquisition is a separate private build step; never run npm here.
function prepareHostCliAssets(root) {
  if (!fs.existsSync(root)) return [];
  const prepared = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('Host resource links are not allowed.');
    if (!item.isDirectory()) continue;
    const directory = path.join(root, item.name);
    if (!fs.existsSync(path.join(directory, 'package.json'))) continue;
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const lockBytes = fs.readFileSync(path.join(directory, 'package-lock.json'));
    const lock = JSON.parse(lockBytes);
    const dependencies = pkg.dependencies || {};
    if (JSON.stringify(dependencies) !== JSON.stringify(lock.packages?.['']?.dependencies || {})
        || Object.values(dependencies).some(version => !/^\d+\.\d+\.\d+$/.test(version))) {
      throw new Error('Host dependencies must use exact versions and a matching lockfile.');
    }
    const pin = JSON.parse(fs.readFileSync(path.join(directory, 'offline-dependencies.json'), 'utf8'));
    if (pin.schemaVersion !== 1 || pin.lockSha256 !== hash(lockBytes)) throw new Error('Offline dependency lock mismatch.');
    const modules = path.join(directory, 'node_modules');
    if (!fs.existsSync(modules) || fs.lstatSync(modules).isSymbolicLink()) throw new Error('Restore the pinned offline host dependencies before building.');
    const files = [];
    const visit = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (!prefix && entry.name === '.host-cli-receipt.json') continue;
        if (entry.isSymbolicLink()) throw new Error('Offline dependency links are not allowed.');
        const name = prefix + entry.name;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(file, name + '/');
        else if (entry.isFile()) files.push({ name, sha256: hash(fs.readFileSync(file)) });
        else throw new Error('Unsupported offline dependency file.');
      }
    };
    visit(modules);
    if (files.length !== pin.fileCount || hash(JSON.stringify(files)) !== pin.treeSha256) throw new Error('Offline dependency content mismatch.');
    prepared.push(item.name);
  }
  return prepared;
}
module.exports = { prepareHostCliAssets };
