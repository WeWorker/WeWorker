## Purpose

Define privacy-preserving and completeness-aware API exploration evidence so captured traffic can guide semantic Adapter authoring without replaying user data or treating incomplete bodies as executable requests.

## ADDED Requirements

### Requirement: Request evidence records structure and completeness
The system SHALL represent each captured request with its method, normalized endpoint, query-key shape, body kind, body-key or nested shape metadata when safely available, original body size when known, truncation state, and omission state. It MUST distinguish complete JSON or form data from opaque, positional, binary, malformed, and truncated bodies.

#### Scenario: Complete JSON request is captured
- **WHEN** exploration captures a complete JSON request body
- **THEN** the evidence records `json` as the body kind and a sanitized recursive shape that preserves field names and value types without preserving captured business values

#### Scenario: Complete form request is captured
- **WHEN** exploration captures a complete URL-encoded form body
- **THEN** the evidence records `form` as the body kind and the sanitized field shape without preserving captured business values

#### Scenario: Truncated request is captured
- **WHEN** the capture layer cannot provide the complete request body
- **THEN** the evidence records the body as truncated and omitted or opaque, and no downstream component treats the visible prefix as a complete object

### Requirement: Captured sensitive and business values are not persisted as generation evidence
The system MUST recursively redact credentials, authorization material, cookies, tokens, secrets, personal identities, record identifiers, timestamps, and captured business values before evidence is persisted or sent to Adapter generation. Raw request bodies MUST NOT be stored in generated source, Adapter knowledge, generation provenance, or trace artifacts.

#### Scenario: Sensitive values occur at nested levels
- **WHEN** a complete captured body contains sensitive values in nested objects or arrays
- **THEN** persisted evidence retains only safe structural information and contains none of the original sensitive values

#### Scenario: Existing memory contains a legacy body preview
- **WHEN** generation reads a pre-migration site-memory record containing a raw or truncated body preview
- **THEN** the record is normalized to safe structural evidence in memory and the raw preview is excluded from prompts, generated files, and newly persisted artifacts

### Requirement: Incomplete bodies are never salvaged for execution
The system MUST NOT repair, close, parse, or otherwise salvage a truncated or malformed body prefix into executable defaults, schemas, fixtures, or payload templates.

#### Scenario: JSON preview ends at a partial top-level field
- **WHEN** captured JSON ends before the complete request body is available
- **THEN** no recovered prefix fields or values are used to generate an executable payload or required-parameter schema

#### Scenario: Body structure is required for a write tool
- **WHEN** a write candidate has only truncated, malformed, positional, binary, or opaque body evidence
- **THEN** generation pauses for additional evidence or explicit user input instead of publishing the write tool

### Requirement: Read-only evidence remains usable
The system SHALL continue to support read-only API discovery from normalized endpoints, query keys, sanitized response contracts, and safe replay evidence even when request bodies are omitted.

#### Scenario: Read endpoint has no request body
- **WHEN** exploration identifies a high-confidence read endpoint using a safe HTTP method or read-only replay evidence
- **THEN** the endpoint remains eligible for semantic Adapter authoring and verification
