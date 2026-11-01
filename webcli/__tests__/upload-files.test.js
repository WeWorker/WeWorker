import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {it,expect,afterEach,vi} from 'vitest';
import {inspectLocalUpload} from '../upload-files.js';
const roots=[];
const root=()=>{const value=fs.mkdtempSync(path.join(os.tmpdir(),'example-directory-'));roots.push(value);return value;};
afterEach(()=>{for(const value of roots.splice(0))fs.rmSync(value,{recursive:true,force:true});});
it('snapshots duplicate leaf names by relative path and rejects empty/wrong modes',()=>{
  const folder=root();
  expect(()=>inspectLocalUpload([folder],true)).toThrow(/contain a file/);
  fs.mkdirSync(path.join(folder,'nested'));fs.writeFileSync(path.join(folder,'same.json'),'one');fs.writeFileSync(path.join(folder,'nested/same.json'),'two2');
  const files=inspectLocalUpload([folder],true);
  expect(files).toEqual([{name:'same.json',size:4,relativePath:path.basename(folder)+'/nested/same.json'},{name:'same.json',size:3,relativePath:path.basename(folder)+'/same.json'}]);
  expect(()=>inspectLocalUpload([folder])).toThrow(/regular files/);
  expect(()=>inspectLocalUpload([folder,folder],true)).toThrow(/one directory/);
  expect(()=>inspectLocalUpload([path.join(folder,'missing')],true)).toThrow(/unavailable/);
});
it('rejects directory junctions, too many files and deep trees before dispatch',()=>{
  const folder=root(),outside=root();fs.writeFileSync(path.join(outside,'example.json'),'example');
  fs.symlinkSync(outside,path.join(folder,'link'),process.platform==='win32'?'junction':'dir');
  expect(()=>inspectLocalUpload([folder],true)).toThrow(/links or junctions/);
  const many=root();for(let i=0;i<201;i++)fs.writeFileSync(path.join(many,String(i)+'.json'),'x');
  expect(()=>inspectLocalUpload([many],true)).toThrow(/200 files/);
  const deep=root();let dir=deep;for(let i=0;i<17;i++){dir=path.join(dir,'d');fs.mkdirSync(dir);}
  fs.writeFileSync(path.join(dir,'example.json'),'x');expect(()=>inspectLocalUpload([deep],true)).toThrow(/16 levels/);
});
it('fails closed for a changed file identity or size and closes its handle',()=>{
  const folder=root(),file=path.join(folder,'example.json');fs.writeFileSync(file,'example');
  const fstat=fs.fstatSync.bind(fs);
  const read=vi.spyOn(fs,'readFileSync'), close=vi.spyOn(fs,'closeSync');
  const mismatch=vi.spyOn(fs,'fstatSync').mockImplementation((fd,...args)=>{
    const info=fstat(fd,...args);return Object.assign(Object.create(info),{size:info.size+1});
  });
  try{
    read.mockClear();close.mockClear();
    expect(()=>inspectLocalUpload([file])).toThrow(expect.objectContaining({code:'UPLOAD_FILE_VIEW_MISMATCH'}));
    expect(()=>inspectLocalUpload([folder],true)).toThrow(expect.objectContaining({code:'UPLOAD_FILE_VIEW_MISMATCH'}));
    expect(read).not.toHaveBeenCalled();expect(close).toHaveBeenCalledTimes(2);
    mismatch.mockImplementation((fd,...args)=>{const info=fstat(fd,...args);return Object.assign(Object.create(info),{ino:info.ino ? info.ino+1 : 2});});
    const info=fs.lstatSync(file);
    if(info.ino)expect(()=>inspectLocalUpload([file])).toThrow(expect.objectContaining({code:'UPLOAD_FILE_VIEW_MISMATCH'}));
  } finally {mismatch.mockRestore();read.mockRestore();close.mockRestore();}
});
it('rejects a different regular file substituted between lstat and open',()=>{
  const folder=root(),file=path.join(folder,'example.json'),replacement=path.join(folder,'replacement.json');
  fs.writeFileSync(file,'same');fs.writeFileSync(replacement,'same');
  const before=fs.lstatSync(file),other=fs.lstatSync(replacement);
  // Some filesystems do not provide a useful distinct inode. The metadata
  // guard cannot prove identity in that case.
  if (!before.ino || !other.ino || (before.dev===other.dev && before.ino===other.ino)) return;
  const open=fs.openSync.bind(fs);
  const spy=vi.spyOn(fs,'openSync').mockImplementation((name,...args)=>{
    fs.renameSync(file,path.join(folder,'original.json'));fs.renameSync(replacement,file);
    return open(name,...args);
  });
  try{expect(()=>inspectLocalUpload([file])).toThrow(expect.objectContaining({code:'UPLOAD_FILE_VIEW_MISMATCH'}));}
  finally{spy.mockRestore();}
});
it('fails closed and closes a handle if fstat fails',()=>{
  const folder=root(),file=path.join(folder,'example.json');fs.writeFileSync(file,'example');
  const close=vi.spyOn(fs,'closeSync'),stat=vi.spyOn(fs,'fstatSync').mockImplementation(()=>{throw new Error('fixture failure')});
  try{expect(()=>inspectLocalUpload([file])).toThrow(expect.objectContaining({code:'FILE_UNAVAILABLE'}));expect(close).toHaveBeenCalledTimes(1);}
  finally{stat.mockRestore();close.mockRestore();}
});
