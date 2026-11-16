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
