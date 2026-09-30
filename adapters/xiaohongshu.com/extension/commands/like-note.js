/* v2 command xiaohongshu.com.like-note; delegates to the preserved executable implementation. */
(function () {
  __webcliRegisterCommand("like-note", async function (params) {
    return window.__xhsLegacyAction('like_note', params || {});
  });
})();
