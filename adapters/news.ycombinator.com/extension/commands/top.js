/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/hackernews/top.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2 background API execution; see extension/internal/common.js. */
(function () {
  __webcliRegisterCommand('top', async (args = {}) => {
    const api = window.__hackernews;
    const limit = api.integerArg('limit', args.limit, 20, 1, 100);
    return api.storyList('https://hacker-news.firebaseio.com/v0/topstories.json', limit, true);
  });
})();
