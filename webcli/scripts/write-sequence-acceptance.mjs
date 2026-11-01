import assert from 'node:assert/strict';
import http from 'node:http';

/** Real CLI/Bridge orchestration; every mutation belongs to this loopback service. */
export async function verifyWriteSequences({call,pass,startBridge,stopBridge}) {
  const values=new Map(),requests=[],held=new Map();
  const server=http.createServer(async(req,res)=>{
    const parts=new URL(req.url,'http://localhost').pathname.split('/'),label=parts[2];
    res.setHeader('content-type','application/json');
    if(!['items','resources'].includes(parts[1])){res.writeHead(404);res.end('{}');return;}
    let raw='';for await(const chunk of req)raw+=chunk;
    requests.push({label,method:req.method});
    if(req.method==='PUT') {
      const body=JSON.parse(raw);values.set(label,body.title);
      if(label==='uncertain'){req.socket.destroy();return;}
      if(label==='restart'&&body.title==='actual-record-id'){held.set(label,res);return;}
      res.end(JSON.stringify({ok:true,id:'actual-record-id',title:body.title}));return;
    }
    res.end(JSON.stringify({id:'actual-record-id',title:values.get(label)||'Before'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const count=label=>requests.filter(value=>value.label===label&&value.method==='PUT').length;
  const settle=async taskId=>{for(let i=0;i<400;i++){const state=(await call('exploration.get',{taskId})).data;if(!['collecting','validating','verifying_write','installing'].includes(state.status))return state;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Write sequence did not settle');};
  async function draft(label) {
    const taskId=(await call('exploration.start',{mode:'http',origin,goal:'Verify public finite writes',requestId:'sequence-'+label})).data.taskId;await settle(taskId);
    const url=origin+'/items/'+label;
    await call('exploration.declare-write',{taskId,url,method:'PUT',bodyKeys:['title'],reason:'Isolated public sequence fixture'});
    const sourceApiIndexes=[(await call('exploration.evidence',{taskId})).data.candidates.findIndex(value=>value.url===url)];
    const plan={tools:[{name:'sequence_'+label,risk:'write',sourceApiKind:'action',sourceApiIndexes,strategy:'PUBLIC_API',writeReason:'Explicit finite public updates',strategyNote:{reason:'Direct local HTTP endpoint',limitations:'One request per step, independent effects, no rollback'}}]};
    const generated=(await call('exploration.generate',{taskId,plan})).data,tool=generated.toolNames[0];
    const edit=async(file,content)=>{const old=(await call('exploration.draft-read',{taskId,file})).data;await call('exploration.draft-write',{taskId,file,content,expectedHash:old.hash});};
    const manifest=JSON.parse((await call('exploration.draft-read',{taskId,file:'manifest.json'})).data.content),command=manifest.commands.find(value=>tool.endsWith('.'+value.id));
    command.schema={type:'object',additionalProperties:false,required:['title'],properties:{title:{type:'string'},__confirmed:{type:'boolean'}},'x-webcli-requires-confirmation':true,'x-webcli-agent-authored':true};
    await edit('manifest.json',JSON.stringify(manifest));
    await edit(command.module,`module.exports=async(args,api)=>{if(args.__confirmed!==true)return {blocked:true,requiresConfirmation:true};try{return await api.request({url:${JSON.stringify(url)},method:'PUT',json:{title:args.title}});}catch(error){return {ok:false,errorCode:error.code};}};`);
    const first={id:'first',representativeArgs:{title:'After'},expectedRequest:{url,method:'PUT',body:{title:'After'}},successResponse:{status:200,body:{ok:true,id:'example-mock',title:'After'}},successExpectation:{ok:true,title:'After'},failureResponse:{status:409,body:{}},failureExpectation:{ok:false,errorCode:'HTTP_STATUS'},effect:{readback:{url},before:{equals:{title:'Before'}},after:{equals:{title:'After'}},resultReadback:{url:origin+'/resources/'+label+'/:id',publicId:true,responsePath:'id',identityPath:'id',expect:{equals:{title:'After'}}}}};
    const second=structuredClone(first);second.id='second';delete second.effect.resultReadback;second.representativeArgs.title='{{result:first}}';second.expectedRequest.body.title='{{result:first}}';second.successResponse.body.title='{{result:first}}';second.successExpectation.title='{{result:first}}';second.effect.before.equals.title=label==='partial'?'ExternalReady':'After';second.effect.after.equals.title='{{result:first}}';
    const old=(await call('exploration.write-verification-read',{taskId,tool})).data;await call('exploration.write-verification-write',{taskId,tool,fixture:{cases:[first,second]},expectedHash:old.hash});
    await call('exploration.validate',{taskId});assert.equal((await settle(taskId)).status,'write_review_ready');assert.equal(count(label),0);
    const steps=[{id:'first',tool,caseId:'first'},{id:'second',tool,caseId:'second'}],review=(await call('exploration.write-sequence-review',{taskId,steps})).data;
    assert.equal(count(label),0);return {taskId,tool,steps,review,args:{taskId,steps,reviewId:review.reviewId,confirmed:true}};
  }
  try {
    const f=await draft('success');await call('exploration.write-sequence-verify',f.args);const done=await settle(f.taskId);
    assert.equal(done.writeSequences[0].status,'verified',JSON.stringify(done));assert.equal(done.status,'review_ready');assert.equal(count('success'),2);assert.equal(values.get('success'),'actual-record-id');
    assert.equal(JSON.stringify(done).includes('actual-record-id'),false);await call('exploration.write-sequence-verify',f.args);assert.equal(count('success'),2);
    const review=(await call('exploration.review',{taskId:f.taskId})).data;await call('exploration.install',{taskId:f.taskId,reviewId:review.reviewId,confirmed:true});assert.equal((await settle(f.taskId)).status,'installed');
    pass('Write sequence: multi-case zero-write validation, exact review, actual result transfer, per-step effects, install and no replay');
    const partial=await draft('partial');await call('exploration.write-sequence-verify',partial.args);assert.equal((await settle(partial.taskId)).writeSequences[0].status,'partial');assert.equal(count('partial'),1);
    values.set('partial','ExternalReady');const resumed=(await call('exploration.write-sequence-review',{taskId:partial.taskId,steps:partial.steps,resumeFrom:partial.review.reviewId})).data;
    await call('exploration.write-sequence-verify',{...partial.args,resumeFrom:partial.review.reviewId,reviewId:resumed.reviewId});const resumedState=await settle(partial.taskId);
    assert.equal(resumedState.status,'review_ready');assert.equal(resumedState.writeSequences[1].steps[0].reused,true);assert.equal(count('partial'),2);
    pass('Write sequence: partial precondition failure stops later writes; a new resume review skips the verified first step');
    const uncertain=await draft('uncertain');await call('exploration.write-sequence-verify',uncertain.args);assert.equal((await settle(uncertain.taskId)).writeExecutions[0].status,'uncertain');
    assert.equal((await call('exploration.write-sequence-review',{taskId:uncertain.taskId,steps:uncertain.steps,resumeFrom:uncertain.review.reviewId},false)).error.code,'WRITE_SEQUENCE_UNCERTAIN');
    const before=count('uncertain');await call('exploration.write-sequence-readback',{taskId:uncertain.taskId,reviewId:uncertain.review.reviewId});assert.equal(count('uncertain'),before);
    pass('Write sequence: uncertain effects cannot resume or certify; recovery does not replay a write');
    const restart=await draft('restart');await call('exploration.write-sequence-verify',restart.args);
    for(let i=0;i<200&&!held.has('restart');i++)await new Promise(resolve=>setTimeout(resolve,50));assert.ok(held.has('restart'));
    await stopBridge();await startBridge();const restarted=await settle(restart.taskId);
    assert.equal(restarted.writeSequences[0].status,'interrupted');assert.equal(restarted.writeExecutions[1].status,'uncertain');
    await call('exploration.write-sequence-verify',restart.args);assert.equal(count('restart'),2);
    await call('exploration.write-sequence-readback',{taskId:restart.taskId,reviewId:restart.review.reviewId});assert.equal(count('restart'),2);
    pass('Write sequence: real Bridge termination preserves completed and uncertain steps with zero replay');
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
