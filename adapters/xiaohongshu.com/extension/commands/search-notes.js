/* v2 command xiaohongshu.com.search-notes; delegates to the preserved executable implementation. */
(function () {
  __webcliRegisterCommand("search-notes", async function (params) {
    return window.__xhsCompatibility('search', params || {});
  });
})();
