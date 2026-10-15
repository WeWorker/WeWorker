import fs from 'node:fs';
import path from 'node:path';
import { generationEvidenceDir } from './package-draft.js';
import { assertManagedFile } from '../adapter-package-files.js';
import { describeGeneratedInstall } from './install-review.js';

export const GENERATION_HARNESS_VERSION = 'adapter-generation-harness-v1';

export function writeGenerationHarnessProvenance({ run, draft, validation, runtimeValidation, plan }) {
  const manifestPath = draft?.files?.manifest || path.join(draft.adapterDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const provenance = {
    version: GENERATION_HARNESS_VERSION,
    mode: ['auto', 'quick'].includes(run.snapshot.input?.mode) ? run.snapshot.input.mode : 'smart',
    automatic_repair: run.snapshot.artifacts?.automaticRepair || null,
    run_id: run.id,
    generated_at: new Date().toISOString(),
    revision_count: Number(run.snapshot.revisionCount || 0),
    plan_tool_count: Array.isArray(plan?.tools) ? plan.tools.length : 0,
    static_validation: {
      passed: Boolean(validation?.passed),
      validator: validation?.validator || '',
      checked_files: Number(validation?.checkedFiles || 0),
    },
    runtime_validation: runtimeValidation ? {
      passed: Boolean(runtimeValidation.passed),
      validator: runtimeValidation.validator || '',
      attempted: Number(runtimeValidation.executionSummary?.attempted || 0),
      passed_tools: Number(runtimeValidation.executionSummary?.passed || 0),
      skipped: Number(runtimeValidation.executionSummary?.skipped || 0),
    } : null,
  };
  if (manifest.schema_version === 2) {
    run.setArtifact('installationReview', describeGeneratedInstall(draft));
    const evidenceDir = generationEvidenceDir(draft.adapterDir);
    const file = assertManagedFile(path.dirname(draft.adapterDir), `.generation/${manifest.name}/validation.json`);
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  } else {
    manifest.generation_harness = provenance;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  run.setArtifact('provenance', provenance);
  return provenance;
}
