import assert from 'node:assert/strict';
import http from 'node:http';

/** Shared helper drift with two reads and one real write; all effects remain loopback. */
export async function verifySharedRepairs({ call, waitTask, startBridge, stopBridge, pass }) {
  let drift = false, title = 'Before';
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'PUT') title = JSON.parse(body).title;
    const value = { id: 'example-item', [drift && req.url !== '/effect' ? 'label' : 'title']: title };
    res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://localhost:' + server.address().port, shared = 'http/internal/fields.js';
  const writes = () => requests.filter(item => item.method === 'PUT').length;
  const planTool = (name, index, risk = 'read') => ({ name, risk, strategy: 'PUBLIC_API', sourceApiKind: risk === 'write' ? 'action' : 'list', sourceApiIndexes: [index],
    ...(risk === 'write' ? { writeReason: 'Update public isolated item' } : { readReason: 'Read public isolated item' }),
    strategyNote: { reason: 'Explicit loopback fixture', limitations: 'Public fixture only' } });
  const start = async label => (await call('exploration.start', { mode: 'http', origin, goal: 'Repair shared public field mapping', requestId: 'shared-' + label })).data.taskId;
  const observe = async taskId => {
    await call('exploration.request', { taskId, request: { url: origin + '/items' }, reason: 'Read current field structure' }); await waitTask(taskId, 'evidence_ready');
    await call('exploration.declare-write', { taskId, url: origin + '/items', method: 'PUT', bodyKeys: ['title'], reason: 'Declare isolated write without executing' });
  };
  const edit = async (taskId, file, content) => {
    const before = (await call('exploration.draft-read', { taskId, file })).data;
    await call('exploration.draft-write', { taskId, file, content, expectedHash: before.hash });
  };
  const install = async taskId => {
    const review = (await call('exploration.review', { taskId })).data;
    await call('exploration.install', { taskId, reviewId: review.reviewId, confirmed: true }); await waitTask(taskId, 'installed');
  };
  const mapper = field => `module.exports = value => ({id:value.id,title:value.${field}});`;
  try {
    const initial = await start('initial'); await observe(initial);
    const plan = { tools: [planTool('shared_first', 0), planTool('shared_second', 0), planTool('shared_update', 1, 'write')] };
    const generated = (await call('exploration.generate', { taskId: initial, plan })).data;
    const [first, second, writer] = generated.toolNames;
    const manifest = JSON.parse((await call('exploration.draft-read', { taskId: initial, file: 'manifest.json' })).data.content);
    assert.equal(manifest.commands.length, 3, 'This fixture needs its own localhost package');
    await call('exploration.draft-add', { taskId: initial, file: shared, content: mapper('title') });
    for (const command of manifest.commands) {
      const write = command.safety === 'write';
      if (write) command.schema = { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' } }, 'x-webcli-agent-authored': true };
      await edit(initial, command.module, write
        ? `module.exports = async (args,api) => { try { const value=await api.request({url:${JSON.stringify(origin + '/items')},method:'PUT',json:{title:args.title}});return {ok:true,...require('../internal/fields.js')(value)};}catch(error){return {ok:false,errorCode:error.code};}};`
        : `module.exports = async (args,api) => require('../internal/fields.js')(await api.request({url:${JSON.stringify(origin + '/items')}}));`);
    }
    await edit(initial, 'manifest.json', JSON.stringify(manifest));
    for (const tool of [first, second]) {
      const prior = (await call('exploration.verification-read', { taskId: initial, tool })).data;
      await call('exploration.verification-write', { taskId: initial, tool, expectedHash: prior.hash,
        cases: [{ id: 'example-public', args: {}, expect: { equals: { id: 'example-item', title: 'Before' } } }] });
    }
    const fixture = { id: 'example-shared-write', representativeArgs: { title: 'After' }, expectedRequest: { url: origin + '/items', method: 'PUT', body: { title: 'After' } },
      successResponse: { status: 200, body: { id: 'example-item', title: 'After' } }, successExpectation: { ok: true, id: 'example-item', title: 'After' },
      failureResponse: { status: 409, body: {} }, failureExpectation: { ok: false, errorCode: 'HTTP_STATUS' },
      effect: { readback: { url: origin + '/effect' }, before: { equals: { id: 'example-item', title: 'Before' } }, after: { equals: { id: 'example-item', title: 'After' } } } };
    const saveFixture = async (taskId, value) => {
      const before = (await call('exploration.write-verification-read', { taskId, tool: writer })).data;
      await call('exploration.write-verification-write', { taskId, tool: writer, fixture: value, expectedHash: before.hash });
    };
    await saveFixture(initial, fixture); await call('exploration.validate', { taskId: initial }); await waitTask(initial, 'write_review_ready');
    assert.equal(writes(), 0);
    const original = (await call('exploration.write-review', { taskId: initial, tool: writer })).data;
    await call('exploration.write-verify', { taskId: initial, tool: writer, reviewId: original.reviewId, confirmed: true }); await waitTask(initial, 'review_ready');
    await install(initial);
    const priorKnowledge = (await call('exploration.knowledge-read', { mode: 'http', site: manifest.name })).data;
    await call('exploration.knowledge-save', { taskId: initial, expectedHash: priorKnowledge.hash });
    title = 'Before'; drift = true;
    const repair = await start('repair'); await observe(repair);
    const info = (await call('exploration.repair-info', { mode: 'http', site: manifest.name })).data;
    assert.ok(info.sharedFiles.includes(shared));
    const nextPlan = { tools: manifest.commands.map(command => planTool(command.id, command.safety === 'write' ? 1 : 0, command.safety)) };
    const args = { taskId: repair, site: manifest.name, expectedDigest: info.digest, sharedFiles: [shared], plan: nextPlan };
    assert.equal((await call('exploration.repair', { ...args, plan: { tools: nextPlan.tools.slice(0, 1) } }, false)).error.code, 'REPAIR_SHARED_SCOPE_INCOMPLETE');
    const repaired = (await call('exploration.repair', args)).data;
    assert.equal(repaired.repair.impact, 'all-package-commands'); assert.equal((repaired.writeExecutions || []).length, 0);
    const nextFixture = structuredClone(fixture); nextFixture.successResponse.body.label = 'After'; delete nextFixture.successResponse.body.title;
    await saveFixture(repair, nextFixture);
    const beforeValidation = writes(); await call('exploration.validate', { taskId: repair }); await waitTask(repair, 'draft');
    assert.equal(writes(), beforeValidation);
    await edit(repair, shared, mapper('label'));
    await call('exploration.validate', { taskId: repair });
    const validated = await waitTask(repair, 'write_review_ready');
    assert.deepEqual(validated.runtimeValidation.executionSummary, { attempted: 2, passed: 2, skipped: 0, failed: 0 });
    assert.equal(writes(), beforeValidation);
    assert.equal((await call('exploration.review', { taskId: repair }, false)).ok, false);
    assert.equal((await call('exploration.write-verify', { taskId: repair, tool: writer, reviewId: original.reviewId, confirmed: true }, false)).error.code, 'STALE_REVIEW');
    pass('shared repair refuses a partial plan, retains no old authorization, fails old mapping and revalidates both reads without writes');
    const priorReview = (await call('exploration.write-review', { taskId: repair, tool: writer })).data;
    await edit(repair, shared, mapper('label') + '\n// Public mapping revision.\n');
    assert.equal((await call('exploration.write-verify', { taskId: repair, tool: writer, reviewId: priorReview.reviewId, confirmed: true }, false)).ok, false);
    assert.equal(writes(), beforeValidation);
    await call('exploration.validate', { taskId: repair }); await waitTask(repair, 'write_review_ready');
    assert.equal((await call('exploration.write-verify', { taskId: repair, tool: writer, reviewId: priorReview.reviewId, confirmed: true }, false)).error.code, 'STALE_REVIEW');
    const review = (await call('exploration.write-review', { taskId: repair, tool: writer })).data;
    assert.notEqual(review.reviewId, priorReview.reviewId);
    await call('exploration.write-verify', { taskId: repair, tool: writer, reviewId: review.reviewId, confirmed: true }); await waitTask(repair, 'review_ready');
    assert.equal(writes(), beforeValidation + 1);
    await install(repair);
    for (const tool of [first, second]) assert.equal((await call(tool)).title, 'After');
    const knowledge = (await call('exploration.knowledge-read', { mode: 'http', site: manifest.name })).data;
    await call('exploration.knowledge-save', { taskId: repair, expectedHash: knowledge.hash });
    await stopBridge(); await startBridge();
    assert.equal((await call('exploration.get', { taskId: repair })).data.repair.impact, 'all-package-commands');
    assert.equal((await call(first)).title, 'After'); assert.equal(writes(), beforeValidation + 1);
    pass('shared mapper repair requires a fresh independent real write effect before installation; both commands and restart preserve the fix without replay');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
