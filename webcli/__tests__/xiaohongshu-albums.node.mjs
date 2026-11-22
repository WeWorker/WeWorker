import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
function command(name, path='/explore', value) {
  let handler;
  const context={ URL, URLSearchParams, location:{pathname:path,href:'https://www.xiaohongshu.com'+path},
    window:{__webmcpWecliRuntime:{requestPrivileged:async()=>({value:JSON.stringify(value)})}},
    __webcliRegisterCommand:(id,fn)=>{handler=fn;} };
  context.window.__webcliRegisterCommand=context.__webcliRegisterCommand;
  vm.runInNewContext(readFileSync(new URL('../../adapters/xiaohongshu.com/extension/commands/'+name+'.js',import.meta.url),'utf8'), context);
  return handler;
}
const id='a'.repeat(24);
test('album navigation uses host read resume contract',async()=>{
 const r=await command('album-notes')({'album-id':id});
 assert.equal(r.__webcli_navigation.url,'https://www.xiaohongshu.com/board/'+id);
 assert.equal(r.__webcli_navigation.resume,true);
});
test('reject malformed album IDs and bounds before evaluating',async()=>{
 for(const p of [{'album-id':'../login'},{'album-id':id,limit:0},{'album-id':id,limit:1001}])
  await assert.rejects(command('album-notes')(p));
});
test('media refuses external URLs, credentials and wrong routes',async()=>{
 for(const url of ['https://example.org/explore/'+id,'https://user@www.xiaohongshu.com/explore/'+id,'http://www.xiaohongshu.com/explore/'+id,'https://www.xiaohongshu.com/board/'+id])
  await assert.rejects(command('video-media')({url}));
});
test('current album preserves explicit incomplete result',async()=>{
 const result=await command('album-notes','/board/'+id,{notes:[],has_more:true,complete:false})({'album-id':id});
 assert.equal(result.complete,false);assert.equal(result.has_more,true);
});
test('generated package matches maintained local command definitions and sources',async()=>{
 const {resolve}=await import('node:path');
 const base=new URL('../../adapters/xiaohongshu.com/',import.meta.url);
 const source=new URL('../scripts/opencli-xiaohongshu/local-commands/',import.meta.url);
 const manifest=JSON.parse(readFileSync(new URL('manifest.json',base),'utf8'));
 const definitions=JSON.parse(readFileSync(new URL('commands.json',source),'utf8'));
 for(const def of definitions){
  assert.deepEqual(manifest.commands.find(c=>c.id===def.id),def);
  assert.equal(readFileSync(new URL(def.module,base),'utf8'),readFileSync(new URL(def.id+'.js',source),'utf8'));
 }
 assert.equal(new Set(manifest.commands.map(c=>c.id)).size,36);
});
