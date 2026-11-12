import assert from 'node:assert/strict';
import http from 'node:http';

// All effects are confined to this script's loopback server and owned tabs.
export async function verifyPageWriteRepairs({ cli, record, passed, stopBridge, startBridge }) {
  const requests = [], state = new Map(), resources = new Map(), reads = new Map(), keys = new Map();
  let drift = false, nextId = 100, hold = false, held, heldOnce = false;
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), parts = url.pathname.split('/'), kind = parts[2];
    if (parts[1] === 'editor') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'example_repair=example-placeholder; HttpOnly; SameSite=Strict; Path=/' });
      const suffix = drift ? '-new' : '';
      res.end(`<!doctype html><title>Public repair fixture</title>
        <form id="form${suffix}" method="post" action="/items/ui">
          <label>Title<input id="title${suffix}" name="title"></label><label>Marker<input id="marker${suffix}" name="marker"></label>
          <button id="save${suffix}" type="submit">Save</button></form><p id="receipt${suffix}" data-marker="before">Public receipt</p>
        <script>window.exampleSubmits=0;window.exampleEvents=0;
        document.addEventListener('input',()=>window.exampleEvents++);document.addEventListener('change',()=>window.exampleEvents++);
        document.querySelector('form').onsubmit=async e=>{e.preventDefault();window.exampleSubmits++;
          const body=Object.fromEntries(new FormData(e.target));try{const r=await fetch(e.target.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
          const v=await r.json();if(r.ok){const receipt=document.querySelector('p');receipt.setAttribute('data-result-id',v.id);receipt.setAttribute('data-marker',body.marker);}}catch{}};</script>`); return;
    }
    if (!['items', 'resources'].includes(parts[1])) { res.end(''); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const entry = { kind, method: req.method, path: url.pathname, body, authenticated: req.headers.cookie?.includes('example_repair=example-placeholder') === true };
    requests.push(entry); res.setHeader('content-type', 'application/json');
    if (!entry.authenticated) { res.writeHead(401); res.end('{}'); return; }
    if (req.method === 'POST') {
      const data = JSON.parse(body), title = kind === 'page' && drift ? data.label : data.title;
      if (typeof title !== 'string') { res.writeHead(409); res.end('{}'); return; }
      const key = req.headers['idempotency-key'];
      if (kind === 'page') assert.match(key || '', /^[a-f0-9-]{36,64}$/);
      if (key && keys.has(key)) { res.end(JSON.stringify(keys.get(key))); return; }
      const id = nextId++, value = { item: 'example', title, marker: data.marker };
      state.set(kind, value); resources.set(String(id), { ...value, id }); reads.set(kind, 0);
      const response = { ok: true, id, title }; if (key) keys.set(key, response);
      res.end(JSON.stringify(response)); return;
    }
    if (parts[1] === 'resources') {
      const value = resources.get(parts[2]);
      if (!value) { res.writeHead(404); res.end('{}'); return; }
      if (hold && !heldOnce) { heldOnce = true; held = { res, value }; return; }
      res.end(JSON.stringify(value)); return;
    }
    const read = (reads.get(kind) || 0) + 1; reads.set(kind, read);
    res.end(JSON.stringify({ ...(state.get(kind) || { item: 'example', title: 'Before', marker: 'before' }), status: read === 1 ? 'pending' : 'ready' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const count = kind => requests.filter(v => v.kind === kind && v.method === 'POST').length;
  async function settle(taskId) {
    for (let i = 0; i < 250; i++) { const s = (await cli('exploration.get', { taskId })).data; if (!['collecting', 'validating', 'verifying_write', 'installing'].includes(s.status)) return s; await pause(); }
    throw new Error('Repair did not settle');
  }
  const sessions = [];
  async function draft(kind, label, repair, tool) {
    const ui = kind === 'ui', session = 'example-repair-' + kind + '-' + label; sessions.push(session);
    const tabId = (await cli('browser.open', { session, url: origin + '/editor/' + kind })).data.tabId;
    const taskId = (await cli('exploration.start', { tabId, requestId: session, goal: 'Repair an isolated public write contract' })).data.taskId;
    await settle(taskId);
    const url = origin + '/items/' + kind, field = !ui && drift ? 'label' : 'title';
    await cli('exploration.declare-write', { taskId, url, method: 'POST', bodyKeys: [field, 'marker'], reason: 'Explicit public loopback contract' });
    const evidence = (await cli('exploration.evidence', { taskId })).data;
    const index = evidence.candidates.findIndex(v => v.url === url && v.method === 'POST');
    const suffix = drift ? '-new' : '';
    const plan = { tools: [{ name: tool ? tool.split('.').pop() : 'repair-' + kind, risk: 'write', strategy: ui ? 'UI_SELECTOR' : 'PAGE_FETCH', sourceApiKind: 'action', sourceApiIndexes: [index], pagePathname: '/editor/' + kind,
      ...(ui ? { uiWrite: { form: '#form' + suffix, inputMode: 'native-setter-no-events', inputs: ['title', 'marker'].map(name => ({ name, parameter: name, selector: '#' + name + suffix })), submit: { selector: '#save' + suffix, text: 'Save' }, confirmation: { selector: '#receipt' + suffix, attribute: 'data-marker', parameter: 'marker' }, result: { attribute: 'data-result-id', publicId: true, idType: 'integer' } } }
        : { bodyParameters: { [field]: 'title', marker: 'marker' }, idempotency: { header: 'idempotency-key', serverDeduplicates: true } }),
      writeReason: 'Update this isolated example', strategyNote: { reason: 'Declared current loopback page contract', alternatives: 'No external account involved', limitations: 'One submission and independent resource verification' } }] };
    const info = repair ? (await cli('exploration.repair-info', { site: tool.slice(0, tool.lastIndexOf('.')) })).data : null;
    const generated = (await cli(repair ? 'exploration.repair' : 'exploration.generate', { taskId, plan, ...(repair ? { site: info.site, expectedDigest: info.digest } : {}) })).data;
    tool = generated.toolNames[0];
    if (repair) {
      assert.deepEqual(generated.writeExecutions || [], []);
      assert.equal(generated.repair.knowledge.importedWriteTools.includes(tool), ui || label !== 'changed');
    }
    const args = { title: 'After-' + label, marker: 'marker-' + kind + '-' + label };
    const before = state.get(kind) || { item: 'example', title: 'Before', marker: 'before' };
    const fixture = { id: 'example-' + label, representativeArgs: args,
      ...(ui ? { expectedSubmission: { url, method: 'POST', body: args } } : { expectedRequest: { url, method: 'POST', body: { [field]: args.title, marker: args.marker } }, successResponse: { status: 200, body: { ok: true, id: 1, title: args.title } }, successExpectation: { ok: true, title: args.title }, failureResponse: { status: 409, body: {} }, failureExpectation: { ok: false, errorCode: 'PAGE_WRITE_HTTP_STATUS' } }),
      effect: { readback: { url }, before: { equals: before }, after: { equals: { item: 'example', ...args, status: 'ready' } },
        ...(ui ? { identityPath: 'item', argumentPaths: { title: 'title', marker: 'marker' } } : {}),
        resultReadback: { url: origin + '/resources/:id', publicId: true, idType: 'integer', responsePath: ui ? 'resultId' : 'id', identityPath: 'id', expect: { equals: { item: 'example', ...args } } },
        poll: { intervalMs: 250, maxAttempts: 8, pending: { equals: { status: 'pending' } } } } };
    const prior = (await cli('exploration.write-verification-read', { taskId, tool })).data;
    await cli('exploration.write-verification-write', { taskId, tool, fixture, expectedHash: prior.hash });
    const requestCount = requests.length;
    await cli('exploration.validate', { taskId }); const validated = await settle(taskId);
    assert.equal(validated.status, 'write_review_ready', JSON.stringify(validated));
    const review = (await cli('exploration.write-review', { taskId, tool })).data;
    assert.equal(requests.length, requestCount, 'mock and review do not send live requests');
    if (repair) assert.equal(review.repair.authorizationInherited, false);
    return { taskId, tool, reviewId: review.reviewId, session, args };
  }
  const authorization = f => ({ taskId: f.taskId, tool: f.tool, reviewId: f.reviewId });
  async function install(f) {
    const review = (await cli('exploration.review', { taskId: f.taskId })).data;
    await cli('exploration.install', { taskId: f.taskId, reviewId: review.reviewId, confirmed: true });
    assert.equal((await settle(f.taskId)).status, 'installed');
    const knowledge = (await cli('exploration.knowledge-read', { site: review.name })).data;
    await cli('exploration.knowledge-save', { taskId: f.taskId, expectedHash: knowledge.hash });
  }
  try {
    for (const kind of ['page', 'ui']) {
      drift = false; const first = await draft(kind, 'original', false);
      await cli('exploration.write-verify', { ...authorization(first), confirmed: true }); assert.equal((await settle(first.taskId)).status, 'review_ready');
      await install(first); drift = true;
      const repaired = await draft(kind, 'changed', true, first.tool), before = count(kind);
      assert.equal((await cli('exploration.write-verify', { taskId: repaired.taskId, tool: repaired.tool, reviewId: first.reviewId, confirmed: true }, false)).error.code, 'STALE_REVIEW');
      assert.equal((await cli('exploration.write-verify', authorization(repaired), false)).error.code, 'CONFIRMATION_REQUIRED');
      await cli('exploration.write-verify', { ...authorization(repaired), confirmed: true });
      const verified = await settle(repaired.taskId); assert.equal(verified.status, 'review_ready', JSON.stringify(verified));
      assert.equal(count(kind), before + 1); assert.ok(verified.writeExecutions[0].effectAttempts >= 2);
      if (kind === 'ui') assert.deepEqual((await cli('browser.eval', { session: repaired.session, expression: '({submits:window.exampleSubmits,events:window.exampleEvents})' })).data.value, { submits: 1, events: 0 });
      await install(repaired);
      const ordinary = await cli(repaired.tool, { title: 'Ordinary', marker: 'ordinary-' + kind });
      assert.equal(kind === 'ui' ? ordinary.confirmationMatched : ordinary.ok, true);
      assert.equal(state.get(kind).title, 'Ordinary'); assert.equal(count(kind), before + 2);
      await record('repair-' + kind + '-verified', verified);
      passed(kind + ' write repair: actual contract drift, fresh exact consent, numeric resource ID, pending GET, installation and ordinary call');
      // Close matching owned tabs to keep later ordinary-call routing unambiguous.
      await cli('browser.close', { session: first.session }); await cli('browser.close', { session: repaired.session });
      for (const label of ['cancelled', 'restarted']) {
        const f = await draft(kind, label, true, repaired.tool); hold = true; held = null; heldOnce = false;
        const sent = count(kind); await cli('exploration.write-verify', { ...authorization(f), confirmed: true });
        for (let i = 0; i < 150 && !held; i++) await pause(); assert.ok(held, 'actual ID detail GET reached');
        if (label === 'cancelled') await cli('exploration.cancel', { taskId: f.taskId });
        await stopBridge(); await startBridge(); hold = false; held.res.end(JSON.stringify(held.value));
        const state = (await cli('exploration.get', { taskId: f.taskId })).data;
        assert.equal(state.status, label === 'cancelled' ? 'cancelled' : 'interrupted'); assert.equal(state.writeExecutions[0].status, 'uncertain');
        await cli('exploration.write-verify', { ...authorization(f), confirmed: true }); assert.equal(count(kind), sent + 1);
        const result = (await cli('exploration.write-readback', { taskId: f.taskId, reviewId: f.reviewId })).data;
        assert.equal(result.passed, true); assert.equal(result.originalStatus, 'uncertain');
        assert.equal((await cli('exploration.review', { taskId: f.taskId }, false)).ok, false);
        await cli('browser.close', { session: f.session });
      }
      passed(kind + ' repaired writes: cancelled/restarted after actual ID persistence, no replay, readonly recovery cannot certify');
    }
    assert.ok(requests.every(v => v.authenticated)); await record('page-repair-requests', requests);
  } finally { if (held && !held.res.writableEnded) held.res.end('{}'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
