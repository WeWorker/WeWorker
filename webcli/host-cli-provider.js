// This module is a build-time integration point. Public builds never load an
// executable or provider path from an Adapter, command argument or environment.
// An internal distribution may replace this exact module at build time with a
// reviewed provider. The provider must enforce its own fixed command map and
// must respect signal before every side effect and while child processes run.
// A write provider must call markWriteDispatched immediately before it sends a
// write or starts a child that may send one. It must never retry an uncertain
// write. The host treats all later failures as an unknown outcome.
export async function executeHostCli() {
  throw Object.assign(new Error('Host CLI is unavailable in this build.'), { code: 'HOST_CLI_UNAVAILABLE' });
}
