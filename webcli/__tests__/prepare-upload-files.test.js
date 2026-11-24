import {it,expect,vi,beforeEach} from 'vitest';
vi.mock('../upload-files.js',()=>({inspectLocalUpload:vi.fn(()=>[{name:'test.txt',size:3}])}));
vi.mock('node:fs',()=>({default:{existsSync:()=>true}}));
import {inspectLocalUpload} from '../upload-files.js';
import {prepareUploadFiles} from '../prepare-upload-files.js';
import path from 'node:path';
const file=path.resolve('test.txt');
const plain={success:true,encrypted:false,encryption_status:'not_encrypted'};
const encrypted={success:true,encrypted:true,encryption_status:'encrypted'};
const result=r=>({stdout:JSON.stringify(r)});
const options=run=>({run,platform:'win32',resourcesPath:path.resolve('resources')});
beforeEach(()=>vi.clearAllMocks());
it('ordinary files are checked without decrypting',async()=>{
 const run=vi.fn(async()=>result(plain));const r=await prepareUploadFiles([file],false,options(run));
 expect(run).toHaveBeenCalledTimes(1);expect(r.preparation.decrypted).toBe(0);
 expect(inspectLocalUpload.mock.calls).toEqual([[[file],false,{metadataOnly:true}],[[file],false]]);
});
it('encrypted files use supported decrypt and recheck before final inspection',async()=>{
 const run=vi.fn().mockResolvedValueOnce(result(encrypted)).mockResolvedValueOnce(result({success:true})).mockResolvedValueOnce(result(plain));
 const r=await prepareUploadFiles([file],false,options(run));expect(r.preparation.decrypted).toBe(1);
 expect(run.mock.calls.map(c=>c[1])).toEqual([['--check','--json',file],['--json',file],['--check','--json',file]]);
});
it.each([['failure',{success:false}],['unknown',{success:true,encrypted:false,encryption_status:'unknown'}]])('%s stops preparation without fallback',async(_,response)=>{
 await expect(prepareUploadFiles([file],false,options(vi.fn(async()=>result(response))))).rejects.toMatchObject({details:{dispatched:false}});
 expect(inspectLocalUpload).toHaveBeenCalledTimes(1);
});
it('successful utility invocation is not proof of decryption',async()=>{
 const run=vi.fn().mockResolvedValueOnce(result(encrypted)).mockResolvedValueOnce(result({success:true})).mockResolvedValueOnce(result(encrypted));
 await expect(prepareUploadFiles([file],false,options(run))).rejects.toMatchObject({code:'UPLOAD_DECRYPTION_INCOMPLETE'});
 expect(run).toHaveBeenCalledTimes(3);
});
it('unsupported platform retains ordinary file validation',async()=>{
 const run=vi.fn();await prepareUploadFiles([file],false,{...options(run),platform:'linux'});expect(run).not.toHaveBeenCalled();expect(inspectLocalUpload).toHaveBeenCalledTimes(2);
});
