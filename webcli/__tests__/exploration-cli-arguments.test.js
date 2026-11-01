import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { extractFlagArgs, resolveCliInvocation } from '../index.js';
const roots=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
it('preserves multiline content and rejects extra tool tokens',()=>{
 const content='{"中文":"value"}\nconst x = "a\\b";';
 expect(resolveCliInvocation(['call','exploration.draft-write','--content='+content])).toMatchObject({toolName:'exploration.draft-write',flagArgs:{content}});
 for(const extra of ['unexpected',';','--content','gamejam'])expect(()=>resolveCliInvocation(['call','exploration.draft-write',extra])).toThrow(/positional/);
 expect(resolveCliInvocation(['call','browser.open','--help']).toolName).toBe('browser.open');
});
it('reads BOM JSON files without changing nested types or source text',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cli-args-'));roots.push(root);
 const file=path.join(root,'中文 args.json');const args={content:'{\n "path": "C:\\\\example"\n}',plan:{tools:[{name:'list-items'}]},page:2};
 fs.writeFileSync(file,'\uFEFF'+JSON.stringify(args));
 for(const input of [['--args-file',file],['--args-file='+file]]) expect(extractFlagArgs([...input,'--page=3']).args).toEqual(args);
 expect(()=>extractFlagArgs(['--args-file',file,'--args','{}'])).toThrow(/exactly one/);
 fs.writeFileSync(file,'[]');expect(()=>extractFlagArgs(['--args-file',file])).toThrow(/object/);
 fs.writeFileSync(file,'invalid secret text');expect(()=>extractFlagArgs(['--args-file',file])).toThrow(/UTF-8/);
 expect(()=>extractFlagArgs(['--args-file'])).toThrow(/Missing/);
});
