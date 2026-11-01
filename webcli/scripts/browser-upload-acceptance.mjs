import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function verifyBrowserUploads({cli,root,record,passed}){
  const session='example-upload';const received=[];
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/receive'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const data=await new Request('http://example.com/receive',{method:'POST',headers:req.headers,body:Buffer.concat(chunks)}).formData();
      const files=[];for(const file of data.getAll('files'))files.push({name:file.name,content:await file.text()});received.push(files);
      res.setHeader('content-type','application/json');res.end(JSON.stringify({received:files.length}));return;
    }
    const route=new URL(req.url,'http://127.0.0.1').pathname,child=route==='/child',leaf=route==='/leaf';
    res.setHeader('content-type','text/html');res.end(`<!doctype html><title>Example upload targets</title><style>input{margin:4px}iframe{width:700px;height:220px}</style>
      <input id="main" type="file" multiple aria-label="Example main file" style="display:none">
      <button id="choose" onclick="window.exampleChooserClicks=(window.exampleChooserClicks||0)+1;const n=document.createElement('input');n.id='chosen-file';n.type='file';n.multiple=true;n.hidden=true;document.body.append(n);n.click()">Choose files</button>
      <button id="choose-folder" onclick="document.querySelector('#directory').click()">Choose folder</button><button id="no-chooser" onclick="window.exampleNoChooser=(window.exampleNoChooser||0)+1;document.querySelector('#unrelated-chooser').contentDocument.querySelector('input').click()">Wrong frame picker</button><iframe id="unrelated-chooser" srcdoc="&lt;input type=file&gt;"></iframe><input id="single" type="file" aria-label="Example single file"><input id="directory" type="file" webkitdirectory>
      <fieldset disabled><input id="disabled" type="file"></fieldset><input id="aria-disabled" type="file" aria-disabled="true">
      <input id="reset" type="file" onchange="window.exampleReset=(window.exampleReset||0)+1;this.value=''">
      <input id="navigate" type="file" onchange="location.href='/navigated'">
      <div id="open-host"></div><div id="closed-host"></div><div id="other-host"></div>
      ${leaf?'':child?`<iframe src="http://127.0.0.1:${server.address().port}/leaf"></iframe>`:`<iframe src="http://localhost:${server.address().port}/child"></iframe><iframe src="http://localhost:${server.address().port}/child"></iframe>`}
      <script>
      const open=document.querySelector('#open-host').attachShadow({mode:'open'});open.innerHTML='<input id="open-file" class="duplicate" type="file" multiple aria-label="Example open file"><div id="inner"></div>';
      const inner=open.querySelector('#inner').attachShadow({mode:'open'});inner.innerHTML='<input id="nested-file" type="file" multiple aria-label="Example nested file" style="display:none">';
      const closed=document.querySelector('#closed-host').attachShadow({mode:'closed'});closed.innerHTML='<input id="closed-file" type="file" multiple aria-label="Example closed file">';
      closed.querySelector('input').onchange=async e=>window.exampleClosedContent=await Promise.all([...e.target.files].map(async f=>({name:f.name,content:await f.text()})));
      const other=document.querySelector('#other-host').attachShadow({mode:'open'});other.innerHTML='<input class="duplicate" type="file">';
      window.exampleChanges=0;document.addEventListener('change',()=>window.exampleChanges++);
      </script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const call=(command,args={},ok=true)=>cli(`browser.${command}`,{session,...args},ok);
  // Public JSON fixtures avoid machine-specific .txt transformations. Still
  // verify exact byte content in Chrome and in the receiving loopback server.
  const names=['example-upload-a.json','example 上传 b.json'],contents=['{"example":"alpha"}\n','{"example":"Unicode 示例"}\n'];
  const paths=names.map(name=>path.join(root,name));for(let i=0;i<paths.length;i++)await fs.writeFile(paths[i],contents[i]);
  const expected=names.map((name,i)=>({name,content:contents[i]}));
  const inspect=async(selector,extra={})=>(await call('get',{selector,property:'compound',...extra})).data.value;
  const read=async(expression,extra={})=>(await call('eval',{expression,...extra})).data.value;
  const fileContents=expression=>`Promise.all([...(${expression}).files].map(async f=>({name:f.name,content:await f.text()})))`;
  try{
    await call('open',{url:`http://127.0.0.1:${server.address().port}/`});
    const simple=(await call('upload',{selector:'#main',paths})).data;assert.equal(simple.verified,true);assert.equal(simple.count,2);
    assert.deepEqual(await read(fileContents('document.querySelector("#main")')),expected);
    assert.deepEqual(await read('const data=new FormData();for(const file of document.querySelector("#main").files)data.append("files",file);fetch("/receive",{method:"POST",body:data}).then(r=>r.json())'),{received:2});
    assert.deepEqual(received,[expected]);
    await call('upload',{shadow:true,role:'button',name:'Example nested file',paths});
    assert.deepEqual((await inspect('#nested-file',{shadow:true})).current,names);
    assert.deepEqual(await read(fileContents('document.querySelector("#open-host").shadowRoot.querySelector("#inner").shadowRoot.querySelector("#nested-file")')),expected);
    const domRef=(await call('find',{shadow:true,selector:'#open-file'})).data.elements[0].ref;
    await call('upload',{ref:domRef,paths});assert.deepEqual((await inspect('#open-file',{shadow:true})).current,names);
    const ax=(await call('state',{source:'ax',frameId:0,limit:200})).data,closed=ax.elements.find(row=>row.name==='Example closed file');assert.ok(closed);
    await call('upload',{ref:closed.ref,paths});
    assert.deepEqual((await call('get',{ref:closed.ref,property:'compound'})).data.value.current,names);
    for(let i=0;i<20&&(await read('window.exampleClosedContent||[]')).length!==2;i++)await new Promise(r=>setTimeout(r,50));
    assert.deepEqual(await read('window.exampleClosedContent'),expected);
    // Directory mode carries the root path to CDP, preserving relative names.
    const folder=path.join(root,'example-folder');await fs.mkdir(path.join(folder,'nested'),{recursive:true});
    await fs.writeFile(path.join(folder,'same.json'),'root example');await fs.writeFile(path.join(folder,'nested','same.json'),'nested example');
    const directory=(await call('upload',{selector:'#directory',paths:[folder],directory:true})).data;
    assert.equal(directory.verified,true);assert.equal(directory.count,2);assert.equal(directory.directory,true);
    const directoryState=await read('Promise.all([...document.querySelector("#directory").files].map(async f=>({path:f.webkitRelativePath,content:await f.text()})))');
    assert.deepEqual(directoryState.sort((a,b)=>a.path.localeCompare(b.path)),[{path:'example-folder/nested/same.json',content:'nested example'},{path:'example-folder/same.json',content:'root example'}]);
    const folderChooser=(await call('upload',{selector:'#choose-folder',paths:[folder],directory:true,chooser:true})).data;
    assert.equal(folderChooser.chooserOpened,true);assert.equal(folderChooser.count,2);
    const noPicker=(await call('upload',{selector:'#no-chooser',paths,chooser:true},false)).error;
    assert.equal(noPicker.code,'UPLOAD_INTERRUPTED');assert.equal(noPicker.details.dispatched,true);assert.equal(await read('window.exampleNoChooser'),1);assert.equal(await read('document.querySelector("#unrelated-chooser").contentDocument.querySelector("input").files.length'),0);
    // The following successful chooser proves interception/listener cleanup.
    const chooser=(await call('upload',{selector:'#choose',paths,chooser:true})).data;
    assert.equal(chooser.chooserOpened,true);assert.equal(await read('window.exampleChooserClicks'),1);
    assert.deepEqual(await read(fileContents('document.querySelector("#chosen-file")')),expected);
    // Custom picker -> page-owned multipart flow; verify the receiving service.
    await read('(()=>{const data=new FormData();for(const f of document.querySelector("#chosen-file").files)data.append("files",f);return fetch("/receive",{method:"POST",body:data}).then(r=>r.json());})()');
    assert.deepEqual(received.at(-1),expected);
    const changes=await read('window.exampleChanges');
    for(const [args,code]of [[{selector:'#single',paths},'INVALID_ARGUMENT'],[{selector:'#directory',paths:[paths[0]]},'DIRECTORY_INPUT_UNSUPPORTED'],[{selector:'#disabled',paths:[paths[0]]},'ELEMENT_DISABLED'],[{selector:'#aria-disabled',paths:[paths[0]]},'ELEMENT_DISABLED'],[{shadow:true,selector:'.duplicate',paths:[paths[0]]},'AMBIGUOUS_TARGET'],[{selector:'body',paths:[paths[0]]},'INVALID_ARGUMENT']]){
      const error=(await call('upload',args,false)).error;assert.equal(error.code,code);assert.equal(error.details.dispatched,false);
    }
    assert.equal(await read('window.exampleChanges'),changes);
    const stale=(await call('find',{selector:'#single'})).data.elements[0].ref;
    await read('const node=document.querySelector("#single");node.replaceWith(node.cloneNode(true));true');
    assert.equal((await call('upload',{ref:stale,paths:[paths[0]]},false)).error.code,'STALE_REF');assert.deepEqual((await inspect('#single')).current,[]);
    const reset=(await call('upload',{selector:'#reset',paths:[paths[0]]},false)).error;assert.equal(reset.code,'UPLOAD_VERIFICATION_FAILED');assert.equal(reset.details.dispatched,true);
    assert.equal(await read('window.exampleReset'),1);assert.deepEqual((await inspect('#reset')).current,[]);
    const frames=(await call('frames')).data.frames,children=frames.filter(row=>row.url.endsWith('/child'));assert.equal(children.length,2);
    const frame={frameId:children[1].frameId,documentId:children[1].documentId};
    await call('upload',{...frame,selector:'#choose',paths,chooser:true});assert.deepEqual(await read(fileContents('document.querySelector("#chosen-file")'),frame),expected);assert.equal(await read('document.querySelectorAll("#chosen-file").length',{frameId:children[0].frameId,documentId:children[0].documentId}),0);
    await call('upload',{...frame,selector:'#main',paths});assert.deepEqual(await read(fileContents('document.querySelector("#main")'),frame),expected);
    assert.deepEqual((await inspect('#main',{frameId:children[0].frameId,documentId:children[0].documentId})).current,[]);
    const leaf=frames.find(row=>row.url.endsWith('/leaf'));assert.ok(leaf);
    const nestedFrame={frameId:leaf.frameId,documentId:leaf.documentId};await call('upload',{...nestedFrame,shadow:true,selector:'#nested-file',paths});
    assert.deepEqual((await inspect('#nested-file',{...nestedFrame,shadow:true})).current,names);
    await read('location.href="/child?changed=1";true',frame);
    let changed=false;for(let i=0;i<30;i++){if((await call('frames')).data.frames.find(row=>row.frameId===frame.frameId)?.documentId!==frame.documentId){changed=true;break;}await new Promise(r=>setTimeout(r,50));}assert.equal(changed,true);
    assert.ok(['FRAME_UNAVAILABLE','FRAME_DOCUMENT_CHANGED'].includes((await call('upload',{...frame,selector:'#main',paths},false)).error.code));
    const nav=(await call('upload',{selector:'#navigate',paths:[paths[0]]},false)).error;
    assert.ok(['UPLOAD_TARGET_CHANGED','UPLOAD_INTERRUPTED','UPLOAD_VERIFICATION_FAILED','FRAME_DOCUMENT_CHANGED'].includes(nav.code),nav.code);assert.equal(nav.details.dispatched,true);
    await record('upload-report',{passed:true,verifiedFiles:2,formSubmissions:received.length,crossOriginFrames:children.length,nestedFrame:true,closedAx:true,directory:true,chooser:true,customMultipart:true});
    passed('directory relative paths, dynamic native chooser in main/cross-origin frames, custom multipart; retained file uploads: hidden/semantic/shadow/AX/nested cross-origin targets, exact bytes and form submission, ambiguous/disabled/stale/changed-document guards and post-change verification');
  }catch(error){
    // Only synthetic fixture metadata/equality, never uploaded file contents.
    const local=[];
    for(let i=0;i<paths.length;i++){
      const handle=await fs.open(paths[i],'r');
      try{local.push({name:names[i],pathSize:(await fs.stat(paths[i])).size,handleSize:(await handle.stat()).size,readSize:(await handle.readFile()).length,expectedSize:Buffer.byteLength(contents[i])});}
      finally{await handle.close();}
    }
    const browser=await read(`Promise.all([...document.querySelector('#main').files].map(async(file,index)=>({name:file.name,size:file.size,readSize:(await file.arrayBuffer()).byteLength,matchesExpected:await file.text()===${JSON.stringify(contents)}[index]})))`).catch(()=>null);
    await record('upload-failure-diagnostics',{local,browser});throw error;
  }finally{try{await call('close');}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
}
