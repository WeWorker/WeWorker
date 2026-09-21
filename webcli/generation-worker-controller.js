import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  GENERATION_STATUSES,
  TERMINAL_GENERATION_STATUSES,
} from './generation-harness/constants.js';
import { GenerationRun } from './generation-harness/generation-run.js';
import { GenerationRunStore } from './generation-harness/run-store.js';
import {
  createGenerationEventTransport,
  createGenerationRunTransportSnapshot,
} from './generation-transport.js';

const WORKER_ACTIVE_STATUSES = new Set([
  GENERATION_STATUSES.CREATED,
  GENERATION_STATUSES.CONTEXT_READY,
  GENERATION_STATUSES.PLANNING,
  GENERATION_STATUSES.DRAFTING,
  GENERATION_STATUSES.STATIC_VALIDATING,
  GENERATION_STATUSES.REVISING,
  GENERATION_STATUSES.RUNTIME_VALIDATING,
  GENERATION_STATUSES.PUBLISHING,
]);

function formatProcessExitCode(code, signal) {
  if (signal) return `signal ${signal}`;
  const numeric = Number(code);
  if (!Number.isFinite(numeric)) return String(code);
  const unsigned = numeric >>> 0;
  return `${numeric} (0x${unsigned.toString(16).padStart(8, '0')})`;
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

function writeWorkerPayload(payload) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-generation-worker-'));
  const payloadPath = path.join(tempDir, 'payload.json');
  fs.writeFileSync(payloadPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { tempDir, payloadPath };
}

function cleanupWorkerPayload(session) {
  if (!session?.tempDir) return;
  try { fs.rmSync(session.tempDir, { recursive: true, force: true }); } catch {}
  session.tempDir = null;
}

export class GenerationWorkerController extends EventEmitter {
  constructor({
    store = new GenerationRunStore(),
    requestExtension,
    workerScript = process.argv[1],
    execPath = process.execPath,
    forkProcess = fork,
    reportDir = process.env.WEBCLI_GENERATION_REPORT_DIR
      || process.env.WEBCLI_AI_REPORT_DIR
      || path.join(os.homedir(), '.webcli', 'reports'),
  } = {}) {
    super();
    if (typeof requestExtension !== 'function') {
      throw new Error('GenerationWorkerController requires requestExtension');
    }
    this.store = store;
    this.requestExtension = requestExtension;
    this.workerScript = workerScript;
    this.execPath = execPath;
    this.forkProcess = forkProcess;
    this.reportDir = reportDir;
    this.activeWorkers = new Map();
  }

  async start(payload, { modelConfig = null } = {}) {
    const runId = randomUUID();
    const session = this.#spawn('start', { ...payload, runId }, { modelConfig });
    session.runId = runId;
    this.activeWorkers.set(runId, session);
    try {
      await session.command.promise;
    } catch (error) {
      await Promise.race([
        session.closedSignal.promise,
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      const failed = this.store.load(runId);
      if (failed && !WORKER_ACTIVE_STATUSES.has(failed.status)) {
        return createGenerationRunTransportSnapshot(failed, { rootDir: this.store.rootDir });
      }
      throw error;
    }
    cleanupWorkerPayload(session);
    const run = this.store.load(runId);
    if (!run) throw new Error(`generation worker did not persist run: ${runId}`);
    return createGenerationRunTransportSnapshot(run, { rootDir: this.store.rootDir });
  }

  get(runId) {
    const id = String(runId || '');
    const snapshot = this.store.load(id);
    if (!snapshot) return null;
    if (this.activeWorkers.has(id) || !WORKER_ACTIVE_STATUSES.has(snapshot.status)) {
      return createGenerationRunTransportSnapshot(snapshot, { rootDir: this.store.rootDir });
    }
    return createGenerationRunTransportSnapshot(this.#failPersistedRun(
      id,
      'GENERATION_WORKER_INTERRUPTED',
      'generation run was interrupted because its Harness worker is no longer running',
    ), { rootDir: this.store.rootDir });
  }

  getTrace(runId) {
    return this.store.readTrace(String(runId || ''));
  }

  async cancel(runId, reason = 'cancelled by user') {
    const id = String(runId || '');
    const session = this.activeWorkers.get(id);
    if (session) {
      session.cancelRequested = true;
      try {
        await this.#sendCommand(session, 'cancel', { runId: id, reason }, 2_000);
      } catch {
        try { session.child.kill(); } catch {}
        await Promise.race([
          session.closedSignal.promise,
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
        return createGenerationRunTransportSnapshot(this.#cancelPersistedRun(id, reason), { rootDir: this.store.rootDir });
      }
      const killTimer = setTimeout(() => {
        if (!session.closed) {
          try { session.child.kill(); } catch {}
        }
      }, 2_000);
      killTimer.unref?.();
      return createGenerationRunTransportSnapshot(this.store.load(id), { rootDir: this.store.rootDir });
    }
    return createGenerationRunTransportSnapshot(this.#cancelPersistedRun(id, reason), { rootDir: this.store.rootDir });
  }

  async publish(runId) {
    const id = String(runId || '');
    if (this.activeWorkers.has(id)) throw new Error(`generation run is still active: ${id}`);
    const snapshot = this.store.load(id);
    if (!snapshot) throw new Error(`generation run not found: ${id}`);
    if (snapshot.status !== GENERATION_STATUSES.AWAITING_APPROVAL) {
      throw new Error(`generation run is not awaiting approval: ${snapshot.status}`);
    }
    const session = this.#spawn('publish', { runId: id });
    session.runId = id;
    this.activeWorkers.set(id, session);
    await session.command.promise;
    cleanupWorkerPayload(session);
    await session.completion.promise;
    const run = this.store.load(id);
    if (!run) throw new Error(`generation run not found: ${id}`);
    return createGenerationRunTransportSnapshot(run, { rootDir: this.store.rootDir });
  }

  async resume(runId, answer, { modelConfig = null } = {}) {
    const id = String(runId || '');
    if (this.activeWorkers.has(id)) throw new Error(`generation run is still active: ${id}`);
    const snapshot = this.store.load(id);
    if (!snapshot) throw new Error(`generation run not found: ${id}`);
    if (snapshot.status !== GENERATION_STATUSES.NEEDS_USER_INPUT) {
      throw new Error(`generation run is not awaiting user input: ${snapshot.status}`);
    }
    const session = this.#spawn('resume', { runId: id, answer: String(answer || '') }, modelConfig ? { modelConfig } : {});
    session.runId = id;
    this.activeWorkers.set(id, session);
    await session.command.promise;
    cleanupWorkerPayload(session);
    // Match start(): acknowledge the resumed run, then let the client poll.
    // Waiting for the entire model loop here exceeds the Bridge RPC deadline.
    const run = this.store.load(id);
    if (!run) throw new Error(`generation run not found: ${id}`);
    return createGenerationRunTransportSnapshot(run, { rootDir: this.store.rootDir });
  }

  #spawn(command, payload, { modelConfig = null } = {}) {
    if (!this.workerScript) throw new Error('generation worker entry script is unavailable');
    fs.mkdirSync(this.reportDir, { recursive: true });
    const { tempDir, payloadPath } = writeWorkerPayload(payload);
    const child = this.forkProcess(this.workerScript, ['internal-generation-worker'], {
      execPath: this.execPath,
      execArgv: [
        '--max-old-space-size=2048',
        '--report-on-fatalerror',
        '--report-uncaught-exception',
        `--report-directory=${this.reportDir}`,
      ],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        WEBCLI_GENERATION_WORKER: '1',
        WEBCLI_GENERATION_RUNS_DIR: this.store.rootDir,
        WEBCLI_AI_REPORT_DIR: this.reportDir,
      },
    });
    const session = {
      child,
      command: createDeferred(),
      completion: createDeferred(),
      closedSignal: createDeferred(),
      pendingCommands: new Map(),
      tempDir,
      runId: null,
      finished: false,
      closed: false,
      cancelRequested: false,
    };
    session.completion.promise.catch(() => {});
    session.closedSignal.promise.catch(() => {});
    child.stdout?.on('data', (chunk) => process.stderr.write(`[HarnessWorker] ${chunk}`));
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    child.on('message', (message) => this.#handleWorkerMessage(session, message));
    child.on('error', (error) => this.#handleWorkerError(session, error));
    child.on('close', (code, signal) => this.#handleWorkerClose(session, code, signal));
    const requestId = randomUUID();
    session.pendingCommands.set(requestId, session.command);
    session.commandTimer = setTimeout(() => {
      if (!session.pendingCommands.delete(requestId)) return;
      const error = new Error(`generation worker ${command} command timed out`);
      error.code = 'GENERATION_WORKER_START_TIMEOUT';
      session.command.reject(error);
      try { child.kill(); } catch {}
    }, 25_000);
    session.commandTimer.unref?.();
    try {
      child.send({
        type: 'command',
        requestId,
        command,
        payloadPath,
        ...(modelConfig ? { modelConfig } : {}),
      });
    } catch (error) {
      session.pendingCommands.delete(requestId);
      session.command.reject(error);
    }
    return session;
  }

  #sendCommand(session, command, payload, timeoutMs) {
    const deferred = createDeferred();
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      if (!session.pendingCommands.delete(requestId)) return;
      deferred.reject(new Error(`generation worker ${command} command timed out`));
    }, timeoutMs);
    deferred.promise.finally(() => clearTimeout(timer)).catch(() => {});
    session.pendingCommands.set(requestId, deferred);
    try {
      session.child.send({ type: 'command', requestId, command, payload });
    } catch (error) {
      session.pendingCommands.delete(requestId);
      deferred.reject(error);
    }
    return deferred.promise;
  }

  #handleWorkerMessage(session, message) {
    if (message?.type === 'response') {
      const pending = session.pendingCommands.get(message.requestId);
      if (!pending) return;
      session.pendingCommands.delete(message.requestId);
      if (pending === session.command) clearTimeout(session.commandTimer);
      if (message.ok === false) {
        const error = new Error(message.error || 'generation worker request failed');
        error.code = message.code || 'GENERATION_WORKER_REQUEST_FAILED';
        pending.reject(error);
      } else {
        if (message.runId) session.runId = message.runId;
        pending.resolve(message);
      }
      return;
    }
    if (message?.type === 'event') {
      const runId = String(message.event?.runId || session.runId || '');
      const snapshot = runId ? this.store.load(runId) : null;
      if (snapshot) {
        this.emit(
          'event',
          message.event,
          createGenerationRunTransportSnapshot(snapshot, { rootDir: this.store.rootDir }),
        );
      }
      return;
    }
    if (message?.type === 'extension_request') {
      void this.#handleExtensionRequest(session, message);
      return;
    }
    if (message?.type === 'finished') {
      session.finished = true;
      session.runId = message.runId || session.runId;
      if (this.activeWorkers.get(session.runId) === session) this.activeWorkers.delete(session.runId);
      session.completion.resolve(this.store.load(session.runId));
    }
  }

  async #handleExtensionRequest(session, message) {
    try {
      const requestedTimeout = Number(message.timeout);
      const timeout = Number.isFinite(requestedTimeout)
        ? Math.max(1_000, Math.min(requestedTimeout, 120_000))
        : 60_000;
      const result = await this.requestExtension(message.request, timeout);
      if (session.child.connected) {
        session.child.send({ type: 'extension_response', requestId: message.requestId, ok: true, result });
      }
    } catch (error) {
      if (session.child.connected) {
        session.child.send({
          type: 'extension_response',
          requestId: message.requestId,
          ok: false,
          error: error?.message || String(error),
          code: error?.code,
        });
      }
    }
  }

  #handleWorkerError(session, error) {
    clearTimeout(session.commandTimer);
    for (const pending of session.pendingCommands.values()) {
      pending.reject(error);
    }
    session.pendingCommands.clear();
  }

  #handleWorkerClose(session, code, signal) {
    session.closed = true;
    session.closedSignal.resolve({ code, signal });
    clearTimeout(session.commandTimer);
    cleanupWorkerPayload(session);
    for (const pending of session.pendingCommands.values()) {
      pending.reject(new Error(`Harness worker exited: ${formatProcessExitCode(code, signal)}`));
    }
    session.pendingCommands.clear();
    const ownsRun = this.activeWorkers.get(session.runId) === session;
    if (ownsRun) this.activeWorkers.delete(session.runId);
    if (!session.finished && !session.cancelRequested && session.runId && ownsRun) {
      const exit = formatProcessExitCode(code, signal);
      process.stderr.write(
        `[HarnessWorker] exited unexpectedly (${exit}); Bridge remains active; fatal reports: ${this.reportDir}\n`,
      );
      const run = this.#failPersistedRun(
        session.runId,
        'GENERATION_WORKER_CRASHED',
        `Harness worker crashed: ${exit}`,
        { code, signal, reportDir: this.reportDir },
      );
      session.completion.resolve(run);
      return;
    }
    if (!session.finished && session.cancelRequested && session.runId) {
      session.completion.resolve(this.store.load(session.runId));
      return;
    }
    if (!session.finished) {
      session.completion.reject(new Error(`Harness worker exited before creating a run: ${formatProcessExitCode(code, signal)}`));
    }
  }

  #failPersistedRun(runId, code, message, details) {
    const snapshot = this.store.load(runId);
    if (!snapshot || !WORKER_ACTIVE_STATUSES.has(snapshot.status)) return snapshot;
    const run = GenerationRun.restore({
      store: this.store,
      snapshot,
      onEvent: (event, nextSnapshot) => {
        this.emit(
          'event',
          createGenerationEventTransport(event),
          createGenerationRunTransportSnapshot(nextSnapshot, { rootDir: this.store.rootDir }),
        );
      },
    });
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return run.fail(error);
  }

  #cancelPersistedRun(runId, reason) {
    const snapshot = this.store.load(runId);
    if (!snapshot) return null;
    if (TERMINAL_GENERATION_STATUSES.has(snapshot.status)) return snapshot;
    const run = GenerationRun.restore({
      store: this.store,
      snapshot,
      onEvent: (event, nextSnapshot) => {
        this.emit(
          'event',
          createGenerationEventTransport(event),
          createGenerationRunTransportSnapshot(nextSnapshot, { rootDir: this.store.rootDir }),
        );
      },
    });
    return run.cancel(reason);
  }
}

export { WORKER_ACTIVE_STATUSES, formatProcessExitCode };
