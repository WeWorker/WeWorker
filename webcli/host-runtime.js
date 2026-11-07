/** Serializable compatibility runtime shared by trusted background and page Adapters. */
export function createHostRuntime(adapterId, routeDomain, requestPrivileged) {
  const hostError = (code, message, details = {}) => Object.assign(new Error(message), { code, details });
  return {
    createRuntimeError: hostError,
    getContext: () => ({ adapterId, routeDomain }),
    authRequired(message = 'Login required in the host browser.') { throw hostError('AUTH_REQUIRED', message); },
    requireConfirmation(value = {}) {
      if (value.__confirmed !== true) throw hostError('CONFIRMATION_REQUIRED', 'Explicit confirmation is required.');
      return true;
    },
    requestPrivileged,
    async fetchJson(url, options = {}) {
      const response = await requestPrivileged('backend_fetch', { url: String(url), options: {
        ...options, method: options.method || 'GET', headers: { Accept: 'application/json', ...(options.headers || {}) },
      } });
      const contentType = response?.headers?.['content-type'] || response?.headers?.['Content-Type'] || '';
      const text = response?.body ?? '';
      let body = text;
      if (String(contentType).includes('json') || (typeof text === 'string' && /^[\[{]/.test(text.trim()))) {
        try { body = JSON.parse(text); } catch { }
      }
      // Adapters inspect HTTP_ERROR details to apply their existing authentication policy.
      if (!response?.ok) throw hostError('HTTP_ERROR', `HTTP ${response?.status}`, { status: response?.status, body });
      return body;
    },
    validateArgs(value = {}, schema = {}) {
      const result = { ...value };
      for (const [name, definition] of Object.entries(schema.properties || {})) {
        if (!(name in result) && Object.hasOwn(definition, 'default')) result[name] = definition.default;
      }
      for (const name of schema.required || []) {
        if (result[name] === undefined || result[name] === null || result[name] === '') throw hostError('INVALID_ARGS', `Missing argument: ${name}`);
      }
      for (const [name, value] of Object.entries(result)) {
        const definition = schema.properties?.[name];
        if (!definition) {
          if (schema.additionalProperties === false && !['__confirmed', 'dry-run'].includes(name)) throw hostError('INVALID_ARGS', `Unknown argument: ${name}`);
          continue;
        }
        const types = Array.isArray(definition.type) ? definition.type : [definition.type];
        if (!types.some(type => !type || (type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
          : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
          : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === type))) {
          throw hostError('INVALID_ARGS', `Invalid argument type: ${name}`);
        }
        if (definition.enum && !definition.enum.includes(value)) throw hostError('INVALID_ARGS', `Invalid argument value: ${name}`);
      }
      return result;
    },
  };
}
