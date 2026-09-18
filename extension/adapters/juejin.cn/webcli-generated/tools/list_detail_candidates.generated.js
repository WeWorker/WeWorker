/**
 * Generated tool module for juejin.cn.list_detail_candidates
 */

(function registerGeneratedTool_juejin_cn_list_detail_candidates() {
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

  function listDetailCandidates() {
    return {
      mode: "inspect_only",
      bestCandidateHref: "",
      bestCandidateText: "",
      networkDetailCandidates: [],
    };
  }

  registerTool(siteKey, {
    name: "juejin.cn.list_detail_candidates",
    description: "详情候选辅助工具。返回探索阶段捕获到的详情链接候选及相关元数据。",
    parameters: {
      "type": "object",
      "properties": {},
      "required": []
},
    handler: () => listDetailCandidates(),
  });
})();

