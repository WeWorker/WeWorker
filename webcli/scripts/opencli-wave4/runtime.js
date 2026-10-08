import { commands } from './registry.js';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from './errors.js';
export { commands };
const domains = { toutiao: ['www.toutiao.com', 'mp.toutiao.com'], smzdm: ['search.smzdm.com'] };
const helper = (action, payload) => window.__webmcpWecliRuntime.requestPrivileged(action, payload);
class Page {
  constructor(command) { this.command = command; this.pending = null; }
  async goto(raw) {
    const target = new URL(raw), current = new URL(location.href);
    if (target.protocol !== 'https:' || target.username || target.password || target.port || !domains[this.command.site]?.includes(target.hostname)) throw new ArgumentError('Untrusted navigation target');
    if (current.hostname === target.hostname && /\/auth\/page\/login|\/passport\//.test(current.pathname)) throw new AuthRequiredError(target.hostname);
    const markerKey = '__ww_wave4_navigation';
    if (current.origin === target.origin && current.pathname === target.pathname && [...target.searchParams].every(([k,v]) => current.searchParams.get(k) === v)) {
      sessionStorage.removeItem(markerKey); return;
    }
    // Headline creator root can canonicalize to a dashboard route.
    if (this.command.name === 'whoami' && current.hostname === 'mp.toutiao.com' && current.pathname.startsWith('/profile_v4/')) return;
    let previous; try { previous = JSON.parse(sessionStorage.getItem(markerKey)); } catch {}
    if (previous?.url === target.href && Date.now() - previous.at < 105000) throw new CommandExecutionError('Site redirected the requested page; check login or site verification');
    sessionStorage.setItem(markerKey, JSON.stringify({ url: target.href, at: Date.now() }));
    this.pending = { __webcli_navigation: { version: 1, url: target.href, resume: this.command.access !== 'write' } };
    throw new CommandExecutionError('Navigation required');
  }
  async evaluate(source) {
    if (this.pending) throw new CommandExecutionError('Navigation required');
    const expression = `(async () => { const result = (${source}); return typeof result === 'function' ? await result() : await result; })()`;
    const result = await helper('main_world_eval', { expression });
    if (!result || !Object.hasOwn(result, 'value')) throw new CommandExecutionError('Missing page evaluation result');
    return result.value;
  }
  async wait(value) { if (typeof value === 'number') await new Promise(resolve => setTimeout(resolve, Math.min(value, 3) * 1000)); }
  async getCookies(options) { const result = await helper('cookies_get', options); return Array.isArray(result) ? result : result?.cookies || []; }
}
function normalize(command, input) {
  const args = { ...input };
  for (const spec of command.args || []) {
    let value = args[spec.name];
    if (value === undefined) value = spec.default;
    if (value === undefined) { if (spec.required) throw new ArgumentError(`${spec.name} is required`); continue; }
    if (spec.type === 'int') {
      if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
      if (!Number.isSafeInteger(value) || value < 1) throw new ArgumentError(`${spec.name} must be a positive integer`);
    } else if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new ArgumentError(`${spec.name} must be a non-empty string of at most 2000 characters`);
    args[spec.name] = value;
  }
  if (command.site === 'arxiv' && command.name === 'paper' && !/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v[1-9]\d*)?$/.test(args.id)) throw new ArgumentError('Invalid arXiv paper ID');
  if (command.site === 'arxiv' && command.name === 'author' && /["\\\r\n]/.test(args.author)) throw new ArgumentError('Author must be a name, without query operators or quotes');
  return args;
}
export async function invoke(key, input = {}) {
  const command = commands.get(key);
  if (!command) throw new ArgumentError('Unknown command');
  const args = normalize(command, input), page = new Page(command);
  try { return command.browser === false ? await command.func(args) : await command.func(page, args); }
  catch (error) { if (page.pending) return page.pending; throw error; }
}
