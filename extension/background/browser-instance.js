/**
 * Which browser this extension runs in.
 *
 * In WeWorker 浏览器 (the Chrome instance the desktop app starts with its own
 * profile and an off-screen window) the desktop writes a marker into local
 * storage. The extension then:
 * - sends the marker's token in `extension_hello`, so the bridge prefers this
 *   connection over an extension in the user's own Chrome;
 * - never focuses windows or creates focused ones, so automation never takes
 *   the user's keyboard or mouse focus.
 * Without the marker (the user's own Chrome) behaviour is unchanged.
 */
export const BROWSER_INSTANCE_STORAGE_KEY = 'weworkerBrowserInstance';

let current = null;

export function normalizeBrowserInstance(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.kind !== 'dedicated' || typeof value.token !== 'string' || !value.token) return null;
  return { kind: 'dedicated', token: value.token };
}

export async function loadBrowserInstance(storage = chrome.storage.local) {
  try {
    const stored = await storage.get(BROWSER_INSTANCE_STORAGE_KEY);
    current = normalizeBrowserInstance(stored?.[BROWSER_INSTANCE_STORAGE_KEY]);
  } catch {
    current = null;
  }
  return current;
}

/** Calls `onChange` when the desktop writes or clears the marker. */
export function watchBrowserInstance(onChange, storageApi = chrome.storage) {
  storageApi.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(BROWSER_INSTANCE_STORAGE_KEY in changes)) return;
    current = normalizeBrowserInstance(changes[BROWSER_INSTANCE_STORAGE_KEY].newValue);
    onChange(current);
  });
}

export function isDedicatedBrowser() {
  return current?.kind === 'dedicated';
}

/** Extra `extension_hello` fields; empty outside WeWorker 浏览器. */
export function browserInstanceHelloFields() {
  return current ? { instanceToken: current.token } : {};
}

async function backgroundWindowId(api) {
  const windows = await api.windows.getAll({ windowTypes: ['normal'] });
  if (windows.length > 0) return windows[0].id;
  // Chrome may keep the dedicated process and extension alive after the user closes
  // its last normal window. Recreate the window with the same local landing page
  // used at startup instead of leaving a permanent about:blank first tab.
  const landingUrl = api.runtime.getURL('dedicated-browser/index.html');
  const created = await api.windows.create({ url: landingUrl, focused: false });
  return created.id;
}

/**
 * chrome.tabs.create replacement. In WeWorker 浏览器 the tab is created
 * inactive in an existing window and then selected inside that window:
 * selecting a tab does not activate the OS window, creating an active tab does.
 */
export async function createBrowserTab(props = {}, api = chrome) {
  if (!isDedicatedBrowser()) return api.tabs.create(props);
  const windowId = Number.isInteger(props.windowId) ? props.windowId : await backgroundWindowId(api);
  const wantsActive = props.active !== false;
  const tab = await api.tabs.create({ ...props, windowId, active: false });
  if (!wantsActive || !Number.isInteger(tab?.id)) return tab;
  return (await api.tabs.update(tab.id, { active: true })) || tab;
}

/** chrome.windows.update(id, { focused: true }) replacement; a no-op in WeWorker 浏览器. */
export async function focusBrowserWindow(windowId, api = chrome) {
  if (isDedicatedBrowser()) return false;
  await api.windows.update(windowId, { focused: true });
  return true;
}

/** Windows parked off-screen sit far left/up (Chrome clamps -32000 to about -18000). */
export function isOffscreenWindow(win) {
  return Number.isFinite(win?.left) && Number.isFinite(win?.top) && (win.left < -10000 || win.top < -10000);
}

export const ONSCREEN_BOUNDS = Object.freeze({ left: 120, top: 80, width: 1200, height: 800 });

/**
 * In WeWorker 浏览器 nothing in WeWorker focuses a window, so a focus change
 * means the user activated it (taskbar, Alt+Tab, Dock) or a site opened a
 * focused popup. Either way the user wants to see it: bring an off-screen
 * window on-screen instead of leaving an invisible active window.
 */
export function revealWindowOnUserFocus(api = chrome) {
  if (!api?.windows?.onFocusChanged?.addListener) return;
  api.windows.onFocusChanged.addListener(async (windowId) => {
    if (!isDedicatedBrowser() || windowId === api.windows.WINDOW_ID_NONE || !Number.isInteger(windowId) || windowId < 0) return;
    try {
      const win = await api.windows.get(windowId);
      if (!isOffscreenWindow(win)) return;
      if (win.state && win.state !== 'normal') await api.windows.update(windowId, { state: 'normal' });
      await api.windows.update(windowId, { ...ONSCREEN_BOUNDS });
    } catch {
      // Window closed meanwhile.
    }
  });
}

/** Test hook. */
export function setBrowserInstanceForTest(value) {
  current = normalizeBrowserInstance(value);
}
