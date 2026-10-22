/** Decision service endpoints have no built-in deployment defaults. */
export function decisionServiceUrl(value, variable) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Decision service is not configured: set ${variable}.`);
  }
  let parsed;
  try { parsed = new URL(value.trim()); } catch {
    throw new Error(`${variable} must be an absolute HTTP(S) URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${variable} must be an HTTP(S) URL without credentials, query or fragment.`);
  }
  return parsed.href.replace(/\/+$/, '');
}
