/** Serialize page replacement and calls so an update cannot replace a running command's globals. */
export function createHostAdapterRuntime({ bundle, prepare, clear, inject, navigate, ready, recover, now = Date.now, maxNavigations = 4, timeoutMs = 105000 }) {
  const queues = new Map();
  const stamps = new Map();
  const documents = new Map();
  return {
    invalidate(tabId) {
      stamps.delete(tabId);
      documents.set(tabId, (documents.get(tabId) || 0) + 1);
    },
    execute(tabId, manifest, url, operation = null, command = null) {
      const deadline = now() + timeoutMs;
      const task = (queues.get(tabId) || Promise.resolve()).catch(() => {}).then(async () => {
        const policy = command && manifest.commands?.find(entry => entry.id === command.id);
        let currentUrl = url;
        let recoveries = 0;
        for (let step = 0; ;) {
          if (now() >= deadline) throw new Error('Adapter page execution timed out.');
          for (let attempt = 0; ; attempt++) {
            if (ready) currentUrl = await ready(tabId, manifest, Math.min(25000, deadline - now()));
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
            result = operation ? await operation(Math.max(1, deadline - now())) : undefined;
          } catch (error) {
            // Only Chrome's classified BFCache transport loss is replayable.
            // Keep writes, business errors and ambiguous disconnects fail-closed.
            if (error.code !== 'ADAPTER_BFCACHE_DISCONNECTED' || policy?.safety !== 'read'
                || policy.requires_confirmation === true || !recover || recoveries >= 2) throw error;
            recoveries++;
            stamps.delete(tabId);
            if (now() >= deadline) throw new Error('Adapter page execution timed out.');
            await recover(tabId, manifest, currentUrl, Math.min(25000, deadline - now()));
            continue;
          }
          const next = result?.__webcli_navigation;
          if (!next) return result;
          if (!policy || !navigate || next.version !== 1 || typeof next.resume !== 'boolean') throw new Error('Invalid Adapter navigation continuation.');
          // Never replay writes, regardless of confirmation policy. A write may
          // request terminal navigation only; write errors and timeouts are never replayed.
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
      queues.set(tabId, task);
      void task.finally(() => { if (queues.get(tabId) === task) queues.delete(tabId); }).catch(() => {});
      return task;
    },
  };
}

/** Wait for the original page without undoing the user's navigation or executing on another host. */
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

/** Navigation is limited to declared page hosts; helper hosts allow terminal navigation only. */
export function assertAdapterNavigationUrl(manifest, value, resume = true) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid Adapter navigation URL.'); }
  const hosts = [...(manifest.match || []), ...(resume ? [] : (manifest.runtime_allowed_hosts || []))];
  const allowed = hosts.some(host => url.hostname === host || (host.startsWith('*.') && url.hostname.endsWith(host.slice(1))));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Adapter navigation host is not allowed.');
  }
  if (!allowed) {
    // Report only the origin: redirect queries, paths and fragments may contain
    // credentials or user data. This is diagnostic context, not permission to run.
    throw new Error(`Adapter navigation host is not allowed. 当前或目标页面域名：${url.origin}。`
      + '该域名未获当前 Adapter 授权，已停止执行。若浏览器已跳转至登录或安全验证页，请在连接扩展的同一浏览器中人工完成处理，返回原业务页面后重试；若仍被拒绝，请提供此错误及 trace ID。');
  }
  return url.href;
}

/** Observe load events before initiating navigation, including same-URL reloads. */
export async function navigateAdapterTab(api, tabId, url, manifest, resume, timeoutMs) {
  assertAdapterNavigationUrl(manifest, url, resume);
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
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Adapter page navigation timed out.');
  } finally { api.tabs.onUpdated.removeListener(listener); }
}
