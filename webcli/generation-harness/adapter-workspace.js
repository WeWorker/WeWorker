import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SAFE_SITE_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PUBLISH_RENAME_ATTEMPTS = 3;
const MAX_ADAPTER_COPY_FILES = 4_000;
const MAX_ADAPTER_COPY_BYTES = 256 * 1024 * 1024;
const MAX_ADAPTER_COPY_DEPTH = 32;

function assertSafeSiteKey(siteKey) {
  const value = String(siteKey || '');
  if (!SAFE_SITE_KEY_RE.test(value)) throw new Error('siteKey contains unsafe characters');
  return value;
}

function walkFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const filePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(filePath));
    else if (entry.isFile()) files.push(filePath);
  }
  return files;
}

function removeDirectory(directory) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 75,
      });
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ENOENT') {
        waitBeforeRetry(attempt + 1);
        continue;
      }
    }
    if (!fs.existsSync(directory)) return;
    waitBeforeRetry(attempt + 1);
  }
  try {
    removeDirectoryManually(directory);
  } catch (error) {
    lastError = error;
  }
  for (let attempt = 0; attempt < 4 && fs.existsSync(directory); attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 });
    } catch (error) {
      lastError = error;
    }
    if (!fs.existsSync(directory)) return;
    waitBeforeRetry(attempt + 1);
  }
  if (fs.existsSync(directory)) throw lastError || createPublishFilesystemError(`failed to remove directory: ${directory}`);
}

function removeDirectoryManually(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removeDirectoryManually(entryPath);
    } else {
      fs.rmSync(entryPath, { force: true });
    }
  }
  fs.rmdirSync(directory);
}

export function copyAdapterDirectorySafe(sourceDir, targetDir, {
  maxFiles = MAX_ADAPTER_COPY_FILES,
  maxBytes = MAX_ADAPTER_COPY_BYTES,
  maxDepth = MAX_ADAPTER_COPY_DEPTH,
} = {}) {
  const sourceRoot = path.resolve(sourceDir);
  const targetRoot = path.resolve(targetDir);
  if (targetRoot === sourceRoot || targetRoot.startsWith(`${sourceRoot}${path.sep}`)) {
    throw createPublishFilesystemError('adapter copy target must not be inside its source', {
      sourceDir: sourceRoot,
      targetDir: targetRoot,
      phase: 'safe_copy_target',
    });
  }
  const sourceStat = fs.lstatSync(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw createPublishFilesystemError(`adapter copy source is not a safe directory: ${sourceRoot}`, {
      sourceDir: sourceRoot,
      targetDir: targetRoot,
      phase: 'safe_copy_source',
    });
  }
  fs.mkdirSync(targetRoot, { recursive: true });
  const stack = [{ source: sourceRoot, target: targetRoot, depth: 0 }];
  let fileCount = 0;
  let totalBytes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > maxDepth) {
      throw createPublishFilesystemError(`adapter copy exceeded maximum depth ${maxDepth}`, {
        sourceDir: sourceRoot,
        targetDir: targetRoot,
        phase: 'safe_copy_depth',
      });
    }
    const entries = fs.readdirSync(current.source, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(current.source, entry.name);
      const targetPath = path.join(current.target, entry.name);
      const entryStat = fs.lstatSync(sourcePath);
      if (entry.isSymbolicLink() || entryStat.isSymbolicLink()) {
        throw createPublishFilesystemError(`adapter copy refuses symbolic link or junction: ${sourcePath}`, {
          sourceDir: sourceRoot,
          targetDir: targetRoot,
          unsafePath: sourcePath,
          phase: 'safe_copy_symlink',
        });
      }
      if (entry.isDirectory()) {
        fs.mkdirSync(targetPath, { recursive: true });
        stack.push({ source: sourcePath, target: targetPath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      totalBytes += entryStat.size;
      if (fileCount > maxFiles || totalBytes > maxBytes) {
        throw createPublishFilesystemError('adapter copy exceeded safety limits', {
          sourceDir: sourceRoot,
          targetDir: targetRoot,
          fileCount,
          totalBytes,
          maxFiles,
          maxBytes,
          phase: 'safe_copy_limits',
        });
      }
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
  return { fileCount, totalBytes };
}

function waitBeforeRetry(attempt) {
  if (attempt <= 0) return;
  const waitBuffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(waitBuffer), 0, 0, Math.min(250, attempt * 75));
}

function createRunToken(runId) {
  const value = String(runId || '').trim();
  if (!value) throw new Error('runId is required for adapter publishing');
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function createPublishFilesystemError(message, details = {}) {
  const error = new Error(message);
  error.code = 'ADAPTER_PUBLISH_FILESYSTEM_ERROR';
  error.details = details;
  return error;
}

function copyDirectoryVerified({ sourceDir, targetDir, expectedFingerprint, label }) {
  if (!fs.existsSync(sourceDir)) {
    throw createPublishFilesystemError(`${label} source directory disappeared: ${sourceDir}`, {
      sourceDir,
      targetDir,
      phase: label,
    });
  }
  removeDirectory(targetDir);
  copyAdapterDirectorySafe(sourceDir, targetDir);
  const sourceFingerprint = expectedFingerprint || fingerprintDirectory(sourceDir);
  const targetFingerprint = fingerprintDirectory(targetDir);
  if (sourceFingerprint === 'missing' || targetFingerprint !== sourceFingerprint) {
    throw createPublishFilesystemError(`${label} copy verification failed`, {
      sourceDir,
      targetDir,
      sourceFingerprint,
      targetFingerprint,
      phase: label,
    });
  }
  return targetFingerprint;
}

function captureFile(filePath) {
  return fs.existsSync(filePath)
    ? { exists: true, content: fs.readFileSync(filePath) }
    : { exists: false, content: null };
}

function restoreFile(filePath, snapshot) {
  if (snapshot.exists) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, snapshot.content);
  } else {
    fs.rmSync(filePath, { force: true });
  }
}

function publishStagedDirectory({ stagingDir, targetDir, draftAdapterDir, draftFingerprint }) {
  let lastRenameError = null;
  for (let attempt = 0; attempt < PUBLISH_RENAME_ATTEMPTS; attempt += 1) {
    if (fingerprintDirectory(stagingDir) !== draftFingerprint) {
      copyDirectoryVerified({
        sourceDir: draftAdapterDir,
        targetDir: stagingDir,
        expectedFingerprint: draftFingerprint,
        label: 'restage adapter draft',
      });
    }
    removeDirectory(targetDir);
    try {
      fs.renameSync(stagingDir, targetDir);
      if (fingerprintDirectory(targetDir) === draftFingerprint) {
        return { publishMethod: 'rename', renameFallbackCode: '' };
      }
      lastRenameError = createPublishFilesystemError('published adapter verification failed after rename', {
        stagingDir,
        targetDir,
        phase: 'rename_verify',
      });
    } catch (error) {
      lastRenameError = error;
      // On Windows a directory rename can report ENOENT/EPERM while antivirus,
      // indexing, or another process is briefly touching the directory. If the
      // rename actually completed, the fingerprint is the authoritative result.
      if (fingerprintDirectory(targetDir) === draftFingerprint) {
        return { publishMethod: 'rename_recovered', renameFallbackCode: error?.code || '' };
      }
    }
    removeDirectory(targetDir);
    waitBeforeRetry(attempt + 1);
  }

  // A directory rename is not dependable on every Windows filesystem. If the
  // staging directory disappeared, copy directly from the durable draft.
  const fallbackSourceDir = fingerprintDirectory(stagingDir) === draftFingerprint
    ? stagingDir
    : draftAdapterDir;
  copyDirectoryVerified({
    sourceDir: fallbackSourceDir,
    targetDir,
    expectedFingerprint: draftFingerprint,
    label: 'publish adapter copy fallback',
  });
  return {
    publishMethod: 'copy_fallback',
    renameFallbackCode: lastRenameError?.code || 'RENAME_FAILED',
  };
}

export function fingerprintDirectory(rootDir) {
  if (!fs.existsSync(rootDir)) return 'missing';
  const hash = createHash('sha256');
  for (const filePath of walkFiles(rootDir).sort()) {
    const relative = path.relative(rootDir, filePath).replace(/\\/g, '/');
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function seedAdapterDraft({ sourceAdapterDir, draftRoot, siteKey, adaptersDir = '' }) {
  const safeSiteKey = assertSafeSiteKey(siteKey);
  const draftAdapterDir = path.join(draftRoot, safeSiteKey);
  // 指纹必须在 mkdirSync(draftRoot) 之前计算：V2 证据时 sourceAdapterDir === draftRoot，
  // 先建目录会把「源不存在」(missing) 变成「空目录」(empty hash)，导致 publish 门禁误判。
  const sourceFingerprint = fingerprintDirectory(sourceAdapterDir);
  // publish 门禁的基线必须是「正式 adapters 目录下的目标」，与 seed 源解耦（V2 时源在 run 草稿目录）。
  const publishBaselineFingerprint = adaptersDir
    ? fingerprintDirectory(path.join(adaptersDir, safeSiteKey))
    : sourceFingerprint;
  const seededFromExisting = fs.existsSync(sourceAdapterDir);
  let copyStats = { fileCount: 0, totalBytes: 0 };
  fs.mkdirSync(draftRoot, { recursive: true });
  if (seededFromExisting) {
    copyStats = copyAdapterDirectorySafe(sourceAdapterDir, draftAdapterDir);
  }
  return {
    sourceFingerprint,
    publishBaselineFingerprint,
    draftAdapterDir,
    seededFromExisting,
    copyStats,
  };
}

export function preparePreviewAdapter({ adaptersDir, draftAdapterDir, runId }) {
  const token = String(runId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  if (!token) throw new Error('runId is required for preview adapter');
  const previewAdapterId = `generation_preview_${token}`;
  const previewAdapterDir = path.join(adaptersDir, previewAdapterId);
  fs.rmSync(previewAdapterDir, { recursive: true, force: true });
  copyAdapterDirectorySafe(draftAdapterDir, previewAdapterDir);
  return { previewAdapterId, previewAdapterDir };
}

export function cleanupPreviewAdapter(previewAdapterDir, adaptersDir) {
  const root = path.resolve(adaptersDir);
  const target = path.resolve(previewAdapterDir);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(target).startsWith('generation_preview_')) {
    throw new Error('refusing to clean an unsafe preview adapter path');
  }
  removeDirectory(target);
}

function updateAdapterIndex(adaptersDir, siteKey) {
  const indexPath = path.join(adaptersDir, 'index.json');
  let ids = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (Array.isArray(parsed)) ids = parsed.filter((item) => typeof item === 'string');
  } catch {}
  if (!ids.includes(siteKey)) ids.push(siteKey);
  ids = [...new Set(ids)].sort((left, right) => left.localeCompare(right));
  fs.writeFileSync(indexPath, `${JSON.stringify(ids, null, 2)}\n`, 'utf8');
  return indexPath;
}

export function publishAdapterDraft({
  adaptersDir,
  siteKey,
  draftAdapterDir,
  expectedSourceFingerprint,
  backupRoot,
  runId,
}) {
  const safeSiteKey = assertSafeSiteKey(siteKey);
  const targetDir = path.join(adaptersDir, safeSiteKey);
  const currentFingerprint = fingerprintDirectory(targetDir);
  if (currentFingerprint !== expectedSourceFingerprint) {
    const error = new Error('adapter changed after the generation draft was created; regenerate before publishing');
    error.code = 'ADAPTER_CHANGED_DURING_GENERATION';
    error.details = { expectedSourceFingerprint, currentFingerprint };
    throw error;
  }
  if (!fs.existsSync(draftAdapterDir)) {
    const error = new Error(`draft adapter directory not found: ${draftAdapterDir}`);
    error.code = 'DRAFT_NOT_FOUND';
    throw error;
  }

  fs.mkdirSync(adaptersDir, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });
  const backupDir = path.join(backupRoot, safeSiteKey);
  const stagingDir = path.join(adaptersDir, `.${safeSiteKey}.${createRunToken(runId)}.staging`);
  const indexPath = path.join(adaptersDir, 'index.json');
  const indexSnapshot = captureFile(indexPath);
  const draftFingerprint = fingerprintDirectory(draftAdapterDir);

  let targetBackedUp = false;
  let targetMutationStarted = false;
  try {
    removeDirectory(stagingDir);
    removeDirectory(backupDir);
    copyDirectoryVerified({
      sourceDir: draftAdapterDir,
      targetDir: stagingDir,
      expectedFingerprint: draftFingerprint,
      label: 'stage adapter draft',
    });
    if (fs.existsSync(targetDir)) {
      copyDirectoryVerified({
        sourceDir: targetDir,
        targetDir: backupDir,
        expectedFingerprint: currentFingerprint,
        label: 'backup current adapter',
      });
      targetBackedUp = true;
    }
    targetMutationStarted = true;
    const publication = publishStagedDirectory({
      stagingDir,
      targetDir,
      draftAdapterDir,
      draftFingerprint,
    });
    updateAdapterIndex(adaptersDir, safeSiteKey);
    return {
      adapterDir: targetDir,
      backupDir: targetBackedUp ? backupDir : '',
      indexPath,
      fingerprint: draftFingerprint,
      ...publication,
    };
  } catch (error) {
    let rollbackError = null;
    if (targetMutationStarted) {
      try {
        removeDirectory(targetDir);
        if (targetBackedUp) {
          copyDirectoryVerified({
            sourceDir: backupDir,
            targetDir,
            expectedFingerprint: currentFingerprint,
            label: 'restore previous adapter',
          });
        }
        restoreFile(indexPath, indexSnapshot);
      } catch (restoreError) {
        rollbackError = restoreError;
      }
    }
    const rollbackMessage = rollbackError
      ? `; automatic rollback also failed: ${rollbackError.message}; backup: ${backupDir}`
      : targetMutationStarted
        ? '; previous adapter state was restored'
        : '';
    const publishError = new Error(`failed to publish adapter ${safeSiteKey}: ${error.message}${rollbackMessage}`);
    publishError.code = 'ADAPTER_PUBLISH_FAILED';
    publishError.details = {
      siteKey: safeSiteKey,
      adaptersDir,
      draftAdapterDir,
      stagingDir,
      targetDir,
      backupDir: targetBackedUp ? backupDir : '',
      originalCode: error?.code || '',
      rollbackSucceeded: !rollbackError,
      rollbackError: rollbackError?.message || '',
    };
    publishError.cause = error;
    throw publishError;
  } finally {
    try {
      removeDirectory(stagingDir);
    } catch {
      // A leftover staging directory is safe and will be removed before the
      // same run publishes again. It must not hide the actual publish result.
    }
  }
}
