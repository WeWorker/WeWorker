---
name: weworker-api-autofix
description: Diagnose reproducible API replay, schema, parameter and Preview failures and guide a bounded evidence-driven repair.
---

# WeWorker API AutoFix

> Modified from OpenCLI 1.8.6 `opencli-autofix` under Apache-2.0. This dedicated Agent cannot edit files, execute Shell commands, file upstream issues or publish a repair.

Do not treat every failure as an implementation bug.

## Hard stops

Stop without a repair on authentication loss, browser Bridge failure, CAPTCHA, permission denial or rate limiting. These require user action or a changed environment, not weaker validation or guessed code.

## Repairable failures

Continue only when endpoint drift, response-schema drift, captured parameter mismatch, timeout or wrong capture-sample selection is reproducible.

1. Read the redacted failure evidence and authoritative generated contract.
2. Classify the gap between expected and observed method, endpoint, parameters, response path, type or value constraint.
3. Produce the smallest targeted repair recommendation for the Generation worker.
4. Re-run the original capture-bound replay and fixture.
5. Stop after three failed repair rounds and report what remains unsupported.

## Repair rules

- Preserve the published output contract unless independent evidence proves the site contract changed.
- Do not relax a fixture to accept wrong values, login HTML, empty identity fields or telemetry.
- Do not convert missing values to silent sentinels such as `0`, `-`, `N/A` or fabricated rows.
- Do not broaden authentication access or recover credential values.
- Do not introduce DOM automation or arbitrary page fetches into this API-only route.
- Keep the repaired draft in approval-required state; never publish automatically.

A verified retry may be recorded as a successful repair. If the failure is not reproducible across capture-bound samples, report it as inconclusive rather than changing the implementation.
