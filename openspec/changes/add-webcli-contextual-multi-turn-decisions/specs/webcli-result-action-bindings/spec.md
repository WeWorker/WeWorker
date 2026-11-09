## ADDED Requirements

### Requirement: Declarative exact bindings
WebCLI SHALL compile results metadata from supported Adapter formats using only item/query property paths and JSON literals. Targets MUST be enabled, unambiguous, in the same Adapter and explicitly classified.

#### Scenario: A result supplies a selected entity and numeric or string ID
- **WHEN** a result supplies a selected entity and numeric or string ID
- **THEN** the target receives that exact type and declared arguments, never a model-generated ID

### Requirement: Delivered display and fingerprints
Ordinal selection SHALL use an acknowledged display subset/order and current source/target fingerprint. Raw results MUST be captured before formatting without changing business stdout.

#### Scenario: A host reverses two displayed results
- **WHEN** a host reverses two displayed results
- **THEN** viewing the second item binds the displayed second entity only after display registration

### Requirement: Action-scoped inputs and variants
Declared inputs SHALL be schema-validated explicit user values and MUST NOT override result-bound identity or collect credentials. Variants MUST be mutually exclusive and preserve object type.

#### Scenario: A mixed public/owned result or missing identity is encountered
- **WHEN** a mixed public/owned result or missing identity is encountered
- **THEN** only applicable validated actions are eligible; missing source identity is not repaired through user input

### Requirement: Truthful coverage
Inventory SHALL distinguish mapped queries, explicitly absent follow-ups, write commands and pending review. No-action reasons MUST distinguish result terminals from missing Adapter capabilities.

#### Scenario: A search-only Adapter has no detail command
- **WHEN** a search-only Adapter has no detail command
- **THEN** the report records a capability gap and does not invent a detail action or claim live certification
