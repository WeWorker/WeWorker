import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readPackageDirectory } from '../adapter-package-files.js';
import { compileResultBindings } from '../result-bindings.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const profile = JSON.parse(readFileSync(resolve(repo, 'weworker/build-profile.json'), 'utf8'));
const adapters = [], errors = [];
for (const directory of readdirSync(resolve(repo, 'adapters'), { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  try {
    const pkg = readPackageDirectory(resolve(repo, 'adapters', directory.name));
    if (!profile.adapters.includes(pkg.name)) throw new Error('Package missing from build profile');
    const entries = pkg.commands.map(command => ({ ...command, adapterId: pkg.name, sourceFingerprint: pkg.digest,
      safety: pkg.manifest.commands.find(item => item.id === command.id)?.safety }));
    const bindings = compileResultBindings(entries);
    adapters.push({ name: pkg.name, digest: pkg.digest, commands: entries.map(command => ({
      name: command.name, module: command.module, safety: command.safety,
      status: command.safety === 'write' ? 'write_command' : bindings.get(command.name)?.results.some(rule => rule.actions.length)
        ? 'mapped_query' : command.results !== undefined ? 'declared_no_actions' : 'pending_source_review',
      actions: bindings.get(command.name)?.results.flatMap(rule => rule.actions.map(action => ({ id: action.id, target: action.tool, safety: action.safety }))) || [],
      noActionReasons: bindings.get(command.name)?.results.filter(rule => !rule.actions.length).map(rule => rule.reason || null) || [],
    })) });
  } catch (error) { errors.push({ name: directory.name, error: error.code || error.message }); }
}
const commands = adapters.flatMap(adapter => adapter.commands);
const inventory = {
  scope: 'Current public source packages; external deployment assets require a separate controlled inventory.',
  meaning: {
    mapped_query: 'A declared query-to-action mapping passes package/schema validation; per-command execution evidence is still required.',
    write_command: 'A possible action target or standalone write; being a write does not prove that every query has its needed follow-up.',
    declared_no_actions: 'The author explicitly declared no actions; this alone does not certify that no follow-up is needed.',
    pending_source_review: 'Implementation review remains; do not classify this as terminal, unnecessary, or externally blocked.',
  },
  totals: { adapters: adapters.length, commands: commands.length,
    ...Object.fromEntries(['mapped_query', 'write_command', 'declared_no_actions', 'pending_source_review'].map(status => [status, commands.filter(command => command.status === status).length])) },
  errors, adapters,
};
writeFileSync(resolve(repo, 'docs/context-adapter-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
console.log(JSON.stringify({ ...inventory.totals, errors: errors.length }));
if (!adapters.length || errors.length) process.exitCode = 1;
