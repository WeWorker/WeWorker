## Context

See `proposal.md` for motivation. The current pipeline spans Extension network/action capture, Backend site memory, WebCLI generation orchestration, deterministic Adapter scaffolding, static validation, live runtime validation, and publication. The capture currently persists clipped request previews, while deterministic scaffolding parses those previews into schemas and payload defaults; a recent truncation-recovery path makes that coupling more dangerous.

The latest OpenCLI `main` at commit `8271afc67e8504bda94c147f446ee29775d08274` uses browser inspection as evidence for an agent-authored implementation. Its network layer marks truncated bodies opaque and omitted rather than repairing them, and its write tools use semantic arguments, explicit payload construction, access metadata, execution guards, and focused mocked tests.

The workspace contains user-owned in-progress generation work. Implementation must be incremental, preserve unrelated changes, retain the public WebCLI interface, and avoid real production mutations.

## Goals / Non-Goals

**Goals:**

- Establish one canonical safe request-evidence model shared across capture, persistence, prompting, generation, provenance, and validation.
- Make the generation agent responsible for semantic request construction while keeping deterministic code responsible for safe skeletons, file boundaries, and policy enforcement.
- Turn write safety and exact mocked request behavior into hard publication gates.
- Normalize legacy site memory at the consumption boundary so migration does not require destructive data rewriting.

**Non-Goals:**

- Reproduce OpenCLI's package layout or remove WeWorker's Extension Adapter runtime.
- Change the `webcli call` public protocol or merge Extension and Toolkit runners.
- Automatically execute real writes, modify release/CI configuration, add a new framework, or access legacy storage outside the permitted WeWorker roots.

## Decisions

### 1. Introduce a canonical safe evidence envelope

Captured requests flow as an envelope containing normalized method/endpoint, query keys, `bodyKind`, safe recursive `bodyShape`, `bodyFullSize`, `bodyTruncated`, and `bodyOmitted`. Complete JSON and URL-encoded form bodies are parsed only at the capture/normalization boundary, converted to structural descriptors, and recursively stripped of values. Truncated, malformed, positional, multipart/binary, or unknown bodies are represented as opaque and omitted.

This follows OpenCLI's completeness rule and gives all later stages an explicit truth signal. Keeping clipped raw previews and teaching every consumer to recognize truncation was rejected because one missed consumer can silently recreate an executable partial payload.

### 2. Sanitize on capture and normalize again on consumption

The Extension emits safe evidence for new captures. Backend site memory persists only the safe representation. WebCLI also normalizes incoming memory before model prompting or scaffolding, because existing records and mixed-version clients may still contain `requestBodyPreview`.

The second boundary is deliberate defense in depth. An eager destructive migration was rejected because site memory is user state, rollback would be difficult, and current constraints favor compatibility without broad data rewriting.

### 3. Separate safe deterministic scaffolding from semantic authoring

Deterministic scaffolding may create manifest, runtime helper, tool skeleton, and safe endpoint metadata. It may not infer write schemas/default payloads from captured values. The generation orchestrator must inspect evidence and author or rewrite each write tool file with semantic parameters, explicit payload construction, response interpretation, and access metadata.

The agent receives safe shapes and response contracts, never captured business values. For incomplete or ambiguous write evidence it must invoke the existing user-input pause mechanism with a concrete evidence request. Falling back to a mechanically generated write or marking a write unverifiable is disallowed.

Retaining a pure template compiler was rejected because field ownership and business meaning cannot be recovered reliably from a sample. Removing scaffolding entirely was also rejected because deterministic workspace, manifest, and runtime boilerplate reduce model error and preserve packaging conventions.

### 4. Make write verification a distinct publication gate

Every planned write tool receives a generated or agent-authored focused mock fixture. The verifier imports the draft tool with mocked transport/session resolvers and asserts:

- write access metadata is present;
- unconfirmed execution performs zero I/O;
- confirmed representative input yields the exact reviewed method, URL, encoding, and body;
- stale captured values are absent;
- application-level failure and success mappings behave as declared;
- any safe postcondition mapping is correct.

Live runtime validation continues to execute high-confidence reads only. For writes it checks registration and guard behavior, but never triggers the mutation. Allowing `unverifiable` write tools to publish was rejected because it converts missing safety evidence into a normal success path.

### 5. Enforce provenance and source policy statically

Static validation scans generated JavaScript, manifests, knowledge, and provenance for forbidden raw body fields, truncation markers, captured-value defaults, and missing write metadata/fixtures. Provenance records fingerprints, endpoint shape, completeness, and verification references; it does not contain request bodies or sampled values.

Heuristic scanning alone cannot prove semantics, so it supplements rather than replaces the focused mock gate and agent review.

### 6. Correct the request Adapter through the pipeline

The existing generated request write is treated as a regression fixture: after the pipeline is safe, regenerate or revise it so `submit_request` exposes business inputs only, has no captured default payload, declares write access, blocks I/O until confirmation, and passes an exact mock request test. It must not be accepted merely because its current confirmation gate works.

## Risks / Trade-offs

- [Sanitization removes values that helped weak heuristics infer semantics] → Preserve names, types, nested shapes, endpoint context, response contracts, action labels, and let the agent request targeted evidence.
- [Legacy records have no reliable original body size/truncation flag] → Treat known truncation markers or parse failures conservatively as opaque; never infer completeness from a recoverable prefix.
- [Agent-authored code is less deterministic than templates] → Constrain file access, require static policy checks and exact mock fixtures, and keep deterministic runtime/manifest scaffolding.
- [Existing tests expect sample-derived defaults] → Replace only expectations that encode the unsafe behavior and retain read-only compatibility coverage.
- [Some write APIs require hidden runtime fields] → Add explicit runtime resolver hooks or prerequisite lookup tools; pause when no verified resolver exists.
- [Broader static scans may flag legitimate constants] → Scope checks to generated write artifacts and support an evidence-backed allowlist for documented protocol constants, never captured values.

## Migration Plan

1. Add the safe evidence normalizer and tests, then route new Extension action captures through it.
2. Normalize Backend persistence and WebCLI generation inputs while retaining read compatibility with legacy records.
3. Disable truncated-body recovery and sample-derived write payload generation; make incomplete writes pause.
4. Update generation prompts/tools so the agent authors semantic write implementations and fixtures.
5. Add static and mock verification gates, then integrate them into finish/publish preconditions.
6. Correct the request Adapter and run focused Backend, WebCLI, and Extension tests plus package/build checks appropriate to changed areas.
7. Update documentation and `ROADMAP.md` only with verified results.

Rollback is code-only: revert consumers to the previous generation path while retaining safe evidence fields. Newly sanitized records cannot and must not reconstruct discarded raw business values; additional capture would be required.
