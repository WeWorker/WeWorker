import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {runBrowserPageCommand} from '../background/browser-page.js';
test('HTTP snapshots work without randomUUID and invalidate old references',async()=>{
 const node={tagName:'BUTTON',textContent:'Read',children:[],getClientRects:()=>[{}],getAttribute:()=>null,matches:()=>false,isConnected:true};
 const document={title:'Example',body:{innerText:'Read'},querySelectorAll:()=>[node]};node.ownerDocument=document;node.getRootNode=()=>document;
 const context=vm.createContext({document,location:{href:'http://example.com/'},ShadowRoot:class{},getComputedStyle:()=>({visibility:'visible'}),Uint8Array,crypto:{getRandomValues:globalThis.crypto.getRandomValues.bind(globalThis.crypto)}});
 const run=vm.runInContext(`(${runBrowserPageCommand.toString()})`,context);
 const first=await run('state',{});const second=await run('find',{text:'Read'});
 assert.equal(first.ok,true);assert.equal(second.ok,true);assert.notEqual(first.data.snapshotId,second.data.snapshotId);
 assert.equal((await run('get',{ref:first.data.elements[0].ref})).error.code,'STALE_REF');
});
