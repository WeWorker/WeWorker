import { resolvePageFrame } from './page-frame-context.js';
import { createFrameOperation } from './frame-operation.js';

const fail=code=>Object.assign(new Error(code),{code});

/** Capture only one matching mutation in the retained document, never replay it. */
export async function withUiNetworkResult({chrome,tabId,payload,ensureCdpAttached,assertRunning,execute}) {
  const guard=createFrameOperation({deadline:payload.deadline,assertRunning,timeoutCode:'UI_WRITE_NETWORK_TIMEOUT'});
  const declaration=payload.ui.result;
  let pin,listener;
  try {
    await guard.run(()=>ensureCdpAttached(tabId));
    const frames=payload.frames||payload.ui.frames;
    if(frames)pin=await resolvePageFrame({chrome,tabId,frames,ensureCdpAttached,assertRunning,deadline:payload.deadline});
    const frame=pin ? await pin.snapshot() : (await guard.run(()=>chrome.debugger.sendCommand({tabId},'Page.getFrameTree')))?.frameTree?.frame;
    const frameId=frame.frameId||frame.id,loaderId=frame.loaderId,source=pin?.leaf.context.source||{tabId};
    if(!frameId||!loaderId)throw fail('PAGE_WRITE_DOCUMENT_CHANGED');
    await guard.run(()=>chrome.debugger.sendCommand(source,'Network.enable'));
    let requestKey,responseSource,response,requestId,error,completed=false,count=0,acknowledge;
    const ready=new Promise(resolve=>{acknowledge=resolve;});
    listener=(sender,method,params)=>{
      if(sender.tabId!==tabId)return;
      const key=(sender.sessionId||'')+':'+params.requestId;
      if(method==='Network.requestWillBeSent'&&params.frameId===frameId&&(params.loaderId===loaderId||payload.ui.navigation&&params.type==='Document')&&params.request?.url===declaration.url&&params.request.method===declaration.method){
        if(++count!==1||params.redirectResponse){error=fail('UI_WRITE_NETWORK_AMBIGUOUS');acknowledge();return;}
        requestKey=key;requestId=params.requestId;responseSource={...sender};
      }
      if(key!==requestKey)return;
      if(method==='Network.responseReceived') {
        response=params.response;
        if(response.status<200||response.status>=300){error=fail('UI_WRITE_NETWORK_STATUS');acknowledge();}
      }
      if(method==='Network.loadingFinished'){completed=true;acknowledge();}
      if(method==='Network.loadingFailed'){error=fail('UI_WRITE_NETWORK_FAILED');acknowledge();}
    };
    chrome.debugger.onEvent.addListener(listener);
    const ui={...payload.ui};delete ui.result;
    const reply=await execute({...payload,ui});
    if(!reply?.ok)return reply;
    await guard.run(()=>ready);if(error)throw error;
    if(count!==1||!completed||!response)throw fail('UI_WRITE_NETWORK_AMBIGUOUS');
    if(pin)await (payload.ui.navigation?pin.assertAncestors():pin.assertCurrent());
    const body=await guard.run(()=>chrome.debugger.sendCommand(responseSource,'Network.getResponseBody',{requestId}));
    if(typeof body.body!=='string'||body.body.length>6*1024*1024)throw fail('UI_WRITE_RESPONSE_LIMIT');
    const text=body.base64Encoded?new TextDecoder().decode(Uint8Array.from(atob(body.body),v=>v.charCodeAt(0))):body.body;
    if(new TextEncoder().encode(text).length>4*1024*1024)throw fail('UI_WRITE_RESPONSE_LIMIT');
    const lexemes=new WeakMap();
    let value;
    if(declaration.ids.some(spec=>spec.responsePath))value=JSON.parse(text,function(key,value,context){if(typeof value==='number'){let fields=lexemes.get(this);if(!fields)lexemes.set(this,fields=new Map());fields.set(key,context?.source);}return value;});
    const ids=declaration.ids.map(spec=>{
      let id;
      if(spec.responsePath){
        const parts=spec.responsePath.split('.'),last=parts.pop();let parent=value;
        for(const key of parts){if(!parent||typeof parent!=='object'||!Object.hasOwn(parent,key))throw fail('UI_WRITE_RESULT_ID_INVALID');parent=parent[key];}
        if(!parent||!Object.hasOwn(parent,last))throw fail('UI_WRITE_RESULT_ID_INVALID');id=parent[last];
        if(spec.idType==='decimal'&&typeof id==='number')id=lexemes.get(parent)?.get(last);
      } else if(spec.responseSource?.kind==='header') {
        const matches=Object.entries(response.headers||{}).filter(([name])=>name.toLowerCase()===spec.responseSource.name);
        if(matches.length!==1)throw fail('UI_WRITE_RESULT_ID_INVALID');id=matches[0][1];
      }
      if(spec.responseSource?.kind==='url'||spec.responseSource?.kind==='header'&&spec.responseSource.template) {
        const sourceUrl=spec.responseSource.kind==='url'?response.url:id;
        if(typeof sourceUrl!=='string'||!sourceUrl||sourceUrl.length>4096||/[\r\n\0]/.test(sourceUrl))throw fail('UI_WRITE_RESULT_ID_INVALID');
        const template=new URL(spec.responseSource.template),url=new URL(sourceUrl,template.origin),expected=template.pathname.split('/'),actual=url.pathname.split('/');
        if(url.origin!==template.origin||url.search||url.hash||url.username||url.password||actual.length!==expected.length||expected.some((part,i)=>part!==':id'&&part!==actual[i]))throw fail('UI_WRITE_RESULT_ID_INVALID');
        id=decodeURIComponent(actual[expected.indexOf(':id')]);
      }
      const valid=spec.idType==='integer'?Number.isSafeInteger(id)&&id>=0&&!Object.is(id,-0):spec.idType==='signed-integer'?Number.isSafeInteger(id)&&!Object.is(id,-0)
        :spec.idType==='decimal'?typeof id==='string'&&id.length<=512&&/^(?:0|-?[1-9][0-9]*)$/.test(id)
        :spec.idType==='string'&&typeof id==='string'&&id.length>0&&id.length<=512&&id!=='.'&&id!=='..'&&/^[\p{L}\p{N}_.-]+$/u.test(id);
      if(!valid)throw fail('UI_WRITE_RESULT_ID_INVALID');return id;
    });
    guard.check();if(error||count!==1)throw error||fail('UI_WRITE_NETWORK_AMBIGUOUS');
    return {...reply,value:{...reply.value,...(ids.length===1?{resultId:ids[0]}:{resultIds:ids})}};
  } catch(error){return {ok:false,error:{code:error.code||'UI_WRITE_NETWORK_FAILED',message:'Cannot bind the actual network result; inspect effects without replay.'},dispatched:true};}
  finally {if(listener)chrome.debugger.onEvent.removeListener(listener);await pin?.release();}
}
