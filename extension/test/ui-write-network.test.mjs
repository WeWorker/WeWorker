import assert from 'node:assert/strict';
import test from 'node:test';
import { withUiNetworkResult } from '../background/ui-write-network.js';

const origin='https://example.com';
function fixture(mode='normal') {
  const listeners=new Set(),calls=[];let cancelled=false;
  const emit=(method,params)=>{for(const listener of listeners)listener({tabId:7},method,params);};
  const chrome={debugger:{onEvent:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},sendCommand:async(_source,method)=>{
    calls.push(method);
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',loaderId:'original',url:origin+'/editor'}}};
    if(method==='Network.getResponseBody')return {body:'{"id":-9007199254740993123456789}',base64Encoded:false};
  }}};
  const request=(requestId,frameId='main')=>emit('Network.requestWillBeSent',{requestId,frameId,loaderId:'original',request:{url:origin+'/items/example',method:'POST'}});
  const run=()=>withUiNetworkResult({chrome,tabId:7,ensureCdpAttached:async()=>{},assertRunning:()=>{if(cancelled)throw Object.assign(new Error('cancel'),{code:'CANCELLED'});},
    payload:{deadline:Date.now()+100,ui:{result:{source:'network',url:origin+'/items/example',method:'POST',ids:[{publicId:true,idType:'decimal',responsePath:'id'},{publicId:true,idType:'string',responseSource:{kind:'header',name:'x-resource-id'}}]}}},
    execute:async()=>{
      request('unrelated','other');request('selected');
      if(mode==='ambiguous')request('duplicate');
      if(mode==='cancel')cancelled=true;
      if(mode==='lost')emit('Network.loadingFailed',{requestId:'selected'});
      else {emit('Network.responseReceived',{requestId:'selected',response:{status:200,headers:{'X-Resource-ID':'007','Set-Cookie':'example-placeholder'},url:origin+'/items/example'}});emit('Network.loadingFinished',{requestId:'selected'});}
      return {ok:true,value:{ok:true,confirmationMatched:true,effectVerified:false}};
    }});
  return {run,calls,listeners};
}

test('captures exactly one mutation from the original document, retains typed IDs only and removes listeners',async()=>{
  const f=fixture(),reply=await f.run();assert.equal(reply.ok,true);assert.deepEqual(reply.value.resultIds,['-9007199254740993123456789','007']);
  assert.equal(JSON.stringify(reply).includes('example-placeholder'),false);assert.equal(f.calls.filter(value=>value==='Network.getResponseBody').length,1);assert.equal(f.listeners.size,0);
});
for(const mode of ['ambiguous','lost','cancel'])test('network result '+mode+' stops capture without fetching a body or replaying',async()=>{
  const f=fixture(mode),reply=await f.run();assert.equal(reply.ok,false);assert.equal(f.calls.includes('Network.getResponseBody'),false);assert.equal(f.listeners.size,0);
});
