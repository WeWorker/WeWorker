import { adapterHelperPatterns, adapterPagePatterns, hostMatchesPattern } from './host-scope.js';

/** Serialize page replacement and calls so an update cannot replace a running command's globals. */
export function createHostAdapterRuntime({ bundle, prepare, clear, inject, navigate, ready, recover, query, now = Date.now, maxNavigations = 4, timeoutMs = 105000 }) {
  const queues = new Map();
  const stamps = new Map();
  const documents = new Map();
  function exclusive(tabId, operation) {
    const task = (queues.get(tabId) || Promise.resolve()).catch(() => {}).then(operation);
    queues.set(tabId, task);
    void task.finally(() => { if (queues.get(tabId) === task) queues.delete(tabId); }).catch(() => {});
    return task;
  }
  return {
    exclusive,
    hasSnapshot(tabId, manifest, url) {
      return stamps.get(tabId) === JSON.stringify([manifest.name, manifest._hostSnapshot, url]);
    },
    invalidate(tabId) {
      stamps.delete(tabId);
      documents.set(tabId, (documents.get(tabId) || 0) + 1);
    },
    execute(tabId, manifest, url, operation = null, command = null, traceID = null) {
      const deadline = now() + timeoutMs;
      return exclusive(tabId, async () => {
        const policy = command && manifest.commands?.find(entry => entry.id === command.id);
        let currentUrl = url, continuation = null, recoveries = 0;
        for (let step = 0; ;) {
          if (now() >= deadline) throw new Error('Adapter page execution timed out.');
          for (let attempt = 0; ; attempt++) {
            if (ready) currentUrl = await ready(tabId, manifest, Math.min(25000, deadline - now()), traceID);
            if (now() >= deadline) throw new Error('Adapter page execution timed out.');
            const stamp = JSON.stringify([manifest.name, manifest._hostSnapshot, currentUrl]);
            const sources = await bundle(manifest);
            if (stamps.get(tabId) === stamp) break;
            const document = documents.get(tabId) || 0;
            try {
              await prepare(tabId);
              await clear(tabId, manifest.name);
              stamps.delete(tabId);
              await inject(tabId, manifest, currentUrl, sources);
              if ((documents.get(tabId) || 0) !== document) throw new Error('Adapter document changed during injection.');
              stamps.set(tabId, stamp);
              break;
            } catch (error) {
              stamps.delete(tabId);
              // Registration has not invoked the business handler yet. Only
              // recover document changes; never replay an operation exception.
              const changed = (documents.get(tabId) || 0) !== document || /Adapter (document|target) changed/.test(error.message);
              if (!ready || !changed || attempt >= 2) throw error;
            }
          }
          if (now() >= deadline) throw new Error('Adapter page execution timed out.');
          let result;
          try {
            result = operation ? await operation(Math.max(1, deadline - now()), continuation) : undefined;
          } catch (error) {
            // Only a transport error explicitly classified as BFCache loss is
            // replayable. Business failures, writes and confirmation-gated
            // commands remain fail-closed.
            if (error.code !== 'ADAPTER_BFCACHE_DISCONNECTED' || policy?.safety !== 'read'
                || policy.requires_confirmation === true || !recover || recoveries >= 2) throw error;
            recoveries++;
            stamps.delete(tabId);
            if (now() >= deadline) throw new Error('Adapter page execution timed out.');
            await recover(tabId, manifest, currentUrl, Math.min(25000, deadline - now()));
            continue;
          }
          if (result?.__webcli_page_query) {
            if (continuation || !query || policy?.safety !== 'read' || policy.pageWorkflow !== true) throw new Error('Invalid or repeated page query continuation.');
            const payload = result.__webcli_page_query;
            if (payload.version !== 1) throw new Error('Unsupported page query version.');
            const output = await query(tabId, payload, manifest, policy);
            if (!output?.ok) return output;
            continuation = { kind: 'page_query_result', result: output };
            stamps.delete(tabId);
            continue;
          }
          if (continuation && result?.__webcli_navigation) throw new Error('A resumed page query cannot request another navigation.');
          const next = result?.__webcli_navigation;
          if (!next) return result;
          if (!policy || !navigate || next.version !== 1 || typeof next.resume !== 'boolean') throw new Error('Invalid Adapter navigation continuation.');
          // Never replay writes, regardless of confirmation policy. A write may
          // request terminal navigation only; errors and timeouts are never replayed.
          if (next.resume && policy.safety !== 'read') throw new Error('Write commands cannot be replayed after navigation.');
          if (step >= maxNavigations) throw new Error('Adapter navigation limit exceeded.');
          const target = assertAdapterNavigationUrl(manifest, next.url, next.resume);
          if (now() >= deadline) throw new Error('Adapter page execution timed out.');
          stamps.delete(tabId);
          currentUrl = await navigate(tabId, target, manifest, next.resume, Math.min(25000, deadline - now()));
          assertAdapterNavigationUrl(manifest, currentUrl, next.resume);
          if (now() >= deadline) throw new Error('Adapter page execution timed out.');
          if (!next.resume) return next.result ?? { status: 'navigation_complete', url: currentUrl };
          step++;
        }
      });
    },
  };
}

/** Wait for the original page without activating another tab or undoing user navigation. */
export async function waitForAdapterPageRecovery(api, tabId, manifest, expectedUrl, timeoutMs, { now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  assertAdapterNavigationUrl(manifest, expectedUrl);
  const deadline = now() + timeoutMs;
  let stable = false;
  while (now() < deadline) {
    const tab = await api.tabs.get(tabId);
    if (!tab) throw new Error('Adapter tab was closed.');
    const restored = tab.status === 'complete' && tab.url === expectedUrl && !tab.pendingUrl;
    if (restored && stable) return assertAdapterNavigationUrl(manifest, tab.url);
    stable = restored;
    await sleep(150);
  }
  throw new Error('Adapter page entered back/forward cache; return to the original business page and retry.');
}

/**
 * Classifies a navigation target against the package's declared hosts.
 * This is the single source of truth for the allowed-host rule; both the
 * strict assertion below and the fail-fast wait guard reuse it.
 *
 * - `allowed`: host is declared by `manifest.match` or `manifest.domains`
 *   (always) or by `runtime_allowed_hosts` (terminal navigation only, i.e.
 *   `resume === false`).
 * - `forbidden`: a real http(s) page whose host is not declared.
 * - `unknown`: not judgeable yet (about:blank, chrome-error, data:, an
 *   unparseable value): the tab has not reached a page we can judge.
 */
export function classifyNavigationTarget(manifest, value, resume = true) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { return 'unknown'; }
  if (!['http:', 'https:'].includes(url.protocol)) return 'unknown';
  if (url.username || url.password) return 'forbidden';
  // Page scope: `match` plus every subdomain of `domains`; helper hosts allow terminal navigation only.
  // The host rules themselves live in host-scope.js (`*.x` is x and every subdomain).
  const patterns = resume ? adapterPagePatterns(manifest) : adapterHelperPatterns(manifest);
  return patterns.some((pattern) => hostMatchesPattern(url.hostname, pattern)) ? 'allowed' : 'forbidden';
}

/** Navigation is limited to declared page hosts; helper hosts allow terminal navigation only. */
export function assertAdapterNavigationUrl(manifest, value, resume = true) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid Adapter navigation URL.'); }
  if (classifyNavigationTarget(manifest, url.href, resume) !== 'allowed') {
    // Name the host (never the full URL): the caller must see that this is a package
    // declaration problem that retrying cannot fix.
    const host = ['http:', 'https:'].includes(url.protocol) ? url.hostname : url.protocol;
      const message = `Adapter navigation host is not allowed. Host: ${host}（页面跳转到了该 Adapter 未声明的网站，这是 Adapter 配置问题，重试无效；开发者可在 manifest 的 domains 中声明该网站的域名）`;
    throw Object.assign(new Error(message), {
      code: 'ADAPTER_HOST_NOT_ALLOWED',
    });
  }
  return url.href;
}

/**
 * How long a URL must stay unchanged on a non-declared host before the wait is
 * abandoned. A 302/redirect chain (the normal "hop to A, then land on the
 * declared host" flow) changes `tab.url` within this window, which resets the
 * timer, so a still-redirecting tab is never rejected. Only a URL that has
 * stopped moving on a host the manifest does not declare is judged final.
 */
export const NAVIGATION_TARGET_SETTLE_MS = 1500;

/**
 * Tracks the URL observed while a page loads and decides when waiting can no
 * longer succeed. State lives in the returned closure; the decision itself is a
 * pure function of (manifest, observed URL, time).
 *
 * `observe(url, at)` returns `'reject'` only when the same non-declared http(s)
 * URL has been observed for `settleMs`; every other observation returns `'wait'`.
 * Non-http targets and declared hosts always return `'wait'` (they only affect
 * how long we wait, never correctness).
 */
export function createNavigationGuard(manifest, resume = true, options = {}) {
  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : NAVIGATION_TARGET_SETTLE_MS;
  const now = options.now || Date.now;
  let lastUrl = null;
  let stableSince = 0;
  return {
    observe(value, at = now()) {
      const url = String(value ?? '');
      if (classifyNavigationTarget(manifest, url, resume) !== 'forbidden') {
        lastUrl = null;
        stableSince = 0;
        return 'wait';
      }
      if (url !== lastUrl) {
        lastUrl = url;
        stableSince = at;
        return 'wait';
      }
      return at - stableSince >= settleMs ? 'reject' : 'wait';
    },
    get url() { return lastUrl; },
  };
}

/** Observe load events before initiating navigation, including same-URL reloads. */
export async function navigateAdapterTab(api, tabId, url, manifest, resume, timeoutMs) {
  assertAdapterNavigationUrl(manifest, url, resume);
  // Same fail-fast rule as waitForManagedPageReady: a redirect that settles on a
  // host the package does not declare is rejected without waiting for `complete`.
  const guard = createNavigationGuard(manifest, resume);
  let complete = false;
  const listener = (id, change) => { if (id === tabId && change.status === 'complete') complete = true; };
  api.tabs.onUpdated.addListener(listener);
  const deadline = Date.now() + timeoutMs;
  try {
    const current = await api.tabs.get(tabId);
    const reload = current.url === url;
    if (reload) await api.tabs.reload(tabId);
    else await api.tabs.update(tabId, { url });
    while (Date.now() < deadline) {
      const tab = await api.tabs.get(tabId);
      if (!tab) throw new Error('Adapter tab was closed.');
      if (tab.status === 'complete' && (complete || (!reload && tab.url === url))) {
        return assertAdapterNavigationUrl(manifest, tab.url, resume);
      }
      if (guard.observe(tab.url, Date.now()) === 'reject') {
        return assertAdapterNavigationUrl(manifest, tab.url, resume);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Adapter page navigation timed out.');
  } finally { api.tabs.onUpdated.removeListener(listener); }
}
