import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installAdapter } from '../adapter-install-store.js';
import { validateV2Manifest } from '../adapter-package-validation.js';
import { managedAdapterView } from '../adapter-views.js';
import { WebSocketBridge } from '../bridge.js';
import { v2CommandDef } from '../../extension/background/v2-loader.js';

let root;
const execution = {type:'api',runtime:'background'};
function manifest(background = true) { return {schema_version:2,name:'demo',version:'1.0.0',description:'Fixture',match:['example.com'],
  commands:[{id:'list',runtime:'extension',module:'extension/commands/list.js',description:'Fixture',schema:{},...(background?{execution}: {})}]}; }
function install(pkg, allowPermissionChange = false) { return installAdapter({origin:{kind:'local'},allowPermissionChange,files:new Map([
  ['manifest.json',JSON.stringify(pkg)],['extension/commands/list.js','fixture source'],
])}); }
beforeEach(() => {
  root=mkdtempSync(join(tmpdir(),'adapter-background-'));
  for(const [key,value] of Object.entries({WEWORKER_BUILD_PROFILE:'public',WEWORKER_BUILTIN_ADAPTERS_DIR:join(root,'builtin'),
    WEWORKER_USER_ADAPTERS_DIR:join(root,'user'),WEBCLI_ADAPTERS_DIR:join(root,'user'),WEWORKER_ADAPTER_DATA_DIR:join(root,'data')})) vi.stubEnv(key,value);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root,{recursive:true,force:true}); });

describe('background command package contract', () => {
  it('rejects unknown execution semantics and Toolkit background declarations', () => {
    for(const value of [null,{}, {type:'dom',runtime:'background'}, {...execution,unknown:true}]) {
      const pkg=manifest();pkg.commands[0].execution=value;
      expect(()=>validateV2Manifest(pkg)).toThrow(/execution/);
    }
    const pkg=manifest();pkg.commands[0].runtime='wewright';
    expect(()=>validateV2Manifest(pkg)).toThrow(/execution/);
  });
  it('requires a new grant when a page command gains background execution', () => {
    install(manifest(false));const update={...manifest(),version:'1.1.0'};
    expect(()=>install(update)).toThrow(/permission/i);
    expect(managedAdapterView('demo').version).toBe('1.0.0');
    install(update,true);
    expect(managedAdapterView('demo').tools[0]).toMatchObject({execution,directCapable:true,executionMode:'direct'});
    expect(v2CommandDef(update,update.commands[0])).toMatchObject({execution,directCapable:true,executionMode:'direct'});
  });
  it('requires the negotiated background protocol before forwarding a pinned call', async () => {
    const installed=install(manifest());const request=vi.fn(async()=> 'fixture');
    const bridge={_request:request,_emitTraceEvent:vi.fn(),_extensionCapabilities:['adapter_catalog_v1']};
    await expect(WebSocketBridge.prototype._callToolInner.call(bridge,'demo.list',{})).rejects.toThrow(/Reload/);
    expect(request).not.toHaveBeenCalled();bridge._extensionCapabilities.push('adapter_background_v1');
    expect(await WebSocketBridge.prototype._callToolInner.call(bridge,'demo.list',{count:'007'})).toBe('fixture');
    expect(request.mock.calls[0][0]).toMatchObject({args:{count:'007'},adapterSnapshot:{digest:installed.digest}});
  });
  it('requires the page source protocol before dispatching a route-bound command', async () => {
    const pkg = manifest(false);
    pkg.commands[0].pageRoute = { origin: 'https://example.com', pathname: '/items' };
    install(pkg);
    const request = vi.fn(async () => 'fixture');
    const bridge = { _request: request, _emitTraceEvent: vi.fn(), _extensionCapabilities: ['adapter_catalog_v1'] };
    await expect(WebSocketBridge.prototype._callToolInner.call(bridge, 'demo.list', {})).rejects.toThrow(/Reload/);
    expect(request).not.toHaveBeenCalled();
    bridge._extensionCapabilities.push('page_sources_v1');
    expect(await WebSocketBridge.prototype._callToolInner.call(bridge, 'demo.list', {})).toBe('fixture');
    expect(request).toHaveBeenCalledOnce();
  });
});
