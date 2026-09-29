/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/hackernews/read.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2 background API execution. The comment-tree walk keeps
 * the source limit/depth/replies/max-length semantics and adds a bounded item
 * request budget with explicit truncation markers. */
(function () {
  __webcliRegisterCommand('read', async (args = {}) => window.__hackernews.readStory(args));
})();
