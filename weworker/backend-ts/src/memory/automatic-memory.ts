/** Process-wide opt-out for isolated runs. Explicit memory management is separate. */
export function automaticMemoryEnabled(): boolean {
  return process.env.WEWORKER_DISABLE_AUTOMATIC_MEMORY !== '1'
}
