import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

export async function verifyDiagnostics({ cli, root, record, passed, browser, launchSecond }) {
  const requests=[], held=new Map();
  const server=http.createServer((req,res)=>{
    const route=new URL(req.url,'http://localhost').pathname;requests.push(route);res.setHeader('cache-control','no-store');
    if(route==='/worker.js'){res.setHeader('content-type','application/javascript');res.end("fetch('/dedicated-fetch').then(r=>r.text()).then(postMessage)");}
    else if(route==='/sw.js'){res.setHeader('content-type','application/javascript');res.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/via-sw')e.respondWith(new Response('example-sw'))});self.addEventListener('message',e=>e.waitUntil(fetch('/service-worker-fetch').then(r=>r.text()).then(v=>e.source.postMessage(v))))");}
    else if(route==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>Example diagnostic fixture</title><h1>Public example</h1>');}
    else if(['/stream','/long'].includes(route)){res.setHeader('content-type',route==='/stream'?'text/event-stream':'application/json');res.write(route==='/stream'?'data: example-first\n\n':'{"example":"example-first');held.set(route,res);res.on('close',()=>held.delete(route));}
    else if(route==='/fail'){res.setHeader('content-length','10000');res.write('example-partial');setTimeout(()=>res.destroy(),30);}
    else res.end('example-complete');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`,session='u06-example';
  const bc=(command,args={})=>cli(`browser.${command}`,{session,...args});
  const exportTo=async(name,taskId,extra={})=>{
    const directory=path.join(root,name);const result=await cli('exploration.export',{taskId,directory,...extra});
    assert.equal(result.ok,true);const receipt=JSON.parse(await fs.readFile(path.join(directory,'receipt.json')));
    assert.equal(receipt.currentEffectVerified,false);assert.equal(receipt.replayAllowed,false);
    const text=(await Promise.all((await fs.readdir(directory)).filter(n=>!n.endsWith('.png')).map(n=>fs.readFile(path.join(directory,n),'utf8')))).join('');
    assert.doesNotMatch(text,/example-secret-placeholder|example-other-tab|example-account-placeholder/);
    return{directory,result,receipt};
  };
  try{
    const {tabId}=(await bc('open',{url:origin})).data;
    const taskId=(await cli('exploration.start',{tabId,goal:'Observe public diagnostics',requestId:'example-u06'})).data.taskId;
    for(let i=0;i<100;i++){const state=(await cli('exploration.get',{taskId})).data;if(!['collecting','created'].includes(state.status))break;await new Promise(r=>setTimeout(r,100));}
    // The independent page can produce events but is never included in export.
    await cli('browser.open',{session:'u06-other',url:origin+'/other'});
    await cli('browser.eval',{session:'u06-other',expression:"console.error('example-other-tab');fetch('/other-request').then(()=>true)"});
    await bc('eval',{expression:`(async()=>{
      console.error('example-secret-placeholder');await fetch('/page-fetch?token=example-secret-placeholder').then(r=>r.text());
      await new Promise(resolve=>{const w=new Worker('/worker.js');w.onmessage=()=>{w.terminate();resolve()}});
      await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
      if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));
      await fetch('/via-sw').then(r=>r.text());await new Promise(r=>{navigator.serviceWorker.addEventListener('message',r,{once:true});navigator.serviceWorker.controller.postMessage('example')});
      window.exampleStreams=['/stream','/long'].map(url=>fetch(url).then(r=>r.text()));await fetch('/fail').then(r=>r.text()).catch(()=>{});return true;
    })()`});
    const events=(await bc('events',{channel:'network',all:true,limit:200})).data;
    const route=name=>events.entries.find(e=>new URL(e.url).pathname===name);
    assert.ok(route('/page-fetch'));assert.ok(route('/via-sw'));assert.equal(route('/fail').phase,'failed');
    assert.ok(requests.includes('/dedicated-fetch')&&requests.includes('/service-worker-fetch'));
    assert.equal(route('/dedicated-fetch'),undefined);assert.equal(route('/service-worker-fetch'),undefined);
    assert.equal(route('/stream'),undefined);assert.equal(route('/long'),undefined);
    const detail=(await bc('network',{detail:route('/page-fetch').key})).data;assert.ok(detail.entry.response);
    await record('u06-behavior',{serverRequests:[...requests],events,body:detail});
    passed('U06 real extension: page/SW-returned events, independent Worker requests absent, failed event and no unfinished body events');
    const before=requests.length;const artifact=await exportTo('u06-partial',taskId);
    assert.equal(requests.length,before);assert.equal(artifact.receipt.complete,false);assert.equal(artifact.receipt.sections.state.status,'available');
    assert.ok(artifact.receipt.sections.network.count>0&&artifact.receipt.sections.console.count===1);
    assert.equal(artifact.receipt.sections.screenshot.status,'not-selected');
    assert.equal((await cli('exploration.export',{taskId,directory:artifact.directory},false)).error.code,'EXPORT_DESTINATION_EXISTS');
    passed('U06 unified partial artifact: selected context only, default redaction, zero requests, no overwrite');
    const shot=await exportTo('u06-screenshot',taskId,{screenshot:true});
    assert.equal(shot.receipt.sections.screenshot.status,'available');assert.equal((await fs.readFile(path.join(shot.directory,'screenshot.png'))).subarray(1,4).toString(),'PNG');
    assert.equal(requests.length,before);passed('U06 explicit task viewport screenshot without replay or extra network');
    for(const [name,response] of held)response.end(name==='/stream'?'data: example-last\n\n':'example-last"}');
    await bc('eval',{expression:'Promise.all(window.exampleStreams).then(()=>true)'});
    const ended=(await bc('events',{channel:'network',all:true,limit:200})).data;
    for(const name of ['/stream','/long']){const event=ended.entries.find(e=>new URL(e.url).pathname===name);assert.equal(event.phase,'complete');const body=(await bc('network',{detail:event.key})).data.entry.response;if(name==='/stream')assert.equal(body.omitted,true);else assert.ok(JSON.stringify(body).includes('example-last'));}
    passed('U06 completed long JSON body readable; completed non-JSON SSE remains explicitly omitted by existing redaction');
    const count=requests.length;const again=await exportTo('u06-limit',taskId,{limit:1});assert.equal(again.receipt.sections.network.truncated,true);assert.equal(requests.length,count);
    await cli('browser.close',{session});
    const closed=await exportTo('u06-closed-tab',taskId);assert.equal(closed.receipt.sections.state.status,'failed');assert.equal(closed.receipt.complete,false);
    passed('U06 row truncation, closed task tab and partial failure retained without a fallback tab');
    const profiles=(await cli('profile.list')).data.profiles,existing=new Set(profiles.map(p=>p.contextId));
    const second=await launchSecond();
    try{
      let other;
      for(let i=0;i<40;i++){other=(await cli('profile.list')).data.profiles.find(p=>p.online&&!existing.has(p.contextId));if(other)break;await new Promise(r=>setTimeout(r,100));}
      assert.ok(other);const directory=path.join(root,'u06-wrong-profile');
      const wrong=await cli('exploration.export',{taskId,directory},false,other.contextId);
      assert.equal(wrong.error.code,'TASK_NOT_FOUND');await assert.rejects(fs.access(directory));
      passed('U06 explicit second live profile cannot read or export the first profile task');
    }finally{await second.close();}
  }finally{for(const response of held.values())response.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
