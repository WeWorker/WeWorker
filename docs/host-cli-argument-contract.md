# Host CLI argument contract

`webcli call example.com.start --productId=123 --id=00456`
is a supported invocation. CLI numeric-looking values stay strings until the
selected runtime applies its schema; string IDs must keep leading zeroes.

For a host CLI write, the host resolves the pinned command and normalizes both
the captured caller arguments and the helper arguments using that command's
schema. This covers explicit integer/number/boolean properties, integer arrays,
nested declared properties and schema defaults. Unspecified properties and
string/number unions that allow strings retain their original representations.
Invalid numeric inputs, including unsafe integers, are rejected.

The host compares the complete normalized arguments, then uses its own captured
copy for authorization and provider execution. It never trusts a helper's schema
or confirmation flag. Root `__confirmed` is excluded from the business argument
comparison. Confirmation now comes from the [host execution flow](host-write-confirmation.md),
never the original caller's boolean. Schema defaults cannot synthesize confirmation.
Controlled calls bind the normalized arguments, including defaults, before execution.

This corrects host writes whose helpers normalize numeric CLI values. It does
not change the global CLI parser, HTTP, page or Toolkit argument contracts.
Adapters that pass arguments through remain supported. Confirmed writes with
changed values, removed fields or extra fields are rejected; unknown write
outcomes remain non-retryable.

Trusted host argument failures return `HOST_CLI_INVALID_ARGUMENT` with a fixed
message and bounded field/type diagnostics, `stage=argument_validation` and
`writeDispatched=false`. Values, provider exception text and credentials are
never included. The host retains these diagnostics across the extension reply,
including when a helper swallows the error. Other provider errors do not inherit
this pre-dispatch assertion.

Legacy confirmation flags, including a bare flag, are accepted as inert input.
They do not imply approval and must not be included in new tool instructions.

Regression coverage exercises CLI flags, inline JSON and UTF-8 JSON files
through the real managed Adapter validator and host authorization, plus forged
helper arguments, defaults, arrays, cancellation and unknown write outcomes.
Business writes require separate user acceptance; mocks never contact a site.
