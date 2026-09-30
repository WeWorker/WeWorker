/* v2 command xiaohongshu.com.open-note; delegates to the preserved executable implementation. */
(function () {
  __webcliRegisterCommand("open-note", async function (params) {
    return window.__xhsCompatibility('note', params || {});
  });
})();
