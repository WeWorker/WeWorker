#!/usr/bin/env node
// Foundation probe only: does not claim generated frame workflow support.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const playwrightPath=process.argv.find(x=>x.startsWith('--playwright='))?.slice(13);
const executablePath=process.argv.find(x=>x.startsWith('--chromium='))?.slice(11);
const loadViaCdp=process.argv.includes('--load-via-cdp');
const extensionSource=process.argv.find(x=>x.startsWith('--extension='))?.slice(12)||path.join(repo,'weworker/build/extension-dist');
const {chromium}=await import(playwrightPath?pathToFileURL(playwrightPath).href:'playwright');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'weworker-frame-identity-'));
console.log(root);
async function bounded(operation, milliseconds, message) {
 let timer;
 try { return await Promise.race([operation, new Promise((_, reject) => { timer=setTimeout(()=>reject(Error(message)),milliseconds); })]); }
 finally { clearTimeout(timer); }
}
const extension=path.join(root,'extension');
await fs.cp(extensionSource,extension,{recursive:true});
// Exercise one coherent prepared extension; do not overlay newer source files
// on an older build (including their transitive imports).
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
const workerFile=path.join(extension,'background/service-worker.js');await fs.writeFile(workerFile,"import { withBrowserFrameContext, beginBrowserFrames, executeFrameScript } from './browser-frames.js'; import {resolvePageFrame} from './page-frame-context.js'; globalThis.__frameProbe={withBrowserFrameContext,beginBrowserFrames,ensureCdpAttached,executeFrameScript,resolvePageFrame};\n"+(await fs.readFile(workerFile,'utf8')).replaceAll('3711',String(reserve.address().port)));
let browser, worker, fixtureDocuments;
const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');const origin='http://localhost:'+server.address().port;
 if(req.url==='/loading'){res.writeHead(200);res.write('<!doctype html><h1>Loading</h1>');return;}
 res.end(req.url==='/entry'?`<!doctype html><iframe id="chosen" src="${origin}/child"></iframe><iframe id="other" src="${origin}/child"></iframe>`:req.url==='/child'?`<!doctype html><h1>Child</h1><iframe id="nested" src="http://127.0.0.1:${server.address().port}/leaf"></iframe>`:'<!doctype html><h1>Leaf</h1>');
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{
 browser=await chromium.launchPersistentContext(path.join(root,'profile'),{headless:true,executablePath,ignoreDefaultArgs:['--disable-extensions'],args:loadViaCdp?['--enable-unsafe-extension-debugging']:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 if(loadViaCdp){const session=await browser.browser().newBrowserCDPSession();await session.send('Extensions.loadUnpacked',{path:extension});await session.detach();}
 const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/entry');
 worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker',{timeout:10000});
 const output=await bounded(worker.evaluate(async()=>{
  const stage=value=>{globalThis.__frameProbeStage=value;};
  const pending=globalThis.__frameProbePending={},recent=globalThis.__frameProbeRecent=[];let sequence=0;
  for(const [api,name] of [[chrome.debugger,'sendCommand'],[chrome.scripting,'executeScript']]){
   const original=api[name].bind(api);
   api[name]=async(...args)=>{
    const id=++sequence,started=Date.now();
    const entry={stage:globalThis.__frameProbeStage,api:name,method:name==='sendCommand'?args[1]:undefined,sessionId:args[0]?.sessionId,allFrames:args[0]?.target?.allFrames,injectImmediately:args[0]?.injectImmediately,frameIds:args[0]?.target?.frameIds,documentIds:args[0]?.target?.documentIds};
    pending[id]=entry;
    try{const result=await original(...args);if(name==='sendCommand'&&args[1]==='Runtime.evaluate'){entry.context=args[2]?.uniqueContextId;entry.matched=result.result?.value===true;}if(name==='executeScript')entry.documents=result.map(row=>({frameId:row.frameId,documentId:row.documentId}));return result;}finally{recent.push({...entry,elapsedMs:Date.now()-started});if(recent.length>30)recent.shift();delete pending[id];}
   };
  }
  stage('map owner identities');
  const {withBrowserFrameContext,beginBrowserFrames,ensureCdpAttached,executeFrameScript,resolvePageFrame}=globalThis.__frameProbe;
  const tab=(await chrome.tabs.query({})).find(t=>t.url?.endsWith('/entry'));
  await ensureCdpAttached(tab.id);await beginBrowserFrames(chrome,tab.id);
  const frames=await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},func:()=>({url:location.href})});
  const rows=[];
  for(const f of frames)await withBrowserFrameContext(chrome,tab.id,f,async()=>{},async({isolated,context})=>{
   const row={frameId:f.frameId,documentId:f.documentId,cdpFrameId:isolated.auxData.frameId,session:isolated.source.sessionId||'',url:f.result.url,owners:[]};
   for(const selector of ['#chosen','#other','#nested']){
    const object=await chrome.debugger.sendCommand(isolated.source,'Runtime.evaluate',{expression:`document.querySelector(${JSON.stringify(selector)})`,uniqueContextId:isolated.uniqueId});
    if(!object.result?.objectId)continue;
    const {node}=await chrome.debugger.sendCommand(isolated.source,'DOM.describeNode',{objectId:object.result.objectId});
    row.owners.push({selector,nodeName:node.nodeName,frameId:node.frameId,contentFrameId:node.contentDocument?.frameId,backendNodeId:node.backendNodeId});
    await chrome.debugger.sendCommand(isolated.source,'Runtime.releaseObject',{objectId:object.result.objectId});
   }rows.push(row);
  });
  const origin=new URL(tab.url).origin,cross=origin.replace('127.0.0.1','localhost');
  const path=[{selector:'#chosen',origin:cross,pathname:'/child'},{selector:'#nested',origin,pathname:'/leaf'}];
  stage('resolve selected frame');
  const pinned=await resolvePageFrame({chrome,tabId:tab.id,frames:path,ensureCdpAttached});
  await pinned.assertCurrent();
  const leaf=await executeFrameScript(chrome,tab.id,pinned.selected,()=>document.querySelector('h1').textContent,[]);
  if(leaf.result!=='Leaf')throw Error('Wrong leaf');
  let ambiguous;try{await resolvePageFrame({chrome,tabId:tab.id,frames:[{selector:'iframe',origin:cross,pathname:'/child'}],ensureCdpAttached});}catch(e){ambiguous=e.code;}
  if(ambiguous!=='PAGE_FRAME_TARGET_CHANGED')throw Error('Ambiguous owner was not refused');
  globalThis.__frameProbeState={tab,path,pinned};
  return {rows,checks:{read:leaf.result,ambiguous}};
 }),45000,'Frame foundation probe exceeded its 45 second budget.');
 // Fixture mutations use the test driver's connection. The extension under
 // test only resolves/validates identities; its injection timing must not be
 // used to decide when a replacement fixture has finished loading.
 page.setDefaultTimeout(10000);
 const stage=async value=>worker.evaluate(value=>{globalThis.__frameProbeStage=value;},value);
 const run=async(label,fn)=>{await stage(label);return bounded(worker.evaluate(fn),35000,`${label} exceeded its 35 second budget.`);};
 const waitForFixture=async loading=>{
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){
   const documents=await bounded(worker.evaluate(async()=>chrome.scripting.executeScript({target:{tabId:globalThis.__frameProbeState.tab.id,allFrames:true},injectImmediately:true,world:'ISOLATED',func:()=>({pathname:location.pathname,ready:document.readyState,heading:document.querySelector('h1')?.textContent})})),3000,'Fixture readiness query timed out.');
   fixtureDocuments=documents;
   if(loading?documents.some(row=>row.result.pathname==='/loading'&&row.result.heading==='Loading'):
    documents.length===5&&documents.every(row=>row.result.ready==='complete')&&documents.filter(row=>row.result.pathname==='/leaf'&&row.result.heading==='Leaf').length===2)return;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error('Fixture documents did not become ready within 10 seconds.');
 };
 await stage('create unrelated loading fixture');
 await page.evaluate(()=>{const frame=document.createElement('iframe');frame.id='loading';frame.src='/loading';document.body.append(frame);});
 await waitForFixture(true);
 await run('resolve with unrelated loading frame',async()=>{
  const {tab,path}=globalThis.__frameProbeState,{resolvePageFrame,ensureCdpAttached}=globalThis.__frameProbe;
  const pinned=await resolvePageFrame({chrome,tabId:tab.id,frames:path,ensureCdpAttached});
  await pinned.assertCurrent();await pinned.release();
 });
 output.checks.unrelatedLoading=true;
 await page.locator('#loading').evaluate(owner=>owner.remove());
 const replaceOwner=async selector=>{
  await stage(`replace fixture ${selector}`);
  await page.locator(selector).evaluate(owner=>owner.replaceWith(owner.cloneNode()));
  await waitForFixture(false);
 };
 await replaceOwner('#other');
 await run('retain selection after unrelated replacement',()=>globalThis.__frameProbeState.pinned.assertCurrent());
 output.checks.unrelatedReplacement=true;
 await replaceOwner('#chosen');
 output.checks.replaced=await run('reject selected same-URL replacement',async()=>{
  const {pinned}=globalThis.__frameProbeState;let code;
  try{await pinned.assertCurrent();}catch(error){code=error.code;}await pinned.release();
  if(!['PAGE_FRAME_DOCUMENT_CHANGED','PAGE_FRAME_TARGET_CHANGED','FRAME_UNAVAILABLE'].includes(code))throw Error('Same URL replacement was not refused: '+code);
  return code;
 });
 await run('resolve after selected replacement',async()=>{
  const state=globalThis.__frameProbeState,{resolvePageFrame,ensureCdpAttached}=globalThis.__frameProbe;
  state.fresh=await resolvePageFrame({chrome,tabId:state.tab.id,frames:state.path,ensureCdpAttached});
 });
 await stage('reload parent fixture');await page.reload({waitUntil:'load',timeout:10000});
 output.checks.parentReplaced=await run('reject replaced parent',async()=>{
  const {fresh}=globalThis.__frameProbeState;let code;
  try{await fresh.assertCurrent();}catch(error){code=error.code;}await fresh.release();
  if(!['PAGE_FRAME_DOCUMENT_CHANGED','FRAME_UNAVAILABLE'].includes(code))throw Error('Parent replacement not refused: '+code);
  return code;
 });
 output.checks.cancelCode=await run('resolve after parent replacement and cancel',async()=>{
  const {tab,path}=globalThis.__frameProbeState,{resolvePageFrame,ensureCdpAttached}=globalThis.__frameProbe;
  let cancelled=false,code;
  const active=await resolvePageFrame({chrome,tabId:tab.id,frames:path,ensureCdpAttached,assertRunning:()=>{if(cancelled)throw Object.assign(Error('Cancelled'),{code:'PAGE_WORKFLOW_CANCELLED'});}});
  cancelled=true;try{await active.assertCurrent();}catch(error){code=error.code;}await active.release();
  if(code!=='PAGE_WORKFLOW_CANCELLED')throw Error('Cancellation was not retained');
  return code;
 });
 const main=output.rows.find(r=>r.frameId===0);assert.equal(main.owners.length,2);
 for(const owner of output.rows.flatMap(r=>r.owners))assert.equal(output.rows.filter(r=>r.cdpFrameId===owner.frameId).length,1,JSON.stringify(owner));
 assert.notEqual(main.owners[0].frameId,main.owners[1].frameId);
 await fs.writeFile(path.join(root,'report.json'),JSON.stringify({passed:true,browserVersion:browser.browser().version(),...output},null,2));
 console.log('PASS owner identities for duplicate URLs and nested cross-origin frames; ambiguity, unrelated replacement, selected/parent same-URL replacement and cancellation',output.rows.length);
}catch(error){
 let diagnostic;try{diagnostic=await bounded(worker?.evaluate(async()=>{const tab=(await chrome.tabs.query({})).find(t=>t.url?.endsWith('/entry'));const state=tab?await globalThis.__frameProbe.beginBrowserFrames(chrome,tab.id):null;return {stage:globalThis.__frameProbeStage,pending:globalThis.__frameProbePending,recent:globalThis.__frameProbeRecent,contexts:state?[...state.contexts.values()].map(({id,uniqueId,auxData,source})=>({id,uniqueId,auxData,source})):[]};}),1000,'Stage read timeout');}catch{}
 await fs.writeFile(path.join(root,'report.json'),JSON.stringify({passed:false,...diagnostic,fixtureDocuments,error:String(error)},null,2));
 throw error;
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await new Promise(r=>reserve.close(r));}
