## ADDED Requirements

### Requirement: Independent context identity
WebCLI SHALL generate UUIDs for --new-context, accept explicit --context identifiers across processes and SHALL NOT infer a global latest session.

#### Scenario: Separate CLI processes reuse the returned ID
- **WHEN** separate CLI processes reuse the returned ID
- **THEN** they read the same committed context without caller-managed JSON files

### Requirement: Private atomic bounded storage
WebCLI SHALL use versioned private local files, owner locks, atomic replacement, bounded capacity and conservative crash recovery. Corrupt/newer/redirected files MUST NOT be silently replaced; abandoned dispatching MUST become unknown without replay.

#### Scenario: Two writers or a crashed owner access one context
- **WHEN** two writers or a crashed owner access one context
- **THEN** updates serialize or fail explicitly; recovery requires proof of owner death

### Requirement: Three-round retention and expiry
Retrieval SHALL use at most the preceding three user rounds with original provenance, 24-hour idle expiry and 30-minute evidence expiry. Guards MUST survive history rotation and unresolved state MUST NOT be reclaimed.

#### Scenario: Old evidence is copied into a newer focus or pending record
- **WHEN** old evidence is copied into a newer focus or pending record
- **THEN** its source timestamp and round remain unchanged and cannot regain eligibility

### Requirement: Bounded collection
Collection SHALL recheck eligible records under lock with a 15-minute interval, 50-candidate or 100ms batch budget, an expiry marker and seven-day marker retention. Maintenance MUST NOT imply a background daemon.

#### Scenario: No CLI runs after expiry
- **WHEN** no CLI runs after expiry
- **THEN** logical eligibility expires while physical collection waits for a later invocation
