import { resolvePageFrame } from './page-frame-context.js';
import { executeUiAction } from './ui-write-action.js';
import { createFrameOperation } from './frame-operation.js';

const fail = code => Object.assign(new Error(code), { code });

/** Resolve declared owners, then bind every read/write to their exact identities. */
export async function executeFrameWrite({ chrome, tabId, payload, ensureCdpAttached, assertRunning, pageJsonRequest, pageUiSubmit }) {
  let pin, dispatched = false;
  const guard=createFrameOperation({deadline:payload.deadline,assertRunning,timeoutCode:'PAGE_WRITE_TIMEOUT'});
  try {
    const { route, request, ui, frames, expectedDocument } = payload;
    const page = new URL((await guard.run(()=>chrome.tabs.get(tabId))).url), url = new URL(request.url);
    if (page.origin !== route.origin || page.pathname !== route.pathname || url.origin !== frames.at(-1).origin
      || url.href !== request.url || url.username || url.password || url.hash || !['GET','POST'].includes(request.method)
      || Object.keys(request).some(key => !['url','method','body'].includes(key))
      || request.method === 'GET' && request.body !== undefined
      || request.method !== 'GET' && (!ui || ui.version !== 2 || payload.confirmed !== true || url.search || JSON.stringify(frames) !== JSON.stringify(ui.frames))
      || JSON.stringify(request).length > 400000) throw fail('INVALID_PAGE_WRITE');
    pin = await resolvePageFrame({ chrome, tabId, frames, ensureCdpAttached, assertRunning, deadline: payload.deadline });
    const identity = await pin.identity(), snapshot = await pin.snapshot();
    const document = { frameId:snapshot.frameId, loaderId:snapshot.loaderId, url:snapshot.url, identity };
    if (expectedDocument && JSON.stringify(expectedDocument) !== JSON.stringify(document)) throw fail('PAGE_WRITE_DOCUMENT_CHANGED');
    const documentToken = crypto.randomUUID();
    await pin.script(token => {globalThis.__weworkerWriteDocumentToken = token;}, [documentToken]);
    await pin.assertCurrent();
    const input = { ui, request, resultReadback:payload.resultReadback,decimalPaths:payload.decimalPaths, documentUrl: snapshot.url, documentToken, deadline: Math.min(payload.deadline, Date.now()+15000), timeoutMs: Math.min(15000,payload.deadline-Date.now()) };
    dispatched = request.method !== 'GET';
    if(ui && (ui.navigation || ui.submit.mode==='enter')) {
      await pin.send({tabId},'Page.bringToFront');
      // Freeze this evaluator to the old context, including cleanup after navigation.
      const evaluator=leaf=>async(fn,value)=>{
        const reply=await pin.send(leaf.isolated.source,'Runtime.evaluate',{uniqueContextId:leaf.isolated.uniqueId,expression:`(${fn.toString()})(${JSON.stringify(value)})`,awaitPromise:true,returnByValue:true});
        if(reply.exceptionDetails)throw fail('UI_WRITE_FAILED');return reply.result?.value;
      };
      const reply=await executeUiAction({chrome,tabId,input,initial:snapshot,run:pin.run,evaluate:evaluator(pin.leaf),assertCurrent:pin.assertCurrent,assertAncestors:pin.assertAncestors,
        refresh:async(url,loaderId)=>{
          await pin.refreshLeaf(current=>current.href===url);
          const snapshot=await pin.snapshot();if(snapshot.loaderId!==loaderId)throw fail('UI_WRITE_NAVIGATION_CHANGED');
          return {document:{frameId:snapshot.frameId,loaderId:snapshot.loaderId,url:snapshot.url,identity:await pin.identity()},evaluate:evaluator(pin.leaf),assertCurrent:pin.assertCurrent};
        }});
      if(!reply?.ok)throw fail(reply?.error?.code||'PAGE_WRITE_FAILED');
      return {ok:true,value:reply.value,document:reply.document||document,dispatched};
    }
    const row = await pin.script(ui ? pageUiSubmit : pageJsonRequest, [input]);
    await pin.assertCurrent();
    if (!row.result?.ok) throw fail(row.result?.error?.code || 'PAGE_WRITE_FAILED');
    return { ok:true, value:row.result.value, ...(row.result.resultMetadata?{resultMetadata:row.result.resultMetadata}:{}), document, dispatched };
  } catch(error) {
    return {ok:false,error:{code:error.code || 'PAGE_WRITE_FAILED',message:'Frame write failed; inspect the effect before another explicit call.'},dispatched};
  } finally { await pin?.release(); }
}
