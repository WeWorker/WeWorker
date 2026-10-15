import fs from 'node:fs';
import path from 'node:path';
import { buildRuntimeTestCases } from './runtime-test-policy.js';
import { verifyGeneratedWriteTools } from './write-tool-verifier.js';
import { isPackageDraft, packageDraftBundle, readGenerationEvidence } from './package-inspection.js';
import { verifyRetainedPackage } from './existing-site.js';

const MAX_PREVIEW_SCRIPT_CHARS = 1_000_000;
const SAFE_PREVIEW_SCRIPT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.js$/;

function createPreviewAdapterId(runId) {
  const token = String(runId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  if (!token) throw new Error('runId is required for preview validation');
  return `generation_preview_${token}`;
}

function resolvePreviewScript(adapterDir, relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!SAFE_PREVIEW_SCRIPT_RE.test(normalized) || normalized.includes('..')) {
    throw new Error(`preview script path is not allowed: ${relativePath}`);
  }
  const root = path.resolve(adapterDir);
  const filePath = path.resolve(root, normalized);
  const relative = path.relative(root, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`preview script escapes adapter directory: ${relativePath}`);
  }
  if (!fs.existsSync(filePath)) throw new Error(`preview script not found: ${normalized}`);
  return { path: normalized, filePath };
}

function buildInlinePreviewBundle(adapterDir) {
  if (isPackageDraft(adapterDir)) {
    const { pkg, manifest, scripts } = packageDraftBundle(adapterDir);
    if (scripts.reduce((total, script) => total + script.source.length, 0) > MAX_PREVIEW_SCRIPT_CHARS) throw new Error('Preview scripts exceed size limit.');
    return { manifest, scripts, packageDigest: pkg.digest };
  }
  const manifestPath = path.join(adapterDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`preview manifest not found in draft: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const supportFiles = Array.isArray(manifest.support_files) ? manifest.support_files : [];
  const scriptPaths = [...new Set([...supportFiles, 'index.js'])];
  let totalChars = 0;
  const scripts = scriptPaths.map((relativePath) => {
    const resolved = resolvePreviewScript(adapterDir, relativePath);
    const source = fs.readFileSync(resolved.filePath, 'utf8');
    totalChars += source.length;
    if (totalChars > MAX_PREVIEW_SCRIPT_CHARS) {
      throw new Error(`preview scripts exceed ${MAX_PREVIEW_SCRIPT_CHARS} characters`);
    }
    return { path: resolved.path, source };
  });
  return { manifest, scripts };
}

export function createPreviewRuntimeValidator({ requestExtension } = {}) {
  if (typeof requestExtension !== 'function') throw new Error('runtime validator requires requestExtension');
  return async ({ run, draft, signal, plan, memory, validation }) => {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const preview = {
      previewAdapterId: createPreviewAdapterId(run.id),
      transport: 'inline_bundle',
    };
    const previewBundle = buildInlinePreviewBundle(draft.adapterDir);
    if (previewBundle.packageDigest && validation?.packageDigest && previewBundle.packageDigest !== validation.packageDigest) throw new Error('Draft changed after static validation.');
    run.setArtifact('previewAdapter', { ...preview, packageDigest: previewBundle.packageDigest || null });
    try {
      const writeVerification = await verifyGeneratedWriteTools({
        adapterDir: draft.adapterDir,
        expectedSiteKey: run.snapshot.siteKey,
      });
      run.setArtifact('writeVerification', writeVerification);
      if (!writeVerification.passed) {
        return {
          passed: false,
          validator: 'adapter_runtime_validator_v1',
          errors: writeVerification.errors,
          warnings: writeVerification.warnings || [],
          writeVerification,
        };
      }
      const registration = await requestExtension({
        type: 'validate_generation_preview',
        previewAdapterId: preview.previewAdapterId,
        previewBundle,
        siteKey: memory.siteHost || run.snapshot.siteKey,
        tabId: run.snapshot.input?.tabId,
        expectedToolNames: draft.toolNames || [],
      }, 45_000);
      if (!registration?.passed) {
        return { validator: 'adapter_runtime_validator_v1', ...registration };
      }
      const evidence = previewBundle.manifest.schema_version === 2 ? readGenerationEvidence(draft.adapterDir) : null;
      const retained = evidence ? verifyRetainedPackage(packageDraftBundle(draft.adapterDir).pkg, evidence) : new Set();
      const testCases = buildRuntimeTestCases({
        registeredTools: (registration.tools || []).filter(tool => !retained.has(tool.name.slice(previewBundle.manifest.name?.length + 1))).map(tool => {
          const source = evidence?.commands?.[tool.name.slice(previewBundle.manifest.name?.length + 1)];
          return source ? { ...tool, generationSource: source.generationSource } : tool;
        }),
        plan,
        memory,
      });
      const execution = await requestExtension({
        type: 'validate_generation_preview',
        previewAdapterId: preview.previewAdapterId,
        previewBundle,
        siteKey: memory.siteHost || run.snapshot.siteKey,
        tabId: run.snapshot.input?.tabId,
        expectedToolNames: draft.toolNames || [],
        testCases,
      }, 60_000);
      const warnings = [...(Array.isArray(execution?.warnings) ? execution.warnings : [])];
      for (const testCase of testCases) {
        if (testCase?.unverifiable) {
          warnings.push({
            code: 'TOOL_MARKED_UNVERIFIABLE',
            message: `工具 ${testCase.toolName} 已由修订标记为转人工验证，本轮跳过自动断言`,
            toolName: testCase.toolName,
          });
        }
      }
      return {
        validator: 'adapter_runtime_validator_v1',
        ...execution,
        warnings,
        registration,
        testCases,
        writeVerification,
      };
    } finally {
      run.setArtifact('previewAdapter', null);
    }
  };
}
