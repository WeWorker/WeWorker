'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Only a distribution's checked-in build configuration selects executable code.
// Adapter arguments, runtime environment and user settings cannot select it.
function hostCliProviderPlugins(projectRoot) {
  const configPath = path.join(projectRoot, 'weworker/host-cli-provider.json');
  if (!fs.existsSync(configPath)) return [];
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.schemaVersion !== 1 || typeof config.entry !== 'string'
      || !/^host-cli-assets\/[A-Za-z0-9_./-]+\.(?:js|mjs)$/.test(config.entry)
      || config.entry.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Invalid build-time host CLI provider configuration.');
  }
  const desktopRoot = path.join(projectRoot, 'weworker');
  let current = desktopRoot;
  for (const part of config.entry.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Host CLI provider links are not allowed.');
  }
  if (!fs.statSync(current).isFile()) throw new Error('Host CLI provider must be a file.');
  const contents = fs.readFileSync(current, 'utf8');
  const boundary = path.join(projectRoot, 'webcli/host-cli-provider.js');
  return [{
    name: 'distribution-host-cli-provider',
    setup(build) {
      build.onLoad({ filter: /host-cli-provider\.js$/ }, args => {
        if (path.resolve(args.path) !== boundary) return;
        // The provider implements the public module's contract. Its relative
        // imports resolve at that boundary, without overwriting source files.
        return { contents, loader: 'js', resolveDir: path.join(projectRoot, 'webcli'), watchFiles: [configPath, current] };
      });
    },
  }];
}
module.exports = { hostCliProviderPlugins };
