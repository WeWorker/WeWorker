/* v2 command xiaohongshu.com.navigate-to-homepage; delegates to the preserved executable implementation. */
(function () {
  __webcliRegisterCommand("navigate-to-homepage", async function (params) {
    return { __webcli_navigation: { version: 1, url: 'https://www.xiaohongshu.com/explore', resume: false, result: { status: 'opened', message: '首页已打开；调用 feed 获取推荐列表。' } } };
  });
})();
