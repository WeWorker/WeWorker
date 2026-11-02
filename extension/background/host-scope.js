/**
 * Adapter website scope — one implementation for the Extension and WebCLI.
 *
 * WebCLI keeps a byte-identical copy at webcli/host-scope.js (checked by a test), so
 * v2-loader.js and its WebCLI copy can import it by the same relative path.
 * Pure functions only: no chrome.*, no Node APIs.
 *
 * A v2 manifest declares where its page code may run and navigate:
 * - `match`: exact page hosts. The first entry is the primary host (default route).
 *   A `*.example.com` entry means example.com and all of its subdomains.
 * - `domains`: site domains such as ["jd.com", "jd.hk"]. Each covers the domain itself and
 *   every subdomain, so Adapter authors do not have to list order.*, search.*, item.* …
 *   Different site domains of one company (regional or brand domains) are listed explicitly;
 *   they are never inferred, because a redirect alone does not prove ownership.
 */

/** Second-level public suffixes that must never be declared as a site domain. */
const PUBLIC_SUFFIXES = new Set([
  // Country second-level registries.
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'mil.cn',
  'com.hk', 'net.hk', 'org.hk', 'gov.hk', 'edu.hk', 'idv.hk',
  'com.tw', 'net.tw', 'org.tw', 'gov.tw', 'edu.tw', 'idv.tw',
  'com.mo', 'net.mo', 'org.mo', 'gov.mo', 'edu.mo',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'gr.jp',
  'co.kr', 'or.kr', 'go.kr', 'ac.kr', 'ne.kr',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz', 'ac.nz',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'edu.in',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'co.za', 'org.za', 'gov.za', 'ac.za',
  'com.tr', 'org.tr', 'gov.tr', 'edu.tr',
  'com.ru', 'org.ru', 'net.ru',
  'co.id', 'or.id', 'go.id', 'ac.id',
  'co.th', 'or.th', 'go.th', 'ac.th', 'in.th',
  'com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn',
  'com.ph', 'net.ph', 'org.ph', 'gov.ph', 'edu.ph',
  'com.ar', 'com.co', 'com.pe', 'com.ua', 'com.pl', 'com.es', 'com.pt',
  // Shared hosting where every subdomain belongs to a different owner.
  'github.io', 'gitlab.io', 'gitee.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app',
  'herokuapp.com', 'appspot.com', 'web.app', 'firebaseapp.com', 'blogspot.com', 'wordpress.com',
  'cloudfront.net', 'azurewebsites.net', 'azureedge.net', 'amazonaws.com', 'cloudflare.net',
  'onrender.com', 'fly.dev', 'glitch.me', 'repl.co', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com',
  'myshopify.com', 'notion.site', 'webflow.io', 'surge.sh', 'readthedocs.io',
]);

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

/** Exact host, or `*.domain` for the domain and every subdomain. */
export function hostMatchesPattern(host, pattern) {
  const target = normalizeHost(host);
  const value = normalizeHost(pattern);
  if (!target || !value) return false;
  if (value.startsWith('*.')) return hostInDomain(target, value.slice(2));
  return target === value;
}

export function hostInDomain(host, domain) {
  const target = normalizeHost(host);
  const value = normalizeHost(domain);
  return !!value && (target === value || target.endsWith('.' + value));
}

/** The longest domain suffix two hosts share, label by label ('' when only the TLD matches). */
function sharedDomainSuffix(one, two) {
  const a = normalizeHost(one).split('.');
  const b = normalizeHost(two).split('.');
  const shared = [];
  while (a.length && b.length && a[a.length - 1] === b[b.length - 1]) {
    shared.unshift(a.pop());
    b.pop();
  }
  return shared.join('.');
}

/** Same registrable-domain family: sso.example.com and passport.example.com share example.com.
 *  A shared public suffix alone (foo.co.uk and bar.co.uk share only co.uk) is not a family. */
export function sameDomainFamily(one, two) {
  const shared = sharedDomainSuffix(one, two);
  return !!shared && shared.includes('.') && !PUBLIC_SUFFIXES.has(shared);
}

/** Patterns for the pages an Adapter may run on: `match` plus `*.<domain>` for each domain. */
export function adapterPagePatterns(manifest) {
  const match = Array.isArray(manifest?.match) ? manifest.match : [];
  const domains = Array.isArray(manifest?.domains) ? manifest.domains : [];
  return [...new Set([...match, ...domains.map((domain) => '*.' + normalizeHost(domain))]
    .map(normalizeHost).filter(Boolean))];
}

/** Page patterns plus helper-only hosts (`runtime_allowed_hosts`). */
export function adapterHelperPatterns(manifest) {
  const helpers = Array.isArray(manifest?.runtime_allowed_hosts) ? manifest.runtime_allowed_hosts : [];
  return [...new Set([...adapterPagePatterns(manifest), ...helpers.map(normalizeHost).filter(Boolean)])];
}

export function isAdapterPageHost(manifest, host) {
  return adapterPagePatterns(manifest).some((pattern) => hostMatchesPattern(host, pattern));
}

function hostOf(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

/** Default page host: the first exact `match` host, else the homepage, else the first domain. */
export function adapterPrimaryHost(manifest) {
  const match = (Array.isArray(manifest?.match) ? manifest.match : []).map(normalizeHost).filter(Boolean);
  const exact = match.find((host) => !host.startsWith('*.'));
  if (exact) return exact;
  const home = hostOf(manifest?.homepage_url);
  if (home && isAdapterPageHost(manifest, home)) return home;
  const first = match[0] || normalizeHost(manifest?.domains?.[0]);
  return first.replace(/^\*\./, '');
}

/**
 * Validation message for one `domains` entry, or null when it is acceptable:
 * a lower-case registrable domain, not an IP address and not a public suffix.
 */
export function siteDomainProblem(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value) return 'must be a non-empty string';
  if (value !== value.toLowerCase()) return 'must be lower case';
  if (value.includes('*') || value.includes('/') || value.includes(':')) return 'must be a bare domain such as example.com (no wildcard, scheme or port)';
  if (!HOST_RE.test(value) || value.length > 253) return 'is not a valid domain';
  const labels = value.split('.');
  if (labels.length < 2) return 'must contain at least two labels (example.com)';
  if (labels.every((label) => /^\d+$/.test(label))) return 'must not be an IP address';
  if (!/[a-z]/.test(labels[labels.length - 1])) return 'must end in a top-level domain';
  if (PUBLIC_SUFFIXES.has(value)) return 'is a public suffix shared by unrelated sites';
  return null;
}

/** Whether a declared route host (routeDomain / tabDomain / excludeTabDomain) lies inside the scope. */
export function isDeclaredRouteHost(manifest, host) {
  const value = normalizeHost(host);
  const match = (Array.isArray(manifest?.match) ? manifest.match : []).map(normalizeHost);
  if (match.includes(value)) return true;
  return !value.includes('*') && isAdapterPageHost(manifest, value);
}

function tabHost(tab) {
  return hostOf(tab?.url);
}

function preferredTab(tabs) {
  return [...tabs].sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active))
    || (Number(b.lastAccessed) || 0) - (Number(a.lastAccessed) || 0)
    || Number(b.id) - Number(a.id))[0] || null;
}

/**
 * Tab for a command with a route host: prefer an active matching tab, then the
 * most recently used one, and finally the greatest tab ID for a stable tie-break.
 * A declared route host still takes precedence over redirected-host aliases.
 */
export function pickRouteTab(tabs, route, { aliases = [], excludeTabDomain = '' } = {}) {
  const wanted = [normalizeHost(route), ...aliases.map(normalizeHost)].filter(Boolean);
  for (const host of wanted) {
    const tab = preferredTab((tabs || []).filter((entry) => Number.isInteger(entry?.id) && tabHost(entry) === host
      && !(excludeTabDomain && hostMatchesPattern(host, excludeTabDomain))));
    if (tab) return tab;
  }
  return null;
}

/** Active tab first, then most recently used tab anywhere in the Adapter's page scope. */
export function pickRecentScopeTab(tabs, manifest, excludeTabDomain = '') {
  return preferredTab((tabs || []).filter((entry) => {
    const host = tabHost(entry);
    if (!host || !Number.isInteger(entry?.id)) return false;
    if (excludeTabDomain && hostMatchesPattern(host, excludeTabDomain)) return false;
    return isAdapterPageHost(manifest, host);
  }));
}

/**
 * Remembers where a requested host was redirected inside the Adapter's scope, so later calls
 * reuse that tab instead of opening a new one for the original host each time.
 */
export function createRouteRedirects(limit = 256) {
  const entries = new Map();
  return {
    note(manifest, requestedUrl, landedUrl) {
      const from = hostOf(requestedUrl);
      const to = hostOf(landedUrl);
      if (!manifest?.name || !from || !to || from === to || !isAdapterPageHost(manifest, to)) return;
      const key = manifest.name + '\0' + from;
      entries.delete(key);
      entries.set(key, to);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
    },
    aliases(manifest, host) {
      const to = entries.get((manifest?.name || '') + '\0' + normalizeHost(host));
      return to && isAdapterPageHost(manifest, to) ? [to] : [];
    },
  };
}
