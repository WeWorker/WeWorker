import {it,expect,vi} from 'vitest';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../../extension/background/service-worker.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('async function handleCdpAction('),source.indexOf('\nfunction safeStoredText'));
function setup(reply){
 const prepare=vi.fn(async()=>reply), upload=vi.fn(async()=>({completed:true,verified:true})), ensure=vi.fn(), chrome={};
 const call=Function('requestBridge','uploadBrowserFiles','chrome','ensureCdpAttached',fn+';return handleCdpAction;')(prepare,upload,chrome,ensure);
 return {call,prepare,upload,ensure,chrome};
}
it('adapter shares file preparation and existing browser uploader',async()=>{
 const files=[{name:'fixture.txt',size:3}];const s=setup({ok:true,result:{files,preparation:{decrypted:1}}});
 const r=await s.call(123,{__cdp_action:'set_file_input',selector:'#file',files:['C:/fixture.txt']});
 expect(s.prepare.mock.calls[0][0]).toEqual({type:'prepare_upload_files',paths:['C:/fixture.txt']});
 expect(s.upload).toHaveBeenCalledExactlyOnceWith(s.chrome,123,{selector:'#file',paths:['C:/fixture.txt'],_uploadFiles:files},s.ensure);
 expect(r.success).toBe(true);expect(r.preparation.decrypted).toBe(1);
 expect(fn).not.toMatch(/debugger\.(attach|detach)/);
});
it('adapter does not dispatch after preparation failure',async()=>{
 const s=setup({ok:false,code:'UPLOAD_ENCRYPTION_FAILED',error:'fixture failure'});
 await expect(s.call(123,{__cdp_action:'set_file_input',selector:'#file',files:['C:/fixture.txt']})).rejects.toMatchObject({code:'UPLOAD_ENCRYPTION_FAILED',details:{dispatched:false}});
 expect(s.upload).not.toHaveBeenCalled();
});
