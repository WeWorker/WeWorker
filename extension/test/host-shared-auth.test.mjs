import test from 'node:test';
import assert from 'node:assert/strict';
import { readHostCliCookies } from '../background/http-credentials.js';
test('shared authentication uses only exact installed helper hosts and URL-matching cookies', async () => {
  const calls=[];
  const chrome={cookies:{getAll:async request=>{calls.push(request);return [
    {name:'session',value:'placeholder',domain:'auth.example.org'},
    {name:'other',value:'placeholder-other',domain:'app.example.com'},
    {name:'partitioned',value:'placeholder',domain:'auth.example.org',partitionKey:{topLevelSite:'https://example.org'}},
  ];}}};
  const request={url:'https://auth.example.org/'};
  await assert.rejects(readHostCliCookies(chrome,request,'app.example.com',['*.example.org']));
  await assert.rejects(readHostCliCookies(chrome,{...request,credentialHosts:['auth.example.org']},'app.example.com'));
  assert.equal(calls.length,0);
  const result=await readHostCliCookies(chrome,request,'app.example.com',['auth.example.org']);
  assert.deepEqual(result.cookies.map(c=>c.name),['session']);
  assert.deepEqual(calls,[request]);
});
