import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { businessArgs, businessSchema } from '../business-args.js';
import { buildV2Bootstrap } from '../adapter-extension-loader.js';
import { extractFlagArgs } from '../index.js';
import { invokeHostCli } from '../host-cli-runtime.js';

describe('ordinary calls without a confirmation protocol', () => {
  it('strips only the retired top-level control and preserves business options', () => {
    const original = { __confirmed: ['true', false], yes: false, confirm: true, execute: true, 'dry-run': true, body: { __confirmed: 'business value' } };
    expect(businessArgs(original)).toEqual({ yes: false, confirm: true, execute: true, 'dry-run': true, body: original.body });
    expect(original.__confirmed).toEqual(['true', false]);
    expect(businessSchema({ type: 'object', properties: { name: { type: 'string' }, __confirmed: { type: 'boolean' } }, required: ['name', '__confirmed'], 'x-webcli-requires-confirmation': true })).toEqual({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] });
  });
  it('accepts old flags without requiring their spelling or value for execution', () => {
    for (const flag of ['--__confirmed', '--__confirmed=true', '--__confirmed=false', '--__confirmed=garbage']) {
      expect(businessArgs(extractFlagArgs(['--pipelineId=123', flag]).args)).toEqual({ pipelineId: '123' });
    }
  });
  it('keeps malformed positional input as a CLI syntax error, never an authorization grant', () => {
    expect(extractFlagArgs(['--pipelineId=123', '__confirmed=true'])).toEqual({ args: { pipelineId: '123' }, rest: ['__confirmed=true'] });
  });
  for (const policy of [undefined, false, true]) for (const marker of [undefined, false, true, 'true', ['true','true']]) {
    it(`executes once with legacy policy=${policy}, marker=${marker}`, async () => {
      const tools=[];
      const scope=vm.createContext({ window: { __webmcpRegister: entry=>tools.push(...entry.tools) } });
      vm.runInContext(buildV2Bootstrap({ name:'example.com', commands:[{id:'submit',runtime:'extension',safety:'write',requires_confirmation:policy}] }),scope);
      vm.runInContext('window.__webcliRegisterCommand("submit", args => args)',scope);
      const args={id:'123',...(marker===undefined?{}:{__confirmed:marker})};
      expect(await tools[0].handler(args)).toEqual({id:'123'});
      const ws={},snapshot={name:'example.com',digest:'a'.repeat(64),profile:'public'};
      const selected={snapshot,adapter:{source:'builtin'},command:{id:'submit',safety:'write',runtime:'extension',requires_confirmation:policy,execution:{type:'api',runtime:'background'}}};
      const pending={ws,controller:new AbortController(),hostCall:{toolName:'example.com.submit',snapshot,originalArgs:args}};
      let count=0;
      const call={parentId:'call',ws,payload:{args},pendingRequests:new Map([['call',pending]]),resolveAdapterCall:()=>selected,
        execute:async ({args,markWriteDispatched})=>{expect(args).toEqual({id:'123'});markWriteDispatched();count++;return {ok:true}},credentials:async()=>[]};
      expect(await invokeHostCli(call)).toEqual({ok:true});
      await expect(invokeHostCli(call)).rejects.toMatchObject({code:'HOST_CLI_ALREADY_CALLED'});
      expect(count).toBe(1);
    });
  }
});
