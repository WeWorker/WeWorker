import { request } from 'node:http';

export const HOST_MAX_BYTES = 10 * 1024 * 1024;
export const hostError = (code, message) => Object.assign(new Error(message), { code });

export function hasHostConfiguration(env = process.env) {
  return env.WEBCLI_HOST_ENDPOINT !== undefined || env.WEBCLI_HOST_TOKEN !== undefined;
}

export function readHostConfiguration(env = process.env) {
  if (!hasHostConfiguration(env)) return null;
  let url;
  try { url = new URL(env.WEBCLI_HOST_ENDPOINT); } catch { /* Validated below. */ }
  if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.pathname !== '/webcli/v1' || url.search || url.hash || url.username || url.password
      || !/^[a-f0-9]{64}$/.test(env.WEBCLI_HOST_TOKEN || '')) {
    throw hostError('HOST_CONFIG_INVALID', 'An explicit loopback host endpoint and credential are required.');
  }
  return { endpoint: url.href, token: env.WEBCLI_HOST_TOKEN };
}

export async function requestHost(payload, { config = readHostConfiguration(), timeoutMs = 45000, signal } = {}) {
  if (!config) throw hostError('HOST_CONFIG_MISSING', 'Browser host is not configured.');
  const body = JSON.stringify({ ...payload, schemaVersion: 1 });
  if (Buffer.byteLength(body) > HOST_MAX_BYTES) throw hostError('HOST_PAYLOAD_TOO_LARGE', 'Host request exceeds the size limit.');
  return new Promise((resolve, reject) => {
    const req = request(config.endpoint, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > HOST_MAX_BYTES) req.destroy(hostError('HOST_PAYLOAD_TOO_LARGE', 'Host response exceeds the size limit.'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200 || result.schemaVersion !== 1 || typeof result.ok !== 'boolean') {
            throw hostError('HOST_PROTOCOL_ERROR', 'Host returned an invalid response.');
          }
          if (!result.ok) throw hostError(result.error?.code || 'HOST_CALL_FAILED', result.error?.message || 'Host operation failed.');
          resolve(result.result);
        } catch (error) { reject(error.code ? error : hostError('HOST_PROTOCOL_ERROR', 'Host returned invalid JSON.')); }
      });
    });
    const timer = setTimeout(() => req.destroy(hostError('HOST_TIMEOUT', 'Host call timed out; it was not retried.')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', error => reject(error.code?.startsWith('HOST_') ? error : hostError('HOST_UNAVAILABLE', 'Browser host is unavailable; no fallback was attempted.')));
    req.end(body);
  });
}
