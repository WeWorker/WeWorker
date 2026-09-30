/* v2 command xiaohongshu.com.favorite-note; delegates to the preserved executable implementation. */
(function () {
  __webcliRegisterCommand("favorite-note", async function (params) {
    return window.__xhsLegacyAction('favorite_note', params || {});
  });
})();
