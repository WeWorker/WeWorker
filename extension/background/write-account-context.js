// Account binding is deliberately conservative: all cookie stores/partitions of
// this browser are hashed, never returned. A cookie change invalidates a review.
const revisions = new WeakMap();
export async function writeAccountContext(api = chrome, crypt = crypto) {
  if (!revisions.has(api)) {
    const revision = { value: 0 };
    revisions.set(api, revision);
    api.cookies.onChanged?.addListener(() => { revision.value++; });
  }
  const startRevision = revisions.get(api).value;
  const stores = await api.cookies.getAllCookieStores();
  const cookies = [];
  for (const store of stores) {
    for (const cookie of await api.cookies.getAll({ storeId: store.id })) {
      cookies.push([store.id, cookie.domain, cookie.path, cookie.name, cookie.value,
        cookie.partitionKey?.topLevelSite || '', cookie.partitionKey?.hasCrossSiteAncestor ?? false]);
    }
  }
  cookies.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (startRevision !== revisions.get(api).value) throw Object.assign(new Error('Account changed while reading context.'), { code: 'WRITE_CONTEXT_CHANGED' });
  const digest = await crypt.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ cookies, revision: startRevision })));
  return { fingerprint: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
}

export async function assertWriteAccount(fingerprint, api = chrome, crypt = crypto) {
  if (fingerprint && fingerprint !== (await writeAccountContext(api, crypt)).fingerprint) {
    throw Object.assign(new Error('Account context changed; start a new reviewed request.'), { code: 'WRITE_CONTEXT_CHANGED' });
  }
}
