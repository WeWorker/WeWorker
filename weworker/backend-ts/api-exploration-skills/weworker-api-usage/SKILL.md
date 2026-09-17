---
name: weworker-api-usage
description: Route WeWorker's dedicated API exploration Agent through the minimum built-in Skill needed for the current evidence stage.
---

# WeWorker API exploration usage

> Modified from OpenCLI 1.8.6 `opencli-usage` and `opencli-adapter-author` under Apache-2.0. This version uses only WeWorker's fixed, read-only exploration tools.

The only goal is to discover reusable HTTP APIs from sanitized Fetch/XHR evidence. Do not create DOM automation artifacts and do not use general-purpose Skills, files, Shell, web search or page scripts.

## Routing

1. Read passive evidence and `analysisV2`.
2. If a likely candidate exists, load `strategy-selection`, then request replay evidence.
3. If only weak, noisy or missing candidates exist, load `discovery`. Load `action-probing` only when the client exposes a safe search, filter or pagination candidate.
4. Load `field-decoding` only after a response sample exists.
5. Load `verification` before a candidate enters Site Memory or Generation.
6. Load `autofix` only after a reproducible validation failure.

Use progressive disclosure: do not load every Skill pre-emptively.

## Scope check

Continue only when the target data is visible to the current browser session and appears in HTTP, JSON, JSONP or inline structured state. If the only source is a private binary protocol, encrypted payload, canvas or WebSocket stream with no HTTP equivalent, report `NO_USABLE_API` for this path.

Candidate score is triage evidence, not proof. A candidate with `replayStatus=not_run` is unverified. Only `replayStatus=verified` may be described as verified.

## Hard boundary

The Agent may observe evidence, execute a client-issued safe candidate ID and request a capture-bound replay. It must never invent selectors, issue arbitrary fetches, recover secret values, bypass CAPTCHA or access control, publish an Adapter, or execute create, update, delete, submit, approve, reject, pay, book, reserve or upload actions.
