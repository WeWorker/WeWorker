/* v2 command xiaohongshu.com.read-comments; delegates to the preserved executable implementation. */
(function () {
  __webcliRegisterCommand("read-comments", async function (params) {
    return window.__xhsCompatibility('comments', params || {});
  });
})();
