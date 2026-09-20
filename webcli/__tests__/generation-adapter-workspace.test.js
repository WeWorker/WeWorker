import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  copyAdapterDirectorySafe,
  fingerprintDirectory,
  publishAdapterDraft,
  seedAdapterDraft,
} from '../generation-harness/index.js';

const tmpDirs = [];

function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function createPublishFixture(prefix = 'webcli-publish', nestedAdaptersPath = []) {
  const adaptersRoot = makeTmpDir(`${prefix}-adapters-`);
  const adaptersDir = nestedAdaptersPath.length > 0
    ? path.join(adaptersRoot, ...nestedAdaptersPath)
    : adaptersRoot;
  const sourceDir = path.join(adaptersDir, 'example.test');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'index.js'), 'original');
  fs.writeFileSync(path.join(adaptersDir, 'index.json'), '[]\n');
  const draftRoot = makeTmpDir(`${prefix}-draft-`);
  const workspace = seedAdapterDraft({ sourceAdapterDir: sourceDir, draftRoot, siteKey: 'example.test' });
  fs.writeFileSync(path.join(workspace.draftAdapterDir, 'index.js'), 'generated');
  return {
    adaptersDir,
    sourceDir,
    workspace,
    backupRoot: makeTmpDir(`${prefix}-backup-`),
  };
}

function publishFixture(fixture, runId = 'run-1') {
  return publishAdapterDraft({
    adaptersDir: fixture.adaptersDir,
    siteKey: 'example.test',
    draftAdapterDir: fixture.workspace.draftAdapterDir,
    expectedSourceFingerprint: fixture.workspace.sourceFingerprint,
    backupRoot: fixture.backupRoot,
    runId,
  });
}

describe('generation adapter workspace', () => {
  it('seeds existing adapter files and publishes with a verified backup', () => {
    const fixture = createPublishFixture();
    const result = publishFixture(fixture);

    expect(fs.readFileSync(path.join(result.adapterDir, 'index.js'), 'utf8')).toBe('generated');
    expect(fs.readFileSync(path.join(result.backupDir, 'index.js'), 'utf8')).toBe('original');
    expect(JSON.parse(fs.readFileSync(path.join(fixture.adaptersDir, 'index.json'), 'utf8'))).toContain('example.test');
    expect(result.publishMethod).toBe('rename');
    expect(fs.readdirSync(fixture.adaptersDir).some((name) => name.endsWith('.staging'))).toBe(false);
  });

  it('copies adapter trees without using recursive fs.cpSync', () => {
    const sourceDir = makeTmpDir('webcli-safe-copy-source-');
    const targetRoot = makeTmpDir('webcli-safe-copy-target-');
    const targetDir = path.join(targetRoot, 'adapter');
    fs.mkdirSync(path.join(sourceDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'index.js'), 'root');
    fs.writeFileSync(path.join(sourceDir, 'nested', 'tool.js'), 'nested');
    vi.spyOn(fs, 'cpSync').mockImplementation(() => {
      throw new Error('recursive fs.cpSync must not be used');
    });

    const copied = copyAdapterDirectorySafe(sourceDir, targetDir);

    expect(copied.fileCount).toBe(2);
    expect(fs.readFileSync(path.join(targetDir, 'index.js'), 'utf8')).toBe('root');
    expect(fs.readFileSync(path.join(targetDir, 'nested', 'tool.js'), 'utf8')).toBe('nested');
  });

  it('refuses symbolic links instead of following recursive directory loops', () => {
    if (process.platform === 'win32') return;
    const sourceDir = makeTmpDir('webcli-safe-copy-symlink-source-');
    const targetRoot = makeTmpDir('webcli-safe-copy-symlink-target-');
    fs.writeFileSync(path.join(sourceDir, 'index.js'), 'root');
    fs.symlinkSync(sourceDir, path.join(sourceDir, 'loop'), 'dir');

    expect(() => copyAdapterDirectorySafe(sourceDir, path.join(targetRoot, 'adapter')))
      .toThrow(/refuses symbolic link or junction/);
  });

  it('recovers when a Windows-style directory rename loses the staging directory', () => {
    if (process.platform === 'win32') return;
    const fixture = createPublishFixture('webcli-windows-rename', [
      'Documents',
      '新建文件夹',
      'WeWorker',
      'extension',
      'adapters',
    ]);
    const realRenameSync = fs.renameSync.bind(fs);
    const stagingNames = [];
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (String(source).endsWith('.staging')) {
        stagingNames.push(path.basename(source));
        fs.rmSync(source, { recursive: true, force: true });
        const error = new Error(`ENOENT: no such file or directory, rename '${source}' -> '${target}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return realRenameSync(source, target);
    });

    const result = publishFixture(fixture, 'cbc52d81-3334-418c-94ee-adc0eb46f555');

    expect(result.publishMethod).toBe('copy_fallback');
    expect(result.renameFallbackCode).toBe('ENOENT');
    expect(stagingNames[0]).toMatch(/^\.example\.test\.[a-f0-9]{16}\.staging$/);
    expect(fs.readFileSync(path.join(result.adapterDir, 'index.js'), 'utf8')).toBe('generated');
    expect(fs.readFileSync(path.join(result.backupDir, 'index.js'), 'utf8')).toBe('original');
    expect(fs.readdirSync(fixture.adaptersDir).some((name) => name.endsWith('.staging'))).toBe(false);
  });

  it('leaves the active adapter untouched when staging the draft fails', () => {
    const fixture = createPublishFixture('webcli-stage-failure');
    const realCopyFileSync = fs.copyFileSync.bind(fs);
    vi.spyOn(fs, 'copyFileSync').mockImplementation((source, target, ...args) => {
      if (String(target).includes('.staging')) {
        const error = new Error(`EIO: staging copy interrupted '${source}' -> '${target}'`);
        error.code = 'EIO';
        throw error;
      }
      return realCopyFileSync(source, target, ...args);
    });

    expect(() => publishFixture(fixture, 'run-stage-failure')).toThrow(/failed to publish adapter/);
    expect(fs.readFileSync(path.join(fixture.sourceDir, 'index.js'), 'utf8')).toBe('original');
    expect(fs.readFileSync(path.join(fixture.adaptersDir, 'index.json'), 'utf8')).toBe('[]\n');
    expect(fs.readdirSync(fixture.adaptersDir).some((name) => name.endsWith('.staging'))).toBe(false);
  });

  it('restores the previous adapter and index when both rename and copy fallback fail', () => {
    const fixture = createPublishFixture('webcli-publish-rollback');
    const targetDir = fixture.sourceDir;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      const error = new Error(`EPERM: operation not permitted, rename '${source}' -> '${target}'`);
      error.code = 'EPERM';
      throw error;
    });
    const realCopyFileSync = fs.copyFileSync.bind(fs);
    vi.spyOn(fs, 'copyFileSync').mockImplementation((source, target, ...args) => {
      if (String(source).includes('.staging') && path.resolve(path.dirname(target)) === path.resolve(targetDir)) {
        const error = new Error(`EACCES: permission denied, copy '${source}' -> '${target}'`);
        error.code = 'EACCES';
        throw error;
      }
      return realCopyFileSync(source, target, ...args);
    });

    expect(() => publishFixture(fixture, 'run-copy-failure')).toThrow(/previous adapter state was restored/);
    expect(fs.readFileSync(path.join(targetDir, 'index.js'), 'utf8')).toBe('original');
    expect(fs.readFileSync(path.join(fixture.adaptersDir, 'index.json'), 'utf8')).toBe('[]\n');
    expect(fs.readdirSync(fixture.adaptersDir).some((name) => name.endsWith('.staging'))).toBe(false);
  });

  it('rolls back the adapter when updating the adapter index fails', () => {
    const fixture = createPublishFixture('webcli-index-rollback');
    const indexPath = path.join(fixture.adaptersDir, 'index.json');
    const realWriteFileSync = fs.writeFileSync.bind(fs);
    let indexWriteFailures = 0;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((filePath, ...args) => {
      if (path.resolve(filePath) === path.resolve(indexPath) && indexWriteFailures === 0) {
        indexWriteFailures += 1;
        const error = new Error(`EACCES: permission denied, open '${filePath}'`);
        error.code = 'EACCES';
        throw error;
      }
      return realWriteFileSync(filePath, ...args);
    });

    expect(() => publishFixture(fixture, 'run-index-failure')).toThrow(/previous adapter state was restored/);
    expect(fs.readFileSync(path.join(fixture.sourceDir, 'index.js'), 'utf8')).toBe('original');
    expect(fs.readFileSync(indexPath, 'utf8')).toBe('[]\n');
  });

  it('supports publishing a new adapter and then replacing it in a later run', () => {
    const adaptersDir = makeTmpDir('webcli-new-adapter-');
    fs.writeFileSync(path.join(adaptersDir, 'index.json'), '[]\n');
    const firstDraftRoot = makeTmpDir('webcli-new-adapter-first-draft-');
    const firstWorkspace = seedAdapterDraft({
      sourceAdapterDir: path.join(adaptersDir, 'new.test'),
      draftRoot: firstDraftRoot,
      siteKey: 'new.test',
    });
    fs.mkdirSync(firstWorkspace.draftAdapterDir, { recursive: true });
    fs.writeFileSync(path.join(firstWorkspace.draftAdapterDir, 'index.js'), 'first version');
    const first = publishAdapterDraft({
      adaptersDir,
      siteKey: 'new.test',
      draftAdapterDir: firstWorkspace.draftAdapterDir,
      expectedSourceFingerprint: firstWorkspace.sourceFingerprint,
      backupRoot: makeTmpDir('webcli-new-adapter-first-backup-'),
      runId: 'new-adapter-run-1',
    });
    expect(first.backupDir).toBe('');
    expect(fs.readFileSync(path.join(first.adapterDir, 'index.js'), 'utf8')).toBe('first version');

    const secondDraftRoot = makeTmpDir('webcli-new-adapter-second-draft-');
    const secondWorkspace = seedAdapterDraft({
      sourceAdapterDir: first.adapterDir,
      draftRoot: secondDraftRoot,
      siteKey: 'new.test',
    });
    fs.writeFileSync(path.join(secondWorkspace.draftAdapterDir, 'index.js'), 'second version');
    const second = publishAdapterDraft({
      adaptersDir,
      siteKey: 'new.test',
      draftAdapterDir: secondWorkspace.draftAdapterDir,
      expectedSourceFingerprint: secondWorkspace.sourceFingerprint,
      backupRoot: makeTmpDir('webcli-new-adapter-second-backup-'),
      runId: 'new-adapter-run-2',
    });

    expect(fs.readFileSync(path.join(second.adapterDir, 'index.js'), 'utf8')).toBe('second version');
    expect(fs.readFileSync(path.join(second.backupDir, 'index.js'), 'utf8')).toBe('first version');
    expect(JSON.parse(fs.readFileSync(path.join(adaptersDir, 'index.json'), 'utf8'))).toContain('new.test');
    expect(fs.readdirSync(adaptersDir).some((name) => name.endsWith('.staging'))).toBe(false);
  });

  it('refuses to publish when the source adapter changed after draft creation', () => {
    const adaptersDir = makeTmpDir('webcli-conflict-adapters-');
    const sourceDir = path.join(adaptersDir, 'example.test');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'index.js'), 'original');
    const draftRoot = makeTmpDir('webcli-conflict-draft-');
    const workspace = seedAdapterDraft({ sourceAdapterDir: sourceDir, draftRoot, siteKey: 'example.test' });
    fs.writeFileSync(path.join(sourceDir, 'index.js'), 'changed outside harness');

    expect(() => publishAdapterDraft({
      adaptersDir,
      siteKey: 'example.test',
      draftAdapterDir: workspace.draftAdapterDir,
      expectedSourceFingerprint: workspace.sourceFingerprint,
      backupRoot: makeTmpDir('webcli-conflict-backup-'),
      runId: 'run-2',
    })).toThrow(/adapter changed/);
    expect(fingerprintDirectory(sourceDir)).not.toBe(workspace.sourceFingerprint);
  });
});
