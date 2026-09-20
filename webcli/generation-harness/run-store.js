import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SENSITIVE_KEY_RE = /api[_-]?key|authorization|cookie|credential|password|passwd|secret|session|ticket|token|csrf/i;
const RAW_PREVIEW_KEY_RE = /(?:output|request|response)Preview/i;
const DIAGNOSTIC_TEXT_KEY_RE = /^(?:stack)$/i;
const PATH_KEY_RE = /(?:rootDir|draftRoot|adapterDir|adapterIndex|previewAdapterDir|draftAdapterDir|filePath|manifest|supportFile|sharedRuntime|indexSnippet|integrationGuide|skill|generatedSkill|writtenSkill|knowledgeJson|knowledgeMarkdown|discoveryIndex)$/i;

function assertSafeId(value, label) {
  const text = String(value || '');
  if (!SAFE_ID_RE.test(text)) {
    throw new Error(`${label} contains unsafe characters`);
  }
  return text;
}

function looksLikeAbsolutePath(value) {
  const text = String(value || '');
  return path.isAbsolute(text)
    || /^[a-zA-Z]:[\\/]/.test(text)
    || /^\\\\[^\\]+\\[^\\]+/.test(text);
}

function publicPath(value, rootDir = '') {
  const text = String(value || '');
  if (!text || text.startsWith('<run-root>/')) return text || '[path-redacted]';
  if (rootDir) {
    try {
      const relative = path.relative(path.resolve(rootDir), path.resolve(text));
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return `<run-root>/${relative.split(path.sep).join('/')}`;
      }
    } catch {}
  }
  return '[path-redacted]';
}

function redactValue(value, key = '', { redactPaths = false, rootDir = '' } = {}) {
  if (SENSITIVE_KEY_RE.test(String(key))) {
    if (value == null || value === '') return value;
    return '[redacted]';
  }
  if (RAW_PREVIEW_KEY_RE.test(String(key)) && typeof value === 'string' && value.trim()) {
    return '[redacted]';
  }
  if (DIAGNOSTIC_TEXT_KEY_RE.test(String(key)) && typeof value === 'string' && value.trim()) {
    return '[redacted]';
  }
  if (
    redactPaths
    && typeof value === 'string'
    && value.trim()
    && (PATH_KEY_RE.test(String(key)) || looksLikeAbsolutePath(value))
  ) {
    return publicPath(value, rootDir);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key, { redactPaths, rootDir }));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey, { redactPaths, rootDir }),
      ]),
    );
  }
  return value;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES'].includes(error?.code)) throw error;
      if (attempt < 3) {
        const waitBuffer = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(waitBuffer), 0, 0, 50 * (attempt + 1));
      }
    }
  }
  if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(lastError?.code)) {
    fs.copyFileSync(tempPath, filePath);
    fs.rmSync(tempPath, { force: true });
    return;
  }
  throw lastError;
}

export class GenerationRunStore {
  constructor({
    rootDir = process.env.WEBCLI_GENERATION_RUNS_DIR
      || path.join(os.homedir(), '.webcli', 'generation-runs'),
  } = {}) {
    this.rootDir = path.resolve(rootDir);
  }

  _persistPath(value) {
    const text = String(value || '');
    if (!text || text.startsWith('<run-root>/')) return text || '[redacted]';
    try {
      const relative = path.relative(this.rootDir, path.resolve(text));
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return `<run-root>/${relative.split(path.sep).join('/')}`;
      }
    } catch {}
    return '[external-redacted]';
  }

  _restorePath(value) {
    const text = String(value || '');
    if (!text.startsWith('<run-root>/')) return value;
    return path.join(this.rootDir, text.slice('<run-root>/'.length));
  }

  _redactValue(value, key = '') {
    if (SENSITIVE_KEY_RE.test(String(key))) {
      if (value == null || value === '') return value;
      return '[redacted]';
    }
    if (RAW_PREVIEW_KEY_RE.test(String(key)) && typeof value === 'string' && value.trim()) {
      return '[redacted]';
    }
    if (DIAGNOSTIC_TEXT_KEY_RE.test(String(key)) && typeof value === 'string' && value.trim()) {
      return '[redacted]';
    }
    if (PATH_KEY_RE.test(String(key)) && typeof value === 'string' && value.trim()) {
      return this._persistPath(value);
    }
    if (Array.isArray(value)) return value.map((item) => this._redactValue(item, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [childKey, this._redactValue(childValue, childKey)]),
      );
    }
    return value;
  }

  _restoreValue(value, key = '') {
    if (PATH_KEY_RE.test(String(key)) && typeof value === 'string') return this._restorePath(value);
    if (Array.isArray(value)) return value.map((item) => this._restoreValue(item, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [childKey, this._restoreValue(childValue, childKey)]),
      );
    }
    return value;
  }

  getRunDir(runId) {
    return path.join(this.rootDir, assertSafeId(runId, 'runId'));
  }

  getDraftRoot(runId) {
    return path.join(this.getRunDir(runId), 'drafts');
  }

  save(snapshot) {
    const safeSnapshot = this._redactValue(snapshot);
    writeJsonAtomic(path.join(this.getRunDir(snapshot.id), 'run.json'), safeSnapshot);
    return safeSnapshot;
  }

  load(runId) {
    const filePath = path.join(this.getRunDir(runId), 'run.json');
    if (!fs.existsSync(filePath)) return null;
    return this._restoreValue(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  }

  appendTrace(runId, event) {
    const tracePath = path.join(this.getRunDir(runId), 'trace.jsonl');
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.appendFileSync(tracePath, `${JSON.stringify(this._redactValue(event))}\n`, 'utf8');
  }

  readTrace(runId) {
    const tracePath = path.join(this.getRunDir(runId), 'trace.jsonl');
    if (!fs.existsSync(tracePath)) return [];
    return fs.readFileSync(tracePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

export function sanitizeGenerationValue(value, { rootDir = '' } = {}) {
  return redactValue(value, '', { redactPaths: true, rootDir });
}
