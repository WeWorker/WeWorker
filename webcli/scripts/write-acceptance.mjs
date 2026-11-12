import assert from 'node:assert/strict';
import http from 'node:http';

/** Real processes and loopback effects; no browser, user account or remote write. */
export async function verifyHttpWrites({ call, waitTask, startBridge, stopBridge, pass }) {
  const requests = [], titles = new Map();
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer example-auth-placeholder') { res.writeHead(401); res.end('{}'); return; }
    if (req.method === 'PUT') {
      if (req.url === '/items/redirect') { res.writeHead(307, { location: '/items/other' }); res.end(); return; }
      if (req.url !== '/items/noeffect') titles.set(req.url, JSON.parse(body).title);
      if (req.url === '/items/lost') { req.socket.destroy(); return; }
      if (['/items/hang', '/items/stopped'].includes(req.url)) return;
      res.end(JSON.stringify({ ok: true, title: JSON.parse(body).title })); return;
    }
    res.end(JSON.stringify({ title: titles.get(req.url) || 'Before', extra: 'example-unpersisted-response' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const writeCount = label => requests.filter(item => item.method === 'PUT' && item.url === '/items/' + label).length;
  async function draft(label) {
    const taskId = (await call('exploration.start', { mode: 'http', origin, requestId: 'write-' + label, goal: 'Verify public example write ' + label })).data.taskId;
    const url = origin + '/items/' + label;
    await call('exploration.declare-write', { taskId, url, method: 'PUT', bodyKeys: ['title'], reason: 'Local fixture declaration without execution' });
    const evidence = (await call('exploration.evidence', { taskId })).data.candidates[0];
    assert.equal(evidence.declared, true); assert.equal(evidence.status, null);
    const generated = await call('exploration.generate', { taskId, plan: { tools: [{ name: 'write_' + label, risk: 'write', sourceApiKind: 'action', sourceApiIndexes: [0],
      strategy: 'AUTH_API', auth: { type: 'bearer', origin, env: 'EXAMPLE_DISCOVERY_KEY' }, writeReason: 'Update a public example title',
      strategyNote: { reason: 'Explicit loopback write', limitations: 'One exact request and GET effect assertions' } }] } });
    const tool = generated.data.toolNames[0];
    async function edit(file, content) {
      const old = (await call('exploration.draft-read', { taskId, file })).data;
      await call('exploration.draft-write', { taskId, file, expectedHash: old.hash, content });
    }
    const manifest = JSON.parse((await call('exploration.draft-read', { taskId, file: 'manifest.json' })).data.content);
    const command = manifest.commands.find(item => tool === manifest.name + '.' + item.id);
    command.schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false,
      'x-webcli-agent-authored': true };
    await edit('manifest.json', JSON.stringify(manifest));
    await edit(command.module, `module.exports = async (args, api) => {
      try { return await api.request({url:${JSON.stringify(url)},method:'PUT',json:{title:args.title}}); }
      catch (error) { return {ok:false,errorCode:error.code}; }
    };`);
    const fixture = { id: 'example-' + label, representativeArgs: { title: 'After' }, expectedRequest: { url, method: 'PUT', body: { title: 'After' } },
      successResponse: { status: 200, body: { ok: true, title: 'After' } }, successExpectation: { ok: true, title: 'After' },
      failureResponse: { status: 409, body: {} }, failureExpectation: { ok: false, errorCode: 'HTTP_STATUS' },
      effect: { readback: { url }, before: { equals: { title: 'Before' } }, after: { equals: { title: 'After' } } } };
    const old = await call('exploration.write-verification-read', { taskId, tool });
    await call('exploration.write-verification-write', { taskId, tool, fixture, expectedHash: old.data.hash });
    const count = requests.length;
    await call('exploration.validate', { taskId }); await waitTask(taskId, 'write_review_ready');
    const review = (await call('exploration.write-review', { taskId, tool })).data;
    assert.equal(requests.length, count);
    return { taskId, tool, reviewId: review.reviewId, confirmed: true };
  }
  try {
    const success = await draft('success');
    assert.equal(requests.length, 0);
    assert.equal((await call('exploration.write-verify', { ...success, confirmed: false }, false)).error.code, 'CONFIRMATION_REQUIRED');
    assert.equal((await call('exploration.review', { taskId: success.taskId }, false)).error.code, 'VALIDATION_REQUIRED');
    pass('write declaration, implementation, mock validation and exact review send zero network requests');
    await call('exploration.write-verify', success); await waitTask(success.taskId, 'review_ready');
    assert.deepEqual(requests.map(item => item.method), ['GET', 'PUT', 'GET']);
    await call('exploration.write-verify', success); assert.equal(writeCount('success'), 1);
    const review = await call('exploration.review', { taskId: success.taskId });
    await call('exploration.install', { taskId: success.taskId, reviewId: review.data.reviewId, confirmed: true }); await waitTask(success.taskId, 'installed');
    assert.equal((await call(success.tool, { title: 'Ordinary' })).title, 'Ordinary');
    pass('real before/write/after succeeds; duplicate review never repeats; installation and ordinary business calls work');

    for (const label of ['lost', 'noeffect', 'redirect']) {
      const args = await draft(label);
      await call('exploration.write-verify', args);
      const state = await waitTask(args.taskId, 'write_review_ready');
      assert.equal(state.writeExecutions[0].status, 'uncertain');
      await call('exploration.write-verify', args); assert.equal(writeCount(label), 1);
      assert.equal((await call('exploration.write-readback', { taskId: args.taskId, reviewId: args.reviewId })).data.passed, label === 'lost');
      assert.equal((await call('exploration.review', { taskId: args.taskId }, false)).error.code, 'VALIDATION_REQUIRED');
    }
    assert.equal(requests.filter(item => item.url === '/items/other').length, 0);
    pass('lost response, absent effect and redirect remain uncertain; independent GET works without write replay');

    for (const label of ['stopped', 'hang']) {
      const args = await draft(label);
      await call('exploration.write-verify', args);
      for (let i = 0; i < 50 && writeCount(label) === 0; i++) await pause();
      assert.equal(writeCount(label), 1);
      if (label === 'stopped') { await call('exploration.cancel', { taskId: args.taskId }); await waitTask(args.taskId, 'cancelled'); }
      await stopBridge(); await startBridge();
      const state = (await call('exploration.get', { taskId: args.taskId })).data;
      assert.equal(state.status, label === 'stopped' ? 'cancelled' : 'interrupted');
      assert.equal(state.writeExecutions[0].status, 'uncertain');
      await call('exploration.write-verify', args);
      assert.equal(writeCount(label), 1);
      assert.equal((await call('exploration.write-readback', { taskId: args.taskId, reviewId: args.reviewId })).data.passed, true);
    }
    pass('real Bridge restart and cancellation after dispatch retain uncertainty; repeated review never resends the write');
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}
