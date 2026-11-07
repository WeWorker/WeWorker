import assert from 'node:assert/strict';
import http from 'node:http';
import { verifyWriteResults } from './write-result-acceptance.mjs';

export async function verifyExtensionWrites({ cli, record, passed, stopBridge, startBridge }) {
  const requests = [], values = new Map(), held = new Map(), deduplicated = new Map(), mutations = new Map();
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/editor/')) {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'example_page_session=example-placeholder; HttpOnly; SameSite=Strict; Path=/' });
      res.end('<!doctype html><title>Example page writes</title><h1>Public example editor</h1>'); return;
    }
    if (!url.pathname.startsWith('/items/')) { res.end(''); return; }
    const label = url.pathname.split('/').pop(); let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ label, method: req.method, body, key: req.headers['idempotency-key'] || null, authenticated: req.headers.cookie?.includes('example_page_session=example-placeholder') === true });
    res.setHeader('content-type', 'application/json');
    if (!requests.at(-1).authenticated) { res.writeHead(401); res.end('{}'); return; }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const key = req.headers['idempotency-key'];
      if (!/^[a-f0-9-]{36,64}$/.test(key || '')) { res.writeHead(400); res.end('{}'); return; }
      const identity = label + ':' + key;
      if (deduplicated.has(identity)) {
        assert.equal(deduplicated.get(identity), body);
        if (['lost', 'patchlost', 'putlost', 'fourthlost'].includes(label)) { req.socket.destroy(); return; }
        res.end(JSON.stringify({ ok: true, title: values.get(label) })); return;
      }
      deduplicated.set(identity, body);
      if (label === 'redirect') { res.writeHead(307, { location: '/items/unintended' }); res.end(); return; }
      const title = JSON.parse(body).title;
      if (label !== 'noeffect') { values.set(label, title); mutations.set(label, (mutations.get(label) || 0) + 1); }
      if (['lost', 'patchlost', 'putlost', 'fourthlost'].includes(label)) { req.socket.destroy(); return; }
      if (['stopped', 'restart'].includes(label)) { held.set(label, res); return; }
      res.end(JSON.stringify({ ok: true, title })); return;
    }
    res.end(JSON.stringify({ title: values.get(label) || 'Before' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const count = label => requests.filter(item => item.label === label && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(item.method)).length;
  async function settle(taskId) {
    for (let i = 0; i < 200; i++) {
      const state = (await cli('exploration.get', { taskId })).data;
      if (!['collecting', 'validating', 'verifying_write', 'installing'].includes(state.status)) return state;
      await pause();
    }
    throw new Error('Page write task did not settle');
  }
  async function draft(label) {
    const method = label.startsWith('patch') ? 'PATCH' : label.startsWith('put') ? 'PUT' : label.startsWith('fourth') ? 'DELETE' : 'POST';
    const tabId = (await cli('browser.open', { session: 'example-page-write-' + label, url: origin + '/editor/' + label })).data.tabId;
    const taskId = (await cli('exploration.start', { tabId, requestId: 'example-page-write-' + label, goal: 'Update a public example through the browser session' })).data.taskId;
    await settle(taskId);
    const url = origin + '/items/' + label;
    await cli('exploration.declare-write', { taskId, url, method, bodyKeys: ['title'], reason: 'Explicit loopback example mutation' });
    const evidence = (await cli('exploration.evidence', { taskId })).data;
    const index = evidence.candidates.findIndex(item => item.url === url && item.method === method);
    const plan = { tools: [{ name: 'page_write_' + label, risk: 'write', sourceApiKind: 'action', sourceApiIndexes: [index], strategy: 'PAGE_FETCH',
      pagePathname: '/editor/' + label, bodyParameters: { title: 'title' }, idempotency: { header: 'idempotency-key', serverDeduplicates: true }, writeReason: 'Update the public example title',
      strategyNote: { reason: 'The browser session authenticates this local fixture', alternatives: 'There is no public unauthenticated write endpoint or UI submit control.', limitations: 'One fixed JSON request with a separate GET' } }] };
    const generated = (await cli('exploration.generate', { taskId, plan })).data, tool = generated.toolNames[0];
    const fixture = { id: 'example-' + label, representativeArgs: { title: 'After' }, expectedRequest: { url, method, body: { title: 'After' } },
      successResponse: { status: 200, body: { ok: true, title: 'After' } }, successExpectation: { ok: true, title: 'After' },
      failureResponse: { status: 409, body: {} }, failureExpectation: { ok: false, errorCode: 'PAGE_WRITE_HTTP_STATUS' },
      effect: { readback: { url }, before: { equals: { title: 'Before' } }, after: { equals: { title: 'After' } } } };
    const old = (await cli('exploration.write-verification-read', { taskId, tool })).data;
    await cli('exploration.write-verification-write', { taskId, tool, fixture, expectedHash: old.hash });
    const before = requests.length;
    await cli('exploration.validate', { taskId }); const validated = await settle(taskId);
    assert.equal(validated.status, 'write_review_ready', JSON.stringify(validated));
    const review = (await cli('exploration.write-review', { taskId, tool })).data;
    assert.equal(requests.length, before, 'declarative mocks and review must not fetch');
    assert.equal(review.page.tabId, tabId);
    return { taskId, tool, reviewId: review.reviewId, confirmed: true };
  }
  try {
    const success = await draft('success');
    assert.equal((await cli('exploration.write-verify', { ...success, confirmed: false }, false)).error.code, 'CONFIRMATION_REQUIRED');
    assert.equal(count('success'), 0);
    await cli('exploration.write-verify', success); const verified = await settle(success.taskId);
    assert.equal(verified.status, 'review_ready', JSON.stringify(verified));
    assert.deepEqual(requests.filter(item => item.label === 'success').map(item => item.method), ['GET', 'POST', 'GET']);
    await cli('exploration.write-verify', success); assert.equal(count('success'), 1);
    passed('Extension page write: zero-request mock/review, exact confirmation, browser HttpOnly session and real before/write/after with duplicate review suppressed');
    const review = (await cli('exploration.review', { taskId: success.taskId })).data;
    assert.ok(review.permissions.some(value => value.startsWith('page-write:')));
    await cli('exploration.install', { taskId: success.taskId, reviewId: review.reviewId, confirmed: true }); assert.equal((await settle(success.taskId)).status, 'installed');

    const ordinary = await cli(success.tool, { title: '007 示例' }); assert.equal(ordinary.title, '007 示例');
    assert.equal(values.get('success'), '007 示例'); assert.equal(count('success'), 2);
    await cli(success.tool, { title: 1 }, false); assert.equal(count('success'), 2);
    const knowledge = (await cli('exploration.knowledge-read', { site: review.name })).data;
    await cli('exploration.knowledge-save', { taskId: success.taskId, expectedHash: knowledge.hash });
    assert.equal((await cli('exploration.knowledge-read', { site: review.name })).data.knowledge.commands[success.tool].writeVerification.kind, 'extension_single_write_v1');
    passed('Extension write installation, action permission, ordinary confirmation, exact string arguments and knowledge history');
    for (const label of ['lost', 'patchlost', 'putlost', 'fourthlost', 'noeffect', 'redirect']) {
      const args = await draft(label);
      await cli('exploration.write-verify', args); const state = await settle(args.taskId);
      assert.equal(state.writeExecutions[0].status, 'uncertain', JSON.stringify(state));
      const sent = count(label); await cli('exploration.write-verify', args); assert.equal(count(label), sent);
      if (['lost', 'patchlost', 'putlost', 'fourthlost'].includes(label)) { assert.equal(mutations.get(label), 1); assert.equal(new Set(requests.filter(item => item.label === label && item.method !== 'GET').map(item => item.key)).size, 1); }
      assert.equal((await cli('exploration.write-readback', { taskId: args.taskId, reviewId: args.reviewId })).data.passed, ['lost', 'patchlost', 'putlost', 'fourthlost'].includes(label));
      assert.equal((await cli('exploration.review', { taskId: args.taskId }, false)).error.code, 'VALIDATION_REQUIRED');
    }
    assert.equal(count('unintended'), 0);
    passed('Extension lost responses retain one server mutation under browser transport resends with the same key; absent effect/redirect cannot certify; independent readback works');
    const precondition = await draft('precondition'); values.set('precondition', 'Different');
    await cli('exploration.write-verify', precondition); assert.equal((await settle(precondition.taskId)).writeExecutions[0].status, 'not_dispatched');
    values.set('precondition', 'Before'); await cli('exploration.write-verify', precondition); assert.equal(count('precondition'), 0);
    passed('Extension failed before assertion consumes review without sending a mutation');
    for (const label of ['stopped', 'restart']) {
      const args = await draft(label); await cli('exploration.write-verify', args);
      for (let i = 0; i < 100 && count(label) === 0; i++) await pause(); assert.equal(count(label), 1);
      if (label === 'stopped') await cli('exploration.cancel', { taskId: args.taskId });
      await stopBridge(); await startBridge();
      held.get(label).end(JSON.stringify({ ok: true, title: 'After' }));
      const state = (await cli('exploration.get', { taskId: args.taskId })).data;
      assert.equal(state.status, label === 'stopped' ? 'cancelled' : 'interrupted');
      assert.equal(state.writeExecutions[0].status, 'uncertain');
      await cli('exploration.write-verify', args); assert.equal(count(label), 1);
      assert.equal((await cli('exploration.write-readback', { taskId: args.taskId, reviewId: args.reviewId })).data.passed, true);
    }
    assert.ok(requests.every(item => item.authenticated));
    await record('extension-write-requests', requests); await record('extension-write-verified', verified);
    passed('Extension cancellation and Bridge restart retain consumed authorization; response completion and readback never replay a write');
    await verifyWriteResults({ call: cli, startBridge, stopBridge, pass: passed, page: true });
  } finally { await record('extension-write-requests', requests); await record('extension-write-mutations', Object.fromEntries(mutations)); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}
