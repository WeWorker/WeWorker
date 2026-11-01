import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { readAdapterPackage } from './adapterhub-package-v2.js';
import { managedAdapterViews } from './adapter-views.js';
import { installAdapter, registerDevelopmentAdapter, removeInstalledAdapter, selectAdapter } from './adapter-install-store.js';
import { ejectAdapter } from './adapter-export.js';
import { installGitPackage } from './adapter-git-source.js';

/** Shared local package operations. Legacy inputs remain explicit migration paths. */
export function runManagedAdapterCommand(args, options = {}) {
  const [command, ...rest] = args;
  if (command === 'install' && rest.includes('--git')) {
    const values = {}, flags = new Set(['--allow-downgrade', '--allow-permission-change', '--change-source', '--inactive', '--json']);
    const keys = { '--git': 'repository', '--ref': 'ref', '--package': 'subpath', '--digest': 'digest' };
    for (let i = 0; i < rest.length; i++) {
      const key = keys[rest[i]];
      if (key && values[key] === undefined && rest[i + 1] && !rest[i + 1].startsWith('-')) values[key] = rest[++i];
      else if (!flags.has(rest[i])) throw new Error('Invalid Git installation option.');
    }
    if (Object.keys(values).length !== 4) throw new Error('Git installation requires --git, --ref, --package and --digest.');
    return installGitPackage({ ...values, allowDowngrade: rest.includes('--allow-downgrade'), allowPermissionChange: rest.includes('--allow-permission-change'),
      allowSourceChange: rest.includes('--change-source'), activate: !rest.includes('--inactive') }, options);
  }
  if (command === 'eject') {
    const values = rest.filter(value => value !== '--json');
    if (values.length !== 3 || values[1] !== '--directory' || values[0].startsWith('-') || values[2].startsWith('-')) {
      throw new Error('Usage: webcli adapter eject <name> --directory <new-directory-named-after-adapter>');
    }
    return ejectAdapter(values[0], values[2], options);
  }
  const fileIndex = rest.indexOf('--file');
  const archiveInput = fileIndex !== -1 && /\.adapt$/i.test(rest[fileIndex + 1] || '');
  if (command === 'install' && (rest.includes('--directory') || archiveInput)) {
    const flags = new Set(['--allow-downgrade', '--allow-permission-change', '--change-source', '--inactive', '--json']);
    let directory, archive;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--directory' && directory === undefined) {
        directory = rest[++i];
        if (!directory || directory.startsWith('--')) throw new Error('--directory requires a package directory.');
      } else if (rest[i] === '--file' && archiveInput && archive === undefined) {
        archive = rest[++i];
      } else if (!flags.has(rest[i])) throw new Error('Unsupported local package option: ' + rest[i]);
    }
    if (directory && archive) throw new Error('Choose either --directory or --file, not both.');
    const source = archive ? { files: readAdapterPackage(readFileSync(resolve(archive))).files } : { directory: resolve(directory) };
    const result = installAdapter({ ...source, origin: { kind: 'local' },
      allowDowngrade: rest.includes('--allow-downgrade'), allowPermissionChange: rest.includes('--allow-permission-change'),
      allowSourceChange: rest.includes('--change-source'), activate: !rest.includes('--inactive'),
    }, options);
    return { name: result.name, version: result.version, digest: result.digest, active: result.active };
  }
  if (command === 'develop') {
    if (rest.length !== 1 || rest[0].startsWith('-')) throw new Error('Usage: webcli adapter develop <directory>');
    const catalog = registerDevelopmentAdapter(rest[0], options);
    return { action: 'development-selected', revision: catalog.revision };
  }
  if (command === 'use') {
    if (rest.length !== 2) throw new Error('Usage: webcli adapter use <name> <builtin|user|development|disabled>');
    const catalog = selectAdapter(rest[0], rest[1], options);
    return { name: rest[0], source: rest[1], revision: catalog.revision };
  }
  if (['remove', 'uninstall'].includes(command)) {
    const name = rest.find((arg) => !arg.startsWith('--'));
    if (name && managedAdapterViews(options).managedNames.has(name)) {
      if (rest.some((arg) => arg !== name && arg !== '--json' && arg !== '--reload')) throw new Error('Unsupported remove option.');
      // Includes disabled/damaged packages; the store refuses built-in/development deletion.
      return removeInstalledAdapter(name, options);
    }
  }
  return null;
}
