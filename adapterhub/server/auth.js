/**
 * 认证提供者：默认实现（无认证）。
 *
 * AdapterHub 开源形态是纯只读分发站：无登录、无发布、无令牌管理——
 * 这些路由仅在 configured=true 的认证提供者存在时才挂载。
 * 企业内部部署可通过 ADAPTERHUB_AUTH_MODULE 注入自有认证模块
 * （导出 createAuthProvider({ db })，返回与本接口同形的对象）。
 */

export const nullAuth = {
  configured: false,
  async handleRoute() {
    return false
  },
  attachUser() {
    return null
  },
  sendMe(req, res) {
    const body = JSON.stringify({ logged_in: false, userid: null, auth: null })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  },
}
