import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { validateV2AdapterDir } from '../adapter-package-v2.js';
import { buildV2Bootstrap } from '../../extension/background/v2-loader.js';
import { managedAdapterSkill } from '../adapter-views.js';

const root = resolve(import.meta.dirname, '../..');
const inventory = JSON.parse(readFileSync(resolve(root,'docs/opencli_reference_wave3_inventory.json')));
function setup(id, payload, response = {}) {
  const pkg = validateV2AdapterDir(resolve(root,'adapters',id));
  const handlers = new Map(), calls = [];
  const FixedDate = class extends Date { static now() { return Date.parse('2026-01-01T00:30:00Z'); } };
  const ctx = { URL, Date:FixedDate, Set, Map, console,
    __webmcpRegister: d => d.tools.forEach(t=>handlers.set(t.name,t.handler)),
    __webmcpWecliRuntime: { requestPrivileged: async (action,args) => {
      calls.push({action,...args});
      if (payload instanceof Error) throw payload;
      return {ok:true,status:200,url:args.url,body:typeof payload==='string'?payload:JSON.stringify(payload),...(typeof response==='function'?response(args,calls.length):response)};
    } },
  };
  ctx.window=ctx;vm.createContext(ctx);vm.runInContext(buildV2Bootstrap(pkg.manifest),ctx);
  for(const file of readdirSync(resolve(root,'adapters',id,'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root,'adapters',id,'extension/internal',file),'utf8'),ctx);
  for(const cmd of pkg.commands)vm.runInContext(readFileSync(resolve(root,'adapters',id,cmd.module),'utf8'),ctx);
  return {pkg,calls,run:(name,args={})=>handlers.get(id+'.'+name)(args)};
}
describe('reference wave3 contracts',()=>{
  it.each(['wikipedia.org','github.com'])('%s loads all source commands and derived guidance',id=>{
    const s=setup(id,{}), originals=inventory.filter(x=>x.package===id);
    // 台账只记录 wave3 迁移来源命令；包允许在台账之外继续增长（如 github.com
    // 的 search/star 等新命令）。契约要求台账命令全部在场，不要求包停滞在台账。
    const commandIds=s.pkg.commands.map(c=>c.id);
    for(const original of originals) expect(commandIds).toContain(original.name);
    for(const cmd of s.pkg.commands){
      const original=originals.find(x=>x.name===cmd.id);
      if(!original) continue; // 非 wave3 来源命令不套用 wave3 的 read/background 契约
      expect(cmd.safety).toBe('read');expect(cmd.execution.runtime).toBe('background');
      for(const arg of original.args){expect(cmd.schema.properties[arg.name]).toBeDefined();if(arg.default!==undefined)expect(cmd.schema.properties[arg.name].default).toEqual(arg.default);}
    }
    const guidance=readFileSync(resolve(root,'adapters',id,'guidance.md'),'utf8');
    const adapter={id,version:s.pkg.manifest.version,tools:[],guidance,match:s.pkg.manifest.match};
    expect(managedAdapterSkill(adapter)).toContain(guidance.trim());
    expect(managedAdapterSkill(adapter)).toBe(managedAdapterSkill(adapter));
    expect(JSON.parse(readFileSync(resolve(root,'weworker/build-profile.json'))).adapters).toContain(id);
  });
});
describe('Wikipedia business contracts',()=>{
  it('encodes a search without allowing host or query injection and caps snippets',async()=>{
    const s=setup('wikipedia.org',{query:{search:[{title:'Fixture & title',snippet:'<b>Example</b> &amp; '+ 'x'.repeat(130)}]}});
    const [r]=await s.run('search',{query:'x&redirect=evil',lang:'ZH',limit:'2'});
    const u=new URL(s.calls[0].url);expect(u.hostname).toBe('zh.wikipedia.org');expect(u.searchParams.get('srsearch')).toBe('x&redirect=evil');
    expect(u.searchParams.has('redirect')).toBe(false);expect(r.snippet).toHaveLength(120);expect(r.snippet_truncated).toBe(true);
    expect(s.calls[0]).toMatchObject({action:'backend_fetch',browserFallback:false,redactBodyInTrace:true,options:{redirect:'manual'}});
  });
  it.each(['en.example.com','en/path','en@evil','../en','',true])('rejects lang %s before network',async lang=>{
    const s=setup('wikipedia.org',{});await expect(s.run('random',{lang})).rejects.toMatchObject({code:'INVALID_ARGS'});expect(s.calls).toHaveLength(0);
  });
  it.each([0,-1,1.5,true,[],null,'','1e2','51'].map(value=>[value]))('rejects invalid limit %s',async limit=>{
    const s=setup('wikipedia.org',{});await expect(s.run('search',{query:'fixture',limit})).rejects.toMatchObject({code:'INVALID_ARGS'});expect(s.calls).toHaveLength(0);
  });
  it('keeps summaries distinct from full text and preserves disambiguation metadata',async()=>{
    const s=setup('wikipedia.org',{title:'Example',extract:'a'.repeat(301),type:'disambiguation'});
    const [r]=await s.run('summary',{title:'Example / name'});
    expect(r).toMatchObject({extract_length:301,extract_truncated:true,content_scope:'lead_summary',description:null,article_type:'disambiguation'});
    expect(r.extract).toHaveLength(300);expect(s.calls[0].url).toContain('Example_%2F_name');
  });
  it('preserves full API text by default and marks explicit paragraph truncation',async()=>{
    const s=setup('wikipedia.org',{query:{pages:[{title:'Resolved fixture',pageid:42,extract:'one\n\ntwo\n\nthree'}]}});
    const [full]=await s.run('page',{title:'Original fixture'});expect(full.extract).toBe('one\n\ntwo\n\nthree');expect(full.extract_truncated).toBe(false);
    const [cap]=await s.run('page',{title:'Original fixture',paragraphs:'2'});expect(cap).toMatchObject({title:'Resolved fixture',pageId:42,extract:'one\n\ntwo',total_paragraphs:3,paragraphs:2,extract_truncated:true});
    expect(new URL(s.calls[0].url).searchParams.get('redirects')).toBe('1');
    await expect(s.run('page',{title:'fixture',paragraphs:true})).rejects.toMatchObject({code:'INVALID_ARGS'});
  });
  it('fetches one random article lead without a redirect or business page', async()=>{
    const s=setup('wikipedia.org',{query:{pages:[{title:'Fixture',extract:'x'.repeat(301),description:'Example',pageprops:{disambiguation:''}}]}});
    const [row]=await s.run('random',{lang:'zh'});
    expect(row).toMatchObject({title:'Fixture',article_type:'disambiguation',extract_truncated:true,extract_length:301,content_scope:'lead_summary'});
    const u=new URL(s.calls[0].url);
    expect(u.origin).toBe('https://zh.wikipedia.org');expect(u.pathname).toBe('/w/api.php');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({generator:'random',grnnamespace:'0',grnlimit:'1',grnfilterredir:'nonredirects',exintro:'1',explaintext:'1'});
    expect(s.calls[0]).toMatchObject({action:'backend_fetch',browserFallback:false,options:{redirect:'manual'}});
    expect(s.calls).toHaveLength(1);
  });
  it('rejects random API redirects and malformed random results',async()=>{
    const redirected=setup('wikipedia.org',{}, {ok:false,status:302,headers:{location:'/api/rest_v1/page/summary/Fixture'}});
    await expect(redirected.run('random')).rejects.toMatchObject({code:'HTTP_ERROR'});expect(redirected.calls).toHaveLength(1);
    for(const [pages,code] of [[[], 'NOT_FOUND'],[[null], 'PARSE_ERROR'],[[{missing:''}], 'NOT_FOUND'],[[{title:'Fixture',extract:''}], 'EMPTY_RESULT'],[[{title:'Fixture'}], 'PARSE_ERROR'],[[{title:'A'},{title:'B'}], 'PARSE_ERROR']]) {
      await expect(setup('wikipedia.org',{query:{pages}}).run('random')).rejects.toMatchObject({code});
    }
  });
  it('distinguishes missing articles, missing extracts and explicit empty extracts',async()=>{
    for(const [page,code]of [[{missing:true},'NOT_FOUND'],[{title:'Fixture'},'PARSE_ERROR'],[{title:'Fixture',extract:''},'EMPTY_RESULT']]){
      await expect(setup('wikipedia.org',{query:{pages:[page]}}).run('page',{title:'Fixture'})).rejects.toMatchObject({code});
    }
  });
  it('uses yesterday UTC across year boundaries, keeps feed date distinct and unknown views null',async()=>{
    const s=setup('wikipedia.org',{mostread:{date:'2025-12-30Z',articles:[{title:'Known zero',views:0},{title:'Unknown'},{views:3}]}});
    const rows=await s.run('trending',{limit:'2'});expect(s.calls[0].url).toContain('/featured/2025/12/31');
    expect(rows.map(x=>x.views)).toEqual([0,null]);expect(rows[0]).toMatchObject({feed_date:'2025-12-31',mostread_date:'2025-12-30Z'});
    await expect(s.run('trending',{limit:3})).rejects.toMatchObject({code:'PARSE_ERROR'});
  });
  it('separates API errors, schema drift, valid empty and transport failures',async()=>{
    for(const [data,code]of [[{error:{code:'badvalue'}},'API_ERROR'],[{},'PARSE_ERROR'],[{query:{search:[]}},'NOT_FOUND'],['<html>error</html>','PARSE_ERROR'],[new Error('network'),'FETCH_ERROR']])await expect(setup('wikipedia.org',data).run('search',{query:'fixture'})).rejects.toMatchObject({code});
    await expect(setup('wikipedia.org',{}, {ok:false,status:429}).run('random')).rejects.toMatchObject({code:'HTTP_ERROR'});
    await expect(setup('wikipedia.org',{}, {status:302}).run('random')).rejects.toMatchObject({code:'HTTP_ERROR'});
    await expect(setup('wikipedia.org',{}, {url:'https://example.org/'}).run('random')).rejects.toMatchObject({code:'HTTP_ERROR'});
  });
});
const card=(period='today')=>`<article class="Box-row"><h2><a href="/example-owner/example-repo">Example</a></h2><p class="col-9 color-fg-muted">Tools &amp; examples</p><span itemprop="programmingLanguage">Rust</span><a href="/example-owner/example-repo/stargazers">1,234</a><a href="/example-owner/example-repo/forks">0</a><span>12 stars ${period}</span></article>`;
describe('GitHub Trending business contracts',()=>{
  it.each([['daily','today'],['weekly','this week'],['monthly','this month']])('preserves %s scope and count meanings',async(since,period)=>{
    const s=setup('github.com','<main>'+card(period)+'</main>');const [r]=await s.run('repos',{since,language:'c++',limit:'1'});
    expect(r).toMatchObject({repo:'example-owner/example-repo',stars:1234,forks:0,starsSince:12,since,requested_language:'c++',description:'Tools & examples'});
    expect(s.calls[0].url).toBe('https://github.com/trending/c%2B%2B?since='+since);expect(s.calls[0].browserFallback).toBe(false);
  });
  it('rejects another period rather than relabeling it',async()=>{await expect(setup('github.com','<main>'+card()+'</main>').run('repos',{since:'weekly'})).rejects.toMatchObject({code:'PARSE_ERROR'});});
  it.each([{limit:0},{limit:26},{limit:true},{since:'yearly'},{language:'..'},{language:'rust/../../login'},{language:'rust?since=daily'}])('rejects invalid args %j before request',async args=>{
    const s=setup('github.com','');await expect(s.run('repos',args)).rejects.toMatchObject({code:'INVALID_ARGS'});expect(s.calls).toHaveLength(0);
  });
  it('does not accept navigation/script cards, broken fields, error pages as an empty board',async()=>{
    for(const html of ['<nav>'+card()+'</nav><main>Loading</main>','<main><script>'+card()+'</script></main>','<main>'+card().replace('1,234','unknown')+'</main>','<html>upstream error</html>'])await expect(setup('github.com',html).run('repos')).rejects.toMatchObject({code:'PARSE_ERROR'});
    await expect(setup('github.com',"<main>It looks like we don’t have any trending repositories for your choices.</main>").run('repos')).rejects.toMatchObject({code:'EMPTY_RESULT'});
    await expect(setup('github.com','',{ok:false,status:403}).run('repos')).rejects.toMatchObject({code:'HTTP_ERROR'});
  });
});
