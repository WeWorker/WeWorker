import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { isPackageDraft, packageDraftBundle, readGenerationEvidence } from './package-inspection.js';
import { verifyRetainedPackage } from './existing-site.js';

function error(code, message, extra = {}) {
  return { code, message, severity: 'error', ...extra };
}

function subsetMatches(actual, expected) {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length
      && expected.every((value, index) => subsetMatches(actual[index], value));
  }
  return actual && typeof actual === 'object'
    && Object.entries(expected).every(([key, value]) => subsetMatches(actual[key], value));
}

function exactMatches(actual, expected) {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length
      && expected.every((value, index) => exactMatches(actual[index], value));
  }
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key, index) => key === actualKeys[index] && exactMatches(actual[key], expected[key]));
}

function safeSupportFiles(adapterDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(adapterDir, 'manifest.json'), 'utf8'));
  const root = path.resolve(adapterDir);
  return (Array.isArray(manifest.support_files) ? manifest.support_files : []).map((relativePath) => {
    const filePath = path.resolve(root, String(relativePath || ''));
    const relative = path.relative(root, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !filePath.endsWith('.js')) {
      throw new Error(`unsafe write verification support file: ${relativePath}`);
    }
    return { relativePath: String(relativePath), filePath };
  });
}

function makeResponse(spec = {}) {
  const status = Number(spec.status || 200);
  const body = spec.body ?? {};
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function normalizeObservedRequest(url, options = {}) {
  let body = options.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  return {
    method: String(options.method || 'GET').toUpperCase(),
    url: String(url),
    headers: options.headers || {},
    body: body === undefined ? null : body,
  };
}

function compareRequest(observed, expected) {
  if (!expected || typeof expected !== 'object') return false;
  if (String(observed.method) !== String(expected.method || 'GET').toUpperCase()) return false;
  if (String(observed.url) !== String(expected.url || '')) return false;
  if (!exactMatches(observed.body, expected.body ?? null)) return false;
  if (expected.headers && !subsetMatches(observed.headers, expected.headers)) return false;
  return true;
}

export async function verifyGeneratedWriteTools({ adapterDir, expectedSiteKey = '' }) {
  const errors = [];
  const cases = [];
  const requests = [];
  let responseSpec = { status: 200, body: {} };
  let window = {
    location: {
      origin: `https://${expectedSiteKey || 'example.test'}`,
      hostname: expectedSiteKey || 'example.test',
      href: `https://${expectedSiteKey || 'example.test'}/`,
    },
  };
  const sandbox = {
    window,
    document: { body: { innerText: 'authenticated' } },
    URL,
    URLSearchParams,
    console,
    structuredClone,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => {
      requests.push(normalizeObservedRequest(url, options));
      return makeResponse(responseSpec);
    },
  };
  Object.assign(sandbox, window);
  window = sandbox;
  window.window = window;
  window.document = sandbox.document;
  window.fetch = sandbox.fetch;
  const context = vm.createContext(sandbox);
  let packageWriteTools = null;

  try {
    if (isPackageDraft(adapterDir)) {
      const bundle = packageDraftBundle(adapterDir);
      const retained = verifyRetainedPackage(bundle.pkg, readGenerationEvidence(adapterDir));
      const fixtures = readGenerationEvidence(adapterDir, 'write-verification.json', { optional: true });
      const rawHandlers = new Map();
      window.__webmcpRegister = () => {};
      new vm.Script(bundle.scripts[0].source).runInContext(context, { timeout: 1000 });
      const register = window.__webcliRegisterCommand;
      window.__webcliRegisterCommand = (id, handler) => { rawHandlers.set(id, handler); register(id, handler); };
      for (const script of bundle.scripts.slice(1)) new vm.Script(script.source).runInContext(context, { timeout: 1000 });
      packageWriteTools = bundle.manifest.commands.filter(command => command.safety === 'write' && !retained.has(command.id)).map(command => ({
        name: `${bundle.manifest.name}.${command.id}`, handler: rawHandlers.get(command.id), writeVerification: fixtures?.commands?.[command.id],
      }));
    } else {
    for (const supportFile of safeSupportFiles(adapterDir)) {
      const source = fs.readFileSync(supportFile.filePath, 'utf8');
      new vm.Script(source, { filename: supportFile.relativePath }).runInContext(context);
    }
    }
  } catch (cause) {
    return {
      passed: false,
      validator: 'write_tool_mock_validator_v1',
      errors: [error('WRITE_FIXTURE_LOAD_FAILED', cause.message)],
      cases,
    };
  }

  const siteStore = window.__webmcpGeneratedSupport?.[expectedSiteKey];
  const writeTools = packageWriteTools || (Array.isArray(siteStore?.tools) ? siteStore.tools : []).filter((tool) => tool?.access === 'write');
  for (const tool of writeTools) {
    const fixture = tool.writeVerification;
    if (!fixture || typeof fixture !== 'object') {
      errors.push(error('MISSING_WRITE_VERIFICATION', `write tool ${tool.name} is missing writeVerification`, { toolName: tool.name }));
      continue;
    }
    const invalidExpectations = ['successExpectation', 'failureExpectation'].filter((key) => {
      const value = fixture[key];
      return !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0;
    });
    if (invalidExpectations.length > 0) {
      errors.push(error('INVALID_WRITE_VERIFICATION', `${tool.name} ${invalidExpectations.join(', ')} must be non-empty JSON objects matched against the result, not JavaScript expression strings`, { toolName: tool.name, fields: invalidExpectations }));
      continue;
    }
    const representativeArgs = fixture.representativeArgs && typeof fixture.representativeArgs === 'object'
      ? structuredClone(fixture.representativeArgs)
      : {};

    // The verifier, not the model-authored fixture, controls confirmation state.
    // Check both omission and explicit false so unsafe handler defaults cannot pass.
    const unconfirmedArgs = structuredClone(representativeArgs);
    delete unconfirmedArgs.__confirmed;
    let confirmationPassed = true;
    for (const args of [unconfirmedArgs, { ...structuredClone(unconfirmedArgs), __confirmed: false }]) {
      requests.length = 0;
      let blockedResult;
      try {
        blockedResult = await tool.handler(args);
      } catch (cause) {
        errors.push(error('WRITE_CONFIRMATION_GUARD_FAILED', `unconfirmed ${tool.name} threw: ${cause.message}`, { toolName: tool.name }));
        confirmationPassed = false;
        break;
      }
      if (requests.length !== 0 || blockedResult?.blocked !== true || blockedResult?.requiresConfirmation !== true) {
        errors.push(error('WRITE_IO_BEFORE_CONFIRMATION', `unconfirmed ${tool.name} must block with zero network I/O`, { toolName: tool.name, requestCount: requests.length }));
        confirmationPassed = false;
        break;
      }
    }
    if (!confirmationPassed) continue;

    requests.length = 0;
    responseSpec = fixture.successResponse || { status: 200, body: {} };
    let successResult;
    try {
      successResult = await tool.handler({ ...structuredClone(representativeArgs), __confirmed: true });
    } catch (cause) {
      errors.push(error('WRITE_SUCCESS_CASE_FAILED', `confirmed ${tool.name} success case threw: ${cause.message}`, { toolName: tool.name }));
      continue;
    }
    const observed = requests[requests.length - 1];
    if (requests.length !== Number(fixture.expectedRequestCount || 1) || !compareRequest(observed, fixture.expectedRequest)) {
      errors.push(error('WRITE_REQUEST_MISMATCH', `confirmed ${tool.name} request does not match reviewed fixture`, {
        toolName: tool.name,
        observed,
        expected: fixture.expectedRequest,
        requestCount: requests.length,
      }));
      continue;
    }
    const serializedRequest = JSON.stringify(requests);
    const forbidden = Array.isArray(fixture.forbiddenValues) ? fixture.forbiddenValues.map(String).filter(Boolean) : [];
    const leaked = forbidden.filter((value) => serializedRequest.includes(value));
    if (leaked.length > 0) {
      errors.push(error('WRITE_CAPTURED_VALUE_LEAK', `confirmed ${tool.name} request contains forbidden captured values`, { toolName: tool.name, leaked }));
      continue;
    }
    if (fixture.successExpectation && !subsetMatches(successResult, fixture.successExpectation)) {
      errors.push(error('WRITE_SUCCESS_INTERPRETATION_MISMATCH', `${tool.name} success result does not match fixture`, { toolName: tool.name }));
      continue;
    }

    if (fixture.failureResponse && fixture.failureExpectation) {
      requests.length = 0;
      responseSpec = fixture.failureResponse;
      let failureResult;
      try {
        failureResult = await tool.handler({ ...structuredClone(representativeArgs), __confirmed: true });
      } catch (cause) {
        failureResult = { ok: false, error: cause.message };
      }
      if (!subsetMatches(failureResult, fixture.failureExpectation)) {
        errors.push(error('WRITE_FAILURE_INTERPRETATION_MISMATCH', `${tool.name} failure result does not match fixture`, { toolName: tool.name }));
        continue;
      }
    }
    cases.push({ toolName: tool.name, passed: true, request: observed });
  }

  return {
    passed: errors.length === 0,
    validator: 'write_tool_mock_validator_v1',
    errors,
    warnings: [],
    cases,
    writeToolCount: writeTools.length,
  };
}
