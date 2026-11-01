import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {uploadBrowserFiles,inspectUploadTarget} from '../background/browser-upload.js';
import {clearBrowserFrames,recordBrowserFrameEvent} from '../background/browser-frames.js';
import {runBrowserPageCommand} from '../background/browser-page.js';

async function fixture({beforeError,afterError,navigate=false,stall=false}={}){
  const tabId=83;clearBrowserFrames(tabId);const calls=[],scripts=[];let dispatched=false,release;
  const source={tabId,sessionId:'example-child-session'};
  const chrome={scripting:{executeScript:async request=>{
    scripts.push(request);
    return[{frameId:12,documentId:'example-upload-document',result:{ok:true,data:{multiple:true,accept:'.txt'}}}];
  }},debugger:{sendCommand:async(src,method,params)=>{
    calls.push({source:src,method,params});
    if(method==='Runtime.evaluate'){
      if(params.expression.startsWith('this['))return{result:{value:true}};
      if(navigate)await recordBrowserFrameEvent(chrome,source,'Runtime.executionContextsCleared',{});
      return{result:{objectId:'example-retained-input'}};
    }
    if(method==='Runtime.callFunctionOn'){
      const phase=params.arguments[1].value,code=phase==='before'?beforeError:afterError;
      if(stall&&phase==='before')return new Promise(resolve=>{release=()=>resolve({result:{value:{ok:true}}});});
      return{result:{value:code?{ok:false,error:{code,message:'Example rejected target'}}:{ok:true,count:2}}};
    }
    if(method==='DOM.setFileInputFiles')dispatched=true;
    return{};
  }}};
  for(const isDefault of [true,false])await recordBrowserFrameEvent(chrome,source,'Runtime.executionContextCreated',{context:{id:isDefault?1:2,uniqueId:isDefault?'example-main':'example-isolated',auxData:{isDefault,frameId:'example-cdp-frame'}}});
  const args={frameId:12,documentId:'example-upload-document',selector:'#file',paths:['/tmp/example-a.txt','/tmp/example-b.txt'],_uploadFiles:[{name:'example-a.txt',size:3},{name:'example-b.txt',size:4}]};
  return{chrome,calls,scripts,args,run:()=>uploadBrowserFiles(chrome,tabId,args,async()=>{}),dispatched:()=>dispatched,release:()=>release?.(),ready:()=>!!release};
}

test('upload resolves a retained object in the exact child session, strips paths from scripts, verifies and cleans up',async()=>{
  const f=await fixture();const result=await f.run();
  assert.equal(result.verified,true);assert.equal(result.count,2);assert.equal(result.frameId,12);assert.equal(result.documentId,'example-upload-document');
  const sets=f.calls.filter(row=>row.method==='DOM.setFileInputFiles');assert.equal(sets.length,1);assert.equal(sets[0].source.sessionId,'example-child-session');assert.equal(sets[0].params.objectId,'example-retained-input');assert.deepEqual(sets[0].params.files,f.args.paths);
  assert.equal(JSON.stringify(f.scripts.map(row=>row.args)).includes('/tmp/example-'),false);
  assert.ok(f.calls.some(row=>row.method==='Runtime.releaseObjectGroup'));
  assert.ok(f.scripts.some(row=>String(row.func).includes('delete globalThis')));
});

test('stale/disabled targets and lost contexts prevent file dispatch, while failed retention reports possible side effects',async()=>{
  for(const mode of [{beforeError:'UPLOAD_TARGET_CHANGED'},{beforeError:'ELEMENT_DISABLED'},{navigate:true},{afterError:'UPLOAD_VERIFICATION_FAILED'}]){
    const f=await fixture(mode);const expected=mode.beforeError||mode.afterError||'FRAME_DOCUMENT_CHANGED';
    await assert.rejects(f.run(),error=>error.code===expected&&error.details.dispatched===!!mode.afterError);
    assert.equal(f.dispatched(),!!mode.afterError);assert.ok(f.calls.some(row=>row.method==='Runtime.releaseObjectGroup'));
  }
});

test('preparation deadline cannot send a late upload even when the pending verifier eventually resolves',async t=>{
  const f=await fixture({stall:true});t.mock.timers.enable({apis:['setTimeout','Date']});
  const pending=f.run();const rejected=assert.rejects(pending,error=>error.code==='UPLOAD_INTERRUPTED'&&error.details.dispatched===false);
  for(let i=0;i<100&&!f.ready();i++)await Promise.resolve();assert.equal(f.ready(),true);
  t.mock.timers.tick(30001);await rejected;f.release();await Promise.resolve();
  assert.equal(f.dispatched(),false);assert.equal(f.calls.some(row=>row.method==='DOM.setFileInputFiles'),false);
});

test('retained-input verification uses actual file order, names and sizes, not only the count',()=>{
  const token='example-upload-unit';const node={files:[{name:'example-a.txt',size:3},{name:'example-b.txt',size:4}]};
  globalThis[token]={node,validate:()=>{}};
  try{
    const expected=[{name:'example-a.txt',size:3},{name:'example-b.txt',size:4}];
    assert.equal(inspectUploadTarget.call(node,token,'after',expected).ok,true);
    for(const rows of [[...expected].reverse(),[{...expected[0],size:9},expected[1]],[expected[0]]])assert.equal(inspectUploadTarget.call(node,token,'after',rows).error.code,'UPLOAD_VERIFICATION_FAILED');
    assert.equal(inspectUploadTarget.call({files:node.files},token,'after',expected).error.code,'UPLOAD_TARGET_CHANGED');
  }finally{delete globalThis[token];}
});

test('isolated target preparation expires before retaining a node and guards subsequent contract changes',async()=>{
  let name='Example file';const node={tagName:'INPUT',type:'file',multiple:true,accept:'.txt',isConnected:true,children:[],getClientRects:()=>[],matches:()=>false,getAttribute:key=>key==='aria-label'?name:null,getRootNode:()=>document};
  const document={querySelectorAll:()=>[node]};node.ownerDocument=document;
  const context=vm.createContext({document,location:{href:'https://example.com/'},ShadowRoot:class{},Date,getComputedStyle:()=>({visibility:'hidden'})});
  const run=vm.runInContext(`(${runBrowserPageCommand.toString()})`,context);
  const args={selector:'#example',uploadToken:'exampleRetained',uploadDeadline:Date.now()-1,fileCount:2};
  assert.equal((await run('upload-target',args)).error.code,'UPLOAD_INTERRUPTED');assert.equal(context.exampleRetained,undefined);
  args.uploadDeadline=Date.now()+30000;assert.equal((await run('upload-target',args)).ok,true);
  name='Example changed';assert.throws(()=>context.exampleRetained.validate('before'),{code:'UPLOAD_TARGET_CHANGED'});
  name='Example file';node.disabled=true;assert.throws(()=>context.exampleRetained.validate('before'),{code:'ELEMENT_DISABLED'});
  node.disabled=false;node.isConnected=false;assert.throws(()=>context.exampleRetained.validate('after'),{code:'UPLOAD_TARGET_CHANGED'});
});

test('directory verification uses complete relative paths, tolerates enumeration order and rejects mismatches',()=>{
  const token='example-directory-unit';const node={files:[{name:'a.json',size:2,webkitRelativePath:'folder/nested/a.json'},{name:'a.json',size:1,webkitRelativePath:'folder/a.json'}]};
  globalThis[token]={node,validate:()=>{}};
  try{
    const expected=[{name:'a.json',size:1,relativePath:'folder/a.json'},{name:'a.json',size:2,relativePath:'folder/nested/a.json'}];
    assert.equal(inspectUploadTarget.call(node,token,'after',expected).ok,true);
    node.files[0].webkitRelativePath='folder/wrong/a.json';assert.equal(inspectUploadTarget.call(node,token,'after',expected).error.code,'UPLOAD_VERIFICATION_FAILED');
    node.files.pop();assert.equal(inspectUploadTarget.call(node,token,'after',expected).ok,false);
  }finally{delete globalThis[token];}
});

test('chooser node retention rejects wrong input mode, disabled, replacement and document drift',async()=>{
  const {retainChooserInput}=await import('../background/browser-upload.js');
  const document={},location={href:'https://example.com/'},node={tagName:'INPUT',type:'file',isConnected:true,multiple:true,ownerDocument:document,matches:()=>false,closest:()=>null,getAttribute:()=>null};
  const context=vm.createContext({document,location,Date});
  const retain=vm.runInContext(`(${retainChooserInput.toString()})`,context);
  assert.equal(retain.call(node,'retained',Date.now()+1000,false,2).ok,true);
  assert.equal(retain.call(node,'wrong',Date.now()+1000,true,2).ok,false);
  node.isConnected=false;assert.throws(()=>context.retained.validate(),{code:'UPLOAD_TARGET_CHANGED'});
  node.isConnected=true;location.href+='changed';assert.throws(()=>context.retained.validate(),{code:'UPLOAD_TARGET_CHANGED'});
  node.matches=()=>true;assert.equal(retain.call(node,'disabled',Date.now()+1000,false,2).error.code,'ELEMENT_DISABLED');
});
