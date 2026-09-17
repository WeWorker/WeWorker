---
name: weworker-api-field-decoding
description: Decode request parameters and response fields from captured shape and value-level evidence without guessing business semantics.
---

# WeWorker API field decoding

> Modified from OpenCLI 1.8.6 `field-decode-playbook.md` and `output-design.md` under Apache-2.0. Decoding uses sanitized captures rather than arbitrary browser evaluation.

Decode from evidence, not plausible names.

## Decision ladder

1. Prefer self-describing keys and preserve their observed type.
2. Compare request/response deltas from two captured search, filter or pagination values.
3. Use structural differences to identify result arrays, pagination metadata and optional branches.
4. Cross-check one known visible business value only when the sanitized evidence explicitly supplies that comparison.
5. Leave unresolved short codes and opaque fields raw instead of assigning a guessed meaning.

For each decoded field record meaning, type, unit, source evidence ID and confidence. Parameter names may be persisted; real parameter values must not be persisted.

## Type and unit traps

- Preserve identifiers and codes as strings so leading zeroes survive.
- Distinguish Unix seconds, Unix milliseconds, compact dates and ISO strings by observed shape.
- Do not silently multiply percentages or currency units.
- Use `null` for a genuinely optional value; do not turn missing data into `0`, an empty string, `-` or `N/A`.
- Treat numeric strings as strings until evidence proves numeric semantics.
- A response array length matching captured page size is evidence for the result path, not proof of every field meaning.

## Output contract

Generated read tools should expose stable, flattened business fields with consistent types. Keep identity/display fields non-empty, preserve original units unless a verified conversion is documented, and avoid leaking raw headers, credentials or private user fields.

Unknown fields may remain available under a clearly raw name for later iteration. Never make a broken mapping appear valid by supplying a plausible fallback value.
