import { executeFrameScript, withBrowserFrameContext } from './browser-frames.js';
import { normalizeWorkflowFrames } from './page-workflow-frames.js';
import { createFrameOperation, settleFrameCleanup } from './frame-operation.js';

// Workflow-scoped owner and document identities; no URL/index rediscovery.

const fail = (code, message) => Object.assign(new Error(message), { code });
const sourceKey = source => source.sessionId || '';

/** Resolve each unique owner once; subsequent reads retain its real documents. */
export async function resolvePageFrame({ chrome, tabId, frames, ensureCdpAttached, assertRunning = () => {}, deadline }) {
  const chain = normalizeWorkflowFrames(frames), objects = [], selected = [], owners = [];
  let stepDeadline = Infinity;
  const guard = createFrameOperation({ ...(deadline === undefined ? {} : { deadline }), assertRunning: () => {
    assertRunning();
    if (Date.now() >= stepDeadline) throw fail('PAGE_QUERY_TIMEOUT', 'Frame step deadline reached; no action was replayed.');
  }, timeoutCode: 'PAGE_FRAME_TIMEOUT', timeoutMessage: 'Frame identity preparation exceeded its budget.' });
  const active = guard.check;
  let state;
  const send = (source, method, params) => guard.run(() => chrome.debugger.sendCommand(source, method, params));
  let released;
  const release = () => released ||= settleFrameCleanup(() => Promise.allSettled(objects.map(({ source, objectId }) => chrome.debugger.sendCommand(source, 'Runtime.releaseObject', { objectId }))));
  try {
    // Only enumerate document identities here. Waiting for document_idle across
    // every frame can stall on a replacement or an unrelated loading frame.
    // Owner availability and the exact retained documents are checked below.
    const all = await guard.run(() => chrome.scripting.executeScript({ target: { tabId, allFrames: true }, injectImmediately: true, world: 'ISOLATED', func: () => ({ url: location.href }) }));
    if (all.length > 50 || !all.some(frame => frame.frameId === 0 && frame.documentId)) throw fail('PAGE_FRAME_UNAVAILABLE', 'The frame tree is unavailable or exceeds 50 documents.');
    const contexts = [];
    for (const frame of all) {
      active();
      await withBrowserFrameContext(chrome, tabId, { frameId: frame.frameId, documentId: frame.documentId }, ensureCdpAttached, async data => {
        state = data.state;
        contexts.push({ selected: data.selected, isolated: data.isolated, context: data.context, url: frame.result.url });
      }, guard);
    }
    let parent = contexts.find(frame => frame.selected.frameId === 0);
    selected.push(parent);
    for (const declaration of chain) {
      const expression = `(() => { const nodes = [...document.querySelectorAll(${JSON.stringify(declaration.selector)})]; if(nodes.length !== 1 || !['IFRAME','FRAME'].includes(nodes[0].tagName)) return null; return nodes[0]; })()`;
      const object = await send(parent.isolated.source, 'Runtime.evaluate', { expression, uniqueContextId: parent.isolated.uniqueId });
      if (object.exceptionDetails || !object.result?.objectId) throw fail('PAGE_FRAME_TARGET_CHANGED', 'Choose exactly one iframe owner at every declared level.');
      const objectId = object.result.objectId;
      objects.push({ source: parent.isolated.source, objectId });
      const { node } = await send(parent.isolated.source, 'DOM.describeNode', { objectId });
      const matches = contexts.filter(frame => frame.context.auxData.frameId === node?.frameId);
      if (!node?.frameId || matches.length !== 1) throw fail('PAGE_FRAME_UNAVAILABLE', 'The selected owner has no unique live child document.');
      const child = matches[0], url = new URL(child.url);
      if (url.origin !== declaration.origin || url.pathname !== declaration.pathname) throw fail('PAGE_FRAME_ROUTE_CHANGED', 'The selected frame differs from its declared origin or pathname.');
      const signature = await send(parent.isolated.source, 'Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(){return [this.getAttribute("src"),this.getAttribute("srcdoc")];}', returnByValue: true });
      if (signature.exceptionDetails || !Array.isArray(signature.result?.value)) throw fail('PAGE_FRAME_TARGET_CHANGED', 'The frame owner changed before capture.');
      owners.push({ parent, child, declaration, objectId, signature: signature.result.value });
      selected.push(child); parent = child;
    }
    const assertCurrent = async (includeLeaf = true) => {
      active();
      for (const frame of includeLeaf ? selected : selected.slice(0, -1)) {
        for (const context of [frame.isolated, frame.context]) if (![...state.contexts.values()].some(item => item.uniqueId === context.uniqueId && sourceKey(item.source) === sourceKey(context.source))) throw fail('PAGE_FRAME_DOCUMENT_CHANGED', 'A selected frame or ancestor document was replaced. No action was replayed.');
        const current = await executeFrameScript(chrome, tabId, frame.selected, () => location.href, [], 'ISOLATED', guard, true);
        if (current.result !== frame.url) throw fail('PAGE_FRAME_ROUTE_CHANGED', 'A selected frame or ancestor changed its full URL.');
      }
      for (const owner of owners) {
        const result = await send(owner.parent.isolated.source, 'Runtime.callFunctionOn', { objectId: owner.objectId,
          functionDeclaration: 'function(selector, signature){ const nodes=[...this.ownerDocument.querySelectorAll(selector)];return this.isConnected && nodes.length===1 && nodes[0]===this && this.getAttribute("src")===signature[0] && this.getAttribute("srcdoc")===signature[1]; }',
          arguments: [{ value: owner.declaration.selector }, { value: owner.signature }], returnByValue: true });
        if (result.exceptionDetails || result.result?.value !== true) throw fail('PAGE_FRAME_TARGET_CHANGED', 'The frame owner was removed, replaced or became ambiguous.');
        const { node } = await send(owner.parent.isolated.source, 'DOM.describeNode', { objectId: owner.objectId });
        if (node?.frameId !== owner.child.context.auxData.frameId) throw fail('PAGE_FRAME_DOCUMENT_CHANGED', 'The owner no longer refers to the selected frame.');
      }
      active();
    };
    await assertCurrent();
    const tree = async () => {
      const result = await send(parent.context.source, 'Page.getFrameTree');
      const find = item => item?.frame?.id === parent.context.auxData.frameId ? item.frame : (item?.childFrames || []).map(find).find(Boolean);
      const frame = find(result.frameTree);
      if (!frame?.loaderId) throw fail('PAGE_FRAME_DOCUMENT_CHANGED', 'The selected frame loader is unavailable.');
      return frame;
    };
    // Only the executor of a declared navigation may call this. Retain every
    // ancestor and owner; never find a substitute owner by URL or selector.
    const refreshLeaf = async accept => {
      await assertCurrent(false);
      const row = await executeFrameScript(chrome, tabId, { frameId: parent.selected.frameId }, () => location.href, [], 'ISOLATED', guard, true);
      if (!accept(new URL(row.result))) throw fail('PAGE_FRAME_ROUTE_CHANGED', 'Frame navigation left its exact declared destination.');
      let next;
      await withBrowserFrameContext(chrome, tabId, { frameId: row.frameId, documentId: row.documentId }, ensureCdpAttached, async data => {
        next = { selected: data.selected, isolated: data.isolated, context: data.context, url: row.result };
      }, guard);
      if (next.context.auxData.frameId !== parent.context.auxData.frameId) throw fail('PAGE_FRAME_DOCUMENT_CHANGED', 'Navigation changed the retained frame identity.');
      parent = next; selected[selected.length - 1] = next; owners.at(-1).child = next;
      await assertCurrent();
    };
    const script = (func, input, world = 'ISOLATED') => executeFrameScript(chrome, tabId, parent.selected, func, input, world, guard, true);
    const snapshot = async () => {
      await assertCurrent();
      const row = await script(() => ({ url: location.href, status: document.readyState === 'complete' ? 'complete' : 'loading' }), []);
      const frame = await tree();
      await assertCurrent();
      return { ...row.result, frameId: frame.id, loaderId: frame.loaderId };
    };
    const identity = async () => {
      await assertCurrent();
      const nodes = [];
      for (const owner of owners) {
        const { node } = await send(owner.parent.isolated.source, 'DOM.describeNode', { objectId: owner.objectId });
        if (!node?.backendNodeId) throw fail('PAGE_FRAME_TARGET_CHANGED', 'Cannot retain the exact frame owner identity.');
        nodes.push(node.backendNodeId);
      }
      return { documents: selected.map(frame => ({ documentId: frame.selected.documentId, frameId: frame.context.auxData.frameId, url: frame.url })), owners: nodes };
    };
    return { get selected() { return parent.selected; }, get leaf() { return parent; }, origin: chain.at(-1).origin, pathname: chain.at(-1).pathname,
      withDeadline: async (limit, operation) => { stepDeadline = limit; try { return await guard.run(operation); } finally { stepDeadline = Infinity; } },
      assertCurrent, assertAncestors: () => assertCurrent(false), refreshLeaf, snapshot, identity, script, send, run: guard.run, check: guard.check, tree, release };
  } catch (error) { await release(); throw error; }
}
