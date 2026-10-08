// Adapt shared OpenCLI auth registration to finite host navigation.
import { cli } from './registry.js';
export function registerSiteAuthCommands(config) {
  cli({ site: config.site, name: 'whoami', access: 'read', browser: true,
    domain: 'mp.toutiao.com', description: '验证头条号登录身份', args: [],
    func: async page => ({ logged_in: true, site: config.site, ...await config.verify(page) }) });
  cli({ site: config.site, name: 'login', access: 'write', browser: true,
    domain: 'mp.toutiao.com', description: '打开头条号登录页；人工完成后调用 whoami', args: [],
    func: async () => ({ __webcli_navigation: { version: 1, url: config.loginUrl, resume: false,
      result: { status: 'login_required', executed: false, message: '请在浏览器完成登录，再调用 whoami 验证。' } } }) });
}
