---
name: weworker-api-verification
description: Verify read-only API candidates and generated output against captured value-level fixtures before persistence or publication.
---

# WeWorker API verification

> Modified from OpenCLI 1.8.6 adapter verification guidance and `success-rate-pitfalls.md` under Apache-2.0. Publication remains an explicit WeWorker approval step.

Before a candidate enters Site Memory or Generation, require a replay result and captured baseline. HTTP 200 alone is not sufficient.

## Verification contract

Check:

- expected method and endpoint family;
- required response paths and field types;
- non-empty identity and display fields;
- reasonable row-count bounds;
- absence of login, CAPTCHA, access-denied and telemetry-shaped content;
- parameter variation for captured search, filter and pagination evidence;
- no Cookie, Authorization, CSRF, token, user path or private business value in public output.

Only read candidates with `replayStatus=verified` are eligible for automatic Generation. Write-like candidates receive no live replay and never enter automatic Generation.

## Empty is not automatically broken

A valid search can return zero results. Distinguish an expected empty business result from a wrong parameter, authentication loss, soft block or changed response path using alternative captured evidence. Do not patch a working contract merely to chase one empty sample.

## Fixture discipline

Never weaken required paths, patterns, type checks, non-empty checks or forbidden-content checks merely to make a broken implementation pass. A fixture may change only when independent evidence proves the site contract changed. Prefer a captured sample from the same endpoint family whose response actually satisfies the fixture; do not select an empty pagination sample by accident.

Static success is not value correctness. A generated tool must also pass capture-bound Preview before it can be presented for approval. Preview success does not publish the draft.
