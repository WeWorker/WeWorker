import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = name => fs.readFileSync(path.join(root,'webcli/scripts/article-publishing',name+'.js'),'utf8');
function env(site, { host = 'example.org', response, files = {} } = {}) {
 const calls = [];
 const ctx = { URL, Map, Set, crypto: globalThis.crypto, atob, location:{hostname:host,pathname:'/'}, setTimeout:fn=>{fn();return 1;}, fetch:async(url,opts)=>{calls.push({url,opts});return {ok:true,status:200,json:async()=>response,text:async()=>typeof response==='string'?response:JSON.stringify(response)}} };
 ctx.window = ctx;
 ctx.__webmcpWecliRuntime = {requestPrivileged:async(action,args)=>{
   calls.push({action,args});
   if(action==='backend_file_read')return files[args.path] || {content:'Article body'};
   if(action==='main_world_eval')return {value:await vm.runInContext(args.expression,ctx)};
   throw new Error('Unexpected write helper');
 }};
 vm.createContext(ctx);vm.runInContext(source('common'),ctx);vm.runInContext(source(site),ctx);
 return {ctx,calls,api:ctx[site==='juejin'?'__juejinPublishing':'__zhihuPublishing']};
}
test('writes require execute=true before reading files or touching a page',async()=>{
 for(const site of ['juejin','zhihu']){
  const {api,calls}=env(site);
  await assert.rejects(api.prepare({title:'示例',file:'/tmp/example.md'}),e=>e.code==='INVALID_ARGS');
  await assert.rejects(api.publish({'draft-id':'123',title:'示例'}),e=>e.code==='INVALID_ARGS');
  assert.equal(calls.length,0);
 }
});
test('invalid IDs and titles fail before network or editor writes',async()=>{
 for(const site of ['juejin','zhihu']){
  const {api,calls}=env(site);
  for(const id of ['https://example.org/1','1e4','../123',123]) await assert.rejects(api.status({id}));
  await assert.rejects(api.prepare({execute:true,title:'',file:'/tmp/example.md'}));
  assert.equal(calls.length,0);
 }
});
test('Juejin prepare rejects unuploaded external images and truncated source without editing',async()=>{
 const one=env('juejin',{files:{'/tmp/example.md':{content:'![img](https://example.org/a.png)'}}});
 await assert.rejects(one.api.prepare({execute:true,title:'示例',file:'/tmp/example.md'}),/local images/);
 assert.equal(one.calls.filter(c=>c.action==='main_world_eval').length,0);
 const two=env('juejin',{files:{'/tmp/example.md':{content:'partial',truncated:true}}});
 await assert.rejects(two.api.prepare({execute:true,title:'示例',file:'/tmp/example.md'}),/truncated/);
});
test('write navigation prepares once and never resumes a business write automatically',async()=>{
 const {api,calls}=env('juejin');
 const r=await api.prepare({execute:true,title:'示例',file:'/tmp/example.md'});
 assert.equal(r.__webcli_navigation.resume,false);
 assert.equal(r.__webcli_navigation.phase,'prepare');
 assert.equal(r.__webcli_navigation.result.executed,false);
 assert.equal(calls.some(c=>c.url),false);
});
test('Zhihu status preserves long IDs and does not turn moderation states into published',async()=>{
 const {api}=env('zhihu',{host:'zhuanlan.zhihu.com',response:'{"id":2100000000000000001,"title":"示例","state":"reviewing"}'});
 const r=await api.status({id:'2100000000000000001'});
 assert.equal(r.article_id,'2100000000000000001');assert.equal(r.status,'submitted');assert.equal(r.platform_status,'reviewing');
});
test('status rejects a different article or malformed receipt',async()=>{
 for(const site of ['juejin','zhihu']){
  const {api}=env(site,{host:site==='juejin'?'juejin.cn':'zhuanlan.zhihu.com',response:site==='juejin'?{err_no:0,data:{article_info:{article_id:'456',title:'示例'}}}:{id:'456',title:'示例',state:'published'}});
  await assert.rejects(api.status({id:'123'}));
 }
});
test('both packages retain old commands and their generated publishing sources',()=>{
 for(const site of ['juejin','zhihu']){
  const domain=site==='juejin'?'juejin.cn':'zhihu.com', pkg=path.join(root,'adapters',domain);
  const m=JSON.parse(fs.readFileSync(path.join(pkg,'manifest.json')));
  assert.equal(m.commands.length,site==='juejin'?7:25);
  assert.ok(m.commands.some(c=>c.id==='check-login-status'||c.id==='answer'));
  assert.equal(fs.readFileSync(path.join(pkg,'extension/internal/article-common.js'),'utf8'),source('common'));
  assert.equal(fs.readFileSync(path.join(pkg,'extension/internal/article-publishing.js'),'utf8'),source(site));
  for(const name of ['prepare-article','publish-article'])assert.equal(m.commands.find(c=>c.id===name).safety,'write');
  assert.equal(m.commands.find(c=>c.id==='article-status').safety,'read');
 }
});
test('Juejin draft status maps to an article with required native API fields',async()=>{
 const {api,ctx,calls}=env('juejin',{host:'juejin.cn'});
 ctx.document={querySelector:()=>null};
 ctx.fetch=async(url,opts)=>{
  const body=JSON.parse(opts.body);calls.push({url,body});
  const data=url.includes('article_draft')?{article_draft:{id:'123',article_id:'456',title:'示例'}}:{article_info:{article_id:'456',status:1,audit_status:2}};
  return {ok:true,json:async()=>({err_no:0,data})};
 };
 const r=await api.status({'draft-id':'123'});
 assert.equal(r.article_id,'456');assert.equal(r.title,'示例');assert.equal(r.status,'submitted');
 assert.equal(calls.find(c=>c.body?.article_id).body.client_type,2608);
 assert.equal(r.platform_status.audit_status,2);
});
test('Juejin publish refuses already published drafts before touching publish controls',async()=>{
 const {api,ctx}=env('juejin',{host:'juejin.cn',response:{err_no:0,data:{article_draft:{id:'123',article_id:'456'}}}});
 ctx.location.pathname='/editor/drafts/123';ctx.sessionStorage={getItem:()=>null};
 await assert.rejects(api.publish({execute:true,'draft-id':'123',title:'示例',category:'示例',tags:'示例',summary:'示例'}),/already mapped/);
});
test('Zhihu status falls back to owner draft when public article is absent',async()=>{
 const {api,ctx}=env('zhihu',{host:'zhuanlan.zhihu.com'});const urls=[];
 ctx.fetch=async url=>{urls.push(url);return urls.length===1?{ok:false,status:404}:{ok:true,text:async()=>JSON.stringify({id:'123',title:'示例',state:'draft'})}};
 assert.equal((await api.status({id:'123'})).status,'draft');assert.equal(urls[1],'/api/articles/123/draft');
});
