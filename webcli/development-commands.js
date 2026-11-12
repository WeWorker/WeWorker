/** Model-independent development commands; use the shared WebCLI argument parser. */
export const developmentCommands = {
  list: { required: [], description: 'List current development workspaces, Adapter identities, editable Tool metadata, retained commands and baseline digests. Read-only; no installed catalog snapshot.' },
  prepare: { required: ['adapter_id', 'expected_digest'], optional: ['toolkit_id'], description: 'Prepare an installed Adapter workspace at the exact catalog digest. Reuse matching workspace or bind a retained package; never install or overwrite. Multiple matches require toolkit_id. Only returned editable_tools may be modified; retained commands cannot be rewritten by this Toolkit flow.' },
  create: { required: ['toolkit_id', 'tool_id', 'allowed_domains', 'goal', 'start_url'], optional: ['expected_effect'], description: 'Create missing Toolkit/Tool metadata; never overwrite a Tool or widen existing domains.' },
  inspect: { required: ['toolkit_id', 'tool_id'], description: 'Read current slots, workspace revision and candidate digest.' },
  validate: { required: ['tool_id', 'code', 'description', 'parameters_schema', 'result_schema', 'risk_notice', 'safety'], description: 'Validate code and object schemas without writing or executing.' },
  save: { required: ['toolkit_id', 'tool_id', 'expected_revision', 'code', 'description', 'parameters_schema', 'result_schema', 'risk_notice', 'safety'], description: 'Validate and atomically advance the development slot and candidate v2 package. No model, installation or publication.' },
  build: { required: ['toolkit_id', 'expected_revision'], description: 'Verify and return the exact saved candidate package, path, manifest and digest. Does not imply runtime verification.' },
  review: { required: ['toolkit_id', 'expected_digest'], description: 'Review the exact built candidate in the desktop host: permissions, source/version changes and active baseline. Does not install; may reconcile an earlier completed installation.' },
  apply: { required: ['toolkit_id', 'expected_digest', 'review_id', 'confirmed'], optional: ['accept_changes'], description: 'After explicit approval, install and activate the exact reviewed package through the host, refresh catalog/Skills and acknowledge the formal version. Never retries automatically.' },
  debug: { required: ['toolkit_id', 'tool_id', 'expected_revision', 'expected_digest', 'parameters', 'confirmed'], optional: ['timeout_seconds'], description: 'Run the exact candidate via the existing isolated WebCLI catalog and Toolkit Runner. Requires authorization; never automatically retry writes.' },
  'debug-get': { required: ['debug_run_id'], description: 'Read debug status, result and error. Poll this after an accepted debug command.' },
  'debug-cancel': { required: ['debug_run_id'], description: 'Cancel a debug run; cancellation cannot undo effects.' },
};

export function developmentHelp() {
  return { namespace: 'development', schemaVersion: 1, model: 'calling-agent',
    usage: 'webcli call development.<command> [--key=value ...] [--args-file=./args.json]',
    requirements: ['Running host-managed website exploration service on 127.0.0.1:8766',
      'WEWORKER_EXPLORATION_INSTANCE_ID supplied by the same desktop host; never infer identity from an unknown listener',
      'prepare/review/apply additionally require the running desktop backend and host-provided WEWORKER_HTTP_TOKEN / WEWORKER_BACKEND_INSTANCE_ID; never pass credentials as command arguments'],
    contract: { parameters_schema: 'JSON object, never a JSON-encoded string', result_schema: 'JSON object, never a JSON-encoded string',
      safety: ['read', 'write'], expected_revision: 'non-negative integer from inspect/save',
      code: 'One top-level async function named tool_id; first parameter ctx; imports/helpers inside; no decorators, positional-only, *args or **kwargs; business parameters must match parameters_schema; no target_id/cdp_url.' },
    commands: Object.entries(developmentCommands).map(([name, spec]) => ({ name: `development.${name}`, ...spec })) };
}
