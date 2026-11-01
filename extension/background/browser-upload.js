import { createFrameOperation, settleFrameCleanup } from './frame-operation.js';
import {executeFrameScript,withBrowserFrameContext} from './browser-frames.js';
import {runBrowserPageCommand} from './browser-page.js';
import {validateBrowserAxReference} from './browser-ax.js';
import {executeFramePointer} from './browser-pointer.js';

const fail=(code,message,details)=>Object.assign(new Error(message),{code,...(details?{details}:{})});
const sourceKey=source=>source.sessionId||'';

// Runs on the exact retained file input in the extension's isolated world.
// No query is repeated after selection and no local path is put into the page.
export function inspectUploadTarget(token,phase,expected){
  try{
    const captured=globalThis[token];
    if(!captured||captured.node!==this)throw Object.assign(new Error('Upload target reference expired.'),{code:'UPLOAD_TARGET_CHANGED'});
    captured.validate(phase);
    if(phase==='before')return{ok:true};
    const files=this.files||[];
    const directory=expected.some(item=>item.relativePath!==undefined);
    const actual=directory?[...files].sort((a,b)=>a.webkitRelativePath.localeCompare(b.webkitRelativePath)):[...files];
    const wanted=directory?[...expected].sort((a,b)=>a.relativePath.localeCompare(b.relativePath)):expected;
    if(actual.length!==wanted.length||wanted.some((item,index)=>actual[index].name!==item.name||actual[index].size!==item.size||(directory&&actual[index].webkitRelativePath!==item.relativePath)))throw Object.assign(new Error('The file input did not retain the expected file names, relative paths and sizes. Inspect its current state before retrying.'),{code:'UPLOAD_VERIFICATION_FAILED'});
    return{ok:true,count:files.length};
  }catch(error){return{ok:false,error:{code:error.code||'UPLOAD_VERIFICATION_FAILED',message:error.code?error.message:'The selected file input could not be verified.'}};}
}

// The event's backend node is resolved in the original isolated world, never
// rediscovered by selector. A dynamically created custom picker is supported.
export function retainChooserInput(token, deadline, directory, count) {
  const node=this,url=location.href,multiple=node.multiple;
  const validate=()=>{
    const error=code=>{throw Object.assign(new Error(code),{code});};
    if(Date.now()>=deadline)error('UPLOAD_INTERRUPTED');
    if(!node.isConnected||node.ownerDocument!==document||location.href!==url)error('UPLOAD_TARGET_CHANGED');
    if(node.tagName!=='INPUT'||node.type!=='file'||node.multiple!==multiple||!!node.webkitdirectory!==directory)error('UPLOAD_TARGET_CHANGED');
    if(node.matches(':disabled')||node.closest('[inert]')||node.getAttribute('aria-disabled')==='true')error('ELEMENT_DISABLED');
    if(count>1&&!multiple&&!directory)error('INVALID_ARGUMENT');
  };
  try {validate();globalThis[token]={node,validate};return{ok:true,data:{multiple:!!multiple,accept:String(node.accept||'').slice(0,500)}};}
  catch(error){return{ok:false,error:{code:error.code||'UPLOAD_TARGET_CHANGED'}};}
}

export async function uploadBrowserFiles(chrome,tabId,args,ensureCdpAttached){
  if(!Array.isArray(args.paths)||!args.paths.length||args.paths.length>20||!Array.isArray(args._uploadFiles)||!args._uploadFiles.length||args._uploadFiles.length>200||(!args.directory&&args._uploadFiles.length!==args.paths.length)||(args.directory&&args.paths.length!==1)
    ||args._uploadFiles.some(file=>!file||typeof file.name!=='string'||!Number.isSafeInteger(file.size)||file.size<0))throw fail('INVALID_ARGUMENT','Upload requires locally validated files.');
  return withBrowserFrameContext(chrome,tabId,args,ensureCdpAttached,async({isolated,selected,state})=>{
    const token=`__weworkerUpload_${crypto.randomUUID().replaceAll('-','')}`,group=`weworker-upload-${crypto.randomUUID()}`;
    const selection={...args,frameId:selected.frameId,documentId:selected.documentId};
    const deadline=Date.now()+30000;let dispatched=false,chooserOpened=false,chooserArmed=false,listener,intercepted=false;
    const chooserEvents=[];
    const check=()=>{
      if(Date.now()>=deadline)throw fail('UPLOAD_INTERRUPTED','Upload preparation or verification exceeded its deadline.',{dispatched});
      if(![...state.contexts.values()].some(context=>context.uniqueId===isolated.uniqueId&&sourceKey(context.source)===sourceKey(isolated.source)))throw fail('FRAME_DOCUMENT_CHANGED','The upload document is no longer available.',{dispatched});
      if(chooserEvents.length>1)throw fail('UPLOAD_CHOOSER_AMBIGUOUS','More than one chooser opened; no automatic retry.',{dispatched});
    };
    const guard=createFrameOperation({deadline,assertRunning:check,timeoutCode:'UPLOAD_INTERRUPTED',timeoutMessage:'Upload timed out; inspect current state before retrying.'});
    const bounded=operation=>guard.run(operation);
    const send=(method,params)=>bounded(()=>chrome.debugger.sendCommand(isolated.source,method,params));
    try{
      // File paths/metadata are deliberately omitted from page script arguments.
      const {paths,_uploadFiles,...target}=selection;
      let prepared,resolved;
      if(args.chooser){
        listener=(source,method,event)=>{
          if(chooserArmed&&source.tabId===tabId&&sourceKey(source)===sourceKey(isolated.source)&&method==='Page.fileChooserOpened'&&event.frameId===isolated.auxData.frameId)chooserEvents.push(event);
        };
        chrome.debugger.onEvent.addListener(listener);
        intercepted=true;await send('Page.setInterceptFileChooserDialog',{enabled:true});
        // Native pointer reuses exact frame, retained ref, hit-testing and focus guards.
        await bounded(()=>executeFramePointer(chrome,tabId,'click',target,ensureCdpAttached,{assertRunning:()=>guard.check(),beforePress:()=>{guard.check();chooserArmed=true;dispatched=true;}}));
        while(!chooserEvents.length){await bounded(()=>new Promise(resolve=>setTimeout(resolve,25)));}
        check();chooserOpened=true;
        const event=chooserEvents[0];
        if(!Number.isInteger(event.backendNodeId)||event.backendNodeId<=0)throw fail('UPLOAD_CHOOSER_UNSUPPORTED','Chooser has no native file input; File System Access pickers are unsupported.');
        resolved=await send('DOM.resolveNode',{backendNodeId:event.backendNodeId,executionContextId:isolated.id,objectGroup:group});
        resolved={result:resolved.object};
        if(!resolved.result?.objectId)throw fail('UPLOAD_TARGET_CHANGED','The chooser input is unavailable.');
        const captured=await send('Runtime.callFunctionOn',{objectId:resolved.result.objectId,functionDeclaration:retainChooserInput.toString(),arguments:[{value:token},{value:deadline},{value:!!args.directory},{value:_uploadFiles.length}],returnByValue:true});
        prepared={result:captured.result?.value};
      }else{
        prepared=await bounded(()=>executeFrameScript(chrome,tabId,selection,runBrowserPageCommand,['upload-target',{...target,uploadToken:token,uploadDeadline:deadline,fileCount:_uploadFiles.length}]));
        resolved=await send('Runtime.evaluate',{expression:`globalThis[${JSON.stringify(token)}]?.node`,uniqueContextId:isolated.uniqueId,objectGroup:group});
      }
      if(!prepared.result?.ok)throw fail(prepared.result?.error?.code||'ELEMENT_NOT_FOUND',prepared.result?.error?.message||'The file input is unavailable.');
      if(resolved.exceptionDetails||!resolved.result?.objectId)throw fail('UPLOAD_TARGET_CHANGED','The retained upload target is no longer available.');
      const objectId=resolved.result.objectId;
      const inspect=async phase=>{
        const result=await send('Runtime.callFunctionOn',{objectId,functionDeclaration:inspectUploadTarget.toString(),arguments:[{value:token},{value:phase},{value:phase==='after'?_uploadFiles:[]}],returnByValue:true});
        if(result.exceptionDetails||!result.result?.value?.ok)throw fail(result.result?.value?.error?.code||'UPLOAD_VERIFICATION_FAILED',result.result?.value?.error?.message||'The retained file input could not be verified.',{dispatched});
        return result.result.value;
      };
      if(!args.chooser&&typeof args.ref==='string'&&args.ref.startsWith('ax:'))await bounded(()=>validateBrowserAxReference(chrome,tabId,selection,ensureCdpAttached,'upload'));
      await inspect('before');check();
      // Object identity belongs to the selected target session, including OOPIFs.
      await bounded(()=>{dispatched=true;return chrome.debugger.sendCommand(isolated.source,'DOM.setFileInputFiles',{objectId,files:paths});});
      // Chromium enumerates directory contents asynchronously. Poll only the
      // retained input, never repeat setFileInputFiles or the chooser trigger.
      let verified;
      while(true){try{verified=await inspect('after');break;}catch(error){if(!args.directory||error.code!=='UPLOAD_VERIFICATION_FAILED')throw error;await bounded(()=>new Promise(resolve=>setTimeout(resolve,50)));}}
      return{completed:true,verified:true,count:verified.count,directory:!!args.directory,chooserOpened,...prepared.result.data,frameId:selected.frameId,documentId:selected.documentId};
    }catch(error){
      if(error.code)throw Object.assign(error,{details:{...error.details,dispatched}});
      throw fail('UPLOAD_INTERRUPTED','The upload was interrupted. Its page events may have happened; inspect state before retrying.',{dispatched});
    }finally{
      if(listener)chrome.debugger.onEvent.removeListener(listener);
      if(intercepted)await settleFrameCleanup(()=>chrome.debugger.sendCommand(isolated.source,'Page.setInterceptFileChooserDialog',{enabled:false}));
      await settleFrameCleanup(()=>executeFrameScript(chrome,tabId,{frameId:selected.frameId,documentId:selected.documentId},function(name){delete globalThis[name];},[token]));
      await settleFrameCleanup(()=>chrome.debugger.sendCommand(isolated.source,'Runtime.releaseObjectGroup',{objectGroup:group}));
    }
  });
}
