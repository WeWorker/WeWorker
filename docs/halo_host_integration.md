# WebCLI host protocol experiment

Current local verification and release ownership are recorded at the top of
`halo-host-continuation.md`. Historical acceptance below does not certify private
sites. Current helpers include file upload completion and scoped session-storage
cache reuse supplied by the desktop host; unsupported page-query continuations
still fail explicitly. Current dev-1.1.0 validation: 102 host/provider tests and 12 standalone CLI tests passed.

The optional host transport lets an embedding desktop app supply browser capabilities
without emulating Chrome extensions. Unconfigured WebCLI retains its existing Bridge,
dedicated browser and independent Agent usage.

`WEBCLI_HOST_ENDPOINT` and `WEBCLI_HOST_TOKEN` must both be set. The endpoint is exactly
`http://127.0.0.1:<ephemeral-port>/webcli/v1`. Protocol requests are authenticated JSON
POSTs with `schemaVersion: 1`, an operation and arguments. The host must reject web
origins, malformed requests and unauthorized clients. Payloads and deadlines are bounded.
No fallback or retry is permitted after selecting a host, especially after writes.

Only `webcli call` is enabled in host mode. `browser.help` describes the selected
host's actual subset. `host.catalog` discovers locally installed Adapter commands.
Background API Adapters retain background execution through restricted host helpers;
unsupported runtimes and helper actions fail explicitly. Existing extension code
and WeWorker browser selection remain unchanged.

The Halo fork owns browser pages, sessions, login persistence and subprocess cleanup.
WebCLI owns Adapter selection, digest checks, registration, execution and confirmation
guards. Each host invocation receives a separate channel; no persistent credentials,
shared WeWorker data root or fixed Bridge port are used.

Implementation and acceptance status is tracked in the cross-repository FOLLOWUP.md
and the validation section below. This experiment is not an npm or application release.

## Development setup

Prepare this checkout before supplying its CLI path to Halo:

```sh
cd webcli
npm ci --ignore-scripts --no-audit --no-fund
cd ..
node weworker/scripts/prepare-build.cjs --profile public
```

Set Halo's `HALO_WEBCLI_PATH` to the absolute path of this checkout's `webcli/index.js`.
The Halo fork exposes only `mcp__ai-browser__webcli_call` for browser execution when
this variable is present, with Adapter-first discovery instructions. Keeping native
tools alongside it allowed a real model to bypass WebCLI. Restart Halo after changing
this startup setting to rebuild the engine sessions' tool inventory.
No extension is required on this route. No variable means existing WeWorker behavior.

The `host.catalog` result describes runtime eligibility, not whole-site certification.
It returns the host's helper capabilities and labels site validation as unverified.
Background execution forwards browser helpers, reuses existing file/Excel helpers,
and delegates `host_cli_call` to the existing provider gate. The selected distribution
owns that provider; no site-specific provider is added to the public host transport.
Conditional commands retain their existing argument-based page/background choice.
Page execution supports standard DOM/fetch, scoped helpers and navigation continuations.
Halo permits trusted read commands implemented using POST and requires confirmation
for writes. No write is automatically replayed. Unsupported runtimes, helpers and
continuations fail explicitly.

Embedding hosts set `WEBCLI_HOST_STATE_DIR` to an absolute private state directory.
This isolates provider secrets and lock namespaces while standalone defaults remain
unchanged. Provider overlays should use `resolveHostStateDirectory()` for journals.
Cancellation IPC uses `{type:'webcli:cancel'}`; provider work receives the existing
abort signal. Files must be named in the original invocation arguments. Browser
helper authority remains constrained by the selected Adapter manifest.

The host runtime preserves the existing background `fetchJson` contract: default
JSON Accept header, JSON-or-text responses, and `HTTP_ERROR` with status/body
details for the Adapter's own authentication handling. It does not translate every
HTTP 401 into an Adapter-specific login error or retry the request.

Packaged hosts must invoke the actual package executable (`bin.webcli`), preserving
distribution initialization. Install a fixed tarball/version with its production
dependency tree; do not replace the executable with a source `index.js` path.

## Validation — 2026-10-21

- 87 focused WebCLI tests passed: new host protocol, Adapter selection/digests,
  default dedicated browser/Bridge, profile routing, npm preparation and CLI parsing.
- Public preparation produced 33 packages. `npm pack` included all four host files.
  The existing desktop CLI bundler and its real host-call smoke test passed.
- Halo: 66 focused tests under Electron's Node runtime, including host/native tool
  selection and failure routing; changed-file type checking
  and `electron-vite build` passed. Whole-repository type checking still has upstream
  errors and is not reported as passing.
- Real Electron MCP → CLI → Halo webview integration passed using both the source
  entry and extracted npm package. A local fixture verified fill/click/snapshot,
  screenshot, page reuse, initial AUTH_REQUIRED, login, a normal background call
  after closing all task pages, context separation, cleanup and authenticated
  background calls after restarting Electron with the same isolated profile.
- After the routing fix, real Electron MCP discovery exposes only `webcli_call` in
  main chat, digital-human chat and automation, and the browser integration passes.
- A full Halo client conversation using GLM-5.3 and an ordinary public example.com
  reading request selected `host.catalog` followed by browser commands through
  `webcli_call`, with no native browser tool calls, and completed successfully.
  This is one model/page routing case, not certification of site Adapters.
- The npm test reused installed dependencies through a local symlink. It is not a
  clean-machine installation test. The npm package version remains the upstream
  value; no npm publish occurred.

- Page Adapters now reuse verified v2 sources/bootstrap in a Halo isolated world,
  with argument defaults/types, confirmation, owned-page reuse and up to four
  scoped navigation continuations. Confirmed writes are never replayed. Unsupported
  helpers/page-query/CDP continuations fail explicitly. Local Electron tests cover
  main-world isolation, initial script redirects, page login/reuse, scope refusal,
  no write replay, cancellation and timeout with no delayed script left running.
  Source and extracted npm entries passed; the desktop bundle's serialized page
  runtime passed its smoke test as well.
- Real read-only `12306.cn.stations` returned three public station records without
  creating a page. `12306.cn.trains` returned three trains from Shanghai Hongqiao
  to Beijing South on 2026-10-22 and reused the same page on a second call. No form
  filling, account login or ticket purchase was used. The existing Adapter sources
  are unchanged. Electron's empty Response.url is normalized under manual redirects
  to fix stations; actual response URLs and redirect refusal are preserved.

Outstanding: additional page Adapter compatibility, Toolkit/HTTP/exploration paths, more
privileged helpers, credential sources beyond cookies, external-site certification,
broader model/Adapter workflows, fresh-machine installation and final Halo bundling.
For the synchronized fork status and remaining distribution work, see `halo-host-continuation.md`.


## Full-client page Adapter acceptance — 2026-10-22

The rebuilt experimental Halo client was restarted with its existing isolated data
and browser profile. A fresh GLM-5.3 conversation received an ordinary read-only
request for the earliest three high-speed trains from Shanghai Hongqiao to Beijing
South on 2026-10-23, without naming WebCLI or an Adapter. It selected `host.catalog`
and then `12306.cn.trains`, both through `webcli_call`. The Adapter returned live
records, and the final UI displayed G532, G548 and G2 with schedule and second-class
availability. Logs show two WebCLI calls and zero native browser tool calls; no form
filling, account login, booking or payment was used. The client remains running for
manual trial. This validates this model/command flow, not every Adapter or a packaged
Halo distribution. No execution-code changes were needed for this acceptance run.
