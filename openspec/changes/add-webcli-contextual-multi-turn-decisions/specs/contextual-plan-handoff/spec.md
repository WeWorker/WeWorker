## ADDED Requirements

### Requirement: Decision and Runner separation
route SHALL return bound invocation descriptors; execution SHALL remain through call and existing distinct Runners. Context IDs and model scores MUST NOT confer permissions or prove business success.

#### Scenario: An external Agent receives a resolved decision
- **WHEN** an external Agent receives a resolved decision
- **THEN** no business action occurs until it invokes the returned call under existing permissions

### Requirement: Durable dispatch and honest outcomes
Supported context writes SHALL persist a dispatching guard before invocation, preserve unknown outcomes and block replay. Post-dispatch persistence failure MUST preserve the known business result separately.

#### Scenario: A write response is lost or final context save fails
- **WHEN** a write response is lost or final context save fails
- **THEN** the system does not automatically repeat the write or label it safely failed

### Requirement: Trusted preparation lifecycle
Only a trusted execution receipt for validated pre-side-effect navigation MAY mark a write prepared and safe to continue with the same step. Business JSON MUST NOT unlock replay; terminal navigation after side effects MUST NOT claim preparation.

#### Scenario: A write first opens its required page without acting
- **WHEN** a write first opens its required page without acting
- **THEN** the original decision can continue once; actual acknowledgement or unknown outcome then blocks replay

### Requirement: Explicit support and validation scope
Unsupported embedding-host context calls MUST fail before dispatch. Reports SHALL distinguish mock execution, real model/site tests, client integration and controlled deployment assets.

#### Scenario: A mode lacks the context catalogue/receipt protocol
- **WHEN** a mode lacks the context catalogue/receipt protocol
- **THEN** it rejects context explicitly rather than silently ignoring it
