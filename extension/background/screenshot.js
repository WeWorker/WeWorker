/**
 * Target choice and chrome.debugger capture for `capture_screenshot`.
 *
 * Adapter commands run in background tabs, so the window's active tab is often
 * unrelated to what the model wants to show (in WeWorker 浏览器 it is often the
 * dedicated landing page). The screenshot therefore goes to the tab of the last
 * Adapter call, selected in its window first: a background tab may never
 * paint, and a CDP screenshot waits for a frame.
 *
 * Every chrome.debugger step has its own timeout and a session this module
 * attached is always detached, so one stuck capture cannot leave the tab
 * attached (Chrome then refuses every later capture with "Another debugger is
 * already attached").
 */

export const SCREENSHOT_STEP_TIMEOUT_MS = Object.freeze({ attach: 5000, capture: 15000 });

/** Origin and path only: query strings and fragments may carry session data. */
export function displayPageUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const http = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    return http ? `${parsed.origin}${parsed.pathname}` : `${parsed.protocol}${parsed.pathname}`;
  } catch {
    return '';
  }
}
/** Time for a just-selected tab to paint before it is captured. */
export const SCREENSHOT_SELECT_SETTLE_MS = 300;
const TOOL_TAB_STORAGE_KEY = 'screenshotToolTab';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Remembers the tab the last Adapter command ran in (kept across service worker restarts). */
export function createToolTabTracker(api) {
  let last = null;
  return {
    note(tabId) {
      if (!Number.isInteger(tabId)) return;
      last = tabId;
      try {
        const saved = api?.storage?.session?.set?.({ [TOOL_TAB_STORAGE_KEY]: tabId });
        saved?.catch?.(() => {});
      } catch {
        // Session storage unavailable; the in-memory value still applies.
      }
    },
    async get() {
      if (last != null) return last;
      try {
        const stored = await api?.storage?.session?.get?.(TOOL_TAB_STORAGE_KEY);
        const tabId = stored?.[TOOL_TAB_STORAGE_KEY];
        if (Number.isInteger(tabId)) last = tabId;
      } catch {
        // Nothing stored.
      }
      return last;
    },
  };
}

async function existingTab(api, tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    return (await api.tabs.get(tabId)) || null;
  } catch {
    return null; // Closed meanwhile.
  }
}

/**
 * The tab to capture: the requested one, else the tab of the last Adapter
 * call, else the active tab of the last focused window.
 */
export async function pickScreenshotTab({ api = chrome, tabId = null, toolTabId = null } = {}) {
  const requested = await existingTab(api, tabId);
  if (requested) return { tab: requested, reason: 'requested' };
  if (Number.isInteger(tabId)) throw new Error(`标签页 ${tabId} 不存在`);
  const toolTab = await existingTab(api, toolTabId);
  if (toolTab) return { tab: toolTab, reason: 'last_tool_call' };
  const [focused] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  const active = focused || (await api.tabs.query({ active: true }))[0];
  if (!active) throw new Error('未找到可截图的标签页');
  return { tab: active, reason: 'active_tab' };
}

/** Select the tab inside its window (does not focus the OS window) and let it paint. */
export async function selectTabForScreenshot({ api = chrome, tab, settleMs = SCREENSHOT_SELECT_SETTLE_MS, wait = sleep } = {}) {
  if (tab.active) return tab;
  const updated = await api.tabs.update(tab.id, { active: true });
  await wait(settleMs);
  return { ...tab, ...(updated || {}), active: true };
}

/** CDP target id of a tab; reading it does not attach a debugger. */
export async function debuggerTargetId({ api = chrome, tabId } = {}) {
  try {
    const targets = await api.debugger.getTargets();
    return targets.find((target) => target.tabId === tabId && (!target.type || target.type === 'page'))?.id ?? null;
  } catch {
    return null;
  }
}

export function withStepTimeout(promise, ms, step) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`${step} 超时（${ms} ms）`), { code: 'SCREENSHOT_TIMEOUT', step }));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Page.captureScreenshot through chrome.debugger. A session another feature
 * holds on the tab (`borrowed`) is used as is and left attached.
 */
export async function captureTabViaDebugger({
  api = chrome, tabId, borrowed = false, format = 'jpeg', quality = 80,
  timeouts = SCREENSHOT_STEP_TIMEOUT_MS, log = () => {},
} = {}) {
  const target = { tabId };
  let owned = false;
  const started = Date.now();
  try {
    if (!borrowed) {
      const attaching = api.debugger.attach(target, '1.3');
      try {
        await withStepTimeout(attaching, timeouts.attach, 'debugger.attach');
      } catch (error) {
        // An attach that completes after its timeout must not stay behind.
        attaching.then(() => api.debugger.detach(target)).catch(() => {});
        throw error;
      }
      owned = true;
      log(`debugger attached (${Date.now() - started} ms)`);
    }
    const shotStarted = Date.now();
    const { data } = await withStepTimeout(
      api.debugger.sendCommand(target, 'Page.captureScreenshot', { format, quality }),
      timeouts.capture, 'Page.captureScreenshot',
    );
    log(`Page.captureScreenshot done (${Date.now() - shotStarted} ms)`);
    return `data:image/${format === 'png' ? 'png' : 'jpeg'};base64,${data}`;
  } finally {
    if (owned) {
      try {
        await api.debugger.detach(target);
        log('debugger detached');
      } catch {
        // Already detached (tab closed or navigated away).
      }
    }
  }
}
