## Purpose

Define an OpenCLI-aligned authoring workflow in which deterministic scaffolding supplies only safe structure and an agent turns exploration evidence into semantic, reviewable, and verified API Adapter tools.

## ADDED Requirements

### Requirement: The agent authors semantic tools from evidence
The generation workflow SHALL require the authoring agent to inspect exploration evidence, choose an API strategy, identify business-semantic inputs and outputs, and explicitly author each tool's request construction and response interpretation. Deterministic scaffolding MUST NOT mechanically convert captured sample values into tool parameters or payload defaults.

#### Scenario: Complete write evidence is available
- **WHEN** exploration provides a complete sanitized request shape and enough action context to identify business semantics
- **THEN** the agent authors parameters named for the business operation and constructs the request payload explicitly from caller input and runtime-derived values

#### Scenario: Captured fields include runtime-managed data
- **WHEN** evidence includes fields whose values belong to the current session, user, server, or previously selected record
- **THEN** the authored tool resolves or derives those fields at runtime rather than exposing captured values as defaults

### Requirement: Tool publication is evidence-gated
The system MUST publish only tools whose endpoint, input semantics, request construction, response contract, access classification, and required verification evidence are established. Missing evidence for one write tool MUST NOT be bypassed by marking it unverifiable.

#### Scenario: Write semantics are ambiguous
- **WHEN** the agent cannot determine which fields are caller inputs versus runtime-managed or server-managed values
- **THEN** the generation run enters a user-input-required state with a concrete question and does not publish that write tool

#### Scenario: A read tool cannot be automatically replayed
- **WHEN** a useful read tool has a sound semantic contract but cannot be replayed in the current page state
- **THEN** the workflow may retain it with explicit manual-verification evidence, without weakening the requirements for write tools

### Requirement: Generated tools expose business parameters only
Generated tool schemas SHALL expose only parameters a caller can meaningfully choose for the operation. They MUST NOT require captured database IDs, audit fields, creator or modifier identities, historical timestamps, authorization material, or opaque transport fields unless the field is itself a documented business input.

#### Scenario: Captured request contains identity and audit fields
- **WHEN** a sample write request contains creator, modifier, department, record ID, and audit timestamps
- **THEN** the published schema omits those fields unless independent evidence proves one is a caller-controlled business input

#### Scenario: Resource selection needs an identifier
- **WHEN** a write operates on an existing business resource
- **THEN** the tool accepts a stable business selector or uses a verified lookup tool, and does not default to the identifier captured during exploration

### Requirement: Generation retains WebCLI compatibility
The generated Adapter SHALL remain callable through `webcli call <adapter-id>.<tool-id>` and SHALL preserve the existing Extension Adapter execution boundary.

#### Scenario: Generated Adapter is published
- **WHEN** a generated Adapter passes all publication gates and the user approves publication
- **THEN** its tools are available through the existing WebCLI call interface without a new public protocol or runner
