/**
 * Generated tool module for juejin.cn.check_login_status
 */

(function registerGeneratedTool_juejin_cn_check_login_status() {
  const runtime = window.__webmcpGeneratedRuntime;
  if (!runtime) {
    throw new Error('Generated runtime not initialized before tool module injection');
  }

  const siteKey = "juejin.cn";
  const {
    checkLoginStatus,
    cloneStructuredValue,
    deriveLookupDateValue,
    extractGenericActionIntent,
    fetchGet,
    hasMeaningfulValue,
    hasOwnKey,
    invokeTool,
    normalizeArgsWithDefaults,
    normalizeListItems,
    normalizePlainObjectArg,
    postForm,
    registerTool,
    sameStructuredValue,
    sendJson,
    toAvailabilitySlot,
  } = runtime;

  registerTool(siteKey, {
    name: "juejin.cn.check_login_status",
    description: "登录状态检查工具。用于确认 juejin.cn 当前页面是否已登录，以及当前会话是否可继续调用站点接口。",
    parameters: {
      "type": "object",
      "properties": {},
      "required": []
},
    handler: () => checkLoginStatus(),
  });
})();

