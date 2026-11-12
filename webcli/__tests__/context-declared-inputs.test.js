import { expect, it } from 'vitest';
import { compileResultBindings } from '../result-bindings.js';
import { newState, beginRound, commitRound, registerDisplay } from '../context-model.js';
import { captureResult } from '../context-profile.js';
import { routeContext } from '../context-router.js';

function fixture(properties={body:{type:'string'}},inputs=Object.keys(properties),mapping={id:{from:'item.id'}}) {
  const entries=[{name:'fixture.list',adapterId:'fixture',safety:'read',results:[{itemsPath:'$',idField:'id',titleField:'title',actions:[{id:'edit',label:'修改',command:'edit',args:mapping,inputs}]}]},
    {name:'fixture.edit',adapterId:'fixture',safety:'write',parameters:{type:'object',properties:{id:{type:'integer'},...properties},required:['id'],additionalProperties:false}}];
  const catalog={tools:{},resultBindings:compileResultBindings(entries)},state=newState(1000);
  beginRound(state,null,1000);
  const snap=captureResult(state,{tool:'fixture.list',args:{},raw:[{id:11,title:'Same'},{id:22,title:'Same'}],exitCode:0,now:1000,catalog,roundId:state.activeRound.roundId});commitRound(state);
  registerDisplay(state,{epoch:state.sessionEpoch,revision:state.revision,roundId:snap.sourceRoundId,snapshotId:snap.snapshotId,order:['e2','e1'],completeness:'unknown',delivered:true});
  return {state,catalog,entries,snap};
}
it.each([
  [{body:{type:'string'}},'new body',{body:'new body'}],
  [{replicas:{type:'integer'}},'3',{replicas:3}],
  [{hosts:{type:'array',items:{type:'string'}}},'["host-1","host-2"]',{hosts:['host-1','host-2']}],
  [{branch:{type:'string'},template:{type:'string'},hosts:{type:'array',items:{type:'string'}}},'{"branch":"main","template":"tpl-7","hosts":["host-1"]}',{branch:'main',template:'tpl-7',hosts:['host-1']}],
])('declared optional inputs become required for this action and resume with exact JSON types',async(properties,answer,expected)=>{
  const f=fixture(properties),question=await routeContext(f.state,'修改第二条',{catalog:f.catalog,now:1001});
  expect(question.kind).toBe('needs_input');expect(question.inputMode).toBe('text');
  expect(question.missingFields).toEqual(Object.keys(properties).map(key=>`arguments.${key}`));
  expect(question.knownSelection.entityRefs).toEqual(['e1']);
  const result=await routeContext(JSON.parse(JSON.stringify(f.state)),answer,{catalog:f.catalog,now:1002,replyTo:question.clarificationId});
  expect(result.kind).toBe('resolved');expect(result.executionEligibility).toBe('write_allowed');
  expect(result.steps[0].args).toEqual({id:11,...expected});
  for(const key of Object.keys(expected))expect(result.steps[0].fieldSources[key]).toBe('explicit_user_input');
  expect(f.snap.entities[0].bindings.edit.args).toEqual({id:11});
});
it.each(['{"id":22,"branch":"main","hosts":["h"]}','{"branch":"main","hosts":"h"}','{"branch":"main"}','not json'])('rejects extra, missing or mistyped explicit structured answer %s',async answer=>{
  const f=fixture({branch:{type:'string'},hosts:{type:'array',items:{type:'string'}}});
  const q=await routeContext(f.state,'修改第二条',{catalog:f.catalog,now:1001});
  expect((await routeContext(f.state,answer,{catalog:f.catalog,now:1002,replyTo:q.clarificationId})).steps).toBeUndefined();
});
it('a quoted JSON number is not coerced to an integer',async()=>{
  const f=fixture({replicas:{type:'integer'}}),q=await routeContext(f.state,'修改第二条',{catalog:f.catalog,now:1001});
  expect((await routeContext(f.state,'"3"',{catalog:f.catalog,now:1002,replyTo:q.clarificationId})).steps).toBeUndefined();
});
it.each([
  [{replicas:{type:'integer',minimum:1}},'0'],
  [{hosts:{type:'array',items:{type:'string'},minItems:1}},'[]'],
  [{body:{type:'string',minLength:3}},'a'],
])('rejects explicit answers that violate declared size or numeric limits',async(properties,answer)=>{
  const f=fixture(properties),q=await routeContext(f.state,'修改第二条',{catalog:f.catalog,now:1001});
  expect((await routeContext(f.state,answer,{catalog:f.catalog,now:1002,replyTo:q.clarificationId})).steps).toBeUndefined();
});
it.each(['__confirmed','password','token','__proto__','id'])('cannot declare unsafe, unknown or already bound input %s',key=>{
  expect(()=>fixture({[key]:{type:'string'}},[key])).toThrow('binding_invalid_input');
});
it('a missing mapped source cannot be repaired with an explicitly supplied new value',async()=>{
  const f=fixture({body:{type:'string'},env:{type:'string'}},['body'],{id:{from:'item.id'},env:{from:'query.env'}});
  const q=await routeContext(f.state,'修改第二条',{catalog:f.catalog,now:1001});
  expect(q.inputMode).toBeUndefined();expect(q.missingFields).toEqual(['arguments']);
});
it('an input declaration change invalidates a pending answer',async()=>{
  const f=fixture(),q=await routeContext(f.state,'修改第二条',{catalog:f.catalog,now:1001});
  f.entries[0].results[0].actions[0].inputs=[];f.catalog.resultBindings=compileResultBindings(f.entries);
  expect((await routeContext(f.state,'new value',{catalog:f.catalog,now:1002,replyTo:q.clarificationId})).steps).toBeUndefined();
});

it('rejects input absent from the target Schema',()=>{expect(()=>fixture({body:{type:'string'}},['missing'])).toThrow('binding_invalid_input');});

function modalFixture(mode) {
  const entries = [{name:'fixture.list',adapterId:'fixture',safety:'read',results:['system','plan'].map(kind=>({
    when:{mode:kind},itemsPath:'$',idField:'id',titleField:'title',actions:[{id:'edit',label:'修改',command:'edit',
      args:{[`${kind}Id`]:{from:'item.id'}},inputs:['value']}],
  }))},{name:'fixture.edit',adapterId:'fixture',safety:'write',parameters:{type:'object',properties:{systemId:{type:'integer'},planId:{type:'integer'},value:{type:'string'}},additionalProperties:false}}];
  const catalog={tools:{},resultBindings:compileResultBindings(entries)},state=newState(1000);
  beginRound(state,null,1000);
  const snap=captureResult(state,{tool:'fixture.list',args:{mode},raw:[{id:11,title:'Same'}],exitCode:0,now:1000,catalog,roundId:state.activeRound.roundId});commitRound(state);
  registerDisplay(state,{epoch:state.sessionEpoch,revision:state.revision,roundId:snap.sourceRoundId,snapshotId:snap.snapshotId,order:['e1'],completeness:'unknown',delivered:true});
  return {state:JSON.parse(JSON.stringify(state)),catalog,snap};
}
it.each(['system','plan'])('same action ID/label/target across %s modes uses the captured rule after JSON reopen',async mode=>{
  const f=modalFixture(mode);
  expect(f.snap.resultRuleIndex).toBe(mode==='system'?0:1);expect(f.snap.args).toEqual({});
  const q=await routeContext(f.state,'修改第一条',{catalog:f.catalog,now:1001});expect(q.inputMode).toBe('text');
  const r=await routeContext(f.state,'New',{catalog:f.catalog,now:1002,replyTo:q.clarificationId});
  expect(r.steps[0].args).toEqual({[`${mode}Id`]:11,value:'New'});expect(r.executionEligibility).toBe('write_allowed');
});
it.each([undefined,99])('an old ambiguous or invalid rule index %s cannot use the first mode as a fallback',async index=>{
  const f=modalFixture('plan');
  if(index===undefined) delete f.state.snapshots[f.snap.snapshotId].resultRuleIndex;
  else f.state.snapshots[f.snap.snapshotId].resultRuleIndex=index;
  const q=await routeContext(f.state,'修改第一条',{catalog:f.catalog,now:1001});
  expect(q.inputMode).toBeUndefined();expect(q.steps).toBeUndefined();
});
