## Purpose

Define mandatory safety and behavioral verification for generated write tools so no operation can perform network I/O before confirmation or publish without exact mock evidence of its request and response semantics.

## ADDED Requirements

### Requirement: Write tools declare and enforce write access
Every generated tool that may mutate remote state SHALL declare write access and SHALL require explicit execution confirmation before performing authentication, lookup with side effects, or mutation network I/O. A dry-run or unconfirmed invocation MUST return a reviewable operation summary without sending the write request.

#### Scenario: Write tool is invoked without confirmation
- **WHEN** a caller invokes a write tool without the required confirmation or execution flag
- **THEN** the tool reports that confirmation is required and performs zero network I/O

#### Scenario: Write tool is invoked with confirmation
- **WHEN** a caller supplies valid semantic arguments and explicit confirmation
- **THEN** the tool performs only the verified requests needed for that operation and reports the interpreted business result

### Requirement: Write tools have exact mock or fixture verification
Before publication, every generated write tool MUST pass focused verification that asserts the exact request method, normalized URL, headers relevant to encoding, and serialized body produced from representative semantic arguments. Verification MUST also assert that captured business values do not appear in the request unless supplied by the test caller or a mocked runtime resolver.

#### Scenario: Exact request matches verified fixture
- **WHEN** the focused test executes a confirmed write against mocked transport and runtime resolvers
- **THEN** the observed request exactly matches the reviewed fixture and contains no stale captured identity, ID, timestamp, credential, or unrelated field

#### Scenario: Request differs from fixture
- **WHEN** the method, URL, payload shape, encoding, or runtime-derived fields differ from the reviewed fixture
- **THEN** verification fails and publication is blocked

### Requirement: Business responses and failures are verified
Write verification SHALL cover successful business responses, HTTP or transport failures, and application-level rejection responses. A tool MUST distinguish transport success from business success using the observed response contract or a documented postcondition.

#### Scenario: HTTP succeeds but business operation fails
- **WHEN** the server returns a successful HTTP status with an application-level failure code or message
- **THEN** the tool reports failure and does not claim that the operation succeeded

#### Scenario: Operation has a verifiable postcondition
- **WHEN** the action exposes a safe read endpoint or response field that confirms the mutation
- **THEN** focused verification asserts the postcondition mapping without issuing a real production write

### Requirement: Real writes are not used for automatic verification
The generation and certification workflow MUST NOT execute production mutations to validate generated write tools. Live automatic validation SHALL register and inspect writes without executing them.

#### Scenario: Runtime validation encounters a write tool
- **WHEN** the live page runtime validator processes a generated write tool
- **THEN** it verifies registration, access metadata, and confirmation behavior while leaving the mutation unexecuted
