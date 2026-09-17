import path from 'node:path';
import { resolveAdaptersDir } from '../paths.js';
import { publishAdapterDraft } from './adapter-workspace.js';
import { verifyGeneratedWriteTools } from './write-tool-verifier.js';

export function createAdapterPublisher({ adaptersDir = resolveAdaptersDir() } = {}) {
  return async ({ run, store }) => {
    const draft = run.snapshot.artifacts?.draft;
    const workspace = run.snapshot.artifacts?.workspace;
    const validation = run.snapshot.artifacts?.staticValidation;
    if (!draft?.adapterDir) throw new Error('generation run does not contain a draft adapter');
    if (!validation?.passed) throw new Error('generation run draft has not passed static validation');
    if (!workspace?.sourceFingerprint && !workspace?.publishBaselineFingerprint) throw new Error('generation run is missing source adapter fingerprint');
    const writeVerification = await verifyGeneratedWriteTools({
      adapterDir: draft.adapterDir,
      expectedSiteKey: run.snapshot.siteKey,
    });
    if (!writeVerification.passed) {
      const error = new Error(`generation run write tools have not passed mock verification (${writeVerification.errors.length} errors)`);
      error.code = 'WRITE_VERIFICATION_REQUIRED';
      error.details = writeVerification;
      throw error;
    }
    run.setArtifact('writeVerification', writeVerification);

    const result = publishAdapterDraft({
      adaptersDir,
      siteKey: run.snapshot.siteKey,
      draftAdapterDir: draft.adapterDir,
      expectedSourceFingerprint: workspace.publishBaselineFingerprint || workspace.sourceFingerprint,
      backupRoot: path.join(store.getRunDir(run.id), 'backup'),
      runId: run.id,
    });
    run.setArtifact('publishedAdapter', result);
    return {
      siteKey: run.snapshot.siteKey,
      toolNames: draft.toolNames || [],
      ...result,
    };
  };
}
