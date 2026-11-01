/**
 * Website login rules shared by the extension runtime.
 *
 * Login is a host capability, not Adapter code: an Adapter declares where its
 * login page is and how to tell that the user is signed in (manifest `auth`),
 * the extension recognises "not logged in" in one place, and the Bridge runs
 * the login flow (open the page, wait, retry). See webcli/site-login.js.
 *
 *   "auth": {
 *     "login_url": "https://passport.example.com/login",
 *     "login_hosts": ["passport.example.com"],        // SSO / separate login hosts
 *     "check": { "cookies": { "url": "https://www.example.com/", "all": ["session"] },
 *                "command": "whoami" }                 // read command; optional
 *   }
 */
import { adapterHelperPatterns, adapterPrimaryHost, hostInDomain, hostMatchesPattern, isAdapterPageHost, sameDomainFamily } from './host-scope.js';

export const AUTH_REQUIRED = 'AUTH_REQUIRED';

// Undeclared login pages are only recognised on hosts outside the package.
const GENERIC_LOGIN_HOST_RE = /^(passport|login|signin|sso|account|accounts|auth|cas|uc|ptlogin\d*)\./i;
const GENERIC_LOGIN_PATH_RE = /(^|\/)(login|signin|sign-in|sign_in|logon|passport|sso|cas\/login|auth\/login|oauth\/authorize)(\/|\.|$)/i;

const hostMatches = hostMatchesPattern;

/** Hosts the author named explicitly (`match`, helpers); hosts only covered by `domains` are not. */
function explicitHostPatterns(manifest) {
  return [...(manifest?.match || []), ...(manifest?.runtime_allowed_hosts || [])];
}

function parseHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export function siteAuth(manifest) {
  const auth = manifest?.auth;
  return auth && typeof auth === 'object' && !Array.isArray(auth) ? auth : null;
}

/** Hosts that only serve login: declared `login_hosts`, plus the login URL host when it is not a business host. */
export function loginHosts(manifest) {
  const auth = siteAuth(manifest);
  const hosts = new Set((Array.isArray(auth?.login_hosts) ? auth.login_hosts : []).map((host) => String(host).toLowerCase()));
  const login = parseHttpUrl(auth?.login_url);
  if (login && !isAdapterPageHost(manifest, login.hostname)) hosts.add(login.hostname);
  return [...hosts];
}

export function declaredHosts(manifest) {
  return [...adapterHelperPatterns(manifest), ...loginHosts(manifest)];
}

/** Every host named by `auth`: `login_hosts` plus the `login_url` host, as plain hostnames. */
function declaredLoginHosts(manifest) {
  const auth = siteAuth(manifest);
  const hosts = new Set((Array.isArray(auth?.login_hosts) ? auth.login_hosts : []).map((host) => String(host).toLowerCase()));
  const login = parseHttpUrl(auth?.login_url);
  if (login) hosts.add(login.hostname.toLowerCase());
  return [...hosts];
}

/** Whether a login-looking host on no declared page belongs to this Adapter's site family:
 *  inside a declared `domains` umbrella, or in the registrable-domain family of a declared
 *  login host. Unrelated sites that merely look like login pages are rejected. */
function isFamilyLoginHost(manifest, host) {
  const domains = Array.isArray(manifest?.domains) ? manifest.domains : [];
  if (domains.some((domain) => hostInDomain(host, domain))) return true;
  return declaredLoginHosts(manifest).some((loginHost) => sameDomainFamily(host, loginHost));
}

/**
 * Is `value` a login page of this Adapter?
 * - any page on a declared login host (SSO pages included);
 * - the declared login path on a business host (for example /signin);
 * - with `root: true`, also a login URL that is the site root, which only
 *   tells the login flow that the user is still on the login page;
 * - an undeclared host that looks like a login page (passport.*, /login …) and
 *   belongs to this Adapter's site family (see isFamilyLoginHost).
 */
export function isLoginPageUrl(manifest, value, { root = false } = {}) {
  const url = parseHttpUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (loginHosts(manifest).some((pattern) => hostMatches(host, pattern))) return true;
  const login = parseHttpUrl(siteAuth(manifest)?.login_url);
  if (login && login.hostname.toLowerCase() === host) {
    const loginPath = login.pathname.replace(/\/+$/, '') || '/';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (loginPath === '/') {
      if (root && path === '/') return true;
    } else if (path === loginPath || path.startsWith(`${loginPath}/`)) {
      return true;
    }
  }
  // Generic login pages (passport.*, /login …) are recognised only on hosts of this Adapter's
  // own site family: inside a `domains` umbrella (a site domain usually contains its own SSO
  // host), or in the registrable-domain family of a declared login host (login_hosts / login_url).
  // An unrelated site's login tab that happens to be open in the same browser must not be
  // adopted by this Adapter's login flow; cross-domain SSO hosts have to be declared.
  if (explicitHostPatterns(manifest).some((pattern) => hostMatches(host, pattern))) return false;
  if (!(GENERIC_LOGIN_HOST_RE.test(host) || GENERIC_LOGIN_PATH_RE.test(url.pathname))) return false;
  return isFamilyLoginHost(manifest, host);
}

/** Login page to open when the command was not redirected to one. */
export function loginStartUrl(manifest) {
  const declared = parseHttpUrl(siteAuth(manifest)?.login_url);
  if (declared) return declared.href;
  const home = parseHttpUrl(manifest?.homepage_url);
  const firstHost = adapterPrimaryHost(manifest);
  if (home && declaredHosts(manifest).some((pattern) => hostMatches(home.hostname.toLowerCase(), pattern))) return home.href;
  return firstHost ? `https://${firstHost}/` : null;
}

/** Without query or fragment: login URLs may carry return tokens. */
export function displayUrl(value) {
  const url = parseHttpUrl(value);
  return url ? `${url.origin}${url.pathname}` : '';
}

export function authRequiredError({ site, pageUrl = '', phase = 'handler', message = '' } = {}) {
  const error = new Error(message || `需要登录 ${site || '该网站'}`);
  error.code = AUTH_REQUIRED;
  error.details = { site, phase, ...(pageUrl ? { pageUrl } : {}) };
  return error;
}

/** Structured auth fields for call_tool_error; null for other errors. */
export function authErrorFields(error, manifest = null) {
  if (error?.code !== AUTH_REQUIRED) return null;
  const details = error.details && typeof error.details === 'object' ? error.details : {};
  return {
    site: typeof details.site === 'string' && details.site ? details.site : manifest?.name || null,
    phase: details.phase === 'navigation' ? 'navigation' : 'handler',
    ...(typeof details.pageUrl === 'string' && details.pageUrl ? { pageUrl: details.pageUrl } : {}),
  };
}

/** `check.cookies`: every cookie in `all`, one of `any`, exact `equals`, none of `not`. */
export function evaluateCookieCheck(spec, cookies = []) {
  const values = new Map();
  for (const cookie of cookies) {
    if (cookie?.name && cookie.value !== undefined && cookie.value !== '') values.set(cookie.name, String(cookie.value));
  }
  if (Array.isArray(spec?.all) && !spec.all.every((name) => values.has(name))) return false;
  if (Array.isArray(spec?.any) && spec.any.length && !spec.any.some((name) => values.has(name))) return false;
  for (const [name, value] of Object.entries(spec?.equals || {})) if (values.get(name) !== String(value)) return false;
  for (const [name, value] of Object.entries(spec?.not || {})) if (values.get(name) === String(value)) return false;
  return true;
}

/**
 * Short hash of the checked cookies' values. A stale cookie left behind by an
 * expired session passes the check but keeps its value; a new login changes it.
 * Only the hash leaves the extension.
 */
export function cookieFingerprint(spec, cookies = []) {
  const names = new Set([...(spec?.all || []), ...(spec?.any || []), ...Object.keys(spec?.equals || {}), ...Object.keys(spec?.not || {})]);
  const text = cookies
    .filter((cookie) => names.has(cookie?.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .sort()
    .join(';');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Display name for login prompts. */
export function siteDisplayName(manifest) {
  return siteAuth(manifest)?.display_name || manifest?.i18n?.zh?.name || manifest?.name || '';
}
