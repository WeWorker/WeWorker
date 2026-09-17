# Certification runbook

## Plan and scope

Run from the repository root:

```text
node .codex/skills/certify-api-adapters/scripts/certification-memory.mjs list-profiles
node .codex/skills/certify-api-adapters/scripts/certification-memory.mjs plan --profile=<profile-id>
```

Use the planner's modes:

- `full`: shared routing or Adapter source changed; run static, mock, and live layers for that Adapter.
- `live`: shared static evidence is current but this profile has no live evidence, or profile-scoped evidence exceeded the live TTL.
- `conditional`: that Adapter's local profile changed; rerun its affected CONDITIONAL tools.
- `reuse`: source and fresh evidence are unchanged.

Never reuse a live PASS from a different profile.

If the local profile has `liveScope.deferredAdapters`, omit those Adapter IDs from live commands even when the planner reports `live` or `conditional`. Preserve their existing matrix result, label them as user-deferred in the run summary, and never treat a deferral as PASS. Resume them only after the same profile's user removes the deferral.

## Deterministic gates

```text
cd webcli
npm run test:api:inventory
npm run test:api:evidence
npm run test:api:mock
```

The inventory must match the packaged profile, expose unique public names, contain valid object schemas, and have complete API/background execution metadata.

## Real production route

The live runner accepts three safe scopes:

```text
node webcli/scripts/run-api-adapter-live-reads.js --scope=reads
node webcli/scripts/run-api-adapter-live-reads.js --scope=guards
node webcli/scripts/run-api-adapter-live-reads.js --scope=dry-runs
```

Use `--tools=<comma-separated-public-names>` for an incremental plan. Reads may use authenticated sessions and safe sentinel/default-list arguments. Guard scope must omit confirmation and dry-run flags. Dry-run scope supplies only the declared dry-run flag.

For each AUTH, PERMISSION, FIXTURE_NOT_FOUND, or PAGE_CONTEXT result, consult `adapter-playbooks.json`, then merge only the current profile's capabilities. Never borrow another developer's capability or fixture binding.

## Repetition

Repeat critical tools when they are newly changed, previously intermittent, release-blocking, or latency-sensitive. Three runs are the default. Record status sets and latency min/max/average; do not record response bodies.

## Matrix policy

- PASS: required mock gates pass and this profile has a successful real read.
- CONDITIONAL: mock/safety gates pass but proof is blocked by profile conditions or real mutation authorization.
- FAIL: mock/safety gate failure, missing required evidence, or stable route, argument, timeout, HTTP, service, or response-contract failure.
- Adapter aggregation: any FAIL tool makes the Adapter FAIL; otherwise any CONDITIONAL tool makes it CONDITIONAL.

Generate the matrix:

```text
cd webcli
npm run certify:api:matrix
```

The command intentionally exits non-zero while FAIL tools remain.

Generate a self-contained HTML report from the sanitized matrix:

```text
node .codex/skills/certify-api-adapters/scripts/render-report.mjs --matrix=artifacts/api-adapter-certification/certification-matrix.json --output=artifacts/api-adapter-certification/certification-report.html
```

The report groups every CONDITIONAL tool by actionable blocker and embeds no profile capability values.

## Packaging

Run the focused packaging regression. For a release candidate, run `prepare-build` only after checking whether its output directory already exists, because it replaces staged Adapter copies. Validate staged profile count, API Adapter count, tool count, discovery count, uniqueness, and known schema regressions.

## Persist sanitized memory

After the profile and matrix are ready:

```text
node .codex/skills/certify-api-adapters/scripts/certification-memory.mjs record --profile=<profile-id> --matrix=artifacts/api-adapter-certification/certification-matrix.json
```

Record only after checking that the matrix belongs to the current profile's live run.
