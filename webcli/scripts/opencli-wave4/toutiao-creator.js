import { cli } from './registry.js';
import { AuthRequiredError, CommandExecutionError } from './errors.js';
import { parseArticlesPage, parseToutiaoArticlesText } from './upstream/toutiao/utils.js';

// These read endpoints were observed in the creator page's resource entries.
const STATUS = '/mp/agw/media/user_login_status_api';
const IDENTITY = '/mp/agw/creator_center/user_info';
async function readApi(page, path) {
  const result = await page.evaluate(`async () => {
    const r = await fetch(${JSON.stringify(path)}, { credentials: 'include', redirect: 'error' });
    let data; try { data = await r.json(); } catch { return { status: r.status, malformed: true }; }
    return { status: r.status, data };
  }`);
  if ([401, 403].includes(result?.status)) throw new AuthRequiredError('mp.toutiao.com');
  if (result?.status !== 200 || result?.malformed || !result?.data || result.data.code !== 0) {
    throw new CommandExecutionError('Toutiao creator API rejected the request or returned an unknown response');
  }
  return result.data;
}
async function requireSession(page) {
  const status = await readApi(page, STATUS);
  if (status.data?.is_login === false) throw new AuthRequiredError('mp.toutiao.com');
  if (status.data?.is_login !== true) throw new CommandExecutionError('Toutiao login status field is missing or invalid');
}
export async function identity(page) {
  await page.goto('https://mp.toutiao.com/');
  await requireSession(page);
  const data = await readApi(page, IDENTITY);
  // Numeric IDs may exceed JS precision. Prefer the server's string field.
  const id = typeof data.user_id_str === 'string' && /^\d+$/.test(data.user_id_str) ? data.user_id_str
    : Number.isSafeInteger(data.user_id) && data.user_id > 0 ? String(data.user_id) : null;
  if (!id || typeof data.name !== 'string' || !data.name.trim()) throw new CommandExecutionError('Toutiao creator identity fields are missing or invalid');
  return { logged_in: true, site: 'toutiao', user_id: id, nickname: data.name.trim() };
}
cli({ site: 'toutiao', name: 'whoami', access: 'read', browser: true, domain: 'mp.toutiao.com',
  description: '通过头条号登录状态及用户接口验证当前身份', args: [], func: identity });
cli({ site: 'toutiao', name: 'articles', access: 'read', browser: true, domain: 'mp.toutiao.com',
  description: '读取头条号创作者后台文章列表及指标',
  args: [{ name: 'page', type: 'int', default: 1, help: '页码 (1-4)' }],
  func: async (page, args) => {
    const number = parseArticlesPage(args.page, 1);
    await page.goto(`https://mp.toutiao.com/profile_v4/manage/content/all?page=${number}`);
    await requireSession(page);
    for (let attempt = 0; attempt < 5; attempt++) {
      const probe = await page.evaluate(`() => {
        const list = document.querySelector('.all-content-list');
        const empty = list?.querySelector('.byte-empty');
        const emptyText = empty?.querySelector('.byte-empty-description')?.textContent?.replace(/\\s+/g, '') || '';
        const loading = !!list?.querySelector('[aria-busy="true"], .byte-spin-loading');
        const children = list ? [...list.children] : [];
        return { list: !!list, loading, text: list?.innerText || '',
          explicitEmpty: !!empty && children.length === 1 && children[0] === empty && /^暂无作品[，,]赶紧去创作吧(?:开始创作)?$/.test(emptyText) };
      }`);
      if (probe?.list && !probe.loading) {
        if (probe.explicitEmpty) return [];
        const rows = parseToutiaoArticlesText(probe.text);
        if (rows.length) return rows;
      }
      if (attempt < 4) await page.wait(1);
    }
    throw new CommandExecutionError('Toutiao article list has no recognized rows or verified empty state; inspect the page before retrying');
  } });
