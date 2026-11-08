This directory is reserved for reviewed host CLI resources supplied at build time.
The public build ships no CLI programs here. A fixed, reviewed host provider must
pin and verify its executable resources before use; Adapter arguments and
manifests must not choose resource paths or executable commands.

## Integration contract

- A distribution can add `weworker/host-cli-provider.json` with
  `{"schemaVersion":1,"entry":"host-cli-assets/example/provider.js"}`. Both
  desktop bundles bind that reviewed source to `webcli/host-cli-provider.js`
  during compilation; no public runtime source is overwritten. Relative imports
  in the provider resolve from `webcli/`. Missing/invalid configured files fail
  the build; absent configuration retains the disabled public provider.
  Runtime arguments, settings and environment cannot select a provider. Dispatch by a fixed
  Adapter name, reviewed package digest and command map. The public provider
  always reports unavailable; this is not a generic shell execution tool.
- The Bridge binds each helper to the original builtin Adapter invocation,
  profile, arguments and cancellation signal. Writes must call `markWriteDispatched` before dispatch.
  Disconnection or failure after dispatch reports an unknown outcome, never
  an automatic retry through another implementation.
- Use the host secret store for account credentials (Windows DPAPI or macOS
  Keychain), and the account lock for provisioning/recovery. Site-specific
  credential issuance and recovery remain the provider's responsibility.
  Credentials must not enter Adapter results, logs or command-line arguments.
- Desktop resources use exact dependency versions and a matching lockfile.
  Restore dependencies separately, then let `prepare-host-cli-assets.cjs`
  verify the pinned offline inventory. Build preparation has no network fallback.
- Both desktop bundles externalize the native Keychain module and carry its
  current Mac architecture package. Standalone WebCLI installs the same pinned
  dependency. `node webcli/scripts/verify-host-keychain.mjs` on macOS checks
  disposable-secret storage and cross-process retrieval without a website.

The native Mac path and packaged application still require platform acceptance;
mocked storage and packaging tests do not establish that acceptance.
