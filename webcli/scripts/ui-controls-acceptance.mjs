import assert from 'node:assert/strict';
import http from 'node:http';

/** Public loopback effects only; drives generation through ordinary installed calls. */
export async function verifyUiControls({ cli, passed, record, browser }) {
  const values = new Map(), writes = new Map(), secretsSeen = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), label = url.pathname.startsWith('/resources/')?url.pathname.split('/')[2]:url.pathname.split('/').at(-1);
    if(url.pathname.startsWith('/resources/')) {
      const id=decodeURIComponent(url.pathname.split('/').at(-1)),value=values.get(label);
      if(!value||!['007','-9007199254740993123456789','networkurl'].includes(id)){res.writeHead(404);res.end();return;}
      res.setHeader('content-type','application/json');res.end('{"id":'+(id.startsWith('-')?id:JSON.stringify(id))+','+JSON.stringify(value).slice(1));return;
    }
    if(url.pathname.startsWith('/container/')||url.pathname.startsWith('/nested/')) {
      const port=server.address().port,src=url.pathname.startsWith('/container/')?`http://localhost:${port}/nested/${label}`:`http://127.0.0.1:${port}/editor/${label}`;
      res.writeHead(200,{'content-type':'text/html'});res.end(`<iframe id="chosen" src="${src}"></iframe><iframe id="other" src="${src}"></iframe>`);return;
    }
    if (url.pathname.startsWith('/editor/')) {
      const isChoice=label.startsWith('choice')||label==='calendar';
      const choiceValues=label==='calendar'?['2026-10-28','2026-10-29']:['After','Again'];
      const choiceControl='<button id="title" type="button" role="combobox" data-field="title" data-value="Before" aria-controls="choices" aria-expanded="false">Choose</button><div id="choices" role="'+(label==='calendar'?'grid':'listbox')+'" hidden>'+choiceValues.map(value=>'<button type="button" role="'+(label==='calendar'?'gridcell':'option')+'" data-value="'+value+'">'+value+'</button>').join('')+(label==='choiceambiguous'?'<button type="button" role="option" data-value="After">Duplicate</button>':'')+'</div>';
      const control = isChoice ? choiceControl : label.startsWith('date') ? '<input id="title" name="title" type="date" min="2026-01-01" max="2026-12-31">' : label === 'checkbox' ? '<input id="title" type="checkbox" name="title">' : label === 'select' ? '<select id="title" name="title"><option>Before</option><option>After</option><option>Again</option></select>'
        : label === 'custom' ? '<div id="title" role="textbox" contenteditable="true" data-field="title">Before</div>'
        : '<input id="title" aria-label="Title" name="title" value="Before">';
      const html = `<form id="editor" method="post" action="/items/${label}">${control}<input id="marker" name="marker" value="before">${label === 'hidden' ? '<input id="csrf" type="hidden" name="csrf" value="example-page-owned-placeholder">' : ''}<button id="save" type="submit">Save</button></form><p id="receipt" data-marker="before">Public receipt</p>`;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Public controls fixture</title><div id="host"></div><script>
        const root=${label === 'shadow' ? 'document.querySelector("#host").attachShadow({mode:"open"})' : 'document.querySelector("#host")'};
        root.innerHTML=${JSON.stringify(html)};
        const form=root.querySelector('#editor'),title=root.querySelector('#title'),marker=root.querySelector('#marker'),receipt=root.querySelector('#receipt');
        const state={title:'Before',marker:'before'};window.exampleEvents=0;window.exampleSubmits=0;window.exampleClicks=0;
        const read=node=>node.getAttribute('role')==='combobox'?node.getAttribute('data-value'):node.isContentEditable?node.textContent:node.type==='checkbox'?String(node.checked):node.value;
        if(${isChoice}) {
          const popup=root.querySelector('#choices');
          title.addEventListener('click',()=>{popup.hidden=false;title.setAttribute('aria-expanded','true');});
          for(const option of popup.querySelectorAll('button'))option.addEventListener('click',()=>{
            title.setAttribute('data-value',option.getAttribute('data-value'));${label==='choicereplaced'?"title.replaceWith(title.cloneNode(true));":''}popup.hidden=true;title.setAttribute('aria-expanded','false');
            title.dispatchEvent(new Event('input',{bubbles:true}));title.dispatchEvent(new Event('change',{bubbles:true}));
          });
          if(${label==='choicedisabled'})popup.querySelector('button').setAttribute('aria-disabled','true');
        }
        let pending=Promise.resolve();
        function save(){const body={...state};${label === 'hidden' ? "body.csrf=form.querySelector('#csrf').value;" : ''}
          pending=pending.then(async()=>{const response=await fetch(form.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(response.ok)receipt.setAttribute('data-marker',body.marker);});}
        for(const node of [title,marker])for(const event of ['input','change'])node.addEventListener(event,()=>{window.exampleEvents++;state[node===title?'title':'marker']=read(node);${label === 'replace' ? "if(node===title)node.replaceWith(node.cloneNode(true));" : ''}${label === 'automatic' ? 'save();' : ''}});
        root.querySelector('#save').addEventListener('click',()=>window.exampleClicks++);
        form.addEventListener('submit',event=>{${label.endsWith('navigation') ? 'window.exampleSubmits++;' : 'event.preventDefault();window.exampleSubmits++;save();'}});
      </script>`); return;
    }
    if (!url.pathname.startsWith('/items/')&&!url.pathname.startsWith('/state/')) {res.writeHead(404);res.end();return;}
    res.setHeader('content-type','application/json');
    if (req.method === 'POST') {
      let text='';for await(const chunk of req)text+=chunk;
      const body=label.endsWith('navigation')?Object.fromEntries(new URLSearchParams(text)):JSON.parse(text);writes.set(label,(writes.get(label)||0)+1);
      if(label==='hidden') {if(body.csrf!=='example-page-owned-placeholder'){res.writeHead(403);res.end('{}');return;}secretsSeen.add(label);}
      values.set(label,{item:'example-item',title:body.title,marker:body.marker});
      if(label.endsWith('navigation')) {res.setHeader('content-type','text/html');res.end(`<!doctype html><p id="receipt" data-marker="${body.marker}">Public navigation receipt</p>`);return;}
      if(label.startsWith('network')) {res.setHeader('x-resource-id','007');res.setHeader('location','/resources/'+label+'/007');res.end('{"ok":true,"first":-9007199254740993123456789}');return;}
      res.end('{"ok":true}');return;
    }
    res.end(JSON.stringify(values.get(label)||{item:'example-item',title:'Before',marker:'before'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const settle=async taskId=>{for(let i=0;i<400;i++){const state=(await cli('exploration.get',{taskId})).data;if(!['collecting','validating','verifying_write','installing'].includes(state.status))return state;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Controls verification did not settle');};
  try {
    const labels=process.argv.includes('--b02-controls-only')?['date','choice','calendar','dateinvalid','choiceambiguous','choicedisabled','choicereplaced']:process.argv.includes('--ui-results-only')?['network','networkmulti','networkurl','networklocation','networkframe']:process.argv.includes('--ui-contexts-only')?['enter','navigation','frame','framenavigation']:['controlled','automatic','click','shadow','hidden','select','checkbox','custom','replace','enter','navigation','frame','framenavigation','network','networkmulti','networkurl','networklocation','networkframe'];
    for(const label of labels) {
      const inFrame=label.includes('frame'),pagePathname=(inFrame?'/container/':'/editor/')+label;
      const session='public-controls-'+label,tabId=(await cli('browser.open',{session,url:origin+pagePathname})).data.tabId;
      const taskId=(await cli('exploration.start',{tabId,requestId:session,goal:'Verify isolated public input controls',...(inFrame?{allowedOrigins:['http://localhost:'+server.address().port]}:{})})).data.taskId;await settle(taskId);
      const url=origin+'/items/'+label;
      await cli('exploration.declare-write',{taskId,url,method:'POST',bodyKeys:['title','marker'],reason:'Public controlled form action'});
      const sourceApiIndexes=[(await cli('exploration.evidence',{taskId})).data.candidates.findIndex(v=>v.url===url&&v.method==='POST')];
      const uiWrite={version:2,form:'#editor',inputMode:'native-input-change',inputs:[{selector:'#title',name:'title',parameter:'title',...(label.startsWith('date')?{kind:'date'}:label.startsWith('choice')||label==='calendar'?{kind:'choice',popup:'#choices',option:'button'}:label==='checkbox'?{kind:'checkbox'}:label==='select'?{kind:'select'}:label==='custom'?{kind:'contenteditable'}:{})},{selector:'#marker',name:'marker',parameter:'marker'}],
        submit:label==='automatic'?{mode:'none'}:label==='enter'?{selector:'#title',text:'Title',mode:'enter'}:{selector:'#save',text:'Save',mode:label==='click'?'click':'requestSubmit'},confirmation:{selector:'#receipt',attribute:'data-marker',parameter:'marker'},
        ...(label.endsWith('navigation')?{navigation:{url}}:{}),...(inFrame?{frames:[{selector:'#chosen',origin:'http://localhost:'+server.address().port,pathname:'/nested/'+label},{selector:'#chosen',origin,pathname:'/editor/'+label}]}:{}),
        ...(label==='shadow'?{shadowRoots:['#host']}:{}),...(label==='hidden'?{hiddenFields:[{selector:'#csrf',name:'csrf',source:'page'}]}:{})};
      if(label.startsWith('network'))uiWrite.result={source:'network',url,method:'POST',ids:label==='networkmulti'?[{publicId:true,idType:'decimal',responsePath:'first'},{publicId:true,idType:'string',responseSource:{kind:'header',name:'x-resource-id'}}]:[{publicId:true,idType:'string',responseSource:label==='networkurl'?{kind:'url',template:origin+'/items/:id'}:label==='networklocation'?{kind:'header',name:'location',template:origin+'/resources/'+label+'/:id'}:{kind:'header',name:'x-resource-id'}}]};
      const plan={tools:[{name:'controls_'+label,risk:'write',sourceApiKind:'action',sourceApiIndexes,strategy:'UI_SELECTOR',pagePathname,uiWrite,writeReason:'Explicit public test effect',strategyNote:{reason:'Controlled form requires input events',limitations:'Events can save independently; no automatic replay'}}]};
      const generated=(await cli('exploration.generate',{taskId,plan})).data,tool=generated.toolNames[0];
      const representativeArgs={title:label==='dateinvalid'?'2027-01-01':label.startsWith('date')||label==='calendar'?'2026-10-28':label==='checkbox'?'true':'After',marker:'after-'+label};
      const fixture={id:'controls-'+label,representativeArgs,expectedSubmission:{url,method:'POST',body:representativeArgs},effect:{readback:{url:origin+'/state/'+label},identityPath:'item',argumentPaths:{title:'title',marker:'marker'},before:{equals:{item:'example-item',title:'Before',marker:'before'}},after:{equals:{item:'example-item',...representativeArgs}}}};
      if(uiWrite.result) {
        const specs=uiWrite.result.ids.map((id,index)=>({url:origin+'/resources/'+label+'/:id',publicId:true,idType:id.idType,responsePath:uiWrite.result.ids.length===1?'resultId':'resultIds.'+index,identityPath:'id',expect:{equals:representativeArgs}}));
        fixture.effect.resultReadback=specs.length===1?specs[0]:specs;
      }
      const old=(await cli('exploration.write-verification-read',{taskId,tool})).data;
      await cli('exploration.write-verification-write',{taskId,tool,fixture,expectedHash:old.hash});
      await cli('exploration.validate',{taskId});assert.equal((await settle(taskId)).status,'write_review_ready');assert.equal(writes.get(label)||0,0);
      const review=(await cli('exploration.write-review',{taskId,tool})).data;
      assert.equal(review.page.ui.version,2);assert.equal(JSON.stringify(review).includes('example-page-owned-placeholder'),false);
      const args={taskId,tool,reviewId:review.reviewId,confirmed:true};await cli('exploration.write-verify',args);
      const state=await settle(taskId);record('UI controls '+label,state);
      if(['dateinvalid','choiceambiguous','choicedisabled','choicereplaced'].includes(label)){assert.equal(state.writeExecutions[0].status,'uncertain');assert.equal(writes.get(label)||0,0);await cli('exploration.write-verify',args);assert.equal(writes.get(label)||0,0);passed('Popup '+label+' fails without submit or replay');continue;}
      if(label==='replace'){assert.equal(state.writeExecutions[0].status,'uncertain');assert.equal(writes.get(label)||0,0);passed('Controlled rerender replacement stops before another event or submit');continue;}
      assert.equal(state.status,'review_ready',JSON.stringify(state));assert.deepEqual(values.get(label),{item:'example-item',...representativeArgs});
      if(inFrame&&browser) {
        const page=browser.pages().filter(value=>value.url()===origin+pagePathname).at(-1);
        assert.ok(page);
        const selected=page.frameLocator('#chosen').frameLocator('#chosen');
        if(label.endsWith('navigation'))assert.equal(await selected.locator('#receipt').getAttribute('data-marker'),representativeArgs.marker);
        else assert.equal(await selected.locator('#title').inputValue(),representativeArgs.title);
        assert.equal(await page.frameLocator('#chosen').frameLocator('#other').locator('#title').inputValue(),'Before');
        assert.equal(await page.frameLocator('#other').frameLocator('#chosen').locator('#title').inputValue(),'Before');
      }
      const count=writes.get(label);await cli('exploration.write-verify',args);assert.equal(writes.get(label),count);
      if(!label.endsWith('navigation')&&!inFrame) {
        const snapshot=(await cli('browser.eval',{session,expression:'({events:window.exampleEvents,submits:window.exampleSubmits,clicks:window.exampleClicks})'})).data.value;
        assert.equal(snapshot.events,4);assert.equal(snapshot.submits,label==='automatic'?0:1);assert.equal(snapshot.clicks,['click','enter'].includes(label)?1:0);
      }
      if(label==='hidden')assert.ok(secretsSeen.has(label));
      const install=(await cli('exploration.review',{taskId})).data;await cli('exploration.install',{taskId,reviewId:install.reviewId,confirmed:true});assert.equal((await settle(taskId)).status,'installed');
      if(label.endsWith('navigation'))await cli('browser.open',{session:session+'-ordinary',url:origin+pagePathname});
      const ordinaryTitle=label.startsWith('date')||label==='calendar'?'2026-10-29':label==='checkbox'?'false':'Again';
      const ordinary=await cli(tool,{title:ordinaryTitle,marker:'ordinary-'+label,__confirmed:true});assert.equal(ordinary.confirmationMatched,true);assert.equal(ordinary.effectVerified,false);
      if(label==='networkmulti')assert.deepEqual(ordinary.resultIds,['-9007199254740993123456789','007']);
      if(label==='network')assert.equal(ordinary.resultId,'007');
      if(label==='networkurl')assert.equal(ordinary.resultId,'networkurl');
      assert.deepEqual(values.get(label),{item:'example-item',title:ordinaryTitle,marker:'ordinary-'+label});
      const knowledge=(await cli('exploration.knowledge-read',{site:install.name})).data;await cli('exploration.knowledge-save',{taskId,expectedHash:knowledge.hash});
      passed('UI '+label+': generation, zero-write validation, exact review, effects, no replay, install, ordinary call and knowledge');
    }
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
