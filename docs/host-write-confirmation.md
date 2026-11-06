# Host-owned write confirmation

Models submit ordinary business arguments once:

```sh
webcli call example.com.start --pipelineId=123
```

The Bridge resolves and retains that request. If its policy needs confirmation,
Electron displays a native review; approval continues the retained closure, not
a new model-generated command. Ordinary flags, JSON values and args files keep
their existing input formats. This builds on the argument normalization in #299.

## Authority and policy

| Input or event | Meaning |
| --- | --- |
| User business instruction | Intent and scope; not a reusable machine execution permit |
| Model says "confirmed", a flag, environment value, work/session ID | No approval authority |
| Native dialog response on the inherited child-process channel | User decision for one exact pending request |
| In-memory object capability held by the Bridge | Permission for the retained runtime invocation |

`requires_confirmation:true` requests a review even on a read-labelled command.
An omitted value defaults to confirmation for writes. An explicit `false` is an
installed command policy exemption, not a caller claim; it skips the extra dialog
but still passes through the coordinator and runtime permit checks. Declared
page/UI writes retain their stronger protection regardless of an opt-out.
Policies must be reviewed by effect: downloads, draft edits, publication, bulk
deletion, workflow execution and approvals need not share the same policy.
Equivalent operational aliases must not provide a weaker route to the same action.

Existing native approval is reusable only by the continuation of its exact pending
request, including concurrent callers attached to it. Routine commands explicitly
exempted by package policy do not gain repeated prompts. Previous free-text
"yes", shell permissions, installation permissions, another request's approval,
or a broad conversation-level promise are not imported as write grants. This
release does not infer reusable scopes from natural language.

## Binding and lifecycle

The coordinator normalizes business arguments using the selected schema, including
defaults, and excludes the legacy root confirmation control. It binds the canonical
command definition (including policy), package name/digest/profile, complete
arguments, and host-selected browser connection. Package changes are checked again
before dispatch. Mutable caller objects and Adapter helper arguments cannot replace
the reviewed copy; host CLI arguments must match the normalized captured request.

Account context binds declared HTTP host credentials and/or a digest of the selected
browser's cookie stores and partitions. Raw cookies never enter confirmation events
or logs. A cookie change counter also invalidates a change-and-restore sequence.
The context is checked after confirmation, before Adapter dispatch, when a queued
background invocation starts, and before privileged background helpers/host CLI
credential access. The provider still independently validates its credential identity.
The current implementation conservatively binds the whole cookie jar: unrelated
cookie changes may require a new review. It does not claim to identify a person's
display name from arbitrary site cookies or cover custom authentication stored only
inside a page; page/Toolkit business acceptance is outside this release.

Reviews expire after five minutes and are consumed once. Cancellation, client
disconnect, expiry, parent replacement and restart cannot resume a pending write.
No grant or pending continuation is restored from disk. Concurrent identical
requests share a promise; completed/cancelled results are retained for the review
window, and unknown outcomes are retained for the life of the Bridge. No caller
flag can reset these records. The bounded queue rejects new writes when full.

The native window shows the exact tool, package digest, context and arguments. It
defaults to Cancel and never approves truncated review text. Only the parent of
the Bridge can answer on the inherited Node IPC/Electron utility-process channel.
WebSocket messages cannot sign approvals. The extension popup/sidepanel submit
managed requests to the same host flow; only extension-owned UI senders can use
their manual execution message.

Standalone npm/daemon hosts have no trusted confirmation UI and fail closed with
`WRITE_CONFIRMATION_UNAVAILABLE` for protected commands. Read calls and explicit
policy exemptions remain available. Environment variables and profile/work IDs
only select runtime/routing context. They do not enable or approve a review. This
protects the supported invocation protocols; it is not an OS sandbox against a
same-user process that can replace executable host code or control native input.

## Dispatch and outcomes

| State | Meaning |
| --- | --- |
| waiting_confirmation | Saved proposal, not submitted |
| cancelled | Cancelled before submission |
| not_submitted | Host proves no dispatch; fix the reported issue before a new request |
| running | Dispatched, awaiting outcome |
| succeeded | Runtime returned success; not a claim of independent business readback |
| failed | Runtime returned an explicit business failure |
| unknown | A dispatched operation lost its result; query target state before any new write |

HTTP dispatch is marked at the network boundary. Extension/Toolkit dispatch is
conservatively marked before handing control to executable Adapter code. A lost
extension reply is therefore unknown even if the remote action might not have
started. Host CLI preserves its more precise dispatch marker; only host-retained
argument/required-field preflight errors can establish non-dispatch through this
path. An Adapter-authored error string cannot establish this proof.

Controlled writes never use the read-only login replay path. There is no automatic
fallback or re-generation after approval. Unknown results are non-retryable and
deduplicated; the generic runtime does not invent a site-specific reconciliation
query. A fresh application launch has no pending work to replay; users must still
inspect the target state before intentionally making another write.

CLI JSON carries `_execution`; native UI/popup and chat distinguish the states.
Shell completion without host outcome evidence is displayed as command completion,
not business success. HTTP draft verification obtains the same native confirmation
in addition to its existing exact-request and before/after checks; it cannot bypass
the runtime permit with a legacy verification flag.

## Compatibility and validation

Old `--__confirmed=true`, string values and bare `--__confirmed` are inert input.
The malformed positional `__confirmed=true` is a syntax error before submission.
The host may provide a private compatibility boolean to an already-installed
handler after acquiring a valid permit. It is not an authorization input, is not
shown in generated business schemas/help, and never substitutes for a review.
Legacy page/Toolkit confirmation guards remain; no real page/Toolkit writes were
used as acceptance tests.

Tests cover forged flags and socket messages, normalized argument binding, changed
package/policy/account, cancellation/expiry, duplicate requests, one dispatch,
host CLI/managed background/HTTP execution, unknown results and native channel
decisions. Synthetic adapters and loopback HTTP servers exercise writes without
external business effects. Source tests, native desktop checks and packaged
installer acceptance must be reported separately.

### Validation on Windows (2026-11-06)

- Broad runtime regression: 234/238 tests passed across 13 suites. The four
  Toolkit large-output cases use an extensionless executable fixture; the same
  four failures were reproduced with the original `dev-1.1.0` CLI entry and
  unchanged Toolkit runner. They are not counted as passing acceptance.
- Final coordinator/Bridge tests: 35 passed. HTTP write exploration after the
  confirmation-wait deadline fix: 51 passed. Related catalog/login/schema tests
  passed in the earlier 122-test batch.
- Renderer: 6 tests and production build passed. Backend type checking and
  generated-Skill tests passed. Extension preparation, Bridge bundle and CLI
  bundle passed; existing optional column-mapping/chunk-size warnings remain.
- Actual isolated Electron utility-process/native-dialog checks and loopback
  HTTP calls: ordinary CLI read succeeded; native confirmation continued the
  retained request; identical normalized duplicate reused its result and caused
  no additional POST; a separate native cancellation returned `cancelled` with
  `dispatched:false` and zero POSTs. These are synthetic local effects only.
- No real publication, approval or pipeline was triggered. No Windows/macOS
  installer was installed or accepted; full application/extension end-to-end
  acceptance and page/Toolkit business acceptance remain separate work.
