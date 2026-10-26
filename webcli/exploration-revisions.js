import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { assertManagedFile } from './adapter-package-files.js';
import { explorationError as fail } from './exploration-commands.js';
import { readGenerationEvidence } from './generation-harness/package-inspection.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
export function explorationDraftHash(run) {
  if (!run.draft) throw fail('INVALID_STATE', 'Generate a draft before replanning.');
  // Hash bytes rather than a validated package so a broken manifest can also be
  // preserved and replaced. Include authored cases to detect concurrent edits.
  const files = [...run.draftFiles].sort().map(file => [file, hash(fs.readFileSync(assertManagedFile(run.draft.adapterDir, file)))]);
  const writes = run.plan?.tools?.some(tool => tool.risk === 'write');
  return hash(JSON.stringify({ files, plan: run.plan, verification: run.verification || {},
    ...(writes ? { writeFixtures: readGenerationEvidence(run.draft.adapterDir, 'write-verification.json', { optional: true }) } : {}) }));
}
export function archiveExplorationDraft(run, expectedHash, reason) {
  if (run.repairScope) throw fail('REPAIR_SCOPE_CHANGED', 'Source replanning currently applies to unpublished new tools. Start a separate scoped repair to change repair evidence.');
  if ((run.revisions?.length || 0) >= 20) throw fail('REVISION_LIMIT', 'This task already has 20 preserved attempts. Start a new task with its trace.');
  const draftHash = explorationDraftHash(run);
  if (expectedHash !== draftHash) throw fail('STALE_DRAFT', 'Draft or verification cases changed; read the current draftHash before replanning.');
  const revision = { revision: (run.revisions?.length || 0) + 1, at: new Date().toISOString(), reason, draftHash,
    draft: clone(run.draft), draftFiles: clone(run.draftFiles), plan: clone(run.plan), candidates: clone(run.candidates), pageSources: clone(run.pageSources || []),
    verification: clone(run.verification || {}), verificationWarnings: clone(run.verificationWarnings || {}), validation: clone(run.validation || null), runtimeSummary: clone(run.runtimeSummary || null),
    ...(run.plan?.tools?.some(tool => tool.risk === 'write') ? { writeFixtures: readGenerationEvidence(run.draft.adapterDir, 'write-verification.json', { optional: true }) } : {}),
    status: run.status, error: clone(run.error || null) };
  return [...(run.revisions || []), revision];
}
export function explorationRevisionView(revision) {
  return { revision: revision.revision, at: revision.at, reason: revision.reason, draftHash: revision.draftHash,
    status: revision.status, toolNames: revision.draft.toolNames, plan: clone(revision.plan), files: revision.draftFiles,
    verification: clone(revision.verification), verificationWarnings: clone(revision.verificationWarnings || {}), ...(revision.writeFixtures ? { writeFixtures: clone(revision.writeFixtures) } : {}),
    validation: revision.validation, runtimeValidation: revision.runtimeSummary, error: revision.error };
}
export function readExplorationRevision(run, number, file) {
  const revision = run.revisions?.find(item => item.revision === number);
  if (!revision) throw fail('REVISION_NOT_FOUND', 'Select a preserved revision from exploration.revisions.');
  if (explorationDraftHash(revision) !== revision.draftHash) throw fail('REVISION_CHANGED', 'Preserved draft files changed outside this workflow; do not treat them as historical evidence.');
  if (file === undefined) return { ...explorationRevisionView(revision), candidates: clone(revision.candidates), pageSources: clone(revision.pageSources) };
  if (!revision.draftFiles.includes(file)) throw fail('INVALID_ARGUMENT', 'File is not in this preserved revision.');
  const content = fs.readFileSync(assertManagedFile(revision.draft.adapterDir, file), 'utf8');
  return { revision: number, file, content, hash: hash(content) };
}
