---
name: certify-api-adapters
description: Certify WeWorker's shipped Extension API Adapters with reusable static, mock, live, safety, and packaging evidence. Use for full or incremental API Adapter release verification, rerunning changed tools, diagnosing CONDITIONAL/FAIL results, or maintaining per-developer certification memory. Do not use for DOM or Toolkit Adapter certification.
---

# Certify API Adapters

Certify the API/background tools selected by `weworker/build-profile.json`. Preserve the production route `webcli call -> Bridge -> Chrome Extension -> Adapter` for live evidence.

## Evidence ownership

- Treat repository code, schemas, generic site requirements, mock results, and confirmed product defects as shared evidence.
- Treat login state, permissions, accessible subsystem IDs, usable fixtures, page contexts, and live results as profile-scoped evidence. Never promote one developer's live result to another developer's PASS.
- Store developer profiles and reusable live memory only below the local state root described in [references/architecture.md](references/architecture.md). Never commit them.
- Never store Cookie values, tokens, passwords, authorization headers, raw business bodies, raw argument values, user paths, or Git identity.

## Start every run

1. Read the repository `AGENTS.md` instructions and `ROADMAP.md`.
2. Determine the profile ID from the user's request. If it is not explicit, run `certification-memory.mjs list-profiles` and use an existing local profile only when there is exactly one; otherwise finish safe static/mock work first, then ask once for all missing profile information.
3. Run the incremental planner:

   ```text
   node .codex/skills/certify-api-adapters/scripts/certification-memory.mjs plan --profile=<profile-id>
   ```

4. Reuse evidence only as the planner allows. A global Runner/Bridge fingerprint change invalidates every Adapter. An Adapter fingerprint change invalidates that Adapter. Fresh unchanged profile-scoped evidence may be reused until its TTL expires.

Read [references/runbook.md](references/runbook.md) before executing certification commands. Read [references/profile-schema.md](references/profile-schema.md) when creating or updating a developer profile. Read [references/architecture.md](references/architecture.md) when changing persistence, invalidation, or team-sharing behavior. Consult `references/adapter-playbooks.json` only for Adapters that need authentication, permissions, fixtures, or page context.

For a developer taking over this workflow for the first time, read [references/team-handoff.md](references/team-handoff.md) before creating their local profile. Historical reports are context only and never establish the new developer's live PASS.

## Safety boundaries

- Reads, unconfirmed guard probes, and declared dry-runs are allowed within the requested certification scope.
- Never pass `yes`, `__confirmed`, or equivalent confirmation for a real mutation without separate explicit authorization for that tool, target fixture, expected effect, and rollback plan.
- A production mutation without a dedicated reversible fixture remains CONDITIONAL.
- Do not terminate or reuse an unknown process on port `8766` or an unknown Bridge process.
- Persist only sanitized result categories, timings, shapes, fingerprints, and tool names.

## Finish every run

1. Produce machine-readable tool and Adapter PASS/CONDITIONAL/FAIL results plus a self-contained HTML report; an Adapter with any FAIL tool cannot PASS.
2. Report CONDITIONAL tools grouped by login, permission, fixture, page context, safe dry-run awaiting UAT, and unapproved mutation.
3. Batch all missing profile facts into one question after safe work is complete.
4. After the user confirms the profile facts, validate the profile and record sanitized evidence:

   ```text
   node .codex/skills/certify-api-adapters/scripts/certification-memory.mjs validate-profile --profile=<profile-id>
   node .codex/skills/certify-api-adapters/scripts/certification-memory.mjs record --profile=<profile-id> --matrix=artifacts/api-adapter-certification/certification-matrix.json
   ```

5. Update `ROADMAP.md` with verified facts only. Never describe a completed certification run as a release PASS when FAIL or unresolved CONDITIONAL tools remain.
