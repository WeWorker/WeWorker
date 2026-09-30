import { commands } from './registry.js';
import { files } from './files.js';
import { CliError, ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError } from './errors.js';

const WEB = 'www.xiaohongshu.com';
const CREATOR = 'creator.xiaohongshu.com';
export const runtime = () => window.__webmcpWecliRuntime;
export const helper = (action, payload) => runtime().requestPrivileged(action, payload);
export function trustedUrl(raw, media = false) {
  let url;
  try { url = new URL(raw); } catch { throw new ArgumentError('Expected an absolute URL'); }
  const allowed = media ? url.hostname === 'xhscdn.com' || url.hostname.endsWith('.xhscdn.com') : [WEB, CREATOR, 'xiaohongshu.com'].includes(url.hostname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed) throw new ArgumentError('URL outside Xiaohongshu allowed hosts');
  return url;
}
class Navigation extends CommandExecutionError {
  constructor(url, write) {
    super('Page navigation required');
    this.result = { __webcli_navigation: { version: 1, url, resume: !write,
      ...(write ? { result: { status: 'ready_to_retry', executed: false, message: '目标页面已打开，尚未执行业务操作。请用相同参数重新调用；写操作不自动重放。' } } : {}) } };
  }
}
export class Page {
  constructor(command, args) { this.command = command; this.args = args; this.started = Date.now(); this.deadline = this.started + Math.min(args.timeout || 95, 95) * 1000; this.firstGoto = true; this.pending = null; this.capture = false; }
  check() { if (this.pending) throw this.pending; if (Date.now() >= this.deadline) throw new TimeoutError(this.command.name, 95, 'Do not blindly retry writes; inspect the site first.'); }
  async evaluate(source) {
    this.check();
    const code = typeof source === 'function' ? source.toString() : String(source);
    const result = await helper('main_world_eval', { expression: `(async () => { try { const candidate = (${code}); const value = typeof candidate === 'function' ? await candidate() : await candidate; return { ok: true, value }; } catch (e) { return { ok: false, message: e?.message || String(e) }; } })()` });
    this.check();
    if (!result?.value?.ok) throw new CommandExecutionError(result?.value?.message || 'Page evaluation returned no result');
    return result.value.value;
  }
  async goto(raw, options = {}) {
    this.check();
    const target = trustedUrl(raw), current = new URL(location.href);
    if (current.origin === target.origin && /\/(?:login|website-login)(?:\/|$)/.test(current.pathname)) {
      if (/error_code=3000(?:17|31)/.test(current.search)) throw new CliError('SECURITY_BLOCK', 'Xiaohongshu redirected to its security restriction page');
      throw new AuthRequiredError(current.hostname);
    }
    // Use the site's React router after the initial creator navigation, as the
    // upstream capture code does. Never replay an already-started write.
    const first = this.firstGoto; this.firstGoto = false;
    if (options.reload) {
      if (this.command.access === 'write') throw new CommandExecutionError('Writes cannot request a replay');
      const key = '__ww_xhs_detail_retry';
      let retry; try { retry = JSON.parse(sessionStorage.getItem(key)); } catch { }
      if (retry?.url === target.href && retry?.command === this.command.name && Date.now() - retry.at < 105000) throw new CliError('SECURITY_BLOCK', 'Xiaohongshu remains restricted after one cooldown/reload');
      sessionStorage.setItem(key, JSON.stringify({ url: target.href, command: this.command.name, at: Date.now() }));
      this.pending = new Navigation(target.href, false); throw this.pending;
    }
    const noteId = url => url.pathname.match(/^\/(?:explore|search_result|note|discovery\/item)\/([a-f0-9]+)\/?$/i)?.[1];
    // The site canonicalizes signed search-result links to /explore/<id> and
    // may change tracking parameters. The validated note identity stays fixed.
    const sameNote = ['note', 'comments', 'download'].includes(this.command.name) && noteId(target) && noteId(current) === noteId(target);
    const equal = current.origin === target.origin && (sameNote || current.pathname === target.pathname && [...target.searchParams].every(([k, v]) => current.searchParams.get(k) === v));
    if (equal) { sessionStorage.removeItem('__ww_xhs_navigation'); return; }
    if (!first && this.command.access !== 'write' && current.hostname === CREATOR && target.hostname === CREATOR) {
      await this.evaluate(`() => { history.pushState({}, '', ${JSON.stringify(target.href)}); window.dispatchEvent(new PopStateEvent('popstate')); }`);
      await this.wait(1); return;
    }
    let previous; try { previous = JSON.parse(sessionStorage.getItem('__ww_xhs_navigation')); } catch { }
    if (previous?.command === this.command.name && previous?.url === target.href && Date.now() - previous.at < 105000) {
      throw new CliError('PAGE_REDIRECT', `The site redirected the requested page to ${current.origin}${current.pathname}. Check login and the current page before retrying.`);
    }
    sessionStorage.setItem('__ww_xhs_navigation', JSON.stringify({ command: this.command.name, url: target.href, at: Date.now() }));
    if (this.capture) {
      const marker = JSON.parse(sessionStorage.getItem('__ww_xhs_capture_pattern') || 'null');
      if (marker) { marker.target = target.href; sessionStorage.setItem('__ww_xhs_capture_pattern', JSON.stringify(marker)); }
    }
    this.pending = new Navigation(target.href, this.command.access === 'write');
    throw this.pending;
  }
  async wait(arg) {
    this.check(); const seconds = typeof arg === 'number' ? arg : arg?.time ?? 0;
    if (!Number.isFinite(seconds) || seconds < 0 || Date.now() + seconds * 1000 >= this.deadline) throw new TimeoutError(this.command.name, 95);
    await new Promise(resolve => setTimeout(resolve, seconds * 1000)); this.check();
  }
  async autoScroll({ times = 1, delayMs = 1000 } = {}) {
    for (let i = 0; i < Math.min(times, 10); i++) { await this.evaluate('() => window.scrollTo(0, document.body.scrollHeight)'); await this.wait(delayMs / 1000); }
  }
  async installInterceptor(pattern) {
    this.check();
    // Keep captures through the host's read-navigation continuation. Starting
    // capture again on the destination would discard its hydration response.
    const key = '__ww_xhs_capture_pattern';
    let marker; try { marker = JSON.parse(sessionStorage.getItem(key)); } catch { }
    const call = JSON.stringify([this.command.name, this.args]);
    const resume = marker?.pattern === pattern && marker?.call === call && marker?.target === location.href && Date.now() - marker.at < 105000;
    const old = resume ? await helper('network_capture_read', { finish: false }).catch(() => null) : null;
    if (!old) await helper('network_capture_start', { pattern });
    sessionStorage.setItem(key, JSON.stringify({ pattern, call, at: Date.now() }));
    this.capture = true;
  }
  async getInterceptedRequests() {
    this.check(); const data = await helper('network_capture_read', { finish: false });
    if (!Array.isArray(data?.entries)) throw new CommandExecutionError('Malformed network capture');
    return data.entries.map(entry => {
      if (entry.responseBodyTruncated) throw new CommandExecutionError('Captured response was truncated');
      if (entry.responseStatus >= 400) throw new CliError('HTTP_ERROR', `Captured API HTTP ${entry.responseStatus}`);
      try { return JSON.parse(entry.responsePreview); } catch { throw new CommandExecutionError('Captured API returned non-JSON'); }
    });
  }
  async getCookies(options) { const r = await helper('cookies_get', options); return Array.isArray(r) ? r : r.cookies || []; }
  async setFileInput(paths, selector) { this.check(); return helper('set_file_input', { selector, files: paths }); }
  async insertText(text) { this.check(); return helper('native_input', { type: 'text', text }); }
  async pressKey(key) { this.check(); return helper('native_input', { type: 'key', key }); }
  // Upstream screenshots are failure diagnostics, never a required step.
  async screenshot() { return { saved: false, reason: 'Use the connected browser to inspect the failed page.' }; }
}
export function normalizeArgs(command, input = {}) {
  const args = { ...input };
  for (const field of command.args || []) {
    let value = args[field.name];
    if (value === undefined) value = field.default;
    if (field.required && (value === undefined || value === null || String(value).trim() === '')) throw new ArgumentError(`${field.name} is required`);
    if (value === undefined) continue;
    if (['bool', 'boolean'].includes(field.type)) {
      if (value === 'true') value = true; else if (value === 'false') value = false;
      if (typeof value !== 'boolean') throw new ArgumentError(`${field.name} must be true or false`);
    } else if (field.type === 'int') {
      if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
      if (!Number.isSafeInteger(value) || value < 1 || value > (field.name === 'timeout' ? 180 : 100)) throw new ArgumentError(`${field.name} must be a positive bounded integer`);
    } else if (typeof value !== 'string') throw new ArgumentError(`${field.name} must be a string`);
    if (field.choices && !field.choices.includes(value)) throw new ArgumentError(`Invalid ${field.name}`);
    args[field.name] = value;
  }
  return args;
}
async function preloadImages(args) {
  files.clear();
  const paths = String(args.images || '').split(',').map(p => p.trim()).filter(Boolean);
  if (paths.length > 9) throw new ArgumentError('At most 9 images');
  let total = 0;
  for (const path of paths) {
    if (!/\.(jpe?g|png|gif|webp)$/i.test(path)) throw new ArgumentError('Unsupported image extension');
    const file = await helper('backend_file_read', { path, encoding: 'base64', maxBytes: 8 * 1024 * 1024 });
    if (typeof file?.content !== 'string' || file.encoding !== 'base64' || !Number.isFinite(file.size)) throw new CommandExecutionError('Invalid image file response');
    total += file.size; if (total > 32 * 1024 * 1024) throw new ArgumentError('Images exceed 32 MiB total');
    files.set(path, file); files.set(file.path, file);
  }
}
async function resolveDownloadLink(args) {
  const raw = args['note-id'];
  if (!/^https?:\/\/xhslink\.com\//i.test(raw)) return;
  let url = new URL(raw);
  for (let i = 0; i < 4; i++) {
    if (url.username || url.password || url.port || !['http:', 'https:'].includes(url.protocol) || url.hostname !== 'xhslink.com') throw new ArgumentError('Invalid short link');
    // Short links carry no account cookies. Follow only explicit trusted redirects.
    const r = await helper('backend_fetch', { url: url.href, suppressBodyTrace: true, options: { method: 'HEAD', redirect: 'manual' } });
    const next = r?.headers?.location;
    if (r?.status < 300 || r?.status >= 400 || !next) throw new CommandExecutionError('Short link did not return a resolvable redirect');
    url = new URL(next, url);
    if (url.hostname !== 'xhslink.com') { trustedUrl(url.href); args['note-id'] = url.href; return; }
  }
  throw new CommandExecutionError('Short link redirect limit exceeded');
}
async function notifications(page, args) {
  if (!['mentions', 'likes', 'connections'].includes(args.type)) throw new ArgumentError('Unknown notification type');
  await page.goto(`https://${WEB}/notification`);
  await page.installInterceptor('/you/');
  const called = await page.evaluate(`async () => {
    const app = document.querySelector('#app');
    const globals = app?.__vue_app__?.config?.globalProperties;
    const store = globals?.$pinia?._s?.get('notification');
    if (typeof store?.getNotification === 'function') { await store.getNotification(${JSON.stringify(args.type)}); return true; }
    const vuex = globals?.$store || app?.__vue__?.$store;
    if (vuex) { await vuex.dispatch('notification/getNotification', ${JSON.stringify(args.type)}); return true; }
    return false;
  }`);
  if (!called) throw new CommandExecutionError('Notification store/action not found');
  let capturedCount = 0;
  let capturedKeys = [];
  for (let i = 0; i < 8; i++) {
    const captures = await page.getInterceptedRequests();
    capturedCount = captures.length;
    capturedKeys = captures.map(x => Object.keys(x?.data || {}));
    const result = captures.find(x => Array.isArray(x?.data?.message_list));
    if (result) return result.data.message_list.slice(0, args.limit).map((item, index) => ({ rank: index + 1, user: item.user_info?.nickname ?? '', action: item.title ?? '', content: item.comment_info?.content ?? '', note: item.item_info?.content ?? '', time: item.time ?? null }));
    await page.wait(1);
  }
  throw new CommandExecutionError(`No notification message_list captured (${capturedCount} responses; data fields: ${JSON.stringify(capturedKeys)})`);
}
export async function invoke(name, input) {
  const command = commands.get(name);
  if (!command) throw new ArgumentError('Unknown Xiaohongshu command');
  const args = normalizeArgs(command, input);
  if (command.access === 'write' && args.__confirmed !== true) throw new CliError('CONFIRMATION_REQUIRED', 'This command requires confirmation');
  const page = new Page(command, args);
  try {
    if (name === 'download') await resolveDownloadLink(args);
    if (name === 'publish') await preloadImages(args);
    const result = name === 'notifications' ? await notifications(page, args) : await command.func(page, args);
    if (page.pending) return page.pending.result;
    return result;
  } catch (error) {
    if (page.pending) return page.pending.result;
    throw error;
  } finally {
    files.clear();
    if (!page.pending) sessionStorage.removeItem('__ww_xhs_detail_retry');
    if (!page.pending && page.capture) { await helper('network_capture_read', { finish: true }).catch(() => {}); sessionStorage.removeItem('__ww_xhs_capture_pattern'); }
  }
}
export { commands };
