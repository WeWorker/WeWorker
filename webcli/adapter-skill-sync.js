import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertAdapterIdentity } from './adapter-catalog.js';
import { assertManagedDirectory, assertManagedFile } from './adapter-package-files.js';
import { renameManagedFile } from './adapter-state.js';
import { managedAdapterSkill, managedAdapterViews } from './adapter-views.js';

const marker = '\n<!-- weworker-adapter-skill:';
const hash = (text) => createHash('sha256').update(text).digest('hex');

function readOwned(content) {
  const at = content.lastIndexOf(marker);
  if (at < 0 || !content.endsWith(' -->\n')) return null;
  try {
    const record = JSON.parse(content.slice(at + marker.length, -5));
    return record.schemaVersion === 1 && record.contentDigest === hash(content.slice(0, at)) ? record : null;
  } catch { return null; }
}

/** Historical model context must match both its file and the current package. */
export function createManagedAdapterSkillValidator(options = {}) {
  let snapshot;
  return (content, directoryName = '') => {
    const marked = content.includes(marker);
    const reservedName = directoryName.startsWith('webcli-') ? directoryName.slice(7) : null;
    if (!marked && !reservedName) return true;
    try {
      snapshot ||= managedAdapterViews(options);
      if (!marked) return !snapshot.managedNames.has(reservedName);
      const record = readOwned(content);
      if (!record || record.status !== 'active' || (reservedName && record.name !== reservedName)) return false;
      const adapter = snapshot.adapters.find((entry) => entry.id === record.name);
      return !!adapter && adapter.profile === record.profile && adapter.digest === record.packageDigest;
    } catch { return false; }
  };
}
export const isManagedAdapterSkillCurrent = (content, directoryName) => createManagedAdapterSkillValidator()(content, directoryName);

function writeOwned(target, body, record, { overwrite = false } = {}) {
  const root = join(target, 'webcli-' + assertAdapterIdentity(record.name));
  assertManagedDirectory(root);
  mkdirSync(root, { recursive: true });
  const disabled = assertManagedFile(root, 'SKILL.md.disabled');
  const file = assertManagedFile(root, 'SKILL.md');
  if (overwrite && existsSync(disabled)) rmSync(disabled, { force: true });
  const selected = overwrite ? file : (existsSync(disabled) ? disabled : file);
  const content = body + marker + JSON.stringify({ ...record, schemaVersion: 1, contentDigest: hash(body) }) + ' -->\n';
  if (existsSync(selected)) {
    const existing = readFileSync(selected, 'utf8');
    const previous = readOwned(existing);
    if (!overwrite && (!previous || previous.name !== record.name || previous.profile !== record.profile)) return false;
    // Hosts refresh before every chat turn; an identical file needs no write or fsync.
    if (existing === content) return true;
  }
  const temporary = assertManagedFile(root, 'SKILL.' + randomUUID() + '.tmp');
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  renameManagedFile(temporary, selected);
  return true;
}

function syncAdapterIcon(target, adapter) {
  const match = /^data:(image\/(?:svg\+xml|png));base64,([A-Za-z0-9+/=]+)$/.exec(adapter.iconUrl || '')
  if (!match) return false
  const extension = match[1] === 'image/png' ? 'png' : 'svg'
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > 512 * 1024) return false
  const root = join(target, 'webcli-' + assertAdapterIdentity(adapter.id))
  assertManagedDirectory(root)
  mkdirSync(root, { recursive: true })
  const destination = assertManagedFile(root, 'icon.' + extension)
  if (existsSync(destination) && readFileSync(destination).equals(bytes)) return true
  const temporary = assertManagedFile(root, 'icon.' + extension + '.' + randomUUID() + '.tmp')
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  renameManagedFile(temporary, destination)
  return true
}

/**
 * Synchronize exact catalog-managed Adapter Skill directories. Installation can
 * force replacement to migrate legacy pre-marker Skills; per-turn refreshes
 * retain the conservative ownership check unless explicitly requested.
 */
export function syncManagedAdapterSkills({ target, snapshot, profile, adapterId = null, overwrite = false }) {
  assertManagedDirectory(target);
  mkdirSync(target, { recursive: true });
  const active = new Map(snapshot.adapters.map((adapter) => [adapter.id, adapter]));
  const managedNames = snapshot.managedNames instanceof Set
    ? snapshot.managedNames
    : new Set(snapshot.managedNames || active.keys());
  let installed = 0, retired = 0;
  const preserved = [];
  for (const adapter of snapshot.adapters) {
    if (adapterId && adapter.id !== adapterId) continue;
    syncAdapterIcon(target, adapter)
    if (writeOwned(target, managedAdapterSkill(adapter), {
      name: adapter.id, profile, packageDigest: adapter.digest, version: adapter.version, status: 'active',
    }, { overwrite })) installed++;
    else preserved.push(adapter.id);
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('webcli-')) continue;
    const name = entry.name.slice(7);
    if ((adapterId && name !== adapterId) || active.has(name) || !managedNames.has(name)) continue;
    const disabled = assertManagedFile(target, entry.name + '/SKILL.md.disabled');
    const file = assertManagedFile(target, entry.name + '/SKILL.md');
    if (!overwrite && !existsSync(disabled) && !existsSync(file)) continue;
    if (!overwrite) {
      const selected = existsSync(disabled) ? disabled : file;
      const previous = readOwned(readFileSync(selected, 'utf8'));
      if (!previous || previous.name !== name || previous.profile !== profile || previous.status === 'unavailable') continue;
    }
    const body = '---\nname: ' + JSON.stringify('webcli-' + name) + '\ndescription: "Adapter unavailable; reload current catalog"\n---\n\n'
      + 'This Adapter is disabled, removed, or unavailable. Do not call tools from earlier versions of this Skill.\n';
    if (writeOwned(target, body, { name, profile, status: 'unavailable' }, { overwrite })) retired++;
  }
  return { installed, retired, preserved };
}
