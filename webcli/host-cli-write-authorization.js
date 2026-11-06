import { hasExecutionPermit } from './write-confirmation.js';

// A policy decision and a real UI confirmation both produce an invocation-bound
// host capability. Neither the original caller nor an Adapter can supply it.
export async function authorizeHostCliWrite({ permit, selected, args }) {
  return hasExecutionPermit(permit, selected, args);
}
