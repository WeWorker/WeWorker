import { pageUiSubmit } from './ui-write.js';
import { executeFrameWrite } from './frame-write.js';
import { executeUiAction } from './ui-write-action.js';
import { createFrameOperation } from './frame-operation.js';
import { withUiNetworkResult } from './ui-write-network.js';
const fail = (code, message) => Object.assign(new Error(message), { code });

/** Mirrors the host's string-only bindings; tests compare both dispatch builders. */
export function pageWriteRequest(command, args) {
  const spec = command.pageWrite;
  if (!spec || spec.version !== 1 || command.runtime !== 'extension' || command.safety !== 'write' || command.requires_confirmation === false
    || !command.pageRoute || command.execution || command.pageWorkflow || spec.idempotency?.serverDeduplicates !== true
    || !['idempotency-key', 'x-idempotency-key'].includes(spec.idempotency?.header)) throw fail('INVALID_PAGE_WRITE', 'Unsupported page write contract.');
  if (args?.__confirmed !== true) throw fail('CONFIRMATION_REQUIRED', 'Explicit confirmation is required.');
  const bindings = spec.bodyParameters;
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings) || Object.keys(bindings).length > 30) throw fail('INVALID_PAGE_WRITE', 'Invalid page write bindings.');
  const names = Object.values(bindings);
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== '__confirmed' && !names.includes(key))
    || names.some(name => typeof args[name] !== 'string' || args[name].length > 10000)) throw fail('INVALID_PAGE_WRITE', 'Provide the declared string arguments.');
  return { url: spec.url, method: spec.method, body: Object.fromEntries(Object.entries(bindings).map(([key, name]) => [key, args[name]])) };
}

// Runs in a dedicated isolated world, without package or page JavaScript.
export async function pageJsonRequest(input) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    if (Date.now() >= input.deadline) return { ok: false, error: { code: 'PAGE_WRITE_TIMEOUT' } };
    if (location.href !== input.documentUrl || globalThis.__weworkerWriteDocumentToken !== input.documentToken) return { ok: false, error: { code: 'PAGE_WRITE_DOCUMENT_CHANGED' } };
    const response = await fetch(input.request.url, { method: input.request.method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      ...(input.request.method !== 'GET' ? { headers: { 'content-type': 'application/json', [input.idempotency.header]: input.idempotency.key }, body: JSON.stringify(input.request.body) } : {}), signal: controller.signal });
    if (!response.ok) return { ok: false, error: { code: 'PAGE_WRITE_HTTP_STATUS' } };
    const reader = response.body?.getReader();
    const specs=input.resultReadback ? (Array.isArray(input.resultReadback)?input.resultReadback:[input.resultReadback]) : [];
    const resultMetadata={headers:Object.fromEntries(specs.filter(spec=>spec.responseSource?.kind==='header').map(spec=>[spec.responseSource.name,response.headers.get(spec.responseSource.name)])),...(specs.some(spec=>spec.responseSource?.kind==='url')?{url:response.url}:{})};
    if (!reader) return { ok: true, value: null, ...(specs.length?{resultMetadata}:{}) };
    const decoder = new TextDecoder(); let size = 0, text = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); return { ok: false, error: { code: 'PAGE_WRITE_RESPONSE_LIMIT' } }; }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try {
      const paths=input.decimalPaths || specs.filter(spec=>spec.idType==='decimal'&&spec.responsePath).map(spec=>spec.responsePath),lexemes=new WeakMap();
      const value=text?JSON.parse(text,function(key,value,context){if(paths.length&&typeof value==='number'){let fields=lexemes.get(this);if(!fields)lexemes.set(this,fields=new Map());fields.set(key,context?.source);}return value;}):null;
      for(const path of paths){const keys=path.split('.'),last=keys.pop();let parent=value;for(const key of keys){if(!parent||typeof parent!=='object'||!Object.hasOwn(parent,key)){parent=null;break;}parent=parent[key];}
        if(parent&&Object.hasOwn(parent,last)&&typeof parent[last]==='number'){const raw=lexemes.get(parent)?.get(last);if(typeof raw!=='string'||raw.length>512||!/^(?:0|-?[1-9][0-9]*)$/.test(raw))return {ok:false,error:{code:'WRITE_RESULT_ID_INVALID'}};parent[last]=raw;}}
      return { ok: true, value, ...(specs.length?{resultMetadata}:{}) };
    }
    catch { return { ok: false, error: { code: 'PAGE_WRITE_INVALID_JSON' } }; }
  } catch { return { ok: false, error: { code: controller.signal.aborted ? 'PAGE_WRITE_TIMEOUT' : 'PAGE_WRITE_NETWORK_ERROR' } }; }
  finally { clearTimeout(timeout); }
}

/** Shared document-bound operation. Fetch writes require server idempotency; UI submissions make no network-count guarantee. */
export async function executePageRequest({ chrome, ensureCdpAttached, tabId, payload, assertRunning = () => {} }) {
  if (payload.ui?.result?.source === 'network') return withUiNetworkResult({chrome,ensureCdpAttached,tabId,payload,assertRunning,execute:next=>executePageRequest({chrome,ensureCdpAttached,tabId,payload:next,assertRunning})});
  if (payload.frames || payload.ui?.frames) return executeFrameWrite({ chrome, ensureCdpAttached, tabId, payload: { ...payload, frames: payload.frames || payload.ui.frames }, assertRunning, pageJsonRequest, pageUiSubmit });
  let dispatched = false, timer;
  const operation = createFrameOperation({deadline:payload.deadline,assertRunning,timeoutCode:'PAGE_WRITE_TIMEOUT'});
  const check = () => {
    assertRunning();
    if (!Number.isFinite(payload.deadline) || Date.now() >= payload.deadline) throw fail('PAGE_WRITE_TIMEOUT', 'Page request deadline expired.');
  };
  const bounded = async promise => {
    let timeout;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(fail('PAGE_WRITE_TIMEOUT', 'Page request deadline expired.')), Math.max(1, payload.deadline - Date.now()));
    })]); } finally { clearTimeout(timeout); }
  };
  try {
    check();
    const { route, request, expectedDocument, idempotency, ui } = payload;
    const url = new URL(request.url), page = new URL((await bounded(chrome.tabs.get(tabId))).url);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== route?.origin || url.username || url.password || url.hash
      || page.origin !== route.origin || page.pathname !== route.pathname || url.href !== request.url
      || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
      || Object.keys(request).some(key => !['url', 'method', 'body'].includes(key))
      || (request.method !== 'GET' && (payload.confirmed !== true || url.search || !request.body || typeof request.body !== 'object' || Array.isArray(request.body)))
      || (request.method === 'GET' && request.body !== undefined)) throw fail('INVALID_PAGE_WRITE', 'Page request does not match the exact same-origin route.');
    if (request.method !== 'GET' && !ui && (!['idempotency-key', 'x-idempotency-key'].includes(idempotency?.header) || !/^[a-f0-9-]{36,64}$/.test(idempotency?.key || ''))) throw fail('PAGE_WRITE_IDEMPOTENCY_REQUIRED', 'Page writes require a reviewed server idempotency contract.');
    if (JSON.stringify(request).length > 400000) throw fail('INVALID_PAGE_WRITE', 'Page request exceeds its size budget.');
    await bounded(ensureCdpAttached(tabId)); check();
    const send = (method, params = {}) => operation.run(() => chrome.debugger.sendCommand({ tabId }, method, params));
    const frame = (await send('Page.getFrameTree'))?.frameTree?.frame;
    if (!frame?.id || !frame.loaderId || frame.url !== page.href) throw fail('PAGE_WRITE_DOCUMENT_CHANGED', 'Cannot identify the selected document.');
    const document = { frameId: frame.id, loaderId: frame.loaderId, url: page.href };
    if (expectedDocument && ['frameId', 'loaderId', 'url'].some(key => expectedDocument[key] !== document[key])) throw fail('PAGE_WRITE_DOCUMENT_CHANGED', 'The before-check document was replaced.');
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'weworker-page-write-v1', grantUniveralAccess: false });
    if (!Number.isInteger(executionContextId)) throw fail('PAGE_WRITE_DOCUMENT_CHANGED', 'The isolated document context is unavailable.');
    const documentToken = crypto.randomUUID();
    await send('Runtime.evaluate', { contextId: executionContextId, expression: `globalThis.__weworkerWriteDocumentToken = ${JSON.stringify(documentToken)}`, returnByValue: true });
    const current = (await send('Page.getFrameTree'))?.frameTree?.frame;
    check();
    if (current?.id !== frame.id || current?.loaderId !== frame.loaderId || current?.url !== page.href) throw fail('PAGE_WRITE_DOCUMENT_CHANGED', 'Document changed before dispatch.');
    const input = { ...(ui ? { ui } : {}), resultReadback:payload.resultReadback,decimalPaths:payload.decimalPaths, documentUrl: page.href, documentToken, request, idempotency, deadline: ui ? Math.min(payload.deadline, Date.now() + 15000) : payload.deadline, timeoutMs: Math.min(15000, payload.deadline - Date.now()) };
    dispatched = request.method !== 'GET';
    if (ui && (ui.navigation || ui.submit.mode === 'enter')) {
      const evaluator = contextId => async (fn,value) => {
        const reply = await send('Runtime.evaluate',{contextId,expression:`(${fn.toString()})(${JSON.stringify(value)})`,awaitPromise:true,returnByValue:true});
        if(reply.exceptionDetails)throw fail('UI_WRITE_FAILED','The retained UI action failed.');
        return reply.result?.value;
      };
      const assertDocument = expected => async () => {
        const current=(await send('Page.getFrameTree'))?.frameTree?.frame;check();
        if(current?.id!==expected.frameId||current?.loaderId!==expected.loaderId||current?.url!==expected.url)throw fail('PAGE_WRITE_DOCUMENT_CHANGED','The retained document changed.');
      };
      await send('Page.bringToFront');
      const reply = await executeUiAction({chrome,tabId,input,initial:document,run:operation.run,evaluate:evaluator(executionContextId),assertCurrent:assertDocument(document),assertAncestors:async()=>check(),
        refresh:async(url,loaderId)=>{
          for(;;){
            const current=(await send('Page.getFrameTree'))?.frameTree?.frame,tab=await bounded(chrome.tabs.get(tabId));check();
            if(current?.id!==frame.id||current?.loaderId!==loaderId||current?.url!==url)throw fail('UI_WRITE_NAVIGATION_CHANGED','Unexpected submission destination.');
            if(tab.url===url)break;
            await operation.run(()=>new Promise(resolve=>setTimeout(resolve,25)));
          }
          const next={frameId:frame.id,loaderId,url};
          const world=await send('Page.createIsolatedWorld',{frameId:frame.id,worldName:'weworker-page-write-v1',grantUniveralAccess:false});
          return {document:next,evaluate:evaluator(world.executionContextId),assertCurrent:assertDocument(next)};
        }});
      if(!reply?.ok)throw fail(reply?.error?.code||'PAGE_WRITE_FAILED','UI confirmation failed.');
      return {ok:true,value:reply.value,document:reply.document||document,dispatched};
    }
    const result = await Promise.race([
      send('Runtime.evaluate', { contextId: executionContextId, expression: `(${(ui ? pageUiSubmit : pageJsonRequest).toString()})(${JSON.stringify(input)})`, awaitPromise: true, returnByValue: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(fail('PAGE_WRITE_TIMEOUT', 'Page request timed out.')), input.timeoutMs + 1000); }),
    ]);
    check();
    const after = (await send('Page.getFrameTree'))?.frameTree?.frame;
    if (after?.loaderId !== frame.loaderId || after?.id !== frame.id || after?.url !== page.href) throw fail('PAGE_WRITE_DOCUMENT_CHANGED', 'Document changed during the request.');
    const reply = result?.result?.value;
    if (result.exceptionDetails || !reply?.ok) throw fail(reply?.error?.code || 'PAGE_WRITE_FAILED', 'The page request did not complete successfully.');
    return { ok: true, value: reply.value, ...(reply.resultMetadata?{resultMetadata:reply.resultMetadata}:{}), document, dispatched };
  } catch (error) { return { ok: false, error: { code: error.code || 'PAGE_WRITE_FAILED', message: 'Page request failed; inspect the effect before another explicit write.' }, dispatched }; }
  finally { clearTimeout(timer); }
}
