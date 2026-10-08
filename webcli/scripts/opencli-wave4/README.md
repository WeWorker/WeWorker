# OpenCLI wave4 source integration

Source: jackwener/OpenCLI at 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0 (LICENSE retained here and inside each standalone package).

Rebuild with `node webcli/scripts/opencli-wave4/build.mjs`. Uses the existing esbuild dependency in weworker; no external OpenCLI executable or extra Runner. Raw upstream files remain in upstream; build-time edits and host bindings are local here. Runtime fetch is fixed-endpoint, bounded, GET-only and refuses redirects. Login opens the site then requires a separate identity check instead of upstream's long polling. Input validation is stricter than upstream.

Tests: from webcli, `npx vitest run --config vitest.wave4.config.js`. Upstream Toutiao/arXiv tests check source parity; integration tests exercise generated packages through the real v2 bootstrap. The retained upstream SMZDM suite requires jsdom and is not run; package DOM extraction is separately exercised by integration fixtures without a new dependency.
