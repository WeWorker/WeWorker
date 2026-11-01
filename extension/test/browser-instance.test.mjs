import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_INSTANCE_STORAGE_KEY,
  browserInstanceHelloFields,
  createBrowserTab,
  focusBrowserWindow,
  isDedicatedBrowser,
  isOffscreenWindow,
  loadBrowserInstance,
  normalizeBrowserInstance,
  ONSCREEN_BOUNDS,
  revealWindowOnUserFocus,
  setBrowserInstanceForTest,
  watchBrowserInstance,
} from '../background/browser-instance.js';

function fakeChrome({ windows = [{ id: 11 }] } = {}) {
  const calls = [];
  return {
    calls,
    runtime: {
      getURL: (relative) => `chrome-extension://fixture/${relative}`,
    },
    tabs: {
      create: async (props) => { calls.push(['tabs.create', props]); return { id: 21, windowId: props.windowId ?? 11, active: props.active !== false }; },
      update: async (id, props) => { calls.push(['tabs.update', id, props]); return { id, ...props }; },
    },
    windows: {
      getAll: async (filter) => { calls.push(['windows.getAll', filter]); return windows; },
      create: async (props) => { calls.push(['windows.create', props]); return { id: 31 }; },
      update: async (id, props) => { calls.push(['windows.update', id, props]); return { id }; },
    },
  };
}

test('accepts only a complete WeWorker browser marker', () => {
  assert.deepEqual(normalizeBrowserInstance({ kind: 'dedicated', token: 'abc', extra: 1 }), { kind: 'dedicated', token: 'abc' });
  assert.equal(normalizeBrowserInstance({ kind: 'dedicated' }), null);
  assert.equal(normalizeBrowserInstance({ kind: 'system', token: 'abc' }), null);
  assert.equal(normalizeBrowserInstance('dedicated'), null);
});

test('loads the marker and adds its token to the hello', async () => {
  const storage = { get: async (key) => ({ [key]: { kind: 'dedicated', token: 'fixture-token' } }) };
  await loadBrowserInstance(storage);
  assert.equal(isDedicatedBrowser(), true);
  assert.deepEqual(browserInstanceHelloFields(), { instanceToken: 'fixture-token' });
  await loadBrowserInstance({ get: async () => { throw new Error('unavailable'); } });
  assert.equal(isDedicatedBrowser(), false);
  assert.deepEqual(browserInstanceHelloFields(), {});
});

test('reacts when the desktop writes the marker later', () => {
  setBrowserInstanceForTest(null);
  let listener;
  const seen = [];
  watchBrowserInstance((value) => seen.push(value), { onChanged: { addListener: (fn) => { listener = fn; } } });
  listener({ other: { newValue: 1 } }, 'local');
  listener({ [BROWSER_INSTANCE_STORAGE_KEY]: { newValue: { kind: 'dedicated', token: 't' } } }, 'sync');
  assert.equal(seen.length, 0);
  listener({ [BROWSER_INSTANCE_STORAGE_KEY]: { newValue: { kind: 'dedicated', token: 't' } } }, 'local');
  assert.deepEqual(seen, [{ kind: 'dedicated', token: 't' }]);
  assert.equal(isDedicatedBrowser(), true);
});

test('outside WeWorker browser tabs and focus behave exactly as before', async () => {
  setBrowserInstanceForTest(null);
  const api = fakeChrome();
  await createBrowserTab({ url: 'https://example.com/', active: true }, api);
  assert.equal(await focusBrowserWindow(11, api), true);
  assert.deepEqual(api.calls, [
    ['tabs.create', { url: 'https://example.com/', active: true }],
    ['windows.update', 11, { focused: true }],
  ]);
});

test('in WeWorker browser an active tab is selected without activating the OS window', async () => {
  setBrowserInstanceForTest({ kind: 'dedicated', token: 't' });
  const api = fakeChrome();
  const tab = await createBrowserTab({ url: 'https://example.com/' }, api);
  assert.equal(tab.active, true);
  assert.deepEqual(api.calls, [
    ['windows.getAll', { windowTypes: ['normal'] }],
    ['tabs.create', { url: 'https://example.com/', windowId: 11, active: false }],
    ['tabs.update', 21, { active: true }],
  ]);
  assert.equal(await focusBrowserWindow(11, api), false);
  assert.equal(api.calls.some(([name]) => name === 'windows.update'), false);
});

test('a window the user activates is brought on-screen, only in WeWorker browser', async () => {
  let listener;
  const updates = [];
  const windowsById = { 3: { id: 3, left: -18725, top: -18725, state: 'normal' }, 4: { id: 4, left: 50, top: 40, state: 'normal' }, 5: { id: 5, left: -18725, top: -18725, state: 'minimized' } };
  const api = {
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: { addListener: (fn) => { listener = fn; } },
      get: async (id) => windowsById[id],
      update: async (id, props) => { updates.push([id, props]); return { id }; },
    },
  };
  revealWindowOnUserFocus(api);
  setBrowserInstanceForTest(null);
  await listener(3);
  assert.deepEqual(updates, []);
  setBrowserInstanceForTest({ kind: 'dedicated', token: 't' });
  await listener(-1);
  await listener(4);
  assert.deepEqual(updates, []);
  assert.equal(isOffscreenWindow(windowsById[3]), true);
  await listener(3);
  assert.deepEqual(updates, [[3, { ...ONSCREEN_BOUNDS }]]);
  await listener(5);
  assert.deepEqual(updates.slice(1), [[5, { state: 'normal' }], [5, { ...ONSCREEN_BOUNDS }]]);
  revealWindowOnUserFocus({});
  setBrowserInstanceForTest(null);
});

test('in WeWorker browser background tabs stay inactive and a missing window is recreated with the dedicated landing page', async () => {
  setBrowserInstanceForTest({ kind: 'dedicated', token: 't' });
  const api = fakeChrome({ windows: [] });
  await createBrowserTab({ url: 'https://example.com/', active: false }, api);
  assert.deepEqual(api.calls, [
    ['windows.getAll', { windowTypes: ['normal'] }],
    ['windows.create', { url: 'chrome-extension://fixture/dedicated-browser/index.html', focused: false }],
    ['tabs.create', { url: 'https://example.com/', active: false, windowId: 31 }],
  ]);
  const explicit = fakeChrome();
  await createBrowserTab({ url: 'about:blank', windowId: 5, active: false }, explicit);
  assert.deepEqual(explicit.calls, [['tabs.create', { url: 'about:blank', windowId: 5, active: false }]]);
  setBrowserInstanceForTest(null);
});
