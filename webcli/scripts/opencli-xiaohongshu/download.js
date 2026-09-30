import { helper, trustedUrl } from './runtime.js';
import { ArgumentError, CommandExecutionError } from './errors.js';
// Cookies stay in the browser; do not forward account cookies to media CDNs.
export function formatCookieHeader() { return ''; }
export async function downloadMedia(media, { output, subdir, filenamePrefix }) {
  if (!/^[a-f0-9]+$/i.test(subdir) || !/^[a-f0-9]+$/i.test(filenamePrefix)) throw new ArgumentError('Missing resolved note id');
  if (typeof output !== 'string' || !output.trim()) throw new ArgumentError('Output directory required');
  const rows = [];
  for (const [index, item] of media.entries()) {
    const url = trustedUrl(item.url, true);
    if (!['image', 'video'].includes(item.type)) throw new CommandExecutionError('Unknown media type');
    const response = await helper('backend_fetch', { url: url.href, suppressBodyTrace: true, options: { redirect: 'manual', responseEncoding: 'base64', maxResponseBytes: 50 * 1024 * 1024 } });
    if (!response?.ok || response.status >= 300 || response.bodyEncoding !== 'base64') throw new CommandExecutionError('Media download failed or redirected');
    const mime = String(response.headers?.['content-type'] || '').split(';')[0].toLowerCase();
    const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' };
    if (!extensions[mime] || !mime.startsWith(item.type + '/')) throw new CommandExecutionError('Unexpected media content type');
    const path = `${output.replace(/[\\/]$/, '')}/${subdir}/${filenamePrefix}_${String(index + 1).padStart(3, '0')}.${extensions[mime]}`;
    const saved = await helper('backend_file_write', { path, encoding: 'base64', content: response.body });
    rows.push({ index: index + 1, type: item.type, status: 'saved', size: response.size, path: saved.path || path });
  }
  return rows;
}
