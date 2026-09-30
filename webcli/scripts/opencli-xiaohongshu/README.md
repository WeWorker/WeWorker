# Xiaohongshu source migration

Source: https://github.com/jackwener/OpenCLI/tree/24136945847afbfad266c6c46a8cd335377f9112/clis/xiaohongshu

GitHub origin HEAD/main was checked with fetch and ls-remote on 2026-09-30 and resolved to that SHA. License: Apache-2.0, copied in LICENSE and emitted as a comment-only internal asset for standalone .adapt distribution.

`upstream/` preserves the source JavaScript. The 16 copied source tests only change their registry/error import paths. `test-utils.js` comes from clis/test-utils.js. Tests needing JSDOM were not copied; package integration tests exercise the host bindings separately. These tests are not live acceptance evidence.

Rebuild from the repository root:

```sh
node webcli/scripts/opencli-xiaohongshu/build.mjs
cd webcli
npx vitest run --config vitest.xiaohongshu.config.js
```

No OpenCLI process or browser runner is started. Build-time aliases bind the upstream functions to adapter-local registration, the existing Extension page Runner, privileged helpers, and v2 host navigation. `auth.js` implements the source identity endpoint with manual login handoff. `download.js` uses bounded existing binary file I/O. `files.js` exposes only images preloaded for the current publish call.

Explicit build transforms: resolve self identity from the current Pinia state rather than re-entering explore on each continuation; mark the one allowed risk-control retry for host navigation; reject a missing comments result payload; restrict publish-success redirects and remove nonexistent screenshot claims. These modifications are visible in build.mjs, not hidden edits to vendored source.

Follow-up transforms exclude hidden/near-transparent duplicate filter controls and validate captured creator-list envelopes before unsigned fallback. The host accepts a canonical same-note redirect while retaining origin and note-ID checks. live-evidence.json contains only sample-level trace references and scopes, never user content or account values; the inventory distinguishes sample passes from full command coverage.

See docs/opencli_xiaohongshu_migration.md for scope, compatibility changes, operational limits and verification evidence. The generated manifest/bundle and command wrappers are versioned assets; no build dependencies are shipped inside the adapter.
