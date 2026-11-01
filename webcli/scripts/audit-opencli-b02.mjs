// Executes unmodified OpenCLI 1.8.8 methods in an isolated loopback/CDP harness.
// This is not a validation of the upstream daemon or browser extension.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const arg=name=>process.argv.find(v=>v.startsWith('--'+name+'='))?.slice(name.length+3);
const upstream=arg('upstream'), playwright=arg('playwright'), executablePath=arg('chromium');
if(!upstream||!playwright)throw new Error('Pass --upstream=<extracted 1.8.8 package> --playwright=<module> and optionally --chromium=<executable>.');
assert.equal(JSON.parse(await fs.readFile(path.join(upstream,'package.json'),'utf8')).version,'1.8.8');
const {chromium}=await import(pathToFileURL(path.resolve(playwright)).href);
const {BasePage}=await import(pathToFileURL(path.resolve(upstream,'dist/src/browser/base-page.js')).href);
const {selectResolvedJs}=await import(pathToFileURL(path.resolve(upstream,'dist/src/browser/target-resolver.js')).href);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'opencli-b02-audit-'));
const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<input id="date" type="date"><select id="select"><option value="one">One</option><option value="two">Two</option></select><button id="custom" role="combobox">Choose</button><input id="file" type="file"><input id="directory" type="file" webkitdirectory><button id="chooser" onclick="document.querySelector(\'#file\').click()">Browse</button>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath});
const page=await browser.newPage();const cdp=await page.context().newCDPSession(page);
class AuditPage extends BasePage {evaluate(js){return cdp.send('Runtime.evaluate',{expression:js,awaitPromise:true,returnByValue:true}).then(r=>{if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;});}cdp(method,params){return cdp.send(method,params);}}
const adapter=new AuditPage(),checks=[];
try{
 await page.goto('http://127.0.0.1:'+server.address().port);
 await assert.rejects(adapter.fillText('#date','2026-10-28'),e=>e.code==='not_editable');checks.push('BasePage.fillText date rejects not_editable');await adapter.typeText('#date','2026-10-28');assert.equal(await page.locator('#date').inputValue(),'2026-10-28');checks.push('BasePage.typeText native date via DOM fallback');
 await adapter.evaluate('window.__resolved=document.querySelector("#select")');assert.deepEqual(await adapter.evaluate(selectResolvedJs('Two')),{selected:'Two'});checks.push('native select by label');
 await adapter.evaluate('window.__resolved=document.querySelector("#custom")');assert.deepEqual(await adapter.evaluate(selectResolvedJs('Two')),{error:'Not a <select>'});checks.push('custom combobox select rejected');
 const file=path.join(root,'example.json');await fs.writeFile(file,'{"example":true}');
 const uploaded=await adapter.uploadFiles('#file',[file]);assert.equal(uploaded.uploaded,true);assert.deepEqual(uploaded.file_names,["example.json"]);checks.push('native input upload via actual BasePage CDP fallback');
 const directory=path.join(root,'example-folder');await fs.mkdir(directory);await fs.writeFile(path.join(directory,'a.json'),'{}');
 const dir=await adapter.uploadFiles('#directory',[directory]);await page.waitForFunction(()=>document.querySelector('#directory').files.length===1);checks.push({directoryReturned:dir.uploaded,relativePath:await page.locator('#directory').evaluate(n=>n.files[0].webkitRelativePath)});
 await assert.rejects(adapter.uploadFiles('#chooser',[file]));checks.push('chooser button upload rejected as not_file_input');
 await fs.writeFile(path.join(root,'report.json'),JSON.stringify({version:'1.8.8',transport:'BasePage with direct CDP harness; not upstream daemon/extension',checks},null,2));console.log(JSON.stringify({root,checks}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
