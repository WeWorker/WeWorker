import { ArgumentError } from './errors.js';
export const files = new Map();
export function resolve(p) { return files.get(p)?.path || p; }
export function extname(p) { return /\.[^./\\]+$/.exec(p)?.[0] || ''; }
export function basename(p) { return p.split(/[\\/]/).pop(); }
export function existsSync(p) { return files.has(p); }
export function readFileSync(p) {
  const file = files.get(p);
  if (!file) throw new ArgumentError('Image was not preloaded');
  return { toString(encoding) { if (encoding !== 'base64') throw new ArgumentError('Expected base64'); return file.content; } };
}
