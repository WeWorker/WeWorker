/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/hackernews/user.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2 background API execution. The username is validated
 * and URL-encoded before the Firebase user lookup; missing users are reported
 * as an explicit empty result instead of an empty row. */
(function () {
  __webcliRegisterCommand('user', async (args = {}) => window.__hackernews.userProfile(args));
})();
