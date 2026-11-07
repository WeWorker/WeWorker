import assert from 'node:assert/strict';
import http from 'node:http';

/** Installed HTTP write repair uses only this isolated public loopback fixture. */
export async function verifyWriteRepairs({ call, waitTask, startBridge, stopBridge, pass }) {
  const requests = [], titles = new Map(), reads = new Map();
  let drift = false, behavior = 'normal';
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, path: req.url });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer example-auth-placeholder') { res.writeHead(401); res.end('{}'); return; }
    if (req.method === 'PUT') {
      const title = JSON.parse(raw).title;
      titles.set(req.url, title); reads.set(req.url, 0);
      if (req.url === '/items/main' && behavior === 'lost') { req.socket.destroy(); return; }
      if (req.url === '/items/main' && behavior === 'hang') return;
      res.end(JSON.stringify({ ok: true, id: 731, [drift ? 'label' : 'title']: title })); return;
    }
    if (req.url === '/records/731') { res.end(JSON.stringify({ id: 731, title: titles.get('/items/main') })); return; }
    const title = titles.get(req.url) || 'Before';
    const count = (reads.get(req.url) || 0) + 1; reads.set(req.url, count);
    res.end(JSON.stringify({ id: 'example', title, state: title === 'Before' ? 'idle' : count === 1 ? 'pending' : 'ready' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = { type: 'bearer', origin, env: 'EXAMPLE_DISCOVERY_KEY' };
  const writeCount = () => requests.filter(item => item.method === 'PUT').length;
  const reset = () => { titles.set('/items/main', 'Before'); reads.set('/items/main', 0); };
  const planTool = (name, index, risk = 'write') => ({ name, risk, sourceApiKind: risk === 'write' ? 'action' : 'list', sourceApiIndexes: [index], strategy: 'AUTH_API', auth,
    ...(risk === 'write' ? { writeReason: 'Update one public fixture' } : { readReason: 'Read public fixture identity' }),
    strategyNote: { reason: 'Explicit loopback endpoint', limitations: 'Isolated public example only' } });
  async function start(label) {
    return (await call('exploration.start', { mode: 'http', origin, auth, goal: 'Verify scoped HTTP write repair', requestId: 'write-repair-' + label })).data.taskId;
  }
  async function edit(taskId, file, content) {
    const old = (await call('exploration.draft-read', { taskId, file })).data;
    await call('exploration.draft-write', { taskId, file, expectedHash: old.hash, content });
  }
  async function saveFixture(taskId, tool, fixture) {
    const old = (await call('exploration.write-verification-read', { taskId, tool })).data;
    await call('exploration.write-verification-write', { taskId, tool, fixture, expectedHash: old.hash });
  }
  const source = (url, field = 'title') => `module.exports = async (args,api) => {
    try { const value=await api.request({url:${JSON.stringify(url)},method:'PUT',json:{title:args.title}}); return {ok:value.ok,title:value.${field}}; }
    catch(error) { return {ok:false,errorCode:error.code}; }
  };`;
  const fixtureFor = (label, result = false) => ({ id: 'example-repair-' + label, representativeArgs: { title: 'After' },
    expectedRequest: { url: origin + '/items/' + label, method: 'PUT', body: { title: 'After' } },
    successResponse: { status: 200, body: { ok: true, id: 1, title: 'After' } }, successExpectation: { ok: true, title: 'After' },
    failureResponse: { status: 409, body: {} }, failureExpectation: { ok: false, errorCode: 'HTTP_STATUS' },
    effect: { readback: { url: origin + '/items/' + label }, before: { equals: { title: 'Before' } }, after: { equals: { title: 'After', state: 'ready' } },
      poll: { maxAttempts: 3, intervalMs: 250, pending: { equals: { state: 'pending' } } },
      ...(result ? { resultReadback: { url: origin + '/records/:id', publicId: true, idType: 'integer', responsePath: 'id', identityPath: 'id', expect: { equals: { title: 'After' } } } } : {}) } });
  async function install(taskId) {
    const review = (await call('exploration.review', { taskId })).data;
    await call('exploration.install', { taskId, reviewId: review.reviewId, confirmed: true }); await waitTask(taskId, 'installed');
  }
  async function saveKnowledge(taskId, site) {
    const old = (await call('exploration.knowledge-read', { site, mode: 'http' })).data;
    const saved = await call('exploration.knowledge-save', { taskId, expectedHash: old.hash });
    assert.equal(JSON.stringify(saved).includes('"id":731'), false);
  }
  try {
    const initial = await start('initial');
    await call('exploration.request', { taskId: initial, request: { url: origin + '/items/main' }, reason: 'Read public fixture identity' });
    await waitTask(initial, 'evidence_ready');
    for (const label of ['main', 'keeper']) await call('exploration.declare-write', { taskId: initial, url: origin + '/items/' + label, method: 'PUT', bodyKeys: ['title'], reason: 'Declare public fixture without writing' });
    const generated = (await call('exploration.generate', { taskId: initial, plan: { tools: [planTool('repair_main', 1), planTool('repair_keeper', 2), planTool('repair_read', 0, 'read')] } })).data;
    const [tool, keeper, reader] = generated.toolNames;
    const manifest = JSON.parse((await call('exploration.draft-read', { taskId: initial, file: 'manifest.json' })).data.content);
    const site = manifest.name;
    for (const [index, label] of ['main', 'keeper'].entries()) {
      const command = manifest.commands.find(item => `${site}.${item.id}` === generated.toolNames[index]);
      command.schema = { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' } }, 'x-webcli-agent-authored': true };
      await edit(initial, command.module, source(origin + '/items/' + label));
    }
    await edit(initial, 'manifest.json', JSON.stringify(manifest));
    await saveFixture(initial, tool, fixtureFor('main', true)); await saveFixture(initial, keeper, fixtureFor('keeper'));
    const oldRead = (await call('exploration.verification-read', { taskId: initial, tool: reader })).data;
    await call('exploration.verification-write', { taskId: initial, tool: reader, expectedHash: oldRead.hash, cases: [{ id: 'example-identity', args: {}, expect: { equals: { id: 'example' } } }] });
    await call('exploration.validate', { taskId: initial }); await waitTask(initial, 'write_review_ready');
    assert.equal(writeCount(), 0);
    let originalReview;
    for (const name of [tool, keeper]) {
      const review = (await call('exploration.write-review', { taskId: initial, tool: name })).data;
      if (name === tool) originalReview = review.reviewId;
      await call('exploration.write-verify', { taskId: initial, tool: name, reviewId: review.reviewId, confirmed: true });
      await waitTask(initial, name === keeper ? 'review_ready' : 'write_review_ready');
    }
    await install(initial); await saveKnowledge(initial, site);
    const before = (await call('exploration.repair-info', { mode: 'http', site })).data;
    const selected = before.commands.find(item => `${site}.${item.id}` === tool);
    const siblings = before.commands.filter(item => item.id !== selected.id);
    async function repair(label) {
      const info = (await call('exploration.repair-info', { mode: 'http', site })).data, taskId = await start(label);
      await call('exploration.declare-write', { taskId, url: origin + '/items/main', method: 'PUT', bodyKeys: ['title'], reason: 'Declare fresh repair source; no write replay' });
      const generated = (await call('exploration.repair', { taskId, site, expectedDigest: info.digest, plan: { tools: [planTool(selected.id, 0)] } })).data;
      assert.deepEqual(generated.repair.knowledge.importedWriteTools, [tool]);
      assert.equal((generated.writeExecutions || []).length, 0);
      return taskId;
    }
    drift = true; reset();
    const baseline = requests.length, repaired = await repair('mapping');
    const historical = (await call('exploration.write-verification-read', { taskId: repaired, tool })).data.fixture;
    historical.successResponse.body.label = historical.successResponse.body.title; delete historical.successResponse.body.title;
    await saveFixture(repaired, tool, historical);
    await call('exploration.validate', { taskId: repaired }); await waitTask(repaired, 'draft');
    assert.equal(requests.length, baseline);
    await edit(repaired, selected.module, source(origin + '/items/main', 'label'));
    await call('exploration.validate', { taskId: repaired }); await waitTask(repaired, 'write_review_ready');
    const review = (await call('exploration.write-review', { taskId: repaired, tool })).data;
    assert.equal(review.repair.authorizationInherited, false); assert.equal(review.consumed, false);
    assert.equal((await call('exploration.write-verify', { taskId: repaired, tool, reviewId: originalReview, confirmed: true }, false)).error.code, 'STALE_REVIEW');
    assert.equal((await call('exploration.write-verify', { taskId: repaired, tool, reviewId: review.reviewId, confirmed: false }, false)).error.code, 'CONFIRMATION_REQUIRED');
    assert.equal(requests.length, baseline);
    pass('HTTP write repair imports only historical fixture data; response drift fails mock without network or inherited consent');
    const writes = writeCount();
    await call('exploration.write-verify', { taskId: repaired, tool, reviewId: review.reviewId, confirmed: true });
    await waitTask(repaired, 'review_ready');
    assert.equal(writeCount(), writes + 1);
    assert.equal(requests.slice(baseline).filter(item => item.path === '/items/main' && item.method === 'GET').length, 3);
    assert.equal(requests.at(-1).path, '/records/731');
    await call('exploration.write-verify', { taskId: repaired, tool, reviewId: review.reviewId, confirmed: true });
    assert.equal(writeCount(), writes + 1);
    await install(repaired); await saveKnowledge(repaired, site);
    const after = (await call('exploration.repair-info', { mode: 'http', site })).data;
    assert.deepEqual(after.commands.filter(item => item.id !== selected.id), siblings);
    assert.notEqual(after.digest, before.digest);
    assert.equal((await call(tool, { title: 'Ordinary' })).title, 'Ordinary');
    assert.equal((await call(reader, {})).id, 'example');
    // The retained write has its own explicit ordinary call; repair validation never executes it.
    drift = false;
    assert.equal((await call(keeper, { title: 'Keeper' })).title, 'Keeper');
    drift = true;
    pass('repaired mapping verifies one write with numeric resource ID and pending GET polling; install and sibling calls pass');

    for (const label of ['cancel', 'restart', 'lost']) {
      reset(); behavior = label === 'lost' ? 'lost' : 'hang';
      const taskId = await repair(label), count = writeCount();
      await call('exploration.validate', { taskId }); await waitTask(taskId, 'write_review_ready');
      const review = (await call('exploration.write-review', { taskId, tool })).data;
      const args = { taskId, tool, reviewId: review.reviewId, confirmed: true };
      await call('exploration.write-verify', args);
      for (let i = 0; i < 50 && writeCount() === count; i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(writeCount(), count + 1);
      if (label === 'cancel') { await call('exploration.cancel', { taskId }); await waitTask(taskId, 'cancelled'); }
      if (label !== 'lost') { await stopBridge(); await startBridge(); }
      const state = label === 'lost' ? await waitTask(taskId, 'write_review_ready') : (await call('exploration.get', { taskId })).data;
      assert.equal(state.writeExecutions[0].status, 'uncertain');
      await call('exploration.write-verify', args);
      const recovery = await call('exploration.write-readback', { taskId, reviewId: review.reviewId }, false);
      // A lost response has no real ID; recovery must never substitute the fixture's numeric ID.
      assert.equal(recovery.ok, false);
      assert.equal(recovery.error.code, 'WRITE_RESULT_ID_UNAVAILABLE');
      assert.equal((await call('exploration.review', { taskId }, false)).ok, false);
      assert.equal(writeCount(), count + 1);
    }
    pass('cancel, real Bridge restart and lost repair responses retain uncertainty and never replay or guess a numeric ID');
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}
