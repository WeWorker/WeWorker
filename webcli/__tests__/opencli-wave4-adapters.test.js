import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { validateV2AdapterDir } from '../adapter-package-v2.js';
import { buildV2Bootstrap } from '../../extension/background/v2-loader.js';
import { managedAdapterSkill } from '../adapter-views.js';
const root = resolve(import.meta.dirname, '../..');
const entry = `<entry><id>http://arxiv.org/abs/2401.00001v2</id><title>Fixture &amp; &#x3B1;</title><author><name>Example Author</name></author><summary><![CDATA[Text <entry> &amp; literal]]></summary><published>2024-01-01T00:00:00Z</published><category term="cs.CL"/><arxiv:primary_category term="cs.CL"/><link href="http://arxiv.org/pdf/2401.00001v2" type="application/pdf" rel="related"/></entry>`;
const feed = content => `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">${content}</feed>`;
function setup(id, payload, options = {}) {
  const pkg = validateV2AdapterDir(resolve(root, 'adapters', id)), handlers = new Map(), calls = [], storage = new Map();
  const ctx = { URL, console, fetch: options.fetch, setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
    location: new URL(options.url || `https://${id}/`),
    sessionStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    document: options.document,
    __webmcpRegister: d => d.tools.forEach(t => handlers.set(t.name, t.handler)),
    __webmcpWecliRuntime: { requestPrivileged: async (action,args) => {
      calls.push({action,...args});
      if (action === 'cookies_get') return [{ name: 'sessionid', value: 'fixture-session' }];
      if (action === 'main_world_eval') return { value: options.document ? await vm.runInContext(args.expression, ctx) : typeof options.pageValue === 'function' ? options.pageValue(args.expression) : options.pageValue };
      if (payload instanceof Error) throw payload;
      return { ok: true, status: 200, url: args.url, body: typeof payload === 'string' ? payload : JSON.stringify(payload), ...options.response };
    } },
  };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(buildV2Bootstrap(pkg.manifest), ctx);
  for (const file of readdirSync(resolve(root, 'adapters', id, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'adapters', id, 'extension/internal', file), 'utf8'), ctx);
  for (const cmd of pkg.commands) vm.runInContext(readFileSync(resolve(root, 'adapters', id, cmd.module), 'utf8'), ctx);
  return { pkg, calls, ctx, run: (name,args={}) => handlers.get(id+'.'+name)(args) };
}
describe('wave4 package contracts', () => {
  it.each([['toutiao.com',5],['smzdm.com',1],['arxiv.org',4]])('%s loads %s commands and guidance', (id,count) => {
    const s = setup(id, {}); expect(s.pkg.commands).toHaveLength(count);
    const guidance=readFileSync(resolve(root,'adapters',id,'guidance.md'),'utf8');
    expect(managedAdapterSkill({id,version:s.pkg.manifest.version,tools:[],guidance,match:s.pkg.manifest.match})).toContain(guidance.trim());
    expect(JSON.parse(readFileSync(resolve(root,'weworker/build-profile.json'))).adapters).toContain(id);
    for (const c of s.pkg.commands) { expect(c.runtime).toBe('extension'); if (c.safety === 'write') expect(c.requires_confirmation).toBe(true); }
  });
  it.each([null, true, [], {}, '', '1e2', 0, 1.1, -1, '51'].map(v=>[v]))('rejects unsafe limits %s before I/O', async limit => {
    const s=setup('toutiao.com',{}); await expect(s.run('hot',{limit})).rejects.toMatchObject({code:'ARGUMENT'}); expect(s.calls).toHaveLength(0);
  });
  it('uses restricted backend transport and keeps metrics unknown', async () => {
    const s=setup('toutiao.com',{status:'success',data:[{Title:'Fixture',ClusterIdStr:'1234567890123456789'}]});
    expect(await s.run('hot',{limit:'2'})).toMatchObject([{rank:1,title:'Fixture',hot_value:null,group_id:'1234567890123456789'}]);
    expect(s.calls[0]).toMatchObject({action:'backend_fetch',browserFallback:false,redactBodyInTrace:true,options:{method:'GET',redirect:'manual',maxResponseBytes:4194304}});
  });
  it.each([{status:302}, {redirected:true}, {url:'https://example.com/'}, {ok:false,status:403}])('rejects HTTP/redirect failure %s', async response => {
    await expect(setup('toutiao.com',{data:[]},{response}).run('hot')).rejects.toMatchObject({code:'COMMAND_EXEC'});
  });
  it.each(['<html>blocked</html>', {message:'blocked'}, {status:'error'}, {status:'success'}, {data:{}}])('rejects error payload %s', async payload => {
    await expect(setup('toutiao.com',payload).run('hot')).rejects.toMatchObject({code:'COMMAND_EXEC'});
  });
  it('recommend filters ads, binds identity and emits UTC time', async () => {
    const s=setup('toutiao.com',{message:'success',data:[{title:'Ad',is_feed_ad:true},{title:'Fixture',source_url:'/article/12345/',behot_time:1,image_url:'//example.com/image'}]});
    const [row]=await s.run('recommend',{category:'news_tech',limit:3});
    expect(row).toMatchObject({rank:1,group_id:'12345',comments:null,published_at:'1970-01-01T00:00:01Z',url:'https://www.toutiao.com/group/12345/'});
    expect(s.calls[0].url).toContain('category=news_tech');
  });
  it.each([{title:'Fixture',source_url:'https://example.com/article/123/'},{title:'Fixture',source_url:'/article/123/',group_id:'456'}, {title:'Fixture'}])('rejects invalid recommendation identity',async row => {
    await expect(setup('toutiao.com',{data:[row]}).run('recommend')).rejects.toMatchObject({code:'COMMAND_EXEC'});
  });
  it('rejects unsupported channel and page before navigation',async()=>{
    const s=setup('toutiao.com',{}); await expect(s.run('recommend',{category:'news_auto'})).rejects.toMatchObject({code:'ARGUMENT'});
    await expect(s.run('articles',{page:5})).rejects.toMatchObject({code:'ARGUMENT'}); expect(s.calls).toHaveLength(0);
  });
  it('returns navigation even when upstream wraps its error',async()=>{
    const result=await setup('toutiao.com',{}).run('articles',{page:2});
    expect(result).toMatchObject({__webcli_navigation:{url:'https://mp.toutiao.com/profile_v4/manage/content/all?page=2',resume:true}});
  });
  it('article rows preserve absent metrics and reject login walls',async()=>{
    const url='https://mp.toutiao.com/profile_v4/manage/content/all?page=1';
    const s=setup('toutiao.com',{}, {url,pageValue:expression=>expression.includes('fetch(')?{status:200,data:{code:0,data:{is_login:true}}}:{list:true,text:'Fixture article\n10-08 10:00\n审核中'}});
    expect(await s.run('articles')).toMatchObject([{title:'Fixture article',status:'审核中','阅读':null}]);
    await expect(setup('toutiao.com',{}, {url,pageValue:{status:200,data:{code:0,data:{is_login:false}}}}).run('articles')).rejects.toMatchObject({code:'AUTH_REQUIRED'});
  });
  it('login navigation never replays and whoami requires identity evidence',async()=>{
    const s=setup('toutiao.com',{});
    // Invoke local API for write navigation: bootstrap confirmation is separately regression-tested.
    expect(await s.ctx.__wave4.invoke('toutiao/login')).toMatchObject({__webcli_navigation:{resume:false,result:{executed:false}}});
    const logged=setup('toutiao.com',{}, {url:'https://mp.toutiao.com/',pageValue:expression=>({status:200,data:expression.includes('user_login_status_api')?{code:0,data:{is_login:true}}:{code:0,user_id_str:'9999999999999999999',name:'Fixture'}})});
    expect(await logged.run('whoami')).toMatchObject({logged_in:true,user_id:'9999999999999999999'});
    await expect(setup('toutiao.com',{}, {url:'https://mp.toutiao.com/',pageValue:{status:401}}).run('whoami')).rejects.toMatchObject({code:'AUTH_REQUIRED'});
  });
  it('executes the generated server identity requests',async()=>{
    const calls=[];
    const s=setup('toutiao.com',{}, {url:'https://mp.toutiao.com/',document:{},fetch:async(path,options)=>{calls.push({path,options});return {status:200,json:async()=>path.includes('status')?{code:0,data:{is_login:true}}:{code:0,user_id_str:'12345',name:'Fixture'}};}});
    expect(await s.run('whoami')).toMatchObject({logged_in:true,user_id:'12345',nickname:'Fixture'});
    expect(calls).toHaveLength(2);expect(calls[0].options).toMatchObject({credentials:'include',redirect:'error'});
  });
  it('does not label an unrecognized logged-in dashboard as an expired session',async()=>{
    const s=setup('toutiao.com',{}, {url:'https://mp.toutiao.com/',pageValue:{status:200,data:{code:0,data:{}}}});
    await expect(s.run('whoami')).rejects.toMatchObject({code:'COMMAND_EXEC'});
  });
  it.each(['empty','missing','loading','mixed'])('executes scoped DOM empty detection: %s',async kind=>{
    const empty={querySelector:()=>({textContent:'暂无作品，赶紧去创作吧开始创作'})};
    const list={innerText:'',children:kind==='mixed'?[empty,{}]:[empty],querySelector:selector=>selector==='.byte-empty'?empty:kind==='loading'?{}:null};
    const s=setup('toutiao.com',{}, {url:'https://mp.toutiao.com/profile_v4/manage/content/all?page=1',document:{querySelector:()=>kind==='missing'?null:list},fetch:async()=>({status:200,json:async()=>({code:0,data:{is_login:true}})})});
    if(kind==='empty') expect(await s.run('articles')).toEqual([]);
    else await expect(s.run('articles')).rejects.toMatchObject({code:'COMMAND_EXEC'});
  });
  it.each([{status:500},{status:200,malformed:true},{status:200,data:{code:1}},{status:200,data:{code:0,data:{is_login:'true'}}}])('rejects unknown session response',async pageValue=>{
    await expect(setup('toutiao.com',{}, {url:'https://mp.toutiao.com/',pageValue}).run('whoami')).rejects.toMatchObject({code:'COMMAND_EXEC'});
  });
  it('rejects rounded numeric user IDs',async()=>{
    const pageValue=expression=>({status:200,data:expression.includes('user_login_status_api')?{code:0,data:{is_login:true}}:{code:0,user_id:1e20,name:'Fixture'}});
    await expect(setup('toutiao.com',{}, {url:'https://mp.toutiao.com/',pageValue}).run('whoami')).rejects.toMatchObject({code:'COMMAND_EXEC'});
  });
});
describe('arXiv actual bundled parser and commands',()=>{
  it('decodes entities once, preserves CDATA and versioned PDF',async()=>{
    const s=setup('arxiv.org',feed(entry)); const [row]=await s.run('paper',{id:'2401.00001v2'});
    expect(row).toMatchObject({id:'2401.00001',title:'Fixture & α',authors:'Example Author',abstract:'Text <entry> &amp; literal',pdf:'https://arxiv.org/pdf/2401.00001v2',primary_category:'cs.CL'});
    expect(s.calls[0].url).toContain('id_list=2401.00001v2');
  });
  it.each(['search','author','recent'])('%s maps list fields and limits',async name=>{
    const s=setup('arxiv.org',feed(entry)); const [row]=await s.run(name,{query:'a&b',author:'Example Author',category:'cs.CL',limit:'2'});
    expect(row.title).toBe('Fixture & α'); expect(row.abstract).toBeUndefined();
    const url=new URL(s.calls[0].url);expect(url.searchParams.get('max_results')).toBe('2');
    expect(url.searchParams.get('search_query')).toBe({search:'all:a&b',author:'au:"Example Author"',recent:'cat:cs.CL'}[name]);
  });
  it.each(['<html>blocked</html>',feed(entry).slice(0,-7),feed(entry)+'<feed/>',feed('<entry><id>http://arxiv.org/api/errors#bad</id><title>Error</title></entry>'),feed('<entry/>'),feed(entry.replace('</title>','</TITLE>')),feed(entry.replace('http://arxiv.org/pdf/','https://example.com/pdf/')),feed(entry.replace('&amp;','&unknown;')),'<!DOCTYPE feed>'+feed(entry)])('rejects malformed/error XML',async xml=>{
    await expect(setup('arxiv.org',xml).run('search',{query:'fixture'})).rejects.toMatchObject({code:'COMMAND_EXEC'});
  });
  it('recognizes a valid empty Atom feed separately',async()=>{
    await expect(setup('arxiv.org',feed('')).run('search',{query:'fixture'})).rejects.toMatchObject({code:'EMPTY_RESULT'});
  });
  it.each(['https://example.com/', '../2401.00001','2401.00001,2401.00002',true])('rejects invalid paper ID %s',async id=>{
    const s=setup('arxiv.org',feed(entry)); await expect(s.run('paper',{id})).rejects.toMatchObject({code:'ARGUMENT'});expect(s.calls).toHaveLength(0);
  });
  it('rejects author query injection and invalid category',async()=>{
    const s=setup('arxiv.org',feed(entry));await expect(s.run('author',{author:'Example" OR all:foo'})).rejects.toMatchObject({code:'ARGUMENT'});
    await expect(s.run('recent',{category:'cs/CL'})).rejects.toMatchObject({code:'ARGUMENT'});
  });
});
describe('SMZDM generated DOM extraction',()=>{
  const url='https://search.smzdm.com/?c=home&s=fixture&v=b';
  function doc(href='https://www.smzdm.com/p/12345/', metrics=true) {
    const title={getAttribute:k=>k==='title'?'Fixture offer':href,textContent:'Fixture offer',href};
    const li={querySelector:selector=>selector==='h5.feed-block-title > a'?title:selector==='.z-highlight'?{textContent:'10元（需用券）'}:selector.includes('.feed-block-extras')?{textContent:'Fixture mall',childNodes:[{nodeType:3,textContent:'10-08 10:00'}]}:metrics?{textContent:'1.2万'}:null};
    return {body:{innerText:''},querySelectorAll:()=>[li]};
  }
  it('encodes user query and requests resumable host navigation',async()=>{
    const s=setup('smzdm.com',{}); const result=await s.run('search',{query:'耳机&redirect=x'});
    const nav=result.__webcli_navigation; expect(nav.resume).toBe(true);expect(new URL(nav.url).searchParams.get('s')).toBe('耳机&redirect=x');expect(new URL(nav.url).searchParams.has('redirect')).toBe(false);
  });
  it('extracts condition-bearing price, metrics and update time',async()=>{
    const s=setup('smzdm.com',{}, {url,document:doc()});
    expect(await s.run('search',{query:'fixture'})).toMatchObject([{title:'Fixture offer',price:'10元（需用券）',zhi_count:12000,updated_at:'10-08 10:00'}]);
  });
  it('keeps missing metrics unknown',async()=>{
    expect(await setup('smzdm.com',{}, {url,document:doc(undefined,false)}).run('search',{query:'fixture'})).toMatchObject([{comments:null,zhi_count:null}]);
  });
  it.each(['https://example.com/p/1/','https://user:pass@www.smzdm.com/p/1/','javascript:alert(1)'])('rejects untrusted links %s',async href=>{
    await expect(setup('smzdm.com',{}, {url,document:doc(href)}).run('search',{query:'fixture'})).rejects.toThrow('results missing');
  });
  it('does not mistake verification or missing cards for no products',async()=>{
    await expect(setup('smzdm.com',{}, {url,document:{body:{innerText:'安全验证'},querySelectorAll:()=>[]}}).run('search',{query:'fixture'})).rejects.toThrow('verification');
    await expect(setup('smzdm.com',{}, {url,document:{body:{innerText:''},querySelectorAll:()=>[]}}).run('search',{query:'fixture'})).rejects.toThrow('results missing');
  });
});
