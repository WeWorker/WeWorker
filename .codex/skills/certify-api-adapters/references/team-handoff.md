# API Adapter certification team handoff

## What the repository shares

The repository carries the Skill, deterministic inventory and mock gates, generic Adapter playbooks, source fingerprints, safety policy, known product defects, and sanitized shared baselines. A successor may reuse matching static, mock, safety, and packaging evidence.

Historical live results are context only. They do not prove that the successor's browser session, permissions, subsystem bindings, fixtures, or page contexts work.

## What never transfers between developers

Do not copy another developer's directory below `~/.weworker/api-adapter-certification/`. Each developer chooses an explicit profile ID and creates their own profile and memory. Never exchange Cookie values, tokens, passwords, authorization headers, raw request or response bodies, downloaded business files, local paths, or account identifiers.

## First prompt for the successor

From the repository branch containing this Skill, start Codex with a request equivalent to:

```text
Use the certify-api-adapters Skill to take over Extension API Adapter certification.
My profileId is <developer-chosen-alias>.
Reuse only eligible shared static/mock evidence and establish my own live evidence.
Do not perform real production mutations. Batch login, permission, fixture, and page-context questions after safe work.
```

## First-run sequence

1. Read repository `AGENTS.md` and `ROADMAP.md`.
2. Create the developer-local profile from `certification-memory.mjs profile-template --profile=<profile-id>` only after the developer confirms non-secret capability facts.
3. Run `validate-profile`, then `plan`.
4. Reuse static/mock evidence only when the planner permits it. A new profile normally receives live work for every shipped API Adapter discovered from the active build profile.
5. Execute reads, confirmation guards, and declared dry-runs through the production WebCLI/Bridge/Extension path. Never supply a confirmation flag for a real mutation without separate authorization and a reversible fixture.
6. Generate the machine-readable matrix and self-contained HTML report, grouped by actionable CONDITIONAL reason.
7. Record only sanitized evidence into the current developer's local memory.

## Current shared entry points

- Operating procedure: `references/runbook.md`
- Local profile schema: `references/profile-schema.md`
- Multi-user boundary: `references/architecture.md`
- Generic site requirements: `references/adapter-playbooks.json`
- Current machine-readable output: `artifacts/api-adapter-certification/certification-matrix.json`
- Current self-contained report: `artifacts/api-adapter-certification/certification-report.html`

Before a release decision, read the current matrix rather than copying counts from this handoff file. FAIL and unresolved CONDITIONAL results must remain visible; a completed run is not automatically a release PASS.
