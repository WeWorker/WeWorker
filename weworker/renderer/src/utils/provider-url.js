export function getProviderUrlHint(fullUrl) {
  return fullUrl ? '直接使用填写的完整接口 URL' : '填写模型服务 Base URL，连接测试会自动检测兼容协议'
}

export function getAnthropicUrlHint(fullUrl) {
  return fullUrl ? '使用填写的完整 URL，不追加任何后缀' : '填写基础 URL，软件自动追加 /v1/messages'
}

export function getOpenAiUrlHint(fullUrl, responses = false) {
  const endpoint = responses ? '/responses' : '/chat/completions'
  return fullUrl ? '使用填写的完整 URL，不追加任何后缀' : `填写基础 URL，软件自动追加 ${endpoint}`
}
