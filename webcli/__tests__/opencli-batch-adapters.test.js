import { createHostAdapterRuntime, assertAdapterNavigationUrl } from '../../extension/background/host-adapter-runtime.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { validateV2AdapterDir } from '../adapter-package-v2.js';
import { buildV2Bootstrap } from '../../extension/background/v2-loader.js';
import { managedAdapterSkill } from '../adapter-views.js';
import { compileResultBindings } from '../result-bindings.js';
import { captureResult } from '../context-profile.js';
import { newState, beginRound, commitRound, registerDisplay } from '../context-model.js';
import { routeContext } from '../context-router.js';

const root = resolve(import.meta.dirname, '../..');
const sites = ['12306.cn', 'zhihu.com', 'note.youdao.com', '51job.com', 'zhipin.com', 'dianping.com', 'douban.com', 'douyin.com'];
const inventory = JSON.parse(readFileSync(resolve(root,'docs/opencli_batch_inventory.json'),'utf8'));
function contextFor(s, command, args, raw) {
  const entries = s.pkg.commands.map(c => ({ ...c, adapterId: s.pkg.name, sourceFingerprint: 'test-package' }));
  const catalog = { entries, tools: {}, resultBindings: compileResultBindings(entries) }, state = newState(1000);
  beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: `${s.pkg.name}.${command}`, args, raw, exitCode: 0, now: 1000, catalog, roundId: state.activeRound.roundId });
  commitRound(state);
  registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(e => e.entityRef).reverse(), completeness: 'unknown', delivered: true });
  return { state, catalog };
}
function setup(site, { url, payload = {}, bodyText = '', one = {}, all = {}, privileged } = {}) {
  const pkg = validateV2AdapterDir(resolve(root, 'adapters', site));
  const handlers = new Map(), requests = [], calls = [], store = new Map();
  const location = new URL(url || 'https://' + pkg.manifest.match[0] + '/');
  const context = { URL, URLSearchParams, Set, Map, Date, AbortController,
    setTimeout, clearTimeout, console, location,
    sessionStorage: { getItem: k => store.get(k), setItem: (k,v) => store.set(k,v), removeItem: k => store.delete(k) },
    document: { body: { innerText: bodyText }, title: '', cookie: '', querySelector: s => one[s] || null, querySelectorAll: s => all[s] || [] },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok:true, status:200, url:String(url), text:async()=>JSON.stringify(typeof payload==='function'?payload(String(url)):payload), json:async()=>typeof payload==='function'?payload(String(url)):payload }; },
    XMLHttpRequest: class {
      open(method,url) { this.url=url; this.method=method; }
      setRequestHeader() {}
      send() { requests.push({url:this.url}); this.status=200; this.responseText=JSON.stringify(typeof payload==='function'?payload(this.url):payload); this.onload(); }
    },
    __webmcpRegister: d => d.tools.forEach(t => handlers.set(t.name, t.handler)),
    __webmcpWecliRuntime: { requestPrivileged: async (action, payload) => { calls.push({action,payload}); if(privileged)return privileged(action,payload);if(action==='browser_fetch'){requests.push({url:payload.url,options:payload.options});return {ok:true,status:200,body:JSON.stringify(context.__fixturePayload)}}return action==='main_world_eval' ? {value:await vm.runInContext(payload.expression,context)} : {}; } },
  };
  context.window = context; context.__fixturePayload=payload;
  vm.createContext(context);
  vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  const internal = resolve(root, 'adapters', site, 'extension/internal');
  if (existsSync(internal)) for (const file of readdirSync(internal).sort()) vm.runInContext(readFileSync(resolve(internal,file),'utf8'),context,{filename:file});
  for (const command of pkg.commands) vm.runInContext(readFileSync(resolve(root,'adapters',site,command.module),'utf8'),context,{filename:command.module});
  return { pkg, handlers, context, requests, calls, run: (id,args={}) => handlers.get(site+'.'+id)(args) };
}

describe('OpenCLI batch v2 contracts', () => {
  it.each(sites)('%s preserves inventoried source arguments, defaults and write classification',site=>{
    const {pkg}=setup(site);
    for(const command of pkg.commands) {
      const original=inventory.find(c=>c.package===site&&c.name===command.id);
      expect(original).toBeDefined();
      if(original.access==='write')expect(command.safety).toBe('write');
      for(const arg of original.args||[]) {
        const schema=command.schema.properties[arg.name];expect(schema).toBeDefined();
        if(arg.default!==undefined)expect(schema.default).toEqual(arg.default);
        if(arg.choices)expect(schema.enum).toEqual(site === 'zhihu.com' && command.id === 'search' && arg.choices === 'TYPES' ? ['all', 'answer', 'article', 'question'] : arg.choices);
      }
    }
  });
  it.each(sites)('%s loads every command through the real v2 bootstrap', site => {
    const {pkg,handlers}=setup(site);
    expect([...handlers.keys()]).toEqual(pkg.commands.map(c=>site+'.'+c.id));
    expect(JSON.parse(readFileSync(resolve(root,'weworker/build-profile.json'))).adapters).toContain(site);
  });
  it.each(sites)('%s includes maintained business guidance in deterministic Skills', site => {
    const {pkg}=setup(site), guidance=readFileSync(resolve(root,'adapters',site,'guidance.md'),'utf8');
    const adapter={id:site,version:pkg.manifest.version,guidance,tools:[],match:pkg.manifest.match};
    const skill=managedAdapterSkill(adapter);
    expect(skill).toContain(guidance.trim());
    expect(skill).toBe(managedAdapterSkill(adapter));
    expect(guidance).toContain('本轮证据');
  });
  it.each(sites)('%s does not add a universal confirmation failure to writes', async site => {
    const s=setup(site);
    for(const c of s.pkg.commands.filter(c=>c.safety==='write')) {
      expect(c.requires_confirmation).not.toBe(false);
      try { await s.run(c.id,{}); } catch(error) { expect(error.code).not.toBe('CONFIRMATION_REQUIRED'); }
    }
    // The harness only supplies mocked page and network helpers.
  });
  it.each(['12306.cn','zhihu.com','zhipin.com','dianping.com','douban.com','douyin.com'])('%s login uses terminal navigation without automatic write replay',async site=>{
    const s=setup(site); expect(await s.run('login',{__confirmed:true,timeout:'300'})).toMatchObject({__webcli_navigation:{version:1,resume:false}});
    expect(s.requests).toHaveLength(0);
  });
});

describe('BOSS context execution', () => {
  const friends = ['10001', '10002'].map(uid => ({ uid, encryptUid: `candidate-${uid}`, name: `Example ${uid}`, securityId: `security-${uid}`, encryptJobId: `job-${uid}` }));
  const jobs = friends.map(f => ({ jobName: f.name, encryptJobId: f.encryptJobId }));
  function boss() {
    const payload = url => ({ code: 0, zpData: url.includes('chatted/jobList') ? jobs : url.includes('search/joblist') ? { jobList: jobs.map(j => ({ ...j, brandName: 'Example company' })), hasMore: false } :
      url.includes('historyMsg') ? { messages: [{ from: { uid: '10001', name: 'Example peer' }, text: 'Example message', type: 1 }] } : url.includes('/label/get') ? { labels: [] } : { friendList: friends } });
    const s = setup('zhipin.com', { url: 'https://www.zhipin.com/web/chat/index', payload });
    s.context.setTimeout = callback => { callback(); return 1; };
    return s;
  }
  it('search and published-job rows execute selected public job details without using a candidate UID', async () => {
    for (const command of ['search', 'joblist']) {
      const s = boss(), args = command === 'search' ? { query: 'Example', limit: 2 } : {};
      if (command === 'search') s.context.location = new URL('https://www.zhipin.com/web/geek/jobs?query=Example&city=101010100&page=1');
      const raw = await s.run(command, args), { state, catalog } = contextFor(s, command, args, raw);
      const result = await routeContext(state, '查看第二条', { catalog, now: 1001 });
      expect(result.steps[0].args).toEqual({ 'security-id': 'job-10001' });
      const nav = await s.run('detail', result.steps[0].args);
      expect(nav.__webcli_navigation.url).toBe('https://www.zhipin.com/job_detail/job-10001.html');
      s.context.location = new URL(nav.__webcli_navigation.url); s.context.document.title = 'Example_Example company招聘-BOSS直聘';
      s.context.document.querySelector = selector => selector === '.job-primary .name h1' ? { textContent: 'Example job' } : selector.includes('job-sec-text') ? { textContent: 'Example description' } : null;
      expect(await s.run('detail', result.steps[0].args)).toMatchObject([{ name: 'Example job', company: 'Example company', url: nav.__webcli_navigation.url }]);
    }
  });
  it('recruiter chatlist preserves the actual side, executes message history, and reply binds the original encrypted candidate UID', async () => {
    const s = boss(), args = { side: 'boss' }, raw = await s.run('chatlist', args), { state, catalog } = contextFor(s, 'chatlist', args, raw);
    const result = await routeContext(state, '查看第二条', { catalog, now: 1001 });
    expect(result.steps[0].args).toEqual({ uid: 'candidate-10001', side: 'boss' });
    const messages = await s.run('chatmsg', result.steps[0].args);
    expect(messages).toMatchObject([{ message_ref: 1, text: 'Example message' }]);
    const followup = contextFor(s, 'chatmsg', result.steps[0].args, messages);
    const question = await routeContext(followup.state, '回复消息第一条', { catalog, now: 1001 });
    const reply = await routeContext(followup.state, 'Example reply', { catalog, now: 1002, replyTo: question.clarificationId });
    expect(reply.steps[0]).toMatchObject({ tool: 'zhipin.com.send', args: { uid: 'candidate-10001', text: 'Example reply' } });
  });
  it('auto chatlist uses the resolved recruiter side; geek and auto histories never expose recruiter-only send', async () => {
    const s = boss(), raw = await s.run('chatlist'), { state, catalog } = contextFor(s, 'chatlist', {}, raw);
    const result = await routeContext(state, '查看第二条', { catalog, now: 1001 });
    expect(result.steps[0].args).toEqual({ uid: 'candidate-10001', side: 'boss' });
    for (const side of ['auto', 'geek']) expect(catalog.resultBindings.get('zhipin.com.chatmsg').results.find(r => r.when.side === side).actions).toEqual([]);
    expect(catalog.resultBindings.get('zhipin.com.chatlist').results.find(r => r.when.side === 'geek').actions.map(a => a.tool)).toEqual(['zhipin.com.chatmsg']);
  });
  it('recommendation executes the actual resume handler and preserves identity for subsequent candidate actions', async () => {
    const s = boss(), raw = await s.run('recommend'), { state, catalog } = contextFor(s, 'recommend', {}, raw);
    const result = await routeContext(state, '查看第二条', { catalog, now: 1001 });
    expect(result.steps[0].args).toEqual({ uid: 'candidate-10001' });
    const container = { querySelector: selector => selector === '.base-name' ? { textContent: 'Example candidate' } : null };
    s.context.document.querySelector = selector => selector === '#_10001-0' ? { click() {} } : selector === '.base-info-single-container' ? container : null;
    const resume = await s.run('resume', result.steps[0].args);
    expect(resume).toMatchObject([{ name: 'Example candidate', encrypt_uid: 'candidate-10001' }]);
    const selected = contextFor(s, 'resume', result.steps[0].args, resume);
    const history = await routeContext(selected.state, '查看聊天记录第一条', { catalog, now: 1001 });
    expect(history.steps[0].args).toEqual({ uid: 'candidate-10001', side: 'boss' });
    expect(await s.run('chatmsg', history.steps[0].args)).toMatchObject([{ text: 'Example message' }]);
  });
  it('job statistics summary is not a job and cannot trigger an unfiltered chat query', async () => {
    const s = boss(), raw = await s.run('stats'), { state, catalog } = contextFor(s, 'stats', {}, raw);
    expect(raw.at(-1)).toMatchObject({ result_id: 'summary', followup_job_id: null });
    expect((await routeContext(state, '查看职位聊天第一条', { catalog, now: 1001 })).steps).toBeUndefined();
    const selected = contextFor(s, 'stats', {}, raw);
    const result = await routeContext(selected.state, '查看职位聊天第三条', { catalog, now: 1001 });
    expect(result.steps[0].args).toEqual({ 'job-id': 'job-10001', side: 'boss' });
    await s.run('chatlist', result.steps[0].args);
    expect(s.requests.at(-1).url).toContain('jobId=job-10001');
  });
  it('recommendation greeting binds all source IDs, asks for message text, and actual handler sends to the verified numeric recipient', async () => {
    const s = boss(), raw = await s.run('recommend'), { state, catalog } = contextFor(s, 'recommend', {}, raw);
    const question = await routeContext(state, '发送招呼第二条', { catalog, now: 1001 });
    const result = await routeContext(state, 'Example greeting', { catalog, now: 1002, replyTo: question.clarificationId });
    expect(result.steps[0].args).toEqual({ uid: 'candidate-10001', 'security-id': 'security-10001', 'job-id': 'job-10001', text: 'Example greeting' });
    const typed = [], clicked = [], editor = { offsetParent: {}, focus() {}, value: '', dispatchEvent() {} };
    s.context.Event = class {};
    s.context.document.execCommand = (_cmd, _flag, text) => typed.push(text);
    s.context.document.querySelector = selector => selector === '#_10001-0' ? { click: () => clicked.push('candidate') } : selector === '.chat-conversation[data-uid="10001"]' ? {} : selector === '.chat-editor [contenteditable="true"]' ? editor : selector === '.conversation-editor .submit' ? { click: () => clicked.push('send') } : null;
    const output = await s.run('greet', result.steps[0].args);
    expect(typed).toEqual(['Example greeting']); expect(clicked).toEqual(['candidate', 'send']);
    expect(output[0].status).toBe('已点击发送，送达未验证');
  });
  it.each([
    ['mark', '添加标签第二条', '收藏', 'label/addMark', { friendId: '10001', labelId: '11' }],
    ['exchange', '交换联系方式第二条', 'wechat', 'exchange/request', { uniqueId: '10001', type: '2' }],
    ['invite', '面试邀请第二条', '{"time":"2026-11-20 14:00","address":"Example office","contact":"Example contact"}', 'interview/invite.json', { uid: '10001', address: 'Example office', contactName: 'Example contact' }],
  ])('selected candidate %s runs its real write handler after correlated input', async (command, text, answer, endpoint, expected) => {
    const s = boss(), writes = [], Original = s.context.XMLHttpRequest;
    s.context.XMLHttpRequest = class extends Original {
      send(body) { if (this.method === 'POST' || this.url.includes('label/addMark')) writes.push({ url: this.url, method: this.method, body }); super.send(body); }
    };
    const raw = await s.run('recommend'), { state, catalog } = contextFor(s, 'recommend', {}, raw);
    const question = await routeContext(state, text, { catalog, now: 1001 });
    expect(question.kind).toBe('needs_input');
    const result = await routeContext(state, answer, { catalog, now: 1002, replyTo: question.clarificationId });
    expect(result).toMatchObject({ kind: 'resolved', executionEligibility: 'write_allowed' });
    expect(result.steps[0]).toMatchObject({ tool: 'zhipin.com.' + command, args: { uid: 'candidate-10001' } });
    await s.run(command, result.steps[0].args);
    expect(writes).toHaveLength(1); expect(writes[0].url).toContain(endpoint);
    const params = new URLSearchParams(writes[0].body || new URL(writes[0].url).search);
    for (const [key, value] of Object.entries(expected)) expect(params.get(key)).toBe(value);
    expect([...params.values()]).not.toContain('10002');
  });
  it.each(['mark', 'exchange', 'invite'])('%s never writes when the selected encrypted candidate is absent', async command => {
    const s = boss(), Original = s.context.XMLHttpRequest, writes = [];
    s.context.XMLHttpRequest = class extends Original {
      send(body) { if (this.method === 'POST' || /label\/(?:addMark|deleteMark)/.test(this.url)) writes.push(this.url); super.send(body); }
    };
    await expect(s.run(command, { uid: 'missing-candidate', label: '收藏', type: 'phone', time: '2026-11-20 14:00' })).rejects.toThrow();
    expect(writes).toEqual([]);
  });
  it('interview rejects an invalid time before any POST', async () => {
    const s = boss(), Original = s.context.XMLHttpRequest, writes = [];
    s.context.XMLHttpRequest = class extends Original { send(body) { if (this.method === 'POST') writes.push(this.url); super.send(body); } };
    await expect(s.run('invite', { uid: 'candidate-10001', time: 'not-a-time' })).rejects.toThrow(/时间格式错误/);
    expect(writes).toEqual([]);
  });
  it('job-bound batch greeting applies explicit limit/text only to recommendations for the selected job', async () => {
    const s = boss(), raw = await s.run('joblist'), { state, catalog } = contextFor(s, 'joblist', {}, raw);
    const question = await routeContext(state, '批量发送招呼第二条', { catalog, now: 1001 });
    const result = await routeContext(state, '{"limit":2,"text":"Example batch greeting"}', { catalog, now: 1002, replyTo: question.clarificationId });
    expect(result.steps[0].args).toEqual({ 'job-id': 'job-10001', limit: 2, text: 'Example batch greeting' });
    const clicks = [], typed = [];
    s.context.Event = class {};
    s.context.document.execCommand = (_cmd, _flag, text) => typed.push(text);
    const editor = { offsetParent: {}, focus() {}, dispatchEvent() {} };
    s.context.document.querySelector = selector => selector === '#_10001-0' ? { click: () => clicks.push('10001') }
      : selector === '.chat-conversation[data-uid="10001"]' ? {} : selector === '.chat-editor [contenteditable="true"]' ? editor
      : selector === '.conversation-editor .submit' ? { click: () => clicks.push('send') } : null;
    const output = await s.run('batchgreet', result.steps[0].args);
    expect(clicks).toEqual(['10001', 'send']); expect(typed).toEqual(['Example batch greeting']);
    expect(output).toMatchObject([{ name: 'Example 10001', status: '已点击发送，送达未验证' }]);
  });

});

describe('Douban context execution', () => {
  function douban(type = 'movie') {
    const node = (text, href = '') => ({ textContent: text, href, getAttribute: key => key === 'href' ? href : '', querySelector: () => null });
    const cards = ['10001', '10002'].map(id => ({ querySelector: selector => {
      if (['.pl2 a', 'a', 'h2 a[href*="/subject/"]', '.title-text, .title a, .title h3 a, h3 a, a[title]', '.info a[href*="/subject/"]'].includes(selector)) return node(`Example ${id}`, `https://${type}.douban.com/subject/${id}/`);
      if (['.title', '.pic em'].includes(selector)) return node(`Example ${id}`);
      return null;
    }, querySelectorAll: () => [] }));
    const photos = ['20001', '20002'].map(id => ({ querySelector: selector => selector === 'a[href*="/photos/photo/"]' ? { getAttribute: key => key === 'href' ? `https://movie.douban.com/photos/photo/${id}/` : `Example ${id}` } :
      selector === 'img' ? { getAttribute: key => key === 'src' ? `https://img3.doubanio.com/view/photo/s/public/p${id}.webp` : '' } : null }));
    const s = setup('douban.com', { url: `https://${type}.douban.com/`, one: {}, all: {} });
    s.context.setTimeout = callback => { callback(); return 1; };
    s.context.document.querySelector = selector => ['span[property="v:itemreviewed"]', 'h1 span', '#content h1'].includes(selector) ? node('Example subject') : selector.includes('.item-root .title-text') ? node('Ready') : null;
    s.context.document.querySelectorAll = selector => ['.item', '.media.clearfix', '.item-root, .result-list .result-item'].includes(selector) ? cards : selector === '.poster-col3 li, .poster-col3l li, .article li' ? photos : [];
    s.context.document.createElement = () => ({}); s.context.document.head = { prepend() {} };
    s.context.DOMParser = class { parseFromString() { return s.context.document; } };
    return s;
  }
  async function follow(s, command, args) {
    let result = await s.run(command, args);
    if (result.__webcli_navigation?.resume) { s.context.location = new URL(result.__webcli_navigation.url); result = await s.run(command, args); }
    return result;
  }
  it.each(['movie-hot', 'top250', 'book-hot'])('%s executes displayed second subject with the correct movie/book namespace', async command => {
    const type = command === 'book-hot' ? 'book' : 'movie', s = douban(type), args = { limit: 2 }, raw = await follow(s, command, args);
    const { state, catalog } = contextFor(s, command, args, raw), result = await routeContext(state, '查看第二条', { catalog, now: 1001 });
    expect(result.steps[0].args).toEqual({ id: '10001', type });
    expect(await follow(s, 'subject', result.steps[0].args)).toMatchObject([{ id: '10001', type, title: 'Example subject' }]);
    if (type === 'book') expect(catalog.resultBindings.get('douban.com.subject').results.find(r => r.when.type === 'book').actions).toEqual([]);
  });
  it.each(['movie', 'book', 'music'])('search %s preserves the query namespace; unsupported music detail is not guessed', async type => {
    const s = douban(type), args = { keyword: 'Example', type }, raw = await follow(s, 'search', args);
    const entries = s.pkg.commands.map(c => ({ ...c, adapterId: s.pkg.name })), catalog = { entries, resultBindings: compileResultBindings(entries) };
    if (type === 'music') { expect(catalog.resultBindings.get('douban.com.search').results.find(r => r.when.type === type).actions).toEqual([]); return; }
    const bound = contextFor(s, 'search', args, raw), result = await routeContext(bound.state, '查看第二条', { catalog: bound.catalog, now: 1001 });
    expect(result.steps[0].args).toEqual({ id: '10001', type });
    expect(await follow(s, 'subject', result.steps[0].args)).toMatchObject([{ id: '10001', type }]);
  });
  it('movie subject opens its own gallery and a displayed photo prepares exactly one file download with explicit output', async () => {
    const s = douban(), args = { id: '10001', type: 'movie' }, subject = await follow(s, 'subject', args), bound = contextFor(s, 'subject', args, subject);
    const result = await routeContext(bound.state, '查看海报第一条', { catalog: bound.catalog, now: 1001 });
    expect(result.steps[0].args).toEqual({ id: '10001' });
    const photos = await follow(s, 'photos', result.steps[0].args), selected = contextFor(s, 'photos', result.steps[0].args, photos);
    const question = await routeContext(selected.state, '下载图片第二条', { catalog: selected.catalog, now: 1001 });
    expect(question.missingFields).toEqual(['arguments.output']);
    const download = await routeContext(selected.state, './example-output', { catalog: selected.catalog, now: 1002, replyTo: question.clarificationId });
    expect(download.executionEligibility).toBe('write_allowed');
    expect(download.steps[0].args).toEqual({ id: '10001', 'photo-id': '20001', type: 'Rb', output: './example-output' });
    const writes = [];
    s.context.__webmcpWecliRuntime.requestPrivileged = async (action, p) => {
      if (action === 'backend_fetch') return { status: 200, bodyEncoding: 'base64', body: 'UklGRg==', size: 4, headers: { 'content-type': 'image/webp' } };
      if (action === 'backend_file_write') { writes.push(p); return { path: p.path }; }
      throw new Error(`Unexpected helper ${action}`);
    };
    expect(await s.run('download', download.steps[0].args)).toMatchObject([{ photo_id: '20001', status: 'success' }]);
    expect(writes).toHaveLength(1); expect(writes[0].path).toContain('./example-output/10001/'); expect(writes[0].path).toContain('20001');
  });
  it('download is a write, only prepares navigation on another page, and performs no file transfer before explicit reinvocation', async () => {
    const s = douban();
    expect(s.pkg.commands.find(c => c.id === 'download').safety).toBe('write');
    expect(await s.run('download', { id: '10001' })).toMatchObject({ __webcli_navigation: { resume: false, result: { status: 'prepared' } } });
    expect(s.calls).toHaveLength(0);
  });
  it('marks and reviews bind movie IDs; a review is never replaced with its movie by a generic detail request', async () => {
    const s = douban(), link = { href: 'https://movie.douban.com/subject/10001/', textContent: 'Example movie', getAttribute: () => '', querySelector: () => null };
    s.context.document.querySelectorAll = selector => selector === '.item' ? [{ querySelector: selector => selector.startsWith('.info a') ? link : null }] :
      selector === '.tlst' ? [{ querySelector: selector => selector === '.ilst a' ? link : selector === '.nlst a[title]' ? { href: 'https://movie.douban.com/review/30001/', textContent: 'Example review' } : null }] : [];
    for (const command of ['marks', 'reviews']) {
      const args = { uid: 'example-user', limit: 2 }, raw = await s.run(command, args), { state, catalog } = contextFor(s, command, args, raw);
      if (command === 'reviews') {
        expect(raw[0].reviewId).toBe('30001');
        expect((await routeContext(state, '查看第一条', { catalog, now: 1001 })).steps).toBeUndefined();
      }
      const bound = contextFor(s, command, args, raw), result = await routeContext(bound.state, command === 'reviews' ? '查看电影第一条' : '查看第一条', { catalog, now: 1001 });
      expect(result.steps[0].args).toEqual({ id: '10001', type: 'movie' });
      expect(await follow(s, 'subject', result.steps[0].args)).toMatchObject([{ id: '10001', type: 'movie' }]);
    }
  });
  it('verified account identity can query its own marks and reviews without relying on another active account', async () => {
    const s = douban(); s.context.__DATA__ = { uid: 'example-user' };
    const raw = await s.run('whoami'), { state, catalog } = contextFor(s, 'whoami', {}, raw);
    const result = await routeContext(state, '查看我的标记第一条', { catalog, now: 1001 });
    expect(result.steps[0].args).toEqual({ uid: 'example-user' });
    s.context.document.querySelectorAll = selector => selector === '.item' ? [{ querySelector: selector => selector.startsWith('.info a') ? {
      href: 'https://movie.douban.com/subject/10001/', textContent: 'Example movie', querySelector: () => null,
    } : null }] : [];
    expect(await s.run('marks', result.steps[0].args)).toMatchObject([{ movieId: '10001' }]);
    expect(s.requests.at(-1).url).toContain('/people/example-user/collect');
  });
});

describe('12306 business boundaries',()=>{
  const sessionPayload={status:true,data:{user_name:'fixture-user'}};
  const orderPage='https://kyfw.12306.cn/otn/view/train_order.html';
  const envelope={status:true,httpstatus:200,messages:[],validateMessages:{}};
  const orderSetup=(order,options={})=>setup('12306.cn',{url:orderPage,payload:url=>url.includes('initMy12306Api')?sessionPayload:order,...options});
  const emptyPanel={innerText:'您没有未完成的订单哦～',getClientRects:()=>[{}],querySelector:()=>null};
  it('orders reports server login failure before navigating or requesting orders',async()=>{
    const s=setup('12306.cn',{url:'https://kyfw.12306.cn/otn/resources/login.html',payload:{status:false,messages:['请登录']}});await expect(s.run('orders')).rejects.toMatchObject({code:'AUTH_REQUIRED'});expect(s.requests).toHaveLength(1);expect(s.requests[0].url).toContain('initMy12306Api');
  });
  it.each(['/otn/resources/login.html','/otn/leftTicket/init'])('orders reuses a verified session from stale page %s',async pathname=>{
    const s=setup('12306.cn',{url:'https://kyfw.12306.cn'+pathname,payload:sessionPayload});expect(await s.run('orders')).toMatchObject({__webcli_navigation:{url:orderPage,resume:true}});expect(s.requests).toHaveLength(1);
  });
  it('recognizes explicit no-order messages without treating missing data as empty',async()=>{
    await expect(orderSetup({status:true,messages:['您没有未完成的订单！']}).run('orders')).rejects.toMatchObject({code:'EMPTY_RESULT'});
    await expect(orderSetup({status:true,data:null,messages:[]}).run('orders')).rejects.toThrow(/missing order list array/);
  });
  it('recognizes the official successful no-data envelope only with visible matching empty state',async()=>{
    const s=orderSetup(envelope,{one:{'#not_complete':emptyPanel}});await expect(s.run('orders')).rejects.toMatchObject({code:'EMPTY_RESULT',message:expect.stringContaining('不代表未出行或历史订单为空')});expect(s.requests).toHaveLength(2);
  });
  it.each([
    {status:false,httpstatus:200,messages:[],validateMessages:{}},
    {...envelope,data:{}}, {...envelope,httpstatus:500}, {...envelope,messages:['请求失败']}, {...envelope,validateMessages:{query:'invalid'}}
  ])('does not interpret API failure or malformed payload as empty despite empty DOM',async response=>{
    await expect(orderSetup(response,{one:{'#not_complete':emptyPanel}}).run('orders')).rejects.not.toMatchObject({code:'EMPTY_RESULT'});
  });
  it.each([undefined,{...emptyPanel,getClientRects:()=>[]},{...emptyPanel,querySelector:()=>({})}])('keeps no-data response unknown if the visible empty state is absent or contradicted',async panel=>{
    const s=orderSetup(envelope,{one:{'#not_complete':panel}});s.context.setTimeout=fn=>{fn();return 0};await expect(s.run('orders')).rejects.toThrow(/missing order list array/);
  });
  const bundle="var station_names='@bjn|北京南|VNP|beijingnan|bjn|0|0|北京@shhq|上海虹桥|AOH|shanghaihongqiao|shhq|1|1|上海';";
  it.each(['上海','shanghai','AOH','shhq'])('resolves %s from the official bundle',async keyword=>{
    const s=setup('12306.cn',{privileged:(_,p)=>({ok:true,status:200,url:p.url,body:bundle})});
    expect(await s.run('stations',{keyword,limit:'1'})).toMatchObject([{name:'上海虹桥',code:'AOH'}]);
    expect(s.calls[0].payload).toMatchObject({browserFallback:false,redactBodyInTrace:true,options:{redirect:'manual'}});
  });
  it.each(['',true,'1.5','1e1','0','51',null])('rejects invalid limit %s before requesting',async limit=>{
    const s=setup('12306.cn');await expect(s.run('stations',{keyword:'上海',limit})).rejects.toMatchObject({code:'INVALID_ARGS'});expect(s.calls).toHaveLength(0);
  });
  it('does not expose booking secrets or confuse missing seat availability with zero',()=>{
    const s=setup('12306.cn'),f=Array(36).fill('');f[0]='fixture-booking-secret';f[2]='240000TEST01';f[3]='G1';f[6]='VNP';f[7]='AOH';f[30]='有';
    const row=s.context.__rail12306.parseTrainRecord(f.join('|'),new Map());expect(JSON.stringify(row)).not.toContain(f[0]);expect(row.second_seat).toBe('有');expect(row.first_seat).toBe('');
  });
  it('rejects impossible dates and unknown stations, without guessing',()=>{
    const c=setup('12306.cn').context.__rail12306;expect(()=>c.validateDate('2026-02-30')).toThrow();expect(()=>c.resolveStation([{name:'北京南',code:'VNP'}],'北京')).toThrow();
  });
  it('normalizes explicit sensitive=false and masks account fields',async()=>{
    const s=setup('12306.cn',{url:'https://kyfw.12306.cn/otn/view/index.html',payload:{status:true,data:{userDTO:{loginUserDTO:{user_name:'fixture',real_name:'测试用户'},email:'fixture@example.com',mobile_no:'13800001234',born_date:'1990-01-01'}}}});
    const [row]=await s.run('me',{'include-sensitive':'false'});expect(row.real_name).not.toBe('测试用户');expect(row.email).not.toBe('fixture@example.com');expect(row.mobile).toContain('*');expect(row.birth_date).toBe('1990');
  });
});

describe('API and page extraction regressions',()=>{
  it('BOSS unavailable optional stats remain unknown and samples are not totals',async()=>{
    const s=setup('zhipin.com',{url:'https://www.zhipin.com/web/chat/index',payload:url=>url.includes('jobList')?{code:0,zpData:[{jobName:'Fixture',encryptJobId:'job-a'}]}:url.includes('statistics')?{code:1}:{code:1,message:'fixture unavailable'}});
    const rows=await s.run('stats');expect(rows[0]).toMatchObject({total_chats:null,sampled_chats:null,count_scope:'first_friend_page_grouped_by_job_name_not_total'});expect(rows[1].total_chats).toBeNull();
  });
  it('BOSS missing job list is a parse failure',async()=>{
    const s=setup('zhipin.com',{url:'https://www.zhipin.com/web/chat/index',payload:{code:0,zpData:{}}});await expect(s.run('stats')).rejects.toThrow(/job list missing/);
  });
  it('BOSS verifies recipient before touching an editor',async()=>{
    const s=setup('zhipin.com');await expect(s.context.__boss.typeAndSendMessage('fixture text','123')).rejects.toMatchObject({code:'TARGET_UNVERIFIED'});expect(s.requests).toHaveLength(0);
  });
  it('BOSS obtains page-owned chat context through the main world helper',async()=>{
    const s=setup('zhipin.com',{privileged:()=>({value:'fixture-system-id'})});
    expect(await s.context.__boss.readEncryptSystemId()).toBe('fixture-system-id');
    expect(s.calls[0].action).toBe('main_world_eval');
  });
  it('BOSS rejects malformed recipient uid instead of stripping characters',async()=>{
    const s=setup('zhipin.com');await expect(s.context.__boss.clickCandidateInList('user-123')).rejects.toMatchObject({code:'INVALID_ARGS'});
  });
  const target='https://www.zhipin.com/web/geek/jobs?query=Python&city=101020100&page=1';
  const api='https://www.zhipin.com/wapi/zpgeek/search/joblist.json?query=Python&city=101020100&page=1';
  it('BOSS sends all explicit filters through a page-owned request',async()=>{
    const args={query:'Python',city:'上海',limit:'3',experience:'3-5年',degree:'本科',salary:'20-30K',industry:'互联网',jobType:'全职'};
    const url=target+'&experience=105&degree=203&salary=406&industry=100020&jobType=1901';
    const s=setup('zhipin.com',{url,payload:{code:0,zpData:{jobList:[{encryptJobId:'fixture',jobName:'Python',cityName:'上海'}],hasMore:false}}});
    expect(await s.run('search',args)).toMatchObject([{name:'Python',area:'上海',security_id:'fixture'}]);
    const u=new URL(s.requests[0].url);for(const [key,value] of new URL(url).searchParams)expect(u.searchParams.get(key)).toBe(value);
    expect(u.searchParams.get('pageSize')).toBe('15');expect(s.calls[0].action).toBe('main_world_eval');
  });
  it('BOSS malformed response is not a business empty result',async()=>{
    const s=setup('zhipin.com',{url:target,payload:{code:0,zpData:{}}});await expect(s.run('search',{query:'Python',city:'上海',limit:'3'})).rejects.toThrow(/jobList missing/);
  });
  it('BOSS distinguishes explicit empty lists and API failures',async()=>{
    const empty=setup('zhipin.com',{url:target,payload:{code:0,zpData:{jobList:[],hasMore:false}}});await expect(empty.run('search',{query:'Python',city:'上海'})).rejects.toMatchObject({code:'EMPTY_RESULT'});
    const failed=setup('zhipin.com',{url:target,payload:{code:99,message:'fixture failure'}});await expect(failed.run('search',{query:'Python',city:'上海'})).rejects.not.toMatchObject({code:'EMPTY_RESULT'});
  });
  it('BOSS pagination sends explicit page numbers and deduplicates jobs',async()=>{
    const s=setup('zhipin.com',{url:target.replace('page=1','page=2'),payload:url=>({code:0,zpData:{jobList:new URL(url).searchParams.get('page')==='2'?[{encryptJobId:'a'}]:[{encryptJobId:'a'},{encryptJobId:'b'}],hasMore:true}})});
    const rows=await s.run('search',{query:'Python',city:'上海',page:'2',limit:'2'});expect(rows.map(r=>r.security_id)).toEqual(['a','b']);expect(s.requests.map(r=>new URL(r.url).searchParams.get('page'))).toEqual(['2','3']);
  });
  it.each(['search','hot','suggest'])('Douyin hashtag %s rejects absent lists',async action=>{
    const s=setup('douyin.com',{url:'https://creator.douyin.com/creator-micro/content/manage',payload:{status_code:0}});await expect(s.run('hashtag',{action,keyword:'fixture',cover:'fixture-cover-uri'})).rejects.toThrow(/missing/);
  });
  it('51job preserves filter codes and numeric CLI strings, and leaves missing salary unknown',async()=>{
    const s=setup('51job.com',{payload:{status:'1',resultbody:{job:{items:[{jobId:123456,jobName:'Fixture',companyName:'Example'}]}}}});
    const [row]=await s.run('search',{keyword:'Python',area:'上海',limit:'3',page:'2'});expect(row.jobId).toBe('123456');expect(row.salaryMin).toBeNull();const u=new URL(s.requests[0].url);expect(u.searchParams.get('jobArea')).toBe('020000');expect(u.searchParams.get('pageNum')).toBe('2');
  });
  it('51job malformed API data is not an empty business result',async()=>{
    const s=setup('51job.com',{payload:{status:'1'}});await expect(s.run('search',{keyword:'Python'})).rejects.toMatchObject({code:'PARSE_ERROR'});
  });
  it('51job rejects unknown cities and invalid limits',async()=>{
    const s=setup('51job.com');await expect(s.run('hot',{area:'不存在的城市'})).rejects.toThrow();await expect(s.run('hot',{limit:'1.5'})).rejects.toThrow();expect(s.requests).toHaveLength(0);
  });
  it('Youdao rejects foreign URLs, URL credentials and notebook shares before navigation',async()=>{
    const s=setup('note.youdao.com');for(const url of ['https://example.com/?id=x','https://user:fixture@share.note.youdao.com/ynoteshare/index.html?id=x','https://share.note.youdao.com/?id=x&type=notebook'])await expect(s.run('note',{url})).rejects.toThrow();
  });
  it('Youdao extracts full note content separately from AI summary',async()=>{
    const url='https://share.note.youdao.com/ynoteshare/index.html?id=fixture&type=note';
    const root={__reactContainer$fixture:{memoizedState:{storeState:{content:{data:{tl:'Fixture note',content:JSON.stringify([{8:'Full body'}]),ct:1700000000,sz:10}},aiSummary:{aiSummary:JSON.stringify({description:'Summary only',keywords:[]})}}}}};
    const s=setup('note.youdao.com',{url:url+'&_time=1700000000',one:{'#root':root}});expect(await s.run('note',{url})).toMatchObject([{title:'Fixture note',content:'Full body',summary:'Summary only'}]);
  });
  it('Youdao resolves official short shares with bounded manual redirects',async()=>{
    const s=setup('note.youdao.com',{privileged:(_,p)=>p.url.includes('/s/')?{status:302,headers:{location:'https://share.note.youdao.com/share/?id=fixture&type=note'}}:{status:200}});
    expect(await s.run('note',{url:'https://share.note.youdao.com/s/Fixture'})).toMatchObject({__webcli_navigation:{url:'https://share.note.youdao.com/ynoteshare/index.html?id=fixture&type=note',resume:true}});
    expect(s.calls).toHaveLength(2);expect(s.calls[0].payload).toMatchObject({browserFallback:false,redactBodyInTrace:true,options:{redirect:'manual'}});
  });
  it('Youdao refuses foreign short-link redirects before fetching them',async()=>{
    const s=setup('note.youdao.com',{privileged:()=>({status:302,headers:{location:'https://example.com/?id=fixture'}})});
    await expect(s.run('note',{url:'https://share.note.youdao.com/s/Fixture'})).rejects.toMatchObject({code:'HOST_NOT_ALLOWED'});expect(s.calls).toHaveLength(1);
  });
  it('Youdao refuses changed note identity and redirect loops',async()=>{
    let i=0;const s=setup('note.youdao.com',{privileged:()=>({status:302,headers:{location:'https://share.note.youdao.com/noteshare?id='+ (++i===1?'first':'other')}})});
    await expect(s.run('note',{url:'https://share.note.youdao.com/s/Fixture'})).rejects.toThrow(/identity/);
    const loop=setup('note.youdao.com',{privileged:()=>({status:302,headers:{location:'https://share.note.youdao.com/s/Fixture'}})});
    await expect(loop.run('note',{url:'https://share.note.youdao.com/s/Fixture'})).rejects.toThrow(/limit exceeded/);expect(loop.calls).toHaveLength(5);
  });
  it('Zhihu login redirect fails explicitly instead of navigating in a loop',async()=>{
    const s=setup('zhihu.com',{url:'https://www.zhihu.com/signin?next=%2F'});await expect(s.run('hot',{limit:'3'})).rejects.toMatchObject({code:'AUTH_REQUIRED'});expect(s.requests).toHaveLength(0);
  });
  it('Zhihu hot keeps large IDs exact and projects the limit',async()=>{
    const s=setup('zhihu.com',{payload:{data:[{target:{id:'1937205528846655537',title:'Fixture',answer_count:7},detail_text:'1万热度'}]}});expect(await s.run('hot',{limit:'1'})).toMatchObject([{answers:7,url:'https://www.zhihu.com/question/1937205528846655537'}]);
  });
  it('Zhihu execute=false never performs a write even with host confirmation',async()=>{
    const s=setup('zhihu.com');await expect(s.run('follow',{target:'user:fixture',execute:'false',__confirmed:true})).rejects.toThrow();expect(s.requests).toHaveLength(0);
  });
  it('Douyin missing lists fail rather than fabricate a successful empty result',async()=>{
    const s=setup('douyin.com');await expect(s.run('collections',{limit:'3'})).rejects.toThrow(/list/);
  });
  it('Douyin preserves 64-bit work IDs and absent statistics',async()=>{
    const s=setup('douyin.com',{payload:{status_code:0,work_list:[{aweme_id:'1937205528846655537',desc:'Fixture'}],has_more:false}});expect(await s.run('videos',{limit:'1'})).toMatchObject([{aweme_id:'1937205528846655537',play_count:null}]);
  });
  it('Dianping preserves aliases and missing price/review values',()=>{
    const s=setup('dianping.com');expect(s.pkg.commands.find(c=>c.id==='shop').aliases).toContain('detail');expect(s.context.__dianping.parsePrice('')).toBeNull();expect(s.context.__dianping.parseReviewCount('1.2万')).toBe(12000);
  });
  it('BOSS establishes the requested page before sending its read query',async()=>{
    const s=setup('zhipin.com');expect(await s.run('search',{query:'Python',city:'北京',limit:'3'})).toMatchObject({__webcli_navigation:{resume:true,url:'https://www.zhipin.com/web/geek/jobs?query=Python&city=101010100&page=1'}});expect(s.calls).toHaveLength(0);
  });
  it('BOSS chat pagination accepts CLI page and rejects invalid side',async()=>{
    const s=setup('zhipin.com',{url:'https://www.zhipin.com/'});expect(await s.run('chatlist',{page:'2',limit:'5'})).toMatchObject({__webcli_navigation:{resume:true}});
  });
});


describe('Douban binary export boundaries',()=>{
  const photo={index:1,photoId:'123',title:'fixture',imageUrl:'https://img3.doubanio.com/view/photo/l/public/p123.webp'};
  it('writes only a verified binary image with the original bytes',async()=>{
    const s=setup('douban.com',{privileged:(action,p)=>action==='backend_fetch'?{status:200,bodyEncoding:'base64',body:'UklGRg==',size:4,headers:{'content-type':'image/webp'}}:{path:p.path}});
    expect(await s.context.__doubanDownload.savePhoto(photo,'456','./fixture-output')).toMatchObject({saved:'./fixture-output/456/456_001_123_fixture.webp',size:4});
    expect(s.calls[1]).toMatchObject({action:'backend_file_write',payload:{encoding:'base64',content:'UklGRg=='}});
  });
  it.each([{status:200,body:'broken image text'}, {status:302}, {status:200,bodyEncoding:'base64',body:'eA==',size:1,headers:{'content-type':'text/html'}}])('does not write unsupported or invalid responses',async response=>{
    const s=setup('douban.com',{privileged:()=>response});await expect(s.context.__doubanDownload.savePhoto(photo,'456','./fixture-output')).rejects.toThrow();expect(s.calls.filter(c=>c.action==='backend_file_write')).toHaveLength(0);
  });
  it('refuses foreign image hosts before a network request',async()=>{
    const s=setup('douban.com');await expect(s.context.__doubanDownload.savePhoto({...photo,imageUrl:'https://example.com/private'},'456','./fixture-output')).rejects.toThrow(/host/);expect(s.calls).toHaveLength(0);
  });
});


describe('Zhihu export contracts',()=>{
  it('preserves typed answer identity and refuses foreign targets',()=>{
    const s=setup('zhihu.com');expect(s.context.__zhihuExport.parseDownloadTarget('answer:123:456')).toMatchObject({kind:'answer',questionId:'123',answerId:'456'});expect(s.context.__zhihuExport.parseDownloadTarget('https://example.com/question/123/answer/456')).toBeNull();
  });
  it('exports a full Markdown body and keeps remote images when download-images is false',async()=>{
    const s=setup('zhihu.com',{privileged:(_,p)=>({path:p.path,size:123})});s.context.__zhihuMarkdown={convertToMarkdown:()=>'- full fixture body\n![image](https://pic1.zhimg.com/test.png)',replaceImageUrls:s=>s};
    const result=await s.context.__zhihuDownload.exportArticle({title:'Fixture',author:'Example',sourceUrl:'https://www.zhihu.com/question/123/answer/456',contentHtml:'<p>full fixture body</p>',imageUrls:['https://pic1.zhimg.com/test.png']},{output:'./fixture-export',images:false});
    expect(result[0]).toMatchObject({status:'success',saved:'./fixture-export/Fixture/Fixture.md'});expect(s.calls).toHaveLength(1);expect(s.calls[0].payload.content).toContain('- full fixture body');expect(s.calls[0].payload.encoding).toBe('utf8');
  });
  it('image failure is partial export, never complete download success',async()=>{
    const s=setup('zhihu.com',{privileged:(_,p)=>({path:p.path,size:123})});s.context.__zhihuMarkdown={convertToMarkdown:()=> 'full fixture body',replaceImageUrls:s=>s};
    const [result]=await s.context.__zhihuDownload.exportArticle({title:'Fixture',sourceUrl:'https://www.zhihu.com/question/123/answer/456',contentHtml:'fixture',imageUrls:['https://example.com/foreign-image.png']},{output:'./fixture-export',images:true});expect(result.status).toBe('partial');expect(result.images[0].status).toBe('failed');expect(s.calls).toHaveLength(1);expect(s.calls[0].action).toBe('backend_file_write');
  });
});

describe('Douban and Bilibili regressions', () => {
  it.each(['movie', 'book', 'music'])('Douban %s search invokes its classifier as a function', async type => {
    const title = { textContent: 'Example title', getAttribute: key => key === 'href' ? `https://${type}.douban.com/subject/123/` : '' };
    const row = { querySelector: selector => selector.startsWith('.title-text') ? title : null };
    const s = setup('douban.com', {
      url: `https://search.douban.com/${type}/subject_search?search_text=example${type === 'book' ? '&cat=1001' : ''}`,
      one: { '.item-root .title-text, .item-root .title a': title },
      all: { '.item-root, .result-list .result-item': [row, row] },
    });
    s.context.__DATA__ = { items: [{ id: '123', labels: ['剧集'] }] };
    const result = await s.run('search', { keyword: 'example', type, limit: '1' });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: '123', title: 'Example title', type: type === 'movie' ? 'tvshow' : type });
  });

  it.each([
    ['search-videos', { query: 'new query' }, 'https://search.bilibili.com/all?keyword=old', 'https://search.bilibili.com/all?keyword=new%20query', true],
    ['open-video-detail', { video_url: 'BV1example' }, 'https://www.bilibili.com/', 'https://www.bilibili.com/video/BV1example', true],
    ['like-video', { video_url: 'BV1example' }, 'https://www.bilibili.com/', 'https://www.bilibili.com/video/BV1example', false],
    ['favorite-video', { video_url: 'BV1example' }, 'https://www.bilibili.com/', 'https://www.bilibili.com/video/BV1example', false],
  ])('Bilibili %s uses host navigation with safe replay policy', async (command, args, url, target, resume) => {
    const s = setup('bilibili.com', { url });
    const result = await s.run(command, args);
    expect(result.__webcli_navigation).toMatchObject({ version: 1, url: target, resume });
    expect(assertAdapterNavigationUrl(s.pkg.manifest, target, resume)).toBe(target);
    expect(s.calls).toHaveLength(0);
  });

  it('Bilibili detail completes host navigation and returns the resumed result', async () => {
    let page = setup('bilibili.com', { url: 'https://www.bilibili.com/' });
    const manifest = page.pkg.manifest;
    const navigated = [];
    const runtime = createHostAdapterRuntime({
      bundle: async () => [], prepare: async () => {}, clear: async () => {}, inject: async () => {},
      navigate: async (_tab, url) => {
        navigated.push(url);
        page = setup('bilibili.com', { url, one: { 'h1.video-title': { textContent: 'Example video' } } });
        return url;
      },
    });
    const result = await runtime.execute(1, manifest, 'https://www.bilibili.com/',
      () => page.run('open-video-detail', { video_url: 'BV1example' }), { id: 'open-video-detail' });
    expect(navigated).toEqual(['https://www.bilibili.com/video/BV1example']);
    expect(result).toMatchObject({ title: 'Example video' });
    expect(result.__webcli_navigation).toBeUndefined();
  });

  it('keeps navigation inside declared business hosts', () => {
    const bilibili = setup('bilibili.com').pkg.manifest;
    for (const host of ['bilibili.com', 'www.bilibili.com', 'search.bilibili.com']) {
      expect(assertAdapterNavigationUrl(bilibili, `https://${host}/`)).toBe(`https://${host}/`);
    }
    const douban = setup('douban.com').pkg.manifest;
    for (const host of douban.match) expect(assertAdapterNavigationUrl(douban, `https://${host}/`)).toBe(`https://${host}/`);
    for (const manifest of [bilibili, douban]) {
      expect(() => assertAdapterNavigationUrl(manifest, 'https://example.org/')).toThrow(/not allowed/);
    }
    expect(() => assertAdapterNavigationUrl(douban, 'https://sec.douban.com/')).toThrow(/not allowed/);
    expect(() => assertAdapterNavigationUrl(douban, 'https://accounts.douban.com/')).toThrow(/not allowed/);
    expect(assertAdapterNavigationUrl(douban, 'https://accounts.douban.com/', false)).toBe('https://accounts.douban.com/');
  });
});
