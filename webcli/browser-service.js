import { inspectLocalUpload } from './upload-files.js';
import fs from 'node:fs';
import path from 'node:path';
import { browserCommands, browserHelp, isBrowserObserver } from './browser-commands.js';
import { resolveAdapterPaths } from './paths.js';
import { assertManagedDirectory, assertManagedFile } from './adapter-package-files.js';
import { explorationError as fail, integerArg, textArg } from './exploration-commands.js';
import { TabOperationLocks } from './tab-operation-locks.js';

export class BrowserService {
  constructor({ rootDir, readOnly = false, requestExtension, tabLocks = new TabOperationLocks(), capabilities = () => ({ connected: false, capabilities: [] }) } = {}) {
    this.root = rootDir || path.join(resolveAdapterPaths().workspaceDir, 'browser');
    assertManagedDirectory(this.root); if (!readOnly) fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.file = assertManagedFile(this.root, 'sessions.json');
    this.bindings = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.request = requestExtension; this.capabilities = capabilities; this.busy = new Set(); this.tabLocks = tabLocks;
  }
  save() {
    const temp = assertManagedFile(this.root, 'sessions.json.tmp');
    fs.writeFileSync(temp, JSON.stringify(this.bindings), { mode: 0o600 }); fs.renameSync(temp, this.file);
  }
  async execute(command, args = {}) {
    let session, ownsSession = false;
    try {
      const spec = Object.hasOwn(browserCommands, command) ? browserCommands[command] : null;
      if (!spec) throw fail('UNKNOWN_COMMAND', 'Use webcli call browser.help.');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('INVALID_ARGUMENT', 'Arguments must be an object.');
      for (const key of Object.keys(args)) if (!spec.params.some(param => param.replace(/\?$/, '') === key)) throw fail('INVALID_ARGUMENT', `Unknown argument: ${key}`);
      for (const param of spec.params.filter(param => !param.endsWith('?'))) if (args[param] === undefined) throw fail('INVALID_ARGUMENT', `Missing argument: ${param}`);
      if (command === 'wait' && args.kind !== 'download' && args.value === undefined) throw fail('INVALID_ARGUMENT', 'value is required for this wait kind.');
      if (command === 'wait' && args.shadow !== undefined && args.kind !== 'selector') throw fail('INVALID_ARGUMENT', 'shadow is available for selector waits only.');
      if (['console', 'network'].includes(command) && ['follow', 'cursor', 'durationMs', 'maxEvents', 'intervalMs'].some(key => args[key] !== undefined)) throw fail('INVALID_ARGUMENT', 'Streaming flags belong to the CLI. Direct Bridge clients should poll browser.events with its cursor.');
      if (spec.params.includes('session')) {
        session = textArg(args.session, 'session', 80);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(session) || ['__proto__', 'constructor', 'prototype'].includes(session)) throw fail('INVALID_ARGUMENT', 'Use an alphanumeric session name.');
        // Dialog replies and passive observers must not block the triggering action.
        if (!isBrowserObserver(command, args)) {
          if (this.busy.has(session)) throw fail('SESSION_BUSY', 'Another operation is using this session.');
          this.busy.add(session); ownsSession = true;
        }
      }
      const data = await this.dispatch(command, args, session);
      return { schemaVersion: 1, ok: true, command: `browser.${command}`, data };
    } catch (error) {
      return { schemaVersion: 1, ok: false, command: `browser.${command}`, error: { code: error.code || 'BROWSER_OPERATION_FAILED',
        message: error.code ? String(error.message).slice(0, 1000) : 'Browser operation failed. Inspect connection and current tab state.', ...(error.details ? { details: error.details } : {}) } };
    } finally { if (ownsSession) this.busy.delete(session); }
  }
  async tabs() {
    if (!this.capabilities().connected) throw fail('EXTENSION_UNAVAILABLE', 'Connect the WeWorker extension.');
    const result = await this.request({ type: 'exploration_list_tabs' }, 15000);
    return (result.tabs || []).filter(tab => /^https?:\/\//.test(tab.url));
  }
  async send(command, args, tabId, identity) {
    if (!this.capabilities().capabilities.includes('browser_commands_v1')) throw fail('EXTENSION_UPGRADE_REQUIRED', 'Reload the extension built from this branch to enable browser commands.');
    if(command==='upload'&&(args.directory||args.chooser)&&!this.capabilities().capabilities.includes('browser_upload_extended_v1'))throw fail('EXTENSION_UPGRADE_REQUIRED','Reload the selected extension for directory and chooser uploads.');
    if(command==='upload'&&!this.capabilities().capabilities.includes('browser_upload_target_v1'))throw fail('EXTENSION_UPGRADE_REQUIRED','Reload the extension to upload to retained frame/shadow targets with verification.');
    if((args.compound!==undefined||args.property==='compound'||args.as!==undefined||['depth','childrenMax','textMax','maxNodes','by'].some(key=>args[key]!==undefined))&&!this.capabilities().capabilities.includes('browser_compound_v1'))throw fail('EXTENSION_UPGRADE_REQUIRED','Reload the extension to inspect compound controls, structured HTML or select by an explicit match mode.');
    if((args.shadow!==undefined||String(args.ref||'').startsWith('shadow:'))&&!this.capabilities().capabilities.includes('browser_shadow_query_v1'))throw fail('EXTENSION_UPGRADE_REQUIRED','Reload the extension to query open shadow roots or operate their references.');
    if(command==='screenshot'&&['annotate','width','height'].some(key=>args[key]!==undefined)&&!this.capabilities().capabilities.includes('browser_screenshot_v1'))throw fail('EXTENSION_UPGRADE_REQUIRED','Reload the extension to annotate screenshots or temporarily change their viewport.');
    if (((command === 'state' && (args.source !== undefined || args.compareSources !== undefined)) || String(args.ref||'').startsWith('ax:')) && !this.capabilities().capabilities.includes('browser_accessibility_v1')) throw fail('EXTENSION_UPGRADE_REQUIRED','Reload the extension to use AX snapshots, source comparison and AX references.');
    if ((args.documentId !== undefined || (command === 'eval' && args.frameId !== undefined)) && !this.capabilities().capabilities.includes('browser_frames_v1')) throw fail('EXTENSION_UPGRADE_REQUIRED', 'Reload the extension to select a frame/document; an older extension may evaluate in the main page.');
    if (Number(args.frameId) && ['click', 'dblclick', 'hover', 'drag'].includes(command) && !this.capabilities().capabilities.includes('browser_frame_pointer_v1')) throw fail('EXTENSION_UPGRADE_REQUIRED', 'Reload the extension to execute native pointers in child frames. Older extensions use synthetic DOM events.');
    if ((command === 'downloads' || (command === 'wait' && args.kind === 'download')) && !this.capabilities().capabilities.includes('browser_downloads_v1')) throw fail('EXTENSION_UPGRADE_REQUIRED', 'Reload the extension to observe tab download lifecycles.');
    if ((command === 'events' || args.until !== undefined || (command === 'console' && (args.since !== undefined || args.match !== undefined)) || (command === 'network' && typeof args.since === 'string' && /[a-z]/i.test(args.since)) || String(args.detail || '').startsWith('event:')) && !this.capabilities().capabilities.includes('browser_events_v1')) throw fail('EXTENSION_UPGRADE_REQUIRED', 'Reload the extension to use cursor-based browser events and time filters.');
    const release = isBrowserObserver(command, args) ? () => {} : this.tabLocks.acquire(tabId);
    try {
      const result = await this.request({ type: 'browser_execute', command, args, tabId, identity }, 45000);
      if (!result?.ok) throw Object.assign(fail(result?.error?.code || 'BROWSER_OPERATION_FAILED', result?.error?.message || 'Browser operation failed.'), result?.error?.details ? { details: result.error.details } : {});
      return result.data;
    } finally { release(); }
  }
  async dispatch(command, args, session) {
    if (command === 'help') return browserHelp();
    if (command === 'sessions') return { sessions: Object.values(this.bindings) };
    if (command === 'doctor') {
      const state = this.capabilities(); let tabQuery = false;
      if (state.connected) { await this.tabs(); tabQuery = true; }
      return { ...state, tabQuery, browserCommands: state.capabilities.includes('browser_commands_v1'),
        ready: tabQuery && state.capabilities.includes('browser_commands_v1'), desktopRequired: false };
    }
    if (command === 'tabs') return { tabs: await this.tabs() };
    const binding = Object.hasOwn(this.bindings, session) ? this.bindings[session] : null;
    if (command === 'unbind') { delete this.bindings[session]; this.save(); return { session, released: true, tabClosed: false }; }
    if (command === 'bind') {
      if (binding) throw fail('SESSION_BOUND', 'Unbind or close this session before rebinding.');
      const tabId = integerArg(args.tabId, 'tabId');
      if (!(await this.tabs()).some(tab => tab.id === tabId)) throw fail('TAB_NOT_FOUND', 'Choose an HTTP(S) tab from browser.tabs.');
      if (Object.values(this.bindings).some(item => item.tabId === tabId)) throw fail('TAB_BUSY', 'This tab belongs to another session.');
      const { identity } = await this.send('bind', {}, tabId);
      if (Object.values(this.bindings).some(item => item.tabId === tabId)) throw fail('TAB_BUSY', 'This tab was bound by another session.');
      this.bindings[session] = { session, tabId, identity, owned: false, createdAt: new Date().toISOString() }; this.save();
      return this.bindings[session];
    }
    if (command === 'open') {
      let url; try { url = new URL(args.url); } catch { throw fail('INVALID_ARGUMENT', 'Provide an HTTP(S) URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('INVALID_ARGUMENT', 'Provide an HTTP(S) URL without embedded credentials.');
      if (binding && !binding.owned) throw fail('BOUND_TAB_NAVIGATION', 'Use a separate session to open a page; this session is bound to a user tab.');
      const result = await this.send('open', { url: url.href, background: args.background === true || args.background === 'true' }, binding?.tabId, binding?.identity);
      this.bindings[session] = { session, tabId: result.tabId, identity: result.identity, owned: true, createdAt: binding?.createdAt || new Date().toISOString() }; this.save();
      return { ...this.bindings[session], ...result };
    }
    if (!binding) throw fail('SESSION_NOT_FOUND', 'Use browser.open or browser.bind first.');
    if (command === 'close') {
      if (binding.owned && (await this.tabs()).some(tab => tab.id === binding.tabId)) await this.send('close', {}, binding.tabId, binding.identity);
      delete this.bindings[session]; this.save(); return { session, released: true, tabClosed: binding.owned };
    }
    if (!(await this.tabs()).some(tab => tab.id === binding.tabId)) throw fail('TAB_NOT_FOUND', 'The session tab was closed. Unbind and choose another tab.');
    if (command === 'back' && !binding.owned) throw fail('BOUND_TAB_NAVIGATION', 'Back is available only for session-owned tabs.');
    if (command === 'upload') {
      for (const key of ['directory','chooser']) if (args[key] !== undefined && ![true,false,'true','false'].includes(args[key])) throw fail('INVALID_ARGUMENT', key+' must be boolean.');
      const directory = args.directory === true || args.directory === 'true', chooser = args.chooser === true || args.chooser === 'true';
      const files = inspectLocalUpload(args.paths, directory);
      const {session:ignored,...params}=args;
      return{session,tabId:binding.tabId,...await this.send(command,{...params,directory,chooser,_uploadFiles:files},binding.tabId,binding.identity)};
    }
    if(command==='screenshot'&&args.path!==undefined){
      if(typeof args.path!=='string'||!path.isAbsolute(args.path))throw fail('INVALID_ARGUMENT','Screenshot path must be absolute.');
      try{if(!fs.statSync(path.dirname(args.path)).isDirectory())throw new Error('Not a directory');}
      catch{throw fail('SCREENSHOT_PATH_UNAVAILABLE','The screenshot parent directory is unavailable.');}
      if(fs.existsSync(args.path))throw fail('SCREENSHOT_FILE_EXISTS','The screenshot destination already exists. Choose a new path.');
      const {session:ignored,path:destination,...params}=args;
      const result=await this.send(command,params,binding.tabId,binding.identity);
      if(result.mimeType!=='image/png'||typeof result.data!=='string')throw fail('SCREENSHOT_INVALID','The extension did not return a PNG screenshot.');
      const buffer=Buffer.from(result.data,'base64');
      if(buffer.length<24||!buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw fail('SCREENSHOT_INVALID','The extension did not return a PNG screenshot.');
      try{fs.writeFileSync(destination,buffer,{flag:'wx',mode:0o600});}
      catch(error){throw fail(error.code==='EEXIST'?'SCREENSHOT_FILE_EXISTS':'SCREENSHOT_SAVE_FAILED','Could not save to the selected new screenshot path.');}
      const {data:ignoredData,...metadata}=result;
      return {session,tabId:binding.tabId,...metadata,path:destination,bytes:buffer.length};
    }
    const { session: ignored, ...params } = args;
    return { session, tabId: binding.tabId, ...await this.send(command, params, binding.tabId, binding.identity) };
  }
}
