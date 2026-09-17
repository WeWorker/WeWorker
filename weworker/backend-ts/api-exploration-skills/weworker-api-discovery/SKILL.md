---
name: weworker-api-discovery
description: Discover target API endpoint families from sanitized passive captures and safe Network deltas when initial evidence is incomplete.
---

# WeWorker API discovery

> Modified from OpenCLI 1.8.6 `site-recon.md` and `api-discovery.md` under Apache-2.0. Direct browser commands and arbitrary DOM actions have been replaced with WeWorker evidence tools.

## Discovery ladder

Use this order and stop at the first source that yields replayable target data:

1. Fetch/XHR candidates already present in passive evidence.
2. Network deltas produced by a client-approved search, filter or pagination probe.
3. Initial JSON, hydration state or JSONP clues already reported in evidence.
4. Cookie, CSRF or runtime-token source classification; record only the source type, never the value.
5. Capture-bound page replay or natural request interception when the page must generate a signature.

The dedicated Agent cannot inspect arbitrary files, execute page JavaScript or call a URL of its own choosing. If the evidence lacks the next rung, report the missing evidence instead of simulating an OpenCLI command.

## Classify before selecting

Classify each request as `likely_data`, `maybe_data`, `noise` or `blocked`:

- `likely_data`: successful structured response with non-empty business-like paths.
- `maybe_data`: structured but empty, ambiguous, mixed with personalization, or weakly related to the goal.
- `noise`: analytics, beacon, telemetry, heartbeat, experiment, ad, static asset or login HTML.
- `blocked`: authentication or permission response such as 401/403.

XHR volume is not proof of a usable API. A page with many telemetry requests can still have no target endpoint. Candidate score remains evidence only; replay and value-level checks decide usability.

## Shape-first narrowing

Prefer candidates whose response shape includes the requested entity, a result array, identity/display fields, pagination metadata or goal-relevant keys. Reject responses that are HTML, empty tracking acknowledgements or unrelated configuration.

When the first load lacks the needed request, ask the client for safe candidates. Only search, filter and pagination may be auto-executed, and only by opaque `candidateId`. One action should produce one before/after Network delta so changed parameters can be attributed to that action.

## Authentication evidence

Classify the requirement as none, browser cookie, CSRF header/cookie, tenant/workspace context, page runtime or non-reusable signature. Never expose Cookie, Authorization, CSRF, token or signature values. Do not attempt to crack or reproduce a private signature; prefer capture-bound page replay or report the limitation.

If the target data never appears in structured evidence, return `NO_USABLE_API` rather than crossing into the separate DOM exploration route.
