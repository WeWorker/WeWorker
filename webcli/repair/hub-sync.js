/**
 * 经验库 hub 同步(二期 §7):修复完成上报(可关)、本地命中不足回源合并。
 * 全程静默失败——hub 同步绝不影响修复主流程。
 * 服务端行是 snake_case(root_cause/fix_strategy);上报时由 executor 转 hub 契约,
 * 回源时此处补 camelCase 别名,使 injectContext 无差别渲染本地与共享条目。
 */
const HUB_TIMEOUT_MS = 5000;

async function hubRequest(url, options = {}, fetchImpl = fetch) {
  const resp = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`hub ${resp.status}`);
  return resp;
}

export async function reportExperienceToHub({ entry, registry, token = process.env.ADAPTERHUB_TOKEN || '', fetchImpl = fetch } = {}) {
  if (!registry || !token) return false;
  try {
    await hubRequest(`${String(registry).replace(/\/$/, '')}/api/v1/experiences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(entry),
    }, fetchImpl);
    return true;
  } catch { return false; }
}

export async function fetchHubExperiences({ registry, site = '', runtime = '', rootCause = '', k = 3, fetchImpl = fetch } = {}) {
  if (!registry) return [];
  try {
    const params = new URLSearchParams();
    if (site) params.set('site', site);
    if (runtime) params.set('runtime', runtime);
    if (rootCause) params.set('root_cause', rootCause);
    params.set('k', String(k));
    const resp = await hubRequest(`${String(registry).replace(/\/$/, '')}/api/v1/experiences?${params}`, {}, fetchImpl);
    const body = await resp.json();
    // camelCase 别名(客户端字段优先)+ playbook JSON 字符串还原为对象
    return (body?.items || []).map((e) => {
      const item = { ...e, shared: true };
      if (item.rootCause == null && e.root_cause != null) item.rootCause = e.root_cause;
      if (item.fixStrategy == null && e.fix_strategy != null) item.fixStrategy = e.fix_strategy;
      if (item.lastOutcome == null && e.last_outcome != null) item.lastOutcome = e.last_outcome;
      if (typeof item.playbook === 'string') {
        try {
          const pb = JSON.parse(item.playbook);
          if (pb && typeof pb === 'object' && !Array.isArray(pb)) item.playbook = pb;
          else delete item.playbook;
        } catch { delete item.playbook; }
      }
      return item;
    });
  } catch { return []; }
}
