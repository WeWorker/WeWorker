## 1. Safe API Evidence

- [x] 1.1 Add a canonical request-evidence normalizer that preserves complete JSON/form structure, recursively removes captured values, and marks truncated/malformed/opaque bodies omitted; verify with focused WebCLI unit tests.
- [x] 1.2 Route Extension action-capture candidates through completeness-aware safe evidence and stop returning raw request-body previews for new captures; verify Extension protocol and action-capture tests.
- [x] 1.3 Update Backend site-memory types and persistence to retain safe evidence, normalize legacy previews conservatively, and exclude raw bodies from newly persisted records; verify Backend site-memory tests.
- [x] 1.4 Remove truncated JSON salvage and raw body/value propagation from generation inputs, knowledge, and provenance; verify regression tests cover the request-style truncated body.

## 2. Agent-Authored Semantic Adapters

- [x] 2.1 Change deterministic scaffolding so write candidates produce safe skeletons only and cannot derive schemas or default payloads from captured values; verify scaffold tests assert no sample-derived defaults.
- [x] 2.2 Update generation context, prompts, and authoring tools so the agent defines semantic parameters, explicit payload construction, runtime-managed fields, write access, and response interpretation; verify orchestrator/tool-loop tests.
- [x] 2.3 Make incomplete or ambiguous writes pause with a concrete user question and prohibit publishing or marking such writes unverifiable; verify generation pause/resume and publication-gate tests.

## 3. Write Verification Gates

- [x] 3.1 Add static policy checks for write access metadata, confirmation guards, forbidden raw captures/default values, and required focused fixtures; verify static-validator tests.
- [x] 3.2 Add focused mock verification that asserts no I/O before confirmation, exact confirmed URL/method/body, stale-value absence, and business success/failure interpretation; verify runtime-policy and write-tool tests without real network writes.
- [x] 3.3 Integrate write verification into finish and publish preconditions while keeping live runtime validation non-mutating; verify end-to-end generation and publish-baseline tests.

## 4. Request Regression and Validation

- [x] 4.1 Scrub and withdraw the request `submit_request` tool because its request evidence is truncated; verify no captured values remain, no runtime registration exists, and regeneration is blocked until a complete recapture can be agent-authored and mock-verified.
- [x] 4.2 Run focused Backend, WebCLI, Extension, and Renderer suites plus relevant builds/type checks; record only verified results.
- [x] 4.3 Update API exploration documentation and `ROADMAP.md` with the verified OpenCLI-aligned behavior and remaining limitations.
