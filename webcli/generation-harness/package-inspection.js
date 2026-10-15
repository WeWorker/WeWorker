import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { readPackageDirectory, assertManagedFile } from '../adapter-package-files.js';
import { buildV2Bootstrap, v2InjectionFiles } from '../adapter-extension-loader.js';
import { generationEvidenceDir } from './package-draft.js';

export function isPackageDraft(adapterDir) {
  return JSON.parse(fs.readFileSync(assertManagedFile(adapterDir, 'manifest.json'), 'utf8')).schema_version === 2;
}

export function readGenerationEvidence(adapterDir, name = 'source.json', { optional = false } = {}) {
  if (!['source.json', 'write-verification.json', 'validation.json'].includes(name)) throw new Error('Unknown generation evidence file.');
  const file = assertManagedFile(path.dirname(adapterDir), `.generation/${path.basename(adapterDir)}/${name}`);
  if (optional && !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function packageDraftBundle(adapterDir) {
  const pkg = readPackageDirectory(adapterDir);
  if (pkg.commands.some(command => command.runtime !== 'extension')) throw new Error('Generated drafts must use the Extension runtime.');
  const order = v2InjectionFiles(pkg.manifest, [...pkg.files.keys()]);
  return { pkg, manifest: pkg.manifest, scripts: [
    { path: 'bootstrap.js', source: buildV2Bootstrap(pkg.manifest) },
    ...[...order.internal, ...order.commands].map(file => ({ path: file, source: pkg.files.get(file).toString('utf8') })),
  ] };
}

/** Only registration runs here. Handler execution belongs to the mock or browser validator. */
export function inspectPackageRegistration(adapterDir) {
  const bundle = packageDraftBundle(adapterDir);
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  vm.runInContext('var window = globalThis; window.__registrations = []; window.__webmcpRegister = function(adapter) { window.__registrations.push(...adapter.tools.map(tool => tool.name)); };', context, { timeout: 1000 });
  for (const script of bundle.scripts) new vm.Script(script.source).runInContext(context, { timeout: 1000 });
  const names = JSON.parse(vm.runInContext('JSON.stringify(window.__registrations)', context, { timeout: 1000 }));
  return { ...bundle, names };
}

export function resolveDraftToolName(manifest, name) {
  const prefix = manifest.name + '.';
  if (!name.startsWith(prefix)) return name;
  const local = name.slice(prefix.length);
  const command = manifest.commands.find(command => command.id === local || command.aliases?.includes(local));
  return command ? prefix + command.id : name;
}

export { generationEvidenceDir };
