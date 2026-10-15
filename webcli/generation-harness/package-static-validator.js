import { inspectPackageRegistration, readGenerationEvidence, resolveDraftToolName } from './package-inspection.js';
import { verifyRetainedPackage } from './existing-site.js';

export function validatePackageDraft({ adapterDir, expectedSiteKey = '', expectedToolNames = [] }) {
  const errors = [];
  const fail = (code, message) => errors.push({ code, message, severity: 'error' });
  let checkedFiles = 0;
  let packageDigest;
  try {
    const { pkg, names, manifest } = inspectPackageRegistration(adapterDir);
    checkedFiles = pkg.files.size;
    packageDigest = pkg.digest;
    const evidence = readGenerationEvidence(adapterDir);
    const retained = verifyRetainedPackage(pkg, evidence);
    if (expectedSiteKey && manifest.name !== expectedSiteKey) fail('MANIFEST_ID_MISMATCH', 'Package identity differs from the planned site.');
    const expected = expectedToolNames.map(name => resolveDraftToolName(manifest, name));
    if (new Set(expected).size !== expected.length) fail('DUPLICATE_TOOL_NAME', 'Planned names resolve to the same command.');
    for (const name of expected) if (!names.includes(name)) fail('MISSING_PLANNED_TOOL', `Planned tool is not registered: ${name}`);
    for (const name of names) {
      if (expected.length && !expected.includes(name) && !retained.has(name.slice(manifest.name.length + 1)) && name !== `${manifest.name}.check-login-status`) fail('UNPLANNED_TOOL', `Unplanned tool is registered: ${name}`);
    }
    for (const command of pkg.commands) if (!names.includes(command.name)) fail('MISSING_REGISTERED_TOOL', `Manifest command is not registered: ${command.name}`);
    if (new Set(names).size !== names.length) fail('DUPLICATE_REGISTERED_TOOL', 'Registered tools must be unique.');
    if (evidence.format !== 2 || evidence.name !== manifest.name) fail('INVALID_GENERATION_EVIDENCE', 'Draft evidence identity differs from its package.');
    const fixtures = readGenerationEvidence(adapterDir, 'write-verification.json', { optional: true });
    for (const command of manifest.commands) {
      if (retained.has(command.id)) continue;
      const source = pkg.files.get(command.module).toString('utf8');
      const origin = evidence.commands?.[command.id];
      if (!origin) fail('MISSING_GENERATION_EVIDENCE', `Missing source binding: ${command.id}`);
      const wasWrite = origin?.safety === 'write' || origin?.generationSource?.risk?.level === 'write';
      if ((wasWrite || command.schema?.['x-webcli-requires-confirmation']) && command.safety !== 'write') fail('MISSING_WRITE_ACCESS', `Write command cannot become read-only: ${command.id}`);
      if (/\[truncated\]|\brequestBodyPreview\b|\bdefaultPayload\b/.test(source)) fail('RAW_CAPTURED_BODY_IN_GENERATED_TOOL', 'Generated command contains captured payload evidence.');
      if (command.safety === 'write') {
        if (/AGENT_AUTHORED_WRITE_REQUIRED/.test(source) || command.schema?.['x-webcli-agent-authored'] === false) fail('WRITE_AGENT_AUTHORING_REQUIRED', `Write skeleton requires semantic implementation: ${command.id}`);
        if (!/\b__confirmed\b/.test(source) || !command.schema?.['x-webcli-requires-confirmation']) fail('MISSING_WRITE_CONFIRMATION', `Write handler must enforce confirmation: ${command.id}`);
        if (!fixtures?.commands?.[command.id]) fail('MISSING_WRITE_VERIFICATION', `Missing task-side mock fixture: ${command.id}`);
      }
    }
  } catch (cause) { fail('PACKAGE_DRAFT_INVALID', cause.message); }
  return { passed: !errors.length, validator: 'adapter_static_validator_v2', errors, warnings: [], checkedFiles, packageDigest };
}
