/** Use the desktop host's workspace preparation and installation transactions; never write its registry directly. */
const HOST = 'http://127.0.0.1:8765';
const ID = /^[a-z][a-z0-9_]*$/;
const DIGEST = /^[a-f0-9]{64}$/;

export async function callDevelopmentInstall(command, args, { fetch: fetcher = globalThis.fetch, env = process.env } = {}) {
  const envelope = { schemaVersion: 1, command: `development.${command}` };
  const fail = (code, message, data) => ({ ...envelope, ok: false, error: { code, message }, ...(data ? { data } : {}) });
  if (!['prepare', 'review', 'apply'].includes(command)) return fail('UNKNOWN_COMMAND', 'Unknown installation command.');
  if (command === 'prepare') {
    if (typeof args.adapter_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.adapter_id)
        || typeof args.expected_digest !== 'string' || !DIGEST.test(args.expected_digest)
        || (args.toolkit_id !== undefined && (typeof args.toolkit_id !== 'string' || !ID.test(args.toolkit_id)))) {
      return fail('INVALID_ARGUMENT', 'Use adapter_id and the exact installed catalog digest; toolkit_id is optional for disambiguation.');
    }
  } else if (typeof args.toolkit_id !== 'string' || !ID.test(args.toolkit_id)
      || typeof args.expected_digest !== 'string' || !DIGEST.test(args.expected_digest)) {
    return fail('INVALID_ARGUMENT', 'toolkit_id and the exact expected_digest from build are required.');
  }
  if (command === 'apply') {
    if (args.confirmed !== true) return fail('CONFIRMATION_REQUIRED', 'Obtain approval for the reviewed installation before applying.');
    if (typeof args.review_id !== 'string' || !DIGEST.test(args.review_id)
        || (args.accept_changes !== undefined && typeof args.accept_changes !== 'boolean')) {
      return fail('INVALID_ARGUMENT', 'Use the exact review_id and a boolean accept_changes when supplied.');
    }
  }
  const token = env.WEWORKER_HTTP_TOKEN;
  const backendId = env.WEWORKER_BACKEND_INSTANCE_ID;
  if (typeof token !== 'string' || !token || typeof backendId !== 'string' || !backendId) {
    return fail('HOST_AUTH_REQUIRED', 'Host operations require WEWORKER_HTTP_TOKEN and WEWORKER_BACKEND_INSTANCE_ID from the desktop host environment. Do not read settings or credential files.');
  }
  const headers = { 'X-WeWorker-Auth': token, 'Content-Type': 'application/json' };
  let submitted = false;
  const request = (path, body) => fetcher(HOST + path, {
    method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error',
    signal: AbortSignal.timeout(body === undefined ? 15000 : 60000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const statusResponse = await request('/status');
    if (!statusResponse.ok) return fail('HOST_AUTH_FAILED', 'The desktop host rejected the authenticated status request.');
    const status = await statusResponse.json();
    if (status.service !== 'weworker-backend' || status.runtime_mode !== 'managed' || status.backend_instance_id !== backendId) {
      return fail('HOST_IDENTITY_MISMATCH', 'Listener is not the expected desktop backend. No installation was submitted.');
    }
    if (command === 'prepare') {
      submitted = true;
      const response = await request(`/api/website-exploration/adapters/${encodeURIComponent(args.adapter_id)}/development-prepare`, {
        expectedDigest: args.expected_digest, ...(args.toolkit_id ? { toolkitId: args.toolkit_id } : {}),
      });
      const data = await response.json();
      if (!response.ok) return fail('PREPARE_FAILED', typeof data.detail === 'string' ? data.detail : 'Cannot prepare the selected Adapter.');
      if (data.adapter_id !== args.adapter_id || data.digest !== args.expected_digest || typeof data.toolkit_id !== 'string' || !ID.test(data.toolkit_id)
          || !Array.isArray(data.editable_tools) || !Array.isArray(data.retained_commands) || !Array.isArray(data.allowed_domains)) {
        return fail('OUTCOME_UNKNOWN', 'Unexpected workspace receipt. List workspaces before retrying.');
      }
      return { ...envelope, ok: true, data };
    }
    const base = `/api/website-exploration/toolkits/${args.toolkit_id}`;
    const reviewResponse = await request(`${base}/install-review`);
    if (!reviewResponse.ok) {
      const error = await reviewResponse.json();
      return fail('INSTALL_REVIEW_FAILED', typeof error.detail === 'string' ? error.detail : 'The host could not review this candidate.');
    }
    const review = await reviewResponse.json();
    if (review.digest !== args.expected_digest) return fail('STALE_PACKAGE', 'Candidate changed since build. Build and review again before approving.');
    if (typeof review.reviewId !== 'string' || !DIGEST.test(review.reviewId)
        || typeof review.name !== 'string' || typeof review.profile !== 'string') {
      return fail('INVALID_RESPONSE', 'Host did not return a valid installation review.');
    }
    if (command === 'review') return { ...envelope, ok: true, data: { ...review, review_id: review.reviewId } };
    if (review.reviewId !== args.review_id) return fail('STALE_REVIEW', 'Installation content or host state changed. Obtain approval for a new review.');
    const changes = review.sourceChange || review.downgrade || review.addedPermissions?.length || review.overwritesNewerBase;
    if (changes && args.accept_changes !== true) {
      return fail('INSTALL_CHANGES_NOT_ACCEPTED', 'The review includes permission, source, version or newer-base changes. Obtain explicit approval before setting accept_changes=true.');
    }
    submitted = true;
    const response = await request(`${base}/install-apply`, { reviewId: args.review_id, acceptChanges: args.accept_changes === true });
    const data = await response.json();
    if (!response.ok) {
      return fail('INSTALL_APPLY_FAILED', typeof data.detail === 'string' ? data.detail : 'Installation was rejected. Refresh the review and inspect state before retrying.');
    }
    if (data.digest !== args.expected_digest || data.name !== review.name
        || !Number.isSafeInteger(data.revision) || data.revision < 0
        || typeof data.refreshed !== 'boolean' || typeof data.acknowledged !== 'boolean') {
      return fail('OUTCOME_UNKNOWN', 'Unexpected installation receipt. Inspect the host catalog and workspace before retrying.');
    }
    const receipt = { ...data, installed: true, applied: data.refreshed && data.acknowledged };
    if (!receipt.applied) return fail('APPLY_INCOMPLETE', 'Package is installed, but host refresh or workspace acknowledgement is incomplete. Review current state before resuming the same installation; do not rebuild or claim full completion.', receipt);
    return { ...envelope, ok: true, data: receipt };
  } catch {
    return fail(submitted ? 'OUTCOME_UNKNOWN' : 'HOST_UNAVAILABLE', submitted
      ? 'Connection interrupted after submission. List workspaces and inspect the installed catalog before retrying.'
      : 'Cannot reach the expected desktop host. No installation was submitted.');
  }
}
