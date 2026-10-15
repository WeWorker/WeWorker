import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { modelOutputErrorDetails } from './generation-harness/model-output-policy.js';

function formatWorkerExitCode(code, signal) {
  if (signal) return `signal ${signal}`;
  const numeric = Number(code);
  if (!Number.isFinite(numeric)) return String(code);
  return `${numeric} (0x${(numeric >>> 0).toString(16).padStart(8, '0')})`;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class LanguageModelWorkerSession {
  constructor({
    workerScript = process.argv[1],
    execPath = process.execPath,
    spawnProcess = spawn,
    reportDir = process.env.WEBCLI_AI_REPORT_DIR || '',
  } = {}) {
    this.workerScript = workerScript;
    this.execPath = execPath;
    this.spawnProcess = spawnProcess;
    this.reportDir = reportDir;
    this.session = null;
    this.closing = false;
  }

  async call(input) {
    const maxAttempts = input?.retryOnCrash === false ? 1 : 2;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.#callOnce(input);
      } catch (error) {
        lastError = error;
        if (error?.code !== 'AI_SESSION_WORKER_CRASHED' || attempt >= maxAttempts || this.closing || input?.signal?.aborted) throw error;
        process.stderr.write('[HarnessWorker] persistent AI worker crashed; restarting once\n');
      }
    }
    throw lastError || new Error('persistent AI worker failed');
  }

  async close() {
    this.closing = true;
    const session = this.session;
    if (!session || session.closed) return;
    try { session.child.stdin.end(); } catch {}
    await Promise.race([
      session.closedSignal.promise,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (!session.closed) {
      try { session.child.kill(); } catch {}
      await Promise.race([
        session.closedSignal.promise,
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
  }

  #callOnce(input) {
    const { signal, retryOnCrash: _retryOnCrash, ...request } = input;
    if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('aborted', 'AbortError'));
    if (this.closing) {
      const error = new Error('persistent AI worker session is closing');
      error.code = 'AI_SESSION_CLOSED';
      return Promise.reject(error);
    }
    const session = this.#ensureSession();
    const id = randomUUID();
    const deferred = createDeferred();
    const onAbort = () => {
      const pending = session.pending.get(id);
      if (!pending) return;
      session.pending.delete(id);
      clearTimeout(pending.timer);
      pending.cleanup();
      // Detach before killing: no subsequent request may reuse this process.
      if (this.session === session) this.session = null;
      const error = signal.reason || new DOMException('aborted', 'AbortError');
      pending.reject(error);
      this.#rejectAll(session, error);
      try { session.child.kill(); } catch {}
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      if (!session.pending.delete(id)) return;
      cleanup();
      const error = new Error(`persistent AI worker timed out for ${input?.taskLabel || 'model call'}`);
      error.code = 'AI_WORKER_TIMEOUT';
      deferred.reject(error);
      if (this.session === session) this.session = null;
      this.#rejectAll(session, error);
      try { session.child.kill(); } catch {}
    }, 150_000);
    session.pending.set(id, { ...deferred, timer, cleanup });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      session.child.stdin.write(`${JSON.stringify({ id, ...request })}\n`, (error) => {
        if (!error) return;
        const pending = session.pending.get(id);
        if (!pending) return;
        session.pending.delete(id);
        clearTimeout(pending.timer);
        pending.cleanup();
        const wrapped = new Error(`failed to write persistent AI request: ${error.message}`);
        wrapped.code = 'AI_SESSION_WORKER_CRASHED';
        pending.reject(wrapped);
      });
    } catch (error) {
      session.pending.delete(id);
      clearTimeout(timer);
      cleanup();
      error.code ||= 'AI_SESSION_WORKER_CRASHED';
      deferred.reject(error);
    }
    return deferred.promise;
  }

  #ensureSession() {
    if (this.session && !this.session.closed) return this.session;
    if (!this.workerScript) throw new Error('AI session worker entry script is unavailable');
    const execArgs = [
      '--max-old-space-size=1536',
      '--report-on-fatalerror',
      '--report-uncaught-exception',
      ...(this.reportDir ? [`--report-directory=${this.reportDir}`] : []),
      this.workerScript,
      'internal-ai-session',
    ];
    const child = this.spawnProcess(this.execPath, execArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        WEBCLI_AI_WORKER: '1',
        WEBCLI_AI_SESSION_WORKER: '1',
      },
    });
    const session = {
      child,
      pending: new Map(),
      stdout: '',
      closed: false,
      closedSignal: createDeferred(),
    };
    session.closedSignal.promise.catch(() => {});
    this.session = session;
    child.stdout.on('data', (chunk) => this.#handleStdout(session, chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') this.#handleExit(session, null, null, error);
    });
    child.on('error', (error) => this.#handleExit(session, null, null, error));
    child.on('close', (code, signal) => this.#handleExit(session, code, signal));
    return session;
  }

  #handleStdout(session, chunk) {
    session.stdout += chunk.toString();
    if (Buffer.byteLength(session.stdout, 'utf8') > 8 * 1024 * 1024) {
      const error = new Error('persistent AI worker response buffer exceeded 8MB');
      error.code = 'AI_WORKER_RESPONSE_TOO_LARGE';
      this.#rejectAll(session, error);
      try { session.child.kill(); } catch {}
      return;
    }
    while (true) {
      const newline = session.stdout.indexOf('\n');
      if (newline < 0) break;
      const line = session.stdout.slice(0, newline).trim();
      session.stdout = session.stdout.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        const wrapped = new Error(`persistent AI worker returned invalid JSON: ${error.message}`);
        wrapped.code = 'AI_WORKER_INVALID_RESPONSE';
        this.#rejectAll(session, wrapped);
        try { session.child.kill(); } catch {}
        return;
      }
      const pending = session.pending.get(message.id);
      if (!pending) continue;
      session.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.cleanup();
      if (message.ok === false) {
        const error = new Error(message.error || 'persistent AI worker request failed');
        error.code = message.code || 'AI_WORKER_REQUEST_FAILED';
        if (error.code === 'MODEL_OUTPUT_LIMIT_EXCEEDED') error.details = modelOutputErrorDetails(message.details);
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #handleExit(session, code, signal, cause = null) {
    if (session.closed) return;
    session.closed = true;
    if (this.session === session) this.session = null;
    const error = cause || new Error(`persistent AI worker exited: ${formatWorkerExitCode(code, signal)}`);
    error.code = 'AI_SESSION_WORKER_CRASHED';
    error.details = { code, signal };
    this.#rejectAll(session, error);
    session.closedSignal.resolve({ code, signal });
  }

  #rejectAll(session, error) {
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(error);
    }
    session.pending.clear();
  }
}
