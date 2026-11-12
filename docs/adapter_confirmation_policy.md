# Adapter invocation policy

Ordinary `webcli call <adapter>.<tool> --key=value` uses business arguments only. CLI, Bridge, HTTP, Extension and Toolkit entrypoints do not implement a second user-confirmation protocol. `safety: "write"` still classifies side effects; it does not require a flag or popup. Execute only the user-requested operation, and clarify ambiguous targets or missing inputs first. A request to preview is not a request to submit.

## Compatibility

- Old boolean `requires_confirmation` metadata is accepted but has no consent or permission-diff meaning, including `true`.
- The top-level `__confirmed` argument is discarded, never interpreted as authorization, automatically supplied or passed to business handlers. Nested fields and business `confirm`, `yes`, `execute`, `submit`, `dry-run` options are preserved.
- Shared `requireConfirmation()` helpers remain inert compatibility exports. Custom handlers with their own old flag checks need migration; the runtime does not rewrite third-party code or inject grants.
- Discovery/Skills hide the retired controls. Scaffolds and offline verification use business arguments.
- Exact old declarative page/UI registration stubs and schemas remain loadable; dispatch still uses the validated manifest, not arbitrary author JavaScript.

## Independent protections

Package digests, fixed command mappings, parameter validation, account/credential scope, original-call/helper argument binding, cancellation and dispatch-state checks remain. Unknown write outcomes require reconciliation before another write; removing confirmation does not add idempotency or make replay safe.

Business preview/submit controls, Shell/desktop permissions, Adapter installation review and exploration real write-verification/sequence approval remain separate gates. UI result fields named `confirmation` represent business receipts, not user consent.

## Validation

Cover omitted/false/true legacy policies/markers, marker stripping, ordinary flags and JSON input, real wrappers with mocked providers, changed arguments, duplicate dispatch and unknown outcomes. Real acceptance uses reads or isolated simulated writes, never unsolicited business releases or approvals.
