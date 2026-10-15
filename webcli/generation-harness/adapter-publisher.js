import path from 'node:path';
import { resolveAdaptersDir, resolveAdapterPaths } from '../paths.js';
import { publishAdapterDraft } from './adapter-workspace.js';
import { verifyGeneratedWriteTools } from './write-tool-verifier.js';
import { isPackageDraft, readGenerationEvidence } from './package-inspection.js';
import { verifyRetainedPackage } from './existing-site.js';
import { validateAdapterDraft } from './static-validator.js';
import { installAdapter } from '../adapter-install-store.js';
import { readPackageDirectory, adapterError } from '../adapter-package-files.js';
import { describeGeneratedInstall, resolveGeneratedInstallApproval } from './install-review.js';

export function createAdapterPublisher({ adaptersDir = resolveAdaptersDir(), paths } = {}) {
  return async ({ run, store, approval }) => {
    const draft = run.snapshot.artifacts?.draft;
    const workspace = run.snapshot.artifacts?.workspace;
    const validation = run.snapshot.artifacts?.staticValidation;
    if (!draft?.adapterDir) throw new Error('generation run does not contain a draft adapter');
    if (!validation?.passed) throw new Error('generation run draft has not passed static validation');
    const managed = isPackageDraft(draft.adapterDir);
    if ((draft.packageFormat === 2) !== managed) throw new Error('Draft package format changed; recreate its installation review.');
    if (!managed && !workspace?.sourceFingerprint && !workspace?.publishBaselineFingerprint) throw new Error('generation run is missing source adapter fingerprint');
    if (managed) {
      const revalidated = validateAdapterDraft({ adapterDir: draft.adapterDir, expectedSiteKey: run.snapshot.siteKey, expectedToolNames: draft.toolNames });
      if (!revalidated.passed || revalidated.packageDigest !== validation.packageDigest) throw new Error('Draft changed after validation; validate again before installation.');
    }
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

    if (managed) {
      const adapterPaths = paths || resolveAdapterPaths();
      const baseline = draft.managedBaseline;
      if (!baseline || baseline.name !== run.snapshot.siteKey || baseline.profile !== adapterPaths.profile) throw new Error('Generated draft has no matching profile installation baseline.');
      // Pass immutable validated bytes. Existing publication consent does not
      // silently grant additional permissions, downgrade or source changes.
      const pkg = readPackageDirectory(draft.adapterDir);
      const retention = readGenerationEvidence(draft.adapterDir);
      const expectedRetention = run.snapshot.input?.memory?.generationBaseline;
      if (expectedRetention && (retention.retainedPackage?.digest !== expectedRetention.digest || retention.retainedPackage?.name !== expectedRetention.name)) throw adapterError('RETAINED_ADAPTER_CHANGED', 'Existing package retention evidence changed.');
      verifyRetainedPackage(pkg, retention, { paths: adapterPaths });
      if (pkg.digest !== validation.packageDigest) throw new Error('Draft changed during installation review.');
      const review = describeGeneratedInstall(draft, { paths: adapterPaths, pkg });
      if (review.baselineDigest !== baseline.digest) throw adapterError('ADAPTER_BASE_CHANGED', 'Adapter changed since this draft was created.');
      run.setArtifact('installationReview', review);
      const accepted = resolveGeneratedInstallApproval(review, approval);
      const installed = installAdapter({ files: pkg.files, origin: { kind: 'generated' }, expectedSourceDigest: baseline.digest, ...accepted }, { paths: adapterPaths });
      const result = { siteKey: run.snapshot.siteKey, toolNames: draft.toolNames || [], packageFormat: 2, digest: installed.digest, version: installed.version, adapterDir: installed.dir, published: true };
      run.setArtifact('publishedAdapter', result);
      return result;
    }

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
