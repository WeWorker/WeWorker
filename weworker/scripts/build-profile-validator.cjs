'use strict';

/**
 * Build Profile 校验模块
 *
 * 校验 build-profile.json 的结构和语义正确性。
 * 校验失败时抛出包含具体错误信息的异常。
 */

/**
 * 校验 build-profile.json 对象结构和语义。
 * @param {unknown} obj - 待校验的对象
 * @throws {Error} 校验失败时抛出包含具体错误信息的异常
 */
function validateBuildProfile(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('build-profile.json must be a JSON object');
  }

  const errors = [];

  // 校验 adapters 字段
  if (!Object.prototype.hasOwnProperty.call(obj, 'adapters')) {
    errors.push('Missing required field: "adapters"');
  } else if (!Array.isArray(obj.adapters)) {
    errors.push('"adapters" must be an array');
  } else {
    for (let i = 0; i < obj.adapters.length; i++) {
      if (typeof obj.adapters[i] !== 'string') {
        errors.push(`"adapters[${i}]" must be a string, got ${typeof obj.adapters[i]}`);
      }
    }
  }

  // 校验 providers 字段
  if (!Object.prototype.hasOwnProperty.call(obj, 'providers')) {
    errors.push('Missing required field: "providers"');
  } else if (!Array.isArray(obj.providers)) {
    errors.push('"providers" must be an array');
  } else {
    for (let i = 0; i < obj.providers.length; i++) {
      const p = obj.providers[i];
      if (p === null || typeof p !== 'object' || Array.isArray(p)) {
        errors.push(`"providers[${i}]" must be an object`);
        continue;
      }
      if (typeof p.id !== 'string') {
        errors.push(`"providers[${i}].id" must be a string`);
      }
      for (const field of ['fixed', 'builtin', 'fixedModel', 'allowMultiple']) {
        if (p[field] !== undefined && typeof p[field] !== 'boolean') errors.push(`"providers[${i}].${field}" must be a boolean`);
      }
      if (p.authType !== undefined && !['auth_token', 'api_key'].includes(p.authType)) errors.push(`"providers[${i}].authType" is invalid`);
      if (p.fixedModel && !p.defaultModel) errors.push(`"providers[${i}].fixedModel" requires a defaultModel`);
      for (const field of ['apiKeyEnv', 'baseUrlEnv']) {
        if (p[field] !== undefined && (typeof p[field] !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(p[field]))) errors.push(`"providers[${i}].${field}" must be an environment variable name`);
      }
      if (p.encryptedApiKey !== undefined) {
        const parts = typeof p.encryptedApiKey === 'string' ? p.encryptedApiKey.split('.') : [];
        if (!p.builtin || parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))
          || Buffer.from(parts[0] || '', 'base64url').length !== 12 || Buffer.from(parts[1] || '', 'base64url').length !== 16) {
          errors.push(`"providers[${i}].encryptedApiKey" requires a managed provider and AES-256-GCM iv.tag.ciphertext`);
        }
      }
      for (const gateway of [p.weworker, p.webwright]) {
        if (!gateway || typeof gateway.baseUrl !== 'string' || !gateway.baseUrl) continue;
        try {
          const url = new URL(gateway.baseUrl);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
        } catch { errors.push(`"providers[${i}]" has an invalid gateway baseUrl`); }
      }
      if (typeof p.name !== 'string') {
        errors.push(`"providers[${i}].name" must be a string`);
      }
      if (!Array.isArray(p.models) || p.models.some((model) => typeof model !== 'string')) errors.push(`"providers[${i}].models" must be a string array`);
      if (typeof p.defaultModel !== 'string') errors.push(`"providers[${i}].defaultModel" must be a string`);
      // defaultModel 允许留空：表示该供应商不在构建期内置模型，模型列表只来自模型列表接口或用户手填。
      if (Array.isArray(p.models) && p.defaultModel && !p.models.includes(p.defaultModel)) errors.push(`"providers[${i}].defaultModel" must exist in models or be empty`);
      if (!p.weworker || !['anthropic_messages', 'openai_chat_completions', 'openai_responses'].includes(p.weworker.protocol) || typeof p.weworker.baseUrl !== 'string') errors.push(`"providers[${i}].weworker" must define a supported protocol and baseUrl`);
      if (!p.webwright || !['anthropic_messages', 'openai_chat_completions'].includes(p.webwright.protocol) || typeof p.webwright.baseUrl !== 'string') errors.push(`"providers[${i}].webwright" must define a supported protocol and baseUrl`);
      if (p.webwright && !['anthropic', 'zhipu', 'openai_chat'].includes(p.webwright.modelClass)) errors.push(`"providers[${i}].webwright.modelClass" is invalid`);
      if (p.webwright && !['anthropic_json_schema', 'openai_json_object'].includes(p.webwright.structuredOutput)) errors.push(`"providers[${i}].webwright.structuredOutput" is invalid`);
      if (p.webwright?.protocol === 'anthropic_messages' && p.webwright.modelClass !== 'anthropic') errors.push(`"providers[${i}].webwright.modelClass" must be anthropic`);
      if (p.webwright?.protocol === 'openai_chat_completions' && !['zhipu', 'openai_chat'].includes(p.webwright.modelClass)) errors.push(`"providers[${i}].webwright.modelClass" must be zhipu or openai_chat`);
      if (p.webwright?.protocol === 'anthropic_messages' && p.webwright.structuredOutput !== 'anthropic_json_schema') errors.push(`"providers[${i}].webwright.structuredOutput" must be anthropic_json_schema`);
      if (p.webwright?.protocol === 'openai_chat_completions' && p.webwright.structuredOutput !== 'openai_json_object') errors.push(`"providers[${i}].webwright.structuredOutput" must be openai_json_object`);
    }
  }

  // 校验 defaultProvider 字段
  if (!Object.prototype.hasOwnProperty.call(obj, 'defaultProvider')) {
    errors.push('Missing required field: "defaultProvider"');
  } else if (typeof obj.defaultProvider !== 'string') {
    errors.push('"defaultProvider" must be a string');
  }

  if (Array.isArray(obj.providers)) {
    const ids = obj.providers.map(p => p?.id);
    if (new Set(ids).size !== ids.length) errors.push('Duplicate provider IDs');
  }

  if (errors.length > 0) {
    throw new Error('Build profile validation failed:\n  - ' + errors.join('\n  - '));
  }

  // 语义校验：defaultProvider 必须存在于 providers 的 id 列表中
  const providerIds = obj.providers.map((p) => p.id);
  if (!providerIds.includes(obj.defaultProvider)) {
    throw new Error(
      `"defaultProvider" value "${obj.defaultProvider}" is not found in providers. ` +
      `Available provider IDs: ${providerIds.join(', ')}`
    );
  }
}

module.exports = { validateBuildProfile };
