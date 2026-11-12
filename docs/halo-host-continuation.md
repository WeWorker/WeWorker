# Embedded browser host: validation and release handoff

Updated 2026-11-07. This change targets public dev-1.1.0.

## Source and ownership

The host integration was ported from the companion fork to the current public
runtime, retaining newer shared-browser and host-argument changes. The operator
will publish the selected npm distribution after review and merge; the embedding
application then pins that exact package and integrity before building an installer.
No npm version or release workflow is changed here. Private provider assets and
configuration remain in their owning repository.

## Verification boundary

On the current public base, ten focused host/provider/standalone suites pass
102 tests. Earlier Windows x64 Electron local-site tests passed three cases using
an installed candidate CLI, covering cookies, session-storage reuse, uploads,
cancellation and recovery. Those desktop tests predate this dev-1.1.0 port; they
do not establish that the final published package or installer is accepted.

Authenticated site workflows, real uploads, provider provisioning, enterprise
proxy/certificate behavior, clean installation and real model screenshot follow-up
remain separate acceptance gates. Capability discovery labels site validation as
unverified. Installation testing is deferred because of host execution restrictions.

## Next verification

1. Merge the reviewed public runtime and the distribution's matching provider asset
   changes. Assemble using their exact commits and the existing distribution flow.
2. Inspect the packed executable entry, all host files, Adapter inventory, native
   dependencies and provider resources; record tarball integrity and source SHAs.
3. Publish the reviewed artifact using the distribution's existing release procedure.
4. Pin that package in the embedding application, rerun installed-runtime regressions,
   build the target installer and complete installation/site acceptance in an approved
   environment. Do not treat a successful build as business acceptance.
