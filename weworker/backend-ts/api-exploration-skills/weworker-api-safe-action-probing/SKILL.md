---
name: weworker-api-safe-action-probing
description: Produce attributable Fetch/XHR Network deltas using only client-approved search, filter and pagination candidates.
---

# WeWorker safe API action probing

> Modified from OpenCLI 1.8.6 `opencli-browser` and `api-discovery.md` under Apache-2.0. Generic selectors, arbitrary clicks, typing and page evaluation are not available here.

The only purpose of an action is to produce a Network delta for API evidence.

## Procedure

1. Inspect the client's safe candidate list before acting.
2. Choose only a strong-semantic search, filter or pagination candidate relevant to the user's goal.
3. Execute only its opaque `candidateId`; never construct a selector or action payload.
4. Compare requests before and after that single action.
5. Keep only read-like Fetch/XHR deltas and infer parameters solely from observed differences.
6. Stop after three safe probes in one exploration run.

After a probe, `executed=true` is not enough. A successful probe must produce a goal-relevant Network delta; otherwise record it as no evidence and try a different safe candidate only when one is available.

## Safety boundary

Never auto-execute create, update, delete, submit, approve, reject, pay, book, reserve or upload. Also reject ambiguous controls, free-form navigation and controls whose surrounding semantics contain write intent.

Do not replay a write-like request even when it was captured. A write-like action can only be reported as blocked metadata and remains outside automated API exploration.

Keep action values ephemeral. Persist parameter names and shapes, not search terms, selected business values, selectors or user data.
