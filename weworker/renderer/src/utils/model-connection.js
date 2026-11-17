export function connectionMessage(result) {
  if (result.ok) return `连接成功 · ${result.model}`
  return {
    not_configured: '模型配置不完整',
    auth_failed: '密钥验证失败',
    model_unavailable: '模型不可用',
    rate_limited: '模型服务限流',
    endpoint_missing: '模型接口地址不可用',
    protocol_mismatch: '模型接口响应异常',
    network_error: '模型服务网络连接失败',
    timeout: '模型连接超时',
    service_unavailable: '模型服务暂不可用',
  }[result.error] || '模型连接失败'
}

export function explorationForm(data) {
  const baseUrl = data.configured_base_url ?? data.base_url
  const fullUrl = data.configured_base_url_is_full ?? data.base_url_is_full
  return {
    base_url: baseUrl || data.candidate_url || '',
    base_url_is_full: baseUrl ? fullUrl === true : data.candidate_url_is_full === true,
    api_key: '',
    use_main_key: data.use_main_key !== false,
    model: data.configured_model || '',
    ...(data.configuration_id ? { protocol: data.protocol || 'openai_chat_completions', auth_type: data.auth_type || 'api_key' } : {}),
  }
}
