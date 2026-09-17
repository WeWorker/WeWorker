---
name: weworker-api-strategy-selection
description: Select the safest reusable API strategy from observed endpoint, authentication and replay evidence.
---

# WeWorker API strategy selection

> Modified from OpenCLI 1.8.6 `opencli-adapter-author` and `strategy-selection.md` under Apache-2.0. UI selector strategies are intentionally outside this API-only module.

Choose exactly one of `PUBLIC_API`, `COOKIE_API`, `PAGE_FETCH`, `INTERCEPT` or `NO_USABLE_API`.

## Contract-first rule

Prefer an externally replayable contract over an undocumented internal dependency:

1. `PUBLIC_API`: no login material is required and a direct replay returns the target data.
2. `COOKIE_API`: browser cookie or CSRF source is understood and a capture-bound authenticated replay returns the target data.
3. `PAGE_FETCH`: only page context can reuse same-origin session or runtime state.
4. `INTERCEPT`: the page must naturally generate a non-reusable signature and only its already-occurring response can be captured.
5. `NO_USABLE_API`: evidence is insufficient, the source is outside HTTP/structured data, or safe replay is impossible.

Do not choose `PAGE_FETCH` or `INTERCEPT` merely because an internal XHR exists. Undocumented endpoints and signatures have higher drift risk and require positive evidence that public or cookie replay is unavailable.

## Required strategy note

Record only sanitized facts:

- observed evidence ID and endpoint family;
- method, response content type and non-empty shape;
- auth source type, never its value;
- direct and final replay status;
- contract: `stable` or `internal_unverified`;
- reason each higher-preference strategy failed.

`likely_data` and candidate scores prioritize replay; they do not determine strategy. A captured request with `replayStatus=not_run` remains unverified. Authentication loss, permission denial, CAPTCHA or rate limiting is not evidence that the implementation should be changed.
