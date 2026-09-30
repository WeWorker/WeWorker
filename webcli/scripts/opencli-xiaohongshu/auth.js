import { cli } from './registry.js';
import { AuthRequiredError, CommandExecutionError } from './errors.js';
const home = 'https://creator.xiaohongshu.com/new/home';
export async function identity(page) {
  // The identity endpoint is origin-scoped; creator deployments may redirect
  // /new/home to another dashboard route. Do not cycle through that redirect.
  if (new URL(location.href).hostname !== 'creator.xiaohongshu.com') await page.goto(home);
  const data = await page.evaluate(`async () => {
    const r = await fetch('/api/galaxy/creator/home/personal_info', { credentials: 'include' });
    if (r.status === 401 || r.status === 403) return { auth: true };
    if (!r.ok) return { error: 'HTTP ' + r.status };
    return r.json();
  }`);
  if (data?.auth || /login|登录/i.test(data?.msg || '')) throw new AuthRequiredError('creator.xiaohongshu.com');
  if (data?.success === false) throw new CommandExecutionError('Creator identity API rejected the request');
  if (!data?.data || typeof data.data !== 'object') throw new CommandExecutionError('Creator identity response missing data');
  return { logged_in: true, site: 'xiaohongshu', username: data.data.name ?? '', followers: data.data.fans_count ?? null };
}
cli({ name: 'whoami', access: 'read', domain: 'creator.xiaohongshu.com', description: '通过创作者中心接口验证当前登录账号', args: [], func: identity });
cli({ name: 'login', access: 'write', domain: 'creator.xiaohongshu.com', description: '打开创作者中心登录页；完成登录后调用 whoami', args: [], func: async () => ({ __webcli_navigation: { version: 1, url: home, resume: false, result: { status: 'login_required', message: '请在浏览器完成登录，然后调用 whoami 验证。' } } }) });
