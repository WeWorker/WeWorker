import assert from 'node:assert/strict';
import http from 'node:http';

/** Public loopback fixtures through the actual CLI, Bridge and extension. */
export async function verifyFrameWorkflow({ cli, browser, record, passed, stopBridge, startBridge }) {
  const worker = browser.serviceWorkers()[0];
  await worker.evaluate(() => {
    globalThis.frameDiagnostics = { pending: {}, recent: [], events: [], failures: [] };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      try { const message=JSON.parse(data); if(message.result?.ok===false || message.result?.passed===false) {frameDiagnostics.failures.push(message);if(frameDiagnostics.failures.length>10)frameDiagnostics.failures.shift();} } catch {}
      return send.call(this,data);
    };
    const original = chrome.debugger.sendCommand.bind(chrome.debugger); let sequence = 0;
    chrome.debugger.sendCommand = async (...args) => {
      const id = ++sequence, row = { id, source: args[0], method: args[1], at: Date.now() };
      frameDiagnostics.pending[id] = row;
      try { return await original(...args); }
      catch (error) { row.error = error.message; throw error; }
      finally { delete frameDiagnostics.pending[id]; frameDiagnostics.recent.push(row); if(frameDiagnostics.recent.length>100)frameDiagnostics.recent.shift(); }
    };
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if(!['Page.frameNavigated','Page.navigatedWithinDocument','Target.attachedToTarget','Target.detachedFromTarget'].includes(method))return;
      frameDiagnostics.events.push({source,method,params});if(frameDiagnostics.events.length>50)frameDiagnostics.events.shift();
    });
  });
  const requests = [], sessions = [];
  let origin, childOrigin, drift = false, revision = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('cache-control', 'no-store'); res.setHeader('content-type', 'text/html; charset=utf-8');
    const field = drift ? 'changedResult' : 'publicResult';
    if (url.pathname === '/host') {
      requests.push({ path: '/host' });
      res.end(`<!doctype html><h1>Public frame host</h1><iframe id="decoy" src="${childOrigin}/outer"></iframe><iframe id="owner" style="width:800px;height:500px" src="${childOrigin}/outer"></iframe>`); return;
    }
    if (url.pathname === '/outer') {
      res.end(`<!doctype html><h1>Outer frame</h1><iframe id="leaf" style="width:700px;height:400px" src="${origin}/child"></iframe>`); return;
    }
    if (url.pathname === '/data') {
      const category = url.searchParams.get('category'), page = Number(url.searchParams.get('page'));
      requests.push({ path: '/data', category, page });
      res.setHeader('content-type', 'application/json');
      setTimeout(() => res.end(JSON.stringify({ category, page, items: [{ id: String(page) }], hasNext: page < (category === 'single' ? 1 : 3), revision: ++revision })), category === 'slow' ? 5000 : 100); return;
    }
    if (url.pathname === '/child') {
      res.end(`<!doctype html><h1>Public child</h1><form action="/destination"><input id="search" type="search" name="item" aria-label="Search items"><button id="submit">Search</button></form><select id="category" aria-label="Category">${['initial','many','single','slow'].map(x => '<option>'+x+'</option>').join('')}</select><button id="next">Next page</button>
        <script>let page=0;window.${field}={category:'initial',page:0,items:[],hasNext:false,revision:0};
        async function load(){window.${field}=await(await fetch('/data?category='+document.querySelector('#category').value+'&page='+page)).json()}
        document.querySelector('#category').onchange=()=>{page=1;load()};document.querySelector('#next').onclick=()=>{page++;load()};</script>`); return;
    }
    if (url.pathname === '/destination') {
      const item = url.searchParams.get('item'); requests.push({ path: '/destination', item });
      if (item === 'redirect') { res.writeHead(302, { location: origin + '/unexpected' }); res.end(); return; }
      res.end(`<!doctype html><h1>Destination</h1><script>window.${field}={item:${JSON.stringify(item)},revision:${++revision}};</script>`); return;
    }
    if (url.pathname === '/hash') {
      requests.push({ path: '/hash' });
      res.end(`<!doctype html><h1>Hash child</h1><script>window.${field}={item:'initial',revision:0};
        async function load(){window.${field}=await(await fetch('/hash-data?item='+encodeURIComponent(decodeURIComponent(location.hash.slice(1))))).json()}
        addEventListener('hashchange',load);load();</script>`); return;
    }
    if (url.pathname === '/hash-data') {
      const item = url.searchParams.get('item'); requests.push({ path: '/hash-data', item });
      res.setHeader('content-type','application/json'); res.end(JSON.stringify({ item, revision: ++revision })); return;
    }
    res.end('<!doctype html><h1>Unexpected destination</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port; childOrigin = 'http://localhost:' + server.address().port;
  const frames = [{ selector: '#owner', origin: childOrigin, pathname: '/outer' }, { selector: '#leaf', origin, pathname: '/child' }];
  const result = field => ({ strategy: 'DOM_STATE', path: [field] });
  const sourceFor = (kind, field = 'publicResult') => {
    const steps = [
      { pathname: '/host', query: { mode: 'navigate', resultPathname: '/host', result: { strategy: 'UI_SELECTOR', selector: 'h1', fields: { title: {} } } } },
      { frames, pathname: '/child', query: { mode: 'read', result: result(field) } },
      { frames: [{ ...frames[0], selector: '#decoy' }, frames[1]], pathname: '/child', query: { mode: 'read', result: result(field) } },
    ];
    if (kind === 'control') steps.push(
      { frames, pathname: '/child', query: { mode: 'filter', resultPathname: '/child', trigger: { kind: 'filter', selector: '#category', parameter: 'category', description: 'Public category' }, matchResult: { category: 'category' }, result: result(field) } },
      { frames, pathname: '/child', when: { path: 'hasNext', equals: true }, repeat: { maxIterations: 3, until: { path: 'hasNext', equals: false }, collect: { path: 'items', identityPath: 'id', maxItems: 4, includePrevious: true } }, query: { mode: 'filter', resultPathname: '/child', trigger: { kind: 'pagination', selector: '#next' }, result: result(field) } },
    );
    else {
      const query = ['query','enter'].includes(kind)
        ? { trigger: { kind: 'search', selector: '#search', parameter: 'item', description: 'Public item', ...(kind==='enter'?{pressEnter:true}:{submitSelector:'#submit'}) }, resultPathname: '/destination', matchQuery: { item: 'item' }, result: result(field) }
        : kind === 'hash'
        ? { mode: 'navigate', resultOrigin: childOrigin, resultPathname: '/hash', hashNavigation: { template: ':id', pathParameters: [{ segmentIndex: 0, name: 'item', description: 'Public item' }], matchResult: { item: 'item' }, freshnessPath: 'revision', sameTarget: 'reload' }, result: result(field) }
        : { mode: 'navigate', resultOrigin: childOrigin, resultPathname: '/destination', queryParameters: [{ name: 'item', queryKey: 'item', description: 'Public item' }], result: result(field) };
      steps.push({ frames, pathname: '/child', query });
      if (kind === 'hash') steps.push({ frames, origin: childOrigin, pathname: '/hash', query: { ...query } });
      steps.push({ pathname: '/host', query: { mode: 'read', result: { strategy: 'UI_SELECTOR', selector: 'h1', fields: { title: {} } } } });
      steps.push({ frames, ...(!['query','enter'].includes(kind)?{origin:childOrigin}:{}), pathname: query.resultPathname, query: { mode: 'read', result: result(field) } });
    }
    return { mode: 'workflow', timeoutMs: 30000, steps };
  };
  const settle = async taskId => {
    for (let i=0;i<160;i++) { const state=(await cli('exploration.get',{taskId})).data; if(!['collecting','validating','installing'].includes(state.status))return state; await new Promise(r=>setTimeout(r,200)); }
    throw Error('Frame task did not settle');
  };
  const open = async (name, allowed = true) => {
    const session='example-frame-'+name; sessions.push(session);
    const tabId=(await cli('browser.open',{session,url:origin+'/host'})).data.tabId;
    const taskId=(await cli('exploration.start',{tabId,goal:'Read public nested frame results',requestId:session,...(allowed?{allowedOrigins:[childOrigin]}:{})})).data.taskId;
    await settle(taskId);return {session,tabId,taskId};
  };
  const observe = async (taskId, source, values) => {
    await cli('exploration.query',{taskId,source,values,reason:'Explicit public nested frame read'});
    const state=await settle(taskId);await record('frame-observation',state);assert.equal(state.status,'evidence_ready',JSON.stringify(state));
    return (await cli('exploration.evidence',{taskId})).data;
  };
  try {
    const denied=await open('denied',false), before=requests.length;
    await cli('exploration.query',{taskId:denied.taskId,source:sourceFor('control'),values:{category:'many'},reason:'Undeclared ancestor refusal'});
    assert.equal((await settle(denied.taskId)).error.code,'PAGE_ORIGIN_NOT_ALLOWED'); assert.equal(requests.length,before);
    passed('frame ancestor permissions rejected before any workflow action');
    const only = process.argv.find(x=>x.startsWith('--frame-kind='))?.slice(13);
    for (const kind of only ? [only] : ['control','query','enter','navigation','hash']) {
      const {taskId,tabId}=await open(kind), values=kind==='control'?{category:'many'}:{item:'007'};
      const evidence=await observe(taskId,sourceFor(kind),values);
      const plan={tools:[{name:'read_frame_'+kind,risk:'read',strategy:'UI_SELECTOR',sourcePageId:evidence.pageSources[0].id,readReason:'Public nested read'}]};
      const tool=(await cli('exploration.generate',{taskId,plan})).data.toolNames[0];
      const cases=(kind==='control'?['many','single']:['007','示例']).map((value,i)=>({id:'frame-'+i,args:kind==='control'?{category:value}:{item:value},expect:{equals:kind==='control'?{'data.category':value,'data.hasNext':false,'workflow.collections.0.items.0.id':'1'}:{'data.item':value}}}));
      const verification=(await cli('exploration.verification-read',{taskId,tool})).data;
      await cli('exploration.verification-write',{taskId,tool,expectedHash:verification.hash,cases});
      if(kind==='navigation'){await stopBridge();await startBridge();}
      await cli('exploration.validate',{taskId}); const verified=await settle(taskId); await record('frame-'+kind+'-validation',verified);assert.equal(verified.status,'review_ready',JSON.stringify(verified));
      const review=(await cli('exploration.review',{taskId})).data;assert.ok(review.permissions.some(x=>x.includes('#owner')&&x.includes(childOrigin)));
      await cli('exploration.install',{taskId,reviewId:review.reviewId,confirmed:true});assert.equal((await settle(taskId)).status,'installed');
      for(const value of kind==='control'?['many','single','many']:['009','009','示例']) {
        const before=requests.length, actual=await cli(tool,kind==='control'?{category:value}:{item:value});assert.equal(actual.ok,true,JSON.stringify(actual));
        assert.equal(requests.slice(before).filter(x=>x.path==='/host').length,1);
        if(kind==='control') {assert.deepEqual(actual.workflow.collections[0].items.map(x=>x.id),value==='single'?['1']:['1','2','3']);assert.deepEqual(requests.slice(before).filter(x=>x.path==='/data').map(x=>x.page),value==='single'?[1]:[1,2,3]);}
        else {assert.equal(actual.data.item,value);assert.equal(requests.slice(before).filter(x=>x.path===(kind==='hash'?'/hash':'/destination')).length,kind==='hash'?2:1);}
      }
      const known=(await cli('exploration.knowledge-read',{site:review.name})).data;await cli('exploration.knowledge-save',{taskId,expectedHash:known.hash});
      assert.ok(JSON.stringify((await cli('exploration.knowledge-read',{site:review.name})).data).includes('#owner'));
      passed('frame '+kind+': nested duplicate owners, author cases, validate/install/call/knowledge, retained parent and repeated calls');
      if(kind==='navigation'){const start=requests.length,bad=await cli(tool,{item:'redirect'},false);assert.equal(bad.ok,false);assert.equal(requests.slice(start).filter(x=>x.path==='/destination').length,1);passed('frame undeclared redirect refuses remaining steps without replay');}
      if(kind==='control') {
        drift=true;
        const repairId=(await cli('exploration.start',{tabId,goal:'Repair public frame extraction',requestId:'example-frame-repair',allowedOrigins:[childOrigin]})).data.taskId;await settle(repairId);
        const fresh=await observe(repairId,sourceFor(kind,'changedResult'),values),info=(await cli('exploration.repair-info',{site:review.name})).data;
        await cli('exploration.repair',{taskId:repairId,site:review.name,expectedDigest:info.digest,plan:{tools:[{...plan.tools[0],name:'read-frame-control',sourcePageId:fresh.pageSources[0].id}]}});
        const file='extension/commands/read-frame-control.js',old=(await cli('exploration.draft-read',{taskId:repairId,file})).data;
        const beforeAlteration=requests.length;
        await cli('exploration.draft-write',{taskId:repairId,file,expectedHash:old.hash,content:old.content.replaceAll('#owner','#decoy')});
        await cli('exploration.validate',{taskId:repairId});assert.equal((await settle(repairId)).status,'draft');
        assert.equal(requests.length,beforeAlteration,'Changing an owner without its manifest must fail before navigation');
        const altered=(await cli('exploration.draft-read',{taskId:repairId,file})).data;
        await cli('exploration.draft-write',{taskId:repairId,file,expectedHash:altered.hash,content:old.content.replaceAll('publicResult','changedResult')});
        await cli('exploration.validate',{taskId:repairId});const fixedState=await settle(repairId);assert.equal(fixedState.status,'review_ready',JSON.stringify(fixedState));
        const fixed=(await cli('exploration.review',{taskId:repairId})).data;await cli('exploration.install',{taskId:repairId,reviewId:fixed.reviewId,confirmed:true});assert.equal((await settle(repairId)).status,'installed');
        assert.equal((await cli(tool,{category:'many'})).data.page,3);drift=false;
        passed('frame extraction repair retains owner/action permissions and revalidates authored cases');
      }
    }
    {
      const {taskId,session}=await open('preview-cancel');
      const evidence=await observe(taskId,sourceFor('control'),{category:'many'});
      const tool=(await cli('exploration.generate',{taskId,plan:{tools:[{name:'cancel_frame',risk:'read',strategy:'UI_SELECTOR',sourcePageId:evidence.pageSources[0].id,readReason:'Public frame cancellation'}]}})).data.toolNames[0];
      const verification=(await cli('exploration.verification-read',{taskId,tool})).data;
      await cli('exploration.verification-write',{taskId,tool,expectedHash:verification.hash,cases:['slow','many'].map((category,i)=>({id:'frame-cancel-'+i,args:{category},expect:{equals:{'data.category':category}}}))});
      const before=requests.length;await cli('exploration.validate',{taskId});
      for(let i=0;i<150&&!requests.slice(before).some(x=>x.path==='/data');i++)await new Promise(r=>setTimeout(r,50));
      assert.deepEqual(requests.slice(before).filter(x=>x.path==='/data').map(x=>x.category),['slow']);
      await cli('exploration.cancel',{taskId});await new Promise(r=>setTimeout(r,5500));
      assert.equal((await cli('exploration.get',{taskId})).data.status,'cancelled');
      await cli('browser.get',{session,selector:'h1',property:'text'});
      assert.equal(requests.slice(before).filter(x=>x.path==='/host').length,1);
      assert.equal(requests.slice(before).filter(x=>x.path==='/data').length,1);
      passed('frame author validation cancellation stops remaining iterations and the next case');
    }
    for(const kind of ['cancel','restart','replace','leaf-replace','timeout']) {
      const {taskId}=await open(kind),before=requests.length;
      const source=sourceFor('control');if(kind==='timeout')source.steps.find(x=>x.query.trigger?.parameter).query.timeoutMs=1000;
      await cli('exploration.query',{taskId,source,values:{category:'slow'},reason:'Interrupted frame read'});
      for(let i=0;i<150&&!requests.slice(before).some(x=>x.path==='/data');i++)await new Promise(r=>setTimeout(r,50));
      assert.equal(requests.slice(before).filter(x=>x.path==='/data').length,1);
      if(kind==='cancel')await cli('exploration.cancel',{taskId});
      else if(kind==='restart'){await stopBridge();await startBridge();}
      else if(kind!=='timeout') {
        const pages=browser.pages().filter(x=>x.url()===origin+'/host'),page=pages.at(-1);
        if(kind==='leaf-replace')await page.locator('#owner').contentFrame().locator('#leaf').evaluate(owner=>owner.replaceWith(owner.cloneNode(true)));
        else await page.evaluate(()=>{const owner=document.querySelector('#owner');owner.replaceWith(owner.cloneNode(true));});
      }
      await new Promise(r=>setTimeout(r,5500));
      const state=await settle(taskId);assert.equal(state.status,kind==='cancel'?'cancelled':kind==='restart'?'interrupted':'failed',JSON.stringify(state));
      if(kind==='timeout')assert.equal(state.error.code,'PAGE_QUERY_TIMEOUT');
      assert.equal(requests.slice(before).filter(x=>x.path==='/data').length,1);assert.equal((await cli('exploration.evidence',{taskId})).data.pageSources.length,0);
      passed('frame '+kind+': late data discarded, no remaining action or replay');
    }
  } finally {
    await record('frame-diagnostics',await worker.evaluate(()=>globalThis.frameDiagnostics).catch(()=>null));
    await record('frame-requests',requests);
    for(const session of sessions)await cli('browser.close',{session}).catch(()=>{});
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }
}
