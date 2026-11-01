import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { pageUiSubmit, uiWriteRequest } from '../background/ui-write.js';
import { executePageRequest } from '../background/page-write.js';

const origin='https://example.com';
const ui={version:1,url:origin+'/items/example',method:'POST',form:'#form',inputMode:'native-setter-no-events',inputs:[{selector:'#title',name:'title',parameter:'title'}],submit:{selector:'#submit',text:'Save'},confirmation:{selector:'#receipt',attribute:'data-title',parameter:'title'}};
function fixture(mode, resultText, previousId = null) {
  let submissions=0, events=0;
  class Element {
    constructor(){this.isConnected=true;this.attrs={};this.name='';this.value='';this.validity={valid:true};}
    querySelectorAll(selector){return this.children?.[selector]||[];}
    matches(){return this.disabled===true;}
    getBoundingClientRect(){return {width:100,height:20};}
    closest(){return null;}
    hasAttribute(k){return Object.hasOwn(this.attrs,k);}
    getAttribute(k){return this.attrs[k]??null;}
    dispatchEvent(event){events++;this.onEvent?.(event);}
    click(){if(this.onClick)this.onClick();else this.form.requestSubmit();}
  }
  class Input extends Element {get value(){return this._value;}set value(v){this._value=v; if(mode==='replaced' && v==='After')this.isConnected=false;}}
  class Textarea extends Input {}
  class Button extends Element {}
  class Form extends Element {requestSubmit(){submissions++; if(mode==='lost')return; receipt.attrs['data-title']=input.value; if(resultText !== undefined)receipt.attrs['data-result-id']=resultText;}}
  const form=new Form(),input=new Input(),button=new Button(),receipt=new Element();
  Object.assign(form,{action:ui.url,method:'post',target:'',enctype:'application/x-www-form-urlencoded'});
  Object.assign(input,{type:'text',name:'title',form,willValidate:true});Object.assign(button,{type:'submit',textContent:'Save',form});
  form.children={'#title':[input],'#submit':[button]};form.elements=[input,button];
  if(previousId !== null)receipt.attrs['data-result-id']=previousId;
  const document={querySelectorAll:selector=>({'#form':[form],'#receipt':[receipt]}[selector]||[])};
  if(mode==='disabled')button.disabled=true;
  if(mode==='extra')form.elements.push(Object.assign(new Input(),{name:'extra'}));
  if(mode==='override')button.attrs.formaction=origin+'/other';
  if(mode==='ambiguous')form.children['#title'].push(new Input());
  if(mode==='stale')receipt.attrs['data-title']='After';
  if(mode==='invalid')input.validity.valid=false;
  if(mode==='password')input.type='password';
  const context=vm.createContext({location:{href:origin+'/editor'},__weworkerWriteDocumentToken:'example',document,
    HTMLFormElement:Form,HTMLInputElement:Input,HTMLTextAreaElement:Textarea,HTMLButtonElement:Button,HTMLElement:Element,Event:class {constructor(type){this.type=type;}},
    getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'}),setTimeout});
  const run=patch=>vm.runInContext(`(${pageUiSubmit.toString()})(${JSON.stringify({ui,documentUrl:origin+'/editor',documentToken:'example',request:{url:ui.url,method:'POST',body:{title:'After'}},deadline:Date.now()+150,...patch})})`,context);
  return {run,count:()=>({submissions,events}),input,form,receipt,button,document};
}
test('uses native setters without events and exactly one native submit with correlated acknowledgement',async()=>{
  const f=fixture();const reply=await f.run();assert.equal(reply.ok,true);assert.equal(reply.value.confirmationMatched,true);assert.deepEqual(f.count(),{submissions:1,events:0});assert.equal(f.input.value,'After');
});
test('preflight rejects unsupported, replaced, ambiguous or stale nodes and invalid data without submission',async()=>{
  for(const mode of ['disabled','extra','override','ambiguous','stale','invalid','password','replaced']){
    const f=fixture(mode);assert.equal((await f.run()).ok,false,mode);assert.equal(f.count().submissions,0,mode);
  }
  for(const patch of [{documentToken:'wrong'},{deadline:Date.now()-1},{documentUrl:origin+'/other'}]){
    const f=fixture();assert.equal((await f.run(patch)).ok,false);assert.equal(f.count().submissions,0);
  }
});
test('missing acknowledgement times out after one submit without replay',async()=>{
  const f=fixture('lost'),reply=await f.run({deadline:Date.now()+30});assert.equal(reply.error.code,'UI_WRITE_TIMEOUT');assert.equal(reply.submitted,true);assert.equal(f.count().submissions,1);
});
test('UI dispatch shares exact document/confirmation and cancellation guards without injecting an idempotency fetch',async()=>{
  const calls=[];let changed=false;
  const chrome={tabs:{get:async()=>({url:origin+'/editor'})},debugger:{sendCommand:async(_target,method,params)=>{
    calls.push({method,params});if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',loaderId:changed?'new':'old',url:origin+'/editor'}}};
    if(method==='Page.createIsolatedWorld')return {executionContextId:1};
    if(method==='Runtime.evaluate'&&params.expression.includes('async function pageUiSubmit'))return {result:{value:{ok:true,value:{ok:true,submitted:true,confirmationMatched:true}}}};
  }}};
  const payload={route:{origin,pathname:'/editor'},ui,request:{url:ui.url,method:'POST',body:{title:'After'}},confirmed:true,deadline:Date.now()+1000};
  const execute=patch=>executePageRequest({chrome,ensureCdpAttached:async()=>{},tabId:7,payload:{...payload,...patch}});
  assert.equal((await execute()).ok,true);
  assert.equal(calls.filter(v=>v.params?.expression?.includes('async function pageUiSubmit')).length,1);
  assert.equal(calls.some(v=>v.params?.expression?.includes('async function pageJsonRequest')),false);
  assert.equal((await execute({confirmed:false})).dispatched,false);
  changed=true;assert.equal((await execute({expectedDocument:{frameId:'main',loaderId:'old',url:origin+'/editor'}})).dispatched,false);
  const cancelled=await executePageRequest({chrome,tabId:7,ensureCdpAttached:async()=>{},payload,assertRunning:()=>{throw new Error('Example cancel');}});assert.equal(cancelled.dispatched,false);
});
test('ordinary UI arguments require exact booleans and strings',()=>{
  const command={runtime:'extension',safety:'write',uiWrite:ui};
  assert.equal(uiWriteRequest(command,{title:'007 示例',__confirmed:true}).body.title,'007 示例');
  for(const args of [{title:'After'},{title:'After',__confirmed:'true'},{title:1,__confirmed:true},{title:'After',extra:'x',__confirmed:true},{title:'\n',__confirmed:true}])assert.throws(()=>uiWriteRequest(command,args));
});

test('fresh UI result IDs preserve strings and parse only explicitly typed canonical safe integers', async () => {
  for (const [raw, type, expected] of [['007示例','string','007示例'],['0','integer',0],['9007199254740991','integer',9007199254740991]]) {
    const f=fixture(undefined,raw),reply=await f.run({ui:{...ui,result:{attribute:'data-result-id',publicId:true,idType:type}}});
    assert.equal(reply.ok,true);assert.equal(reply.value.resultId,expected);assert.deepEqual(f.count(),{submissions:1,events:0});
  }
});
test('invalid, missing or stale receipt IDs fail after one submit without fallback or coercion', async () => {
  for (const [raw,type,previous] of [[undefined,'string'],['old','string','old'],['../other','string'],['%2f','string'],['','string'],['007','integer'],['-0','integer'],['-1','integer'],['1.0','integer'],['1e3','integer'],['9007199254740992','integer'],[' 7','integer']]) {
    const f=fixture(undefined,raw,previous),reply=await f.run({ui:{...ui,result:{attribute:'data-result-id',publicId:true,idType:type}}});
    assert.equal(reply.ok,false,String(raw));assert.match(reply.error.code,/UI_WRITE_(STALE_RESULT_ID|RESULT_ID_INVALID)/);assert.equal(f.count().submissions,1);
  }
  for(const result of [{attribute:'data-marker',idType:'string',publicId:false},{attribute:'data-token',idType:'string',publicId:true},{attribute:'data-title',idType:'string',publicId:true}]) {
    const f=fixture(undefined,'example'),reply=await f.run({ui:{...ui,result}});assert.equal(reply.ok,false);assert.equal(f.count().submissions,0);
  }
});

test('v2 dispatches reviewed input/change once, then click; legacy contract cannot opt into events', async () => {
  const f=fixture(); const seen=[]; f.input.onEvent=event=>seen.push(event.type);
  const reply=await f.run({ui:{...ui,version:2,inputMode:'native-input-change',submit:{...ui.submit,mode:'click'}}});
  assert.equal(reply.ok,true);assert.deepEqual(seen,['input','change']);assert.deepEqual(f.count(),{submissions:1,events:2});
  const legacy=fixture();assert.equal((await legacy.run({ui:{...ui,inputMode:'native-input-change'}})).ok,false);assert.deepEqual(legacy.count(),{submissions:0,events:0});
});

test('autosave awaits a new correlated receipt without submitting; event-driven replacement stops later events',async()=>{
  const f=fixture();f.input.onEvent=()=>{f.receipt.attrs['data-title']=f.input.value;};
  const spec={...ui,version:2,inputMode:'native-input-change',submit:{mode:'none'}};
  const reply=await f.run({ui:spec});assert.equal(reply.ok,true);assert.equal(reply.value.submitDispatched,false);assert.deepEqual(f.count(),{submissions:0,events:2});
  const replaced=fixture();replaced.input.onEvent=()=>{replaced.input.isConnected=false;};
  const failure=await replaced.run({ui:spec});assert.equal(failure.ok,false);assert.deepEqual(replaced.count(),{submissions:0,events:1});
  const rejected=fixture();rejected.input.onEvent=()=>{rejected.input.value='Before';};
  assert.equal((await rejected.run({ui:spec})).ok,false);assert.deepEqual(rejected.count(),{submissions:0,events:1});
});

test('explicit hidden page fields remain in the document and are never returned; undeclared fields fail',async()=>{
  const f=fixture(),hidden=new f.input.constructor();Object.assign(hidden,{name:'csrf',type:'hidden',value:'example-placeholder',form:f.form});
  f.form.elements.push(hidden);f.form.children['#csrf']=[hidden];
  const spec={...ui,version:2,hiddenFields:[{selector:'#csrf',name:'csrf',source:'page'}]};
  const reply=await f.run({ui:spec});assert.equal(reply.ok,true);assert.equal(hidden.value,'example-placeholder');assert.equal(JSON.stringify(reply).includes('example-placeholder'),false);
  const undeclared=fixture('extra');assert.equal((await undeclared.run({ui:{...ui,version:2}})).error.code,'UI_WRITE_EXTRA_FIELDS');
});

test('declared popup choices select exact values and stop on ambiguity, disability or replacement',async()=>{
  for(const mode of ['normal','ambiguous','disabled','replaced','unowned','invalid-native']){
    const f=fixture(mode==='invalid-native'?'invalid':undefined),Button=f.button.constructor,Element=f.receipt.constructor;let choiceClicks=0;
    const choice=new Button(),option=new Button(),popup=new Element();
    Object.assign(choice,{type:'button',form:f.form,attrs:{role:'combobox','data-field':'category','data-value':'Before','aria-controls':'choices','aria-expanded':'false'}});
    Object.assign(option,{type:'button',form:f.form,attrs:{role:'option','data-value':'Blue'}});
    Object.assign(popup,{id:'choices',attrs:{role:'listbox'},children:{button:mode==='ambiguous'?[option,option]:[option]},contains:node=>node===option});
    choice.onClick=()=>{choiceClicks++;choice.attrs['aria-expanded']='true';if(mode==='unowned')choice.attrs['aria-controls']='other';};
    option.onClick=()=>{choice.attrs['data-value']='Blue';if(mode==='replaced')f.form.children['#choice']=[new Button()];};
    if(mode==='disabled')option.attrs['aria-disabled']='true';
    f.form.children['#choice']=[choice];f.form.elements.push(choice,option);
    const query=f.document.querySelectorAll;f.document.querySelectorAll=selector=>selector==='#choices'?[popup]:query(selector);
    const spec={...ui,version:2,inputMode:'native-input-change',inputs:[...ui.inputs,{kind:'choice',selector:'#choice',name:'category',parameter:'category',popup:'#choices',option:'button'}]};
    const result=await f.run({ui:spec,request:{url:ui.url,method:'POST',body:{title:'After',category:'Blue'}}});
    assert.equal(result.ok,mode==='normal',mode);assert.equal(f.count().submissions,mode==='normal'?1:0,mode);
    if(mode==='normal'){assert.equal(result.eventsDispatched,4);assert.equal(choice.attrs['data-value'],'Blue');}
    if(mode==='invalid-native'){assert.equal(choiceClicks,0);assert.equal(result.eventsDispatched,0);}
    if(mode==='ambiguous')assert.equal(result.error.code,'UI_WRITE_CHOICE_AMBIGUOUS');
    if(mode==='replaced')assert.equal(result.error.code,'UI_WRITE_INPUT_UNSUPPORTED');
  }
});
