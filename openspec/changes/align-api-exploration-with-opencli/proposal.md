## Why

WeWorker currently turns captured API samples into executable Adapter payloads mechanically, including partially recovered request bodies and captured business values. This diverges from the latest OpenCLI workflow, where network discovery supplies sanitized evidence and an agent authors and verifies a semantic tool; for write operations, the current behavior can publish incomplete schemas or replay stale identities, IDs, and timestamps.

## What Changes

- Align API exploration evidence with OpenCLI: preserve complete, sanitized structure while treating truncated, positional, or otherwise opaque bodies as non-executable evidence.
- Stop persisting or emitting raw captured business request bodies, credentials, identities, record IDs, timestamps, and sample values as generated-code defaults.
- Replace mechanical request-sample-to-tool compilation with an agent-authored workflow that selects a strategy, defines business-semantic parameters, constructs runtime payloads explicitly, and records verification evidence.
- Require write tools to declare write access, block network I/O until explicit confirmation, resolve session/server-managed fields dynamically, and validate business-level success or failure.
- Add focused fixture/mock verification for generated writes, including exact URL/method/body assertions, no-I/O-before-confirmation, error handling, and postconditions.
- Pause publication and ask for additional evidence when a write request body or required semantics cannot be established safely.
- Keep read-only API exploration supported and retain the public `webcli call <adapter-id>.<tool-id>` interface.

## Capabilities

### New Capabilities

- `safe-api-evidence`: Defines sanitized, completeness-aware network evidence and prohibits truncated or sensitive captures from becoming executable defaults.
- `agent-authored-api-adapters`: Defines the OpenCLI-aligned semantic authoring workflow and publication gates for generated API Adapters.
- `write-tool-verification`: Defines write access declarations, confirmation behavior, exact mock/fixture verification, response interpretation, and safe failure handling.

### Modified Capabilities

None. The repository has no existing OpenSpec capabilities.

## Impact

- Affects the website exploration agent's network/action capture, exploration memory, generation orchestration, Adapter scaffold policy, generated Adapter validation, and focused tests.
- Affects TypeScript backend code under `weworker/backend-ts`, generation/runtime support under `webcli`, and generated API Adapter artifacts under `extension/adapters`.
- Adds migration-compatible handling for previously stored exploration records without reading legacy data outside the permitted WeWorker storage roots.
- Does not change the WebCLI public command protocol, Extension/Toolkit Adapter runner boundary, release pipeline, database schema, or external dependencies.
