import { adapterError } from './adapter-package-files.js';
import { httpAuthHeaders } from './http-contract.js';
import { createHttpAuthenticator } from './http-auth.js';
import { parseWriteJson } from './write-result-json.js';

const MAX_BYTES = 4 * 1024 * 1024;
const deniedHeaders = /^(?:cookie|authorization|proxy-authorization|host|connection|content-length|transfer-encoding|upgrade|proxy-.*|sec-.*)$/i;
const fail = (code, message) => adapterError('HTTP_' + code, message);

/** Shared bounded host transport; callers validate the versioned contract first. */
export function createHttpClient(command, options = {}) {
  const spec = command.http;
  const secrets = new Set();
  const authenticate = createHttpAuthenticator(spec, secrets);
  const managedHeaders = [...httpAuthHeaders(spec.auth), ...(spec.cookies?.csrf ? [spec.cookies.csrf.header.toLowerCase()] : [])];
  const redact = value => {
    if (typeof value === 'string') {
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) value = value.split(secret).join('[REDACTED]');
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redact(item)]));
    return value;
  };
  let requests = 0;
  const request = async (input, redirects = 0) => {
    if (options.signal?.aborted) throw fail('ABORTED', 'HTTP operation cancelled.');
    options.validateRequest?.(input);
    if (++requests > (command.safety === 'write' ? 1 : 50)) throw fail('REQUEST_LIMIT', command.safety === 'write'
      ? 'HTTP writes permit one request per invocation. Inspect the effect before invoking again.' : 'HTTP command exceeded 50 requests.');
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['url', 'method', 'headers', 'json', 'body', 'response'].includes(key))) throw fail('INVALID_REQUEST', 'Invalid HTTP request fields.');
    let url;
    try { url = new URL(input.url); } catch { throw fail('INVALID_URL', 'Request needs an absolute HTTP(S) URL.'); }
    if (!spec.origins.includes(url.origin) || url.username || url.password || url.hash) throw fail('ORIGIN_DENIED', 'Request origin is not declared or the URL contains credentials/fragments.');
    const method = input.method || 'GET';
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
      || (command.safety !== 'write' && !['GET', 'HEAD', 'POST'].includes(method))) throw fail('METHOD_DENIED', 'HTTP method is not permitted for this command.');
    const headers = new Headers();
    if (input.headers !== undefined && (!input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers))) throw fail('INVALID_HEADERS', 'Headers must be an object.');
    for (const [name, value] of Object.entries(input.headers || {})) {
      if (deniedHeaders.test(name) || managedHeaders.includes(name.toLowerCase()) || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw fail('INVALID_HEADERS', 'Credential and transport headers must not be authored in a command.');
      try { headers.set(name, value); } catch { throw fail('INVALID_HEADERS', 'Invalid request header.'); }
    }
    let body = input.body;
    if (input.json !== undefined) {
      if (body !== undefined) throw fail('INVALID_BODY', 'Choose json or body.');
      body = JSON.stringify(input.json); headers.set('content-type', 'application/json');
    }
    if (body !== undefined && (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BYTES || ['GET', 'HEAD'].includes(method))) throw fail('INVALID_BODY', 'Request body is invalid or exceeds 4 MiB.');
    if (input.response !== undefined && !['json', 'text'].includes(input.response)) throw fail('INVALID_REQUEST', 'response must be json or text.');
    if (spec.cookies && url.origin === spec.cookies.origin) {
      if (!options.resolveCookies) throw fail('CREDENTIALS_REQUIRED', 'COOKIE_API requires a selected browser profile.');
      let cookies;
      try { cookies = await options.resolveCookies({ url: url.href, names: spec.cookies.names,
        ...(spec.version === 2 ? { version: 2, ...(spec.cookies.storeId !== undefined ? { storeId: spec.cookies.storeId } : {}),
          ...(spec.cookies.partitionKey ? { partitionKey: spec.cookies.partitionKey } : {}) } : {}) }); }
      catch (error) { throw fail(error.code === 'PROFILE_DISCONNECTED' ? 'PROFILE_DISCONNECTED' : 'CREDENTIALS_UNAVAILABLE', 'Cannot read declared credentials from the selected browser connection.'); }
      if (options.signal?.aborted) throw fail('ABORTED', 'HTTP operation cancelled.');
      if (!Array.isArray(cookies) || spec.cookies.names.some(name => cookies.filter(cookie => cookie.name === name).length !== 1)) throw fail('CREDENTIALS_MISSING', 'Declared cookies are missing or ambiguous. Restore the selected browser session.');
      const selected = spec.cookies.names.map(name => cookies.find(cookie => cookie.name === name));
      for (const cookie of selected) {
        if (typeof cookie.value !== 'string' || !cookie.value || /[;\r\n\0]/.test(cookie.value)) throw fail('CREDENTIALS_INVALID', 'A declared cookie is empty or invalid.');
        secrets.add(cookie.value);
      }
      headers.set('cookie', selected.map(cookie => cookie.name + '=' + cookie.value).join('; '));
      if (spec.cookies.csrf) {
        const csrf = spec.cookies.csrf;
        let value = selected.find(cookie => cookie.name === csrf.cookie).value;
        try { if (csrf.decode) value = decodeURIComponent(value); headers.set(csrf.header, value); }
        catch { throw fail('CREDENTIALS_INVALID', 'CSRF cookie cannot be converted to a request header.'); }
        secrets.add(value);
      }
    }
    authenticate({ url, method, body, headers });
    if (options.signal?.aborted) throw fail('ABORTED', 'HTTP operation cancelled.');
    // Persist a write dispatch marker before crossing the network boundary.
    // A failure here must prevent dispatch, including storage failures.
    options.beforeDispatch?.({ url: url.href, method, body });
    let response;
    try {
      response = await (options.fetch || fetch)(url, { method, headers, body, redirect: 'manual', signal: options.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (command.safety === 'write' || options.redirects === false) throw fail('REDIRECT', 'This operation does not follow redirects. Inspect the effect before sending another request.');
        if (!location || redirects >= 5) throw fail('REDIRECT', 'HTTP redirect is missing a location or exceeds five hops.');
        let next;
        try { next = new URL(location, url); } catch { throw fail('REDIRECT', 'Invalid HTTP redirect location.'); }
        if (!spec.origins.includes(next.origin) || next.username || next.password) throw fail('ORIGIN_DENIED', 'Redirect origin is not declared.');
        next.hash = '';
        const get = (response.status === 303 && method !== 'GET' && method !== 'HEAD') || ([301, 302].includes(response.status) && method === 'POST');
        const forwarded = { ...input, url: next.href, method: get ? 'GET' : method };
        if (get) {
          delete forwarded.body; delete forwarded.json;
          forwarded.headers = Object.fromEntries(Object.entries(input.headers || {}).filter(([key]) => !/^content-/i.test(key)));
        }
        // Recheck exact origin and resolve cookies for the new URL. Injected
        // credential headers never become part of the forwarded command input.
        return request(forwarded, redirects + 1);
      }
      const observation = { url: url.href, method, requestBody: body, status: response.status, responseContentType: response.headers.get('content-type') || '' };
      const resultSpecs = options.writeResult ? (Array.isArray(options.writeResult) ? options.writeResult : [options.writeResult]) : [];
      if (resultSpecs.length) observation.resultMetadata = {
        headers:Object.fromEntries(resultSpecs.filter(value=>value.responseSource?.kind==='header').map(value=>[value.responseSource.name,redact(response.headers.get(value.responseSource.name))])),
        ...(resultSpecs.some(value=>value.responseSource?.kind==='url') ? {url:redact(response.url || url.href)} : {}),
      };
      if (!response.ok) options.observe?.(observation);
      if (!response.ok) { await response.body?.cancel(); throw fail([401, 403].includes(response.status) ? 'AUTH_REQUIRED' : 'STATUS', 'HTTP endpoint returned status ' + response.status + '.'); }
      const chunks = []; let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_BYTES) { throw fail('RESPONSE_LIMIT', 'HTTP response exceeds 4 MiB.'); }
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (input.response === 'text') return redact(text);
      if (method === 'HEAD' || response.status === 204) { options.observe?.(observation); return null; }
      let parsed;
      try { parsed = parseWriteJson(text, options.decimalPaths || []); } catch { throw fail('INVALID_JSON', 'HTTP endpoint did not return valid exact JSON.'); }
      const decimalPaths=resultSpecs.filter(value=>value.idType==='decimal'&&value.responsePath).map(value=>value.responsePath);
      if(decimalPaths.length)observation.resultMetadata.exactBody=redact(parseWriteJson(text,decimalPaths));
      const result = redact(parsed);
      options.observe?.({ ...observation, responseBody: result });
      return result;
    } catch (error) {
      if (error.code?.startsWith('HTTP_')) throw error;
      throw fail(options.signal?.aborted ? 'ABORTED' : 'NETWORK', 'HTTP request failed. No request was retried.');
    }
  };
  return { request, redact, dispose: () => secrets.clear() };
}
