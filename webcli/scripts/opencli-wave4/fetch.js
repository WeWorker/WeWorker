import { CommandExecutionError } from './errors.js';
const endpoints = new Map([
  ['www.toutiao.com', new Set(['/hot-event/hot-board/', '/api/pc/feed/'])],
  ['export.arxiv.org', new Set(['/api/query'])],
]);
export async function fetch(raw, options = {}) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !endpoints.get(url.hostname)?.has(url.pathname)) {
    throw new CommandExecutionError('Request is outside the fixed source API endpoints');
  }
  let response;
  try {
    response = await window.__webmcpWecliRuntime.requestPrivileged('backend_fetch', {
      url: url.href, browserFallback: false, redactBodyInTrace: true,
      options: { method: 'GET', redirect: 'manual', maxResponseBytes: 4 * 1024 * 1024,
        headers: { Accept: 'application/json, application/atom+xml', ...options.headers } },
    });
  } catch { throw new CommandExecutionError('Source request failed; retain the trace for diagnosis'); }
  if (response?.redirected || response?.status >= 300 && response?.status < 400 || response?.url && response.url !== url.href) {
    throw new CommandExecutionError('Unexpected API redirect');
  }
  if (typeof response?.body !== 'string' || response.body.length > 4 * 1024 * 1024) throw new CommandExecutionError('Missing or oversized response body');
  return { ok: response.ok, status: response.status, text: async () => response.body, json: async () => JSON.parse(response.body) };
}
