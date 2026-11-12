import assert from 'node:assert/strict';
import http from 'node:http';

/** Shared real CLI acceptance; all writes and retained IDs belong to this loopback fixture. */
export async function verifyWriteResults({ call, startBridge, stopBridge, pass, page = false }) {
  const requests = [], resources = new Map(), states = new Map(), keys = new Map(), released = new Set(), pendingReads = new Map(), navigated = new Set();
  const polling = label => label.startsWith('poll');
  const waiting = (label, resource = false) => {
    if (!polling(label) || released.has(label)) return false;
    if (label !== 'pollsuccess') return true;
    // Both endpoints must actually be observed pending, even on slow machines.
    const key = `${label}:${resource}`, count = (pendingReads.get(key) || 0) + 1;
    pendingReads.set(key, count);
    return count <= 2;
  };
  let serial = 0;
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/navigation-status/pollnavigate') {
      const navigate = !navigated.has('pollnavigate') && requests.filter(r => r.pathname === '/items/pollnavigate' && r.method === 'GET').length >= 2;
      if (navigate) navigated.add('pollnavigate');
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ navigate })); return;
    }
    if (pathname.startsWith('/editor/')) {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'example_result_session=example-placeholder; HttpOnly; SameSite=Strict; Path=/' });
      res.end('<!doctype html><title>Public example result IDs</title>' + (pathname.endsWith('/pollnavigate')
        ? '<script>setInterval(async()=>{if((await (await fetch("/navigation-status/pollnavigate")).json()).navigate)location.reload();},100);</script>' : '')); return;
    }
    if (!pathname.startsWith('/items/') && !pathname.startsWith('/records/') && pathname !== '/unintended') { res.writeHead(404); res.end(); return; }
    requests.push({ method: req.method, pathname, at: Date.now() });
    res.setHeader('content-type', 'application/json');
    if (page ? !req.headers.cookie?.includes('example_result_session=example-placeholder') : req.headers.authorization !== 'Bearer example-auth-placeholder') {
      res.writeHead(401); res.end('{}'); return;
    }
    const label = pathname.split('/').pop();
    if (pathname.startsWith('/records/')) {
      const record = resources.get(decodeURIComponent(label));
      if (!record) { res.writeHead(404); res.end('{}'); return; }
      if (record.label === 'redirect') { res.writeHead(307, { location: '/unintended' }); res.end(); return; }
      if (['stopped', 'restart'].includes(record.label) && !released.has(record.label)) return;
      res.end(JSON.stringify({ id: record.label === 'wrongidentity' ? 'another-id' : record.label === 'wrongtype' ? String(record.id) : record.id,
        title: record.label === 'wrongcontent' ? 'Different' : record.title, ...(polling(record.label) ? { state: waiting(record.label, true) ? 'pending' : 'ready' } : {}) })); return;
    }
    if (req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const key = label + ':' + (req.headers['idempotency-key'] || 'http');
      if (page) assert.ok(req.headers['idempotency-key']);
      let id = keys.get(key);
      if (!keys.has(key)) {
        id = label === 'numeric' ? 0 : label === 'unsafeinteger' ? Number.MAX_SAFE_INTEGER + 1 : polling(label) || label === 'wrongtype' ? ++serial : '007示例-' + (++serial); keys.set(key, id);
        resources.set(String(id), { id, label, title: JSON.parse(raw).title }); states.set(label, 'After');
      }
      if (label === 'lost') { req.socket.destroy(); return; }
      res.end(JSON.stringify({ ok: true, title: 'After', item: { ...(label === 'missing' ? {} : { id: label === 'unsafe' ? '../unintended' : id }) }, extra: 'example-result-body-not-retained' })); return;
    }
    res.end(JSON.stringify({ title: states.get(label) || 'Before', ...(polling(label) ? { state: !states.has(label) ? 'idle' : waiting(label) ? 'pending' : 'ready' } : {}) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const writes = label => requests.filter(r => r.method === 'POST' && r.pathname === '/items/' + label).length;
  async function settle(taskId) {
    for (let i = 0; i < 200; i++) {
      const state = (await call('exploration.get', { taskId })).data;
      if (!['collecting', 'validating', 'verifying_write', 'installing'].includes(state.status)) return state;
      await pause();
    }
    throw new Error('Result readback task did not settle');
  }
  async function draft(label) {
    const tabId = page ? (await call('browser.open', { session: 'example-result-' + label, url: origin + '/editor/' + label })).data.tabId : undefined;
    const taskId = (await call('exploration.start', { ...(page ? { tabId } : { mode: 'http', origin }), requestId: 'example-result-' + label, goal: 'Create a public example and verify its returned identity' })).data.taskId;
    await settle(taskId);
    const url = origin + '/items/' + label;
    await call('exploration.declare-write', { taskId, url, method: 'POST', bodyKeys: ['title'], reason: 'Explicit public loopback creation fixture' });
    const evidence = (await call('exploration.evidence', { taskId })).data;
    const index = evidence.candidates.findIndex(c => c.url === url && c.method === 'POST');
    const toolPlan = { name: 'result_' + label, risk: 'write', sourceApiKind: 'action', sourceApiIndexes: [index], writeReason: 'Create one public example',
      strategyNote: { reason: 'Explicit authenticated fixture', alternatives: 'No UI submission control', limitations: 'Single write and fixed-origin result readback' },
      ...(page ? { strategy: 'PAGE_FETCH', pagePathname: '/editor/' + label, bodyParameters: { title: 'title' }, idempotency: { header: 'idempotency-key', serverDeduplicates: true } }
        : { strategy: 'AUTH_API', auth: { type: 'bearer', origin, env: 'EXAMPLE_DISCOVERY_KEY' } }) };
    const generated = (await call('exploration.generate', { taskId, plan: { tools: [toolPlan] } })).data, tool = generated.toolNames[0];
    if (!page) {
      async function edit(file, content) {
        const old = (await call('exploration.draft-read', { taskId, file })).data;
        await call('exploration.draft-write', { taskId, file, content, expectedHash: old.hash });
      }
      const manifest = JSON.parse((await call('exploration.draft-read', { taskId, file: 'manifest.json' })).data.content);
      const command = manifest.commands.find(c => tool === manifest.name + '.' + c.id);
      command.schema = { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string' } }, 'x-webcli-agent-authored': true };
      await edit('manifest.json', JSON.stringify(manifest));
      await edit(command.module, `module.exports=async(args,api)=>{try {const response=await api.request({url:${JSON.stringify(url)},method:'POST',json:{title:args.title}});return {ok:response.ok,title:response.title};}catch(error){return {ok:false,errorCode:error.code};}};`);
    }
    const fixture = { id: 'example-result-' + label, representativeArgs: { title: 'After' }, expectedRequest: { url, method: 'POST', body: { title: 'After' } },
      successResponse: { status: 201, body: { ok: true, title: 'After', item: { id: 'example-mock-id' } } }, successExpectation: { ok: true, title: 'After' },
      failureResponse: { status: 409, body: {} }, failureExpectation: { ok: false, errorCode: page ? 'PAGE_WRITE_HTTP_STATUS' : 'HTTP_STATUS' },
      effect: { readback: { url }, before: { equals: { title: 'Before' } }, after: { equals: { title: 'After' } },
        resultReadback: { url: origin + '/records/:id', publicId: true, responsePath: 'item.id', identityPath: 'id', expect: { equals: { title: 'After' } } } } };
    if (['numeric', 'wrongtype', 'unsafeinteger'].includes(label) || polling(label)) {
      fixture.successResponse.body.item.id = 1;
      fixture.effect.resultReadback.idType = 'integer';
    }
    if (polling(label)) {
      fixture.effect.after.equals.state = 'ready'; fixture.effect.resultReadback.expect.equals.state = 'ready';
      fixture.effect.poll = { intervalMs: ['pollstopped', 'pollrestart', 'pollnavigate'].includes(label) ? 3000 : 250, maxAttempts: label === 'pollexhausted' ? 2 : 10,
        pending: { equals: { state: 'pending' } }, resultPending: { equals: { state: 'pending' } } };
    }
    const current = (await call('exploration.write-verification-read', { taskId, tool })).data;
    await call('exploration.write-verification-write', { taskId, tool, fixture, expectedHash: current.hash });
    const before = requests.length;
    await call('exploration.validate', { taskId }); assert.equal((await settle(taskId)).status, 'write_review_ready');
    const review = (await call('exploration.write-review', { taskId, tool })).data;
    assert.equal(review.fixture.effect.resultReadback.url, origin + '/records/:id');
    assert.equal(requests.length, before);
    return { taskId, tool, reviewId: review.reviewId, confirmed: true };
  }
  try {
    const args = await draft('success');
    assert.equal((await call('exploration.write-verify', { ...args, confirmed: false }, false)).error.code, 'CONFIRMATION_REQUIRED');
    await call('exploration.write-verify', args); const state = await settle(args.taskId);
    assert.equal(state.status, 'review_ready', JSON.stringify(state));
    assert.deepEqual(requests.map(r => r.method), ['GET', 'POST', 'GET', 'GET']);
    assert.equal(requests.at(-1).pathname, '/records/007%E7%A4%BA%E4%BE%8B-1');
    assert.doesNotMatch(JSON.stringify(state), /007示例|example-result-body-not-retained/);
    await stopBridge(); await startBridge();
    assert.equal((await call('exploration.write-readback', { taskId: args.taskId, reviewId: args.reviewId })).data.passed, true);
    await call('exploration.write-verify', args); assert.equal(writes('success'), 1);
    const review = (await call('exploration.review', { taskId: args.taskId })).data;
    await call('exploration.install', { taskId: args.taskId, reviewId: review.reviewId, confirmed: true }); assert.equal((await settle(args.taskId)).status, 'installed');
    const knowledgeArgs = { ...(page ? {} : { mode: 'http' }), site: '127.0.0.1' };
    const knowledge = (await call('exploration.knowledge-read', knowledgeArgs)).data;
    const saved = await call('exploration.knowledge-save', { taskId: args.taskId, expectedHash: knowledge.hash });
    assert.doesNotMatch(JSON.stringify(saved), /007示例|example-result-body-not-retained/);
    pass('result ID: real creation, preserved Unicode/leading zeros, exact resource identity/content, restart readback, installation and knowledge');

    for (const label of ['missing', 'unsafe', 'wrongidentity', 'wrongcontent', 'redirect', 'lost']) {
      const next = await draft(label);
      const before = requests.length;
      await call('exploration.write-verify', next); const failed = await settle(next.taskId);
      assert.equal(failed.writeExecutions[0].status, 'uncertain', JSON.stringify(failed));
      if (['missing', 'unsafe', 'lost'].includes(label)) {
        assert.equal(requests.slice(before).some(r => r.pathname.startsWith('/records/')), false);
        assert.equal((await call('exploration.write-readback', { taskId: next.taskId, reviewId: next.reviewId }, false)).error.code, 'WRITE_RESULT_ID_UNAVAILABLE');
      }
      const count = writes(label); await call('exploration.write-verify', next); assert.equal(writes(label), count);
      assert.equal((await call('exploration.review', { taskId: next.taskId }, false)).error.code, 'VALIDATION_REQUIRED');
      assert.equal([...resources.values()].filter(record => record.label === label).length, 1);
    }
    assert.equal(requests.some(r => r.pathname === '/unintended' || r.pathname.endsWith('example-mock-id')), false);
    pass('result ID: missing/unsafe/lost responses never guess a URL; wrong identity/content and detail redirects cannot certify; no write replay');

    for (const label of ['stopped', 'restart']) {
      const next = await draft(label);
      await call('exploration.write-verify', next);
      const isReading = () => requests.some(r => r.pathname.startsWith('/records/') && resources.get(decodeURIComponent(r.pathname.split('/').pop()))?.label === label);
      for (let i = 0; i < 100 && !isReading(); i++) await pause();
      assert.equal(isReading(), true, 'must reach actual detail GET before interruption');
      if (label === 'stopped') await call('exploration.cancel', { taskId: next.taskId });
      await stopBridge(); released.add(label); await startBridge();
      const recovered = (await call('exploration.get', { taskId: next.taskId })).data;
      assert.equal(recovered.status, label === 'stopped' ? 'cancelled' : 'interrupted');
      assert.equal(recovered.writeExecutions[0].status, 'uncertain');
      const result = (await call('exploration.write-readback', { taskId: next.taskId, reviewId: next.reviewId })).data;
      assert.equal(result.passed, true); assert.equal(result.originalStatus, 'uncertain');
      await call('exploration.write-verify', next); assert.equal(writes(label), 1);
      assert.equal((await call('exploration.review', { taskId: next.taskId }, false)).error.code, label === 'stopped' ? 'INVALID_STATE' : 'VALIDATION_REQUIRED');
    }
    pass('result ID: cancellation and real Bridge termination after capture preserve the minimal binding; independent GET never certifies or replays');

    for (const label of ['numeric', 'pollsuccess']) {
      const next = await draft(label), before = requests.length;
      await call('exploration.write-verify', next); const state = await settle(next.taskId);
      assert.equal(state.status, 'review_ready', JSON.stringify(state));
      assert.equal(writes(label), 1);
      if (polling(label)) {
        assert.ok(state.writeExecutions[0].effectAttempts > 1);
        assert.ok(requests.slice(before).filter(r => r.pathname.startsWith('/records/')).length > 1);
      } else assert.equal(requests.at(-1).pathname, '/records/0');
      await stopBridge(); await startBridge();
      const recovered = (await call('exploration.write-readback', { taskId: next.taskId, reviewId: next.reviewId })).data;
      assert.equal(recovered.passed, true);
      const review = (await call('exploration.review', { taskId: next.taskId })).data;
      await call('exploration.install', { taskId: next.taskId, reviewId: review.reviewId, confirmed: true }); assert.equal((await settle(next.taskId)).status, 'installed');
      await call('exploration.write-verify', next); assert.equal(writes(label), 1);
    }
    pass('numeric IDs and explicit async states: strict type, zero ID, bounded GET polling, restart recovery and reviewed installation');

    for (const label of ['wrongtype', 'unsafeinteger', 'pollexhausted']) {
      const next = await draft(label), before = requests.length;
      await call('exploration.write-verify', next); const state = await settle(next.taskId);
      assert.equal(state.writeExecutions[0].status, 'uncertain', JSON.stringify(state));
      if (label === 'unsafeinteger') assert.equal(requests.slice(before).filter(r => r.pathname.startsWith('/records/')).length, 0);
      if (label === 'pollexhausted') {
        assert.equal(state.writeExecutions[0].effectAttempts, 2); released.add(label);
        assert.equal((await call('exploration.write-readback', { taskId: next.taskId, reviewId: next.reviewId })).data.passed, true);
      }
      await call('exploration.write-verify', next); assert.equal(writes(label), 1);
      assert.equal((await call('exploration.review', { taskId: next.taskId }, false)).error.code, 'VALIDATION_REQUIRED');
    }
    pass('numeric response/identity type mismatches and exhausted async states cannot certify; later matching recovery stays uncertain');

    for (const label of ['pollstopped', 'pollrestart', ...(page ? ['pollnavigate'] : [])]) {
      const next = await draft(label); await call('exploration.write-verify', next);
      const reads = () => requests.filter(r => r.pathname === '/items/' + label && r.method === 'GET').length;
      for (let i = 0; i < 100 && reads() < 2; i++) await pause();
      assert.equal(reads(), 2);
      if (label === 'pollstopped') await call('exploration.cancel', { taskId: next.taskId });
      if (label === 'pollnavigate') {
        assert.equal((await settle(next.taskId)).writeExecutions[0].status, 'uncertain');
        assert.equal(reads(), 2, 'document changed during the poll delay must prevent another GET');
      }
      await stopBridge(); await startBridge();
      const recovered = (await call('exploration.get', { taskId: next.taskId })).data;
      assert.equal(recovered.writeExecutions[0].status, 'uncertain');
      // A terminal task's independent recovery can be cancelled separately.
      if (label === 'pollstopped') {
        const reading = call('exploration.write-readback', { taskId: next.taskId, reviewId: next.reviewId }, false);
        for (let i = 0; i < 100 && reads() < 3; i++) await pause();
        await call('exploration.cancel', { taskId: next.taskId });
        assert.equal((await reading).error.code, 'WRITE_READBACK_CANCELLED'); assert.equal(reads(), 3);
      }
      released.add(label);
      const result = (await call('exploration.write-readback', { taskId: next.taskId, reviewId: next.reviewId })).data;
      assert.equal(result.passed, true); assert.equal(result.originalStatus, 'uncertain');
      await call('exploration.write-verify', next); assert.equal(writes(label), 1);
      assert.equal((await call('exploration.review', { taskId: next.taskId }, false)).error.code, label === 'pollstopped' ? 'INVALID_STATE' : 'VALIDATION_REQUIRED');
    }
    pass('async poll delay cancellation, recovery cancellation, real Bridge restart and page document guards never replay or unlock uncertain writes');
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}
