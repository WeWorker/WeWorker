## ADDED Requirements

### Requirement: Deterministic bounded selection
WebCLI SHALL parse complete supported ordinal/action instructions before calling a model. Negated, mixed or unsupported extra clauses MUST NOT be partially executed.

#### Scenario: The user asks to view the second displayed item
- **WHEN** the user asks to view the second displayed item
- **THEN** route returns its exact read call without an extra confirmation question

### Requirement: Choice boundary
Natural-language choice SHALL retain abstention controls, enforce 24 options/16KiB candidates/8KiB input/3000ms aggregate wait and strictly validate a unique normalized maximum of at least 0.85 without retries.

#### Scenario: The provider times out or returns an invalid distribution
- **WHEN** the provider times out or returns an invalid distribution
- **THEN** route hands off without a business call or invented selection

### Requirement: Correlated clarification
Missing new parameters SHALL preserve selection and clarification provenance. Reply-to, display version, fingerprint and evidence freshness MUST be validated without coercing JSON types.

#### Scenario: A user answers an edit-body clarification
- **WHEN** a user answers an edit-body clarification
- **THEN** the original entity is retained, the body is validated, and stale or identity-overriding answers fail

### Requirement: Distinct outcomes
route SHALL distinguish resolved, needs_input, handoff and unrelated. Only unrelated input MAY enter ordinary single-turn recommendation.

#### Scenario: A related explanation or unsupported complex action is requested
- **WHEN** a related explanation or unsupported complex action is requested
- **THEN** the whole request is handed to the Agent rather than rerunning a loosely matching query
