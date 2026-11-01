import { pageUiSubmit, pageUiNavigationReceipt } from './ui-write.js';
import { settleFrameCleanup } from './frame-operation.js';

const fail=code=>Object.assign(new Error(code),{code});

/** One prepared submit/Enter, with an optional exact navigation acknowledgement. */
export async function executeUiAction({ chrome, tabId, input, initial, run, evaluate, assertCurrent, assertAncestors, refresh }) {
  const token='__weworkerUiAction_'+crypto.randomUUID().replaceAll('-','');
  const cleanupEvaluate=evaluate;
  const prepared=await evaluate(pageUiSubmit,{...input,actionToken:token});
  if(!prepared?.ok)throw fail(prepared?.error?.code||'UI_WRITE_FAILED');
  let armed=false,eventError,loader,lastEvent;
  let acknowledge;
  const navigation=new Promise(resolve=>{acknowledge=resolve;});
  const listener=(source,method,params)=>{
    if(!armed||source.tabId!==tabId)return;
    const frame=method==='Page.frameNavigated'&&params.frame?.id===initial.frameId;
    const within=method==='Page.navigatedWithinDocument'&&params.frameId===initial.frameId;
    if(!frame&&!within)return;
    const url=frame?params.frame.url+(params.frame.urlFragment||''):params.url;
    const signature=JSON.stringify([method,url,params.frame?.loaderId]);if(signature===lastEvent)return;lastEvent=signature;
    if(!input.ui.navigation||url!==input.ui.navigation.url||!frame||params.frame.loaderId===initial.loaderId||loader&&loader!==params.frame.loaderId)eventError=fail('UI_WRITE_NAVIGATION_CHANGED');
    if(frame)loader=params.frame.loaderId;
    acknowledge();
  };
  chrome.debugger.onEvent.addListener(listener);
  try {
    await assertCurrent();armed=true;
    const dispatch=()=>evaluate(function(name){const action=globalThis[name];if(!action||!action.check())throw new Error('UI_WRITE_TARGET_CHANGED');action.dispatch();return true;},token);
    if(input.ui.submit.mode==='enter') {
      await dispatch();await assertCurrent();
      const focused=await evaluate(function(name){const action=globalThis[name];let root=document;while(root.activeElement?.shadowRoot)root=root.activeElement.shadowRoot;return action?.node===root.activeElement&&document.hasFocus()&&action.check();},token);
      if(!focused)throw fail('UI_WRITE_FOCUS_CHANGED');
      try {await run(()=>chrome.debugger.sendCommand({tabId},'Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',windowsVirtualKeyCode:13,text:'\r'}));}
      finally {await settleFrameCleanup(()=>chrome.debugger.sendCommand({tabId},'Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',windowsVirtualKeyCode:13}));}
    } else await run(()=>input.ui.navigation?Promise.race([dispatch(),navigation]):dispatch());
    if(input.ui.navigation) {
      await run(()=>navigation);if(eventError)throw eventError;
      await assertAncestors();
      const destination=await refresh(input.ui.navigation.url,loader);if(eventError)throw eventError;
      const result=await destination.evaluate(pageUiNavigationReceipt,{...input,documentUrl:input.ui.navigation.url,previousId:prepared.previousId});
      await destination.assertCurrent();if(eventError)throw eventError;
      if(!result?.ok)throw fail(result?.error?.code||'UI_WRITE_CONFIRMATION_FAILED');
      return {...result,document:destination.document};
    }
    const result=await evaluate(async function(name){return await globalThis[name].waitReceipt();},token);
    await assertCurrent();if(eventError)throw eventError;
    return result;
  } finally {
    armed=false;chrome.debugger.onEvent.removeListener(listener);
    await settleFrameCleanup(()=>cleanupEvaluate(function(name){delete globalThis[name];},token));
  }
}
