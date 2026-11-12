import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { validateV2AdapterDir } from '../adapter-package-validation.js';
import { buildV2Bootstrap } from '../../extension/background/v2-loader.js';
import { compileResultBindings, extractBoundEntities } from '../result-bindings.js';
import { captureResult } from '../context-profile.js';
import { newState, beginRound, commitRound, registerDisplay } from '../context-model.js';
import { routeContext } from '../context-router.js';

function setup(site, overrides) {
  const root = resolve(import.meta.dirname, '../../adapters', site), pkg = validateV2AdapterDir(root), handlers = new Map();
  const context = { URL, URLSearchParams, console, location: new URL(site === '12306.cn' ? 'https://kyfw.12306.cn/otn/leftTicket/init' : 'https://we.51job.com/pc/search'),
    __webmcpRegister: definition => definition.tools.forEach(tool => handlers.set(tool.name, tool.handler)), ...overrides };
  context.window = context; vm.createContext(context); vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const file of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', file), 'utf8'), context);
  for (const command of pkg.commands) vm.runInContext(readFileSync(resolve(root, command.module), 'utf8'), context);
  const entries = pkg.commands.map(command => ({ ...command, adapterId: pkg.name, sourceFingerprint: 'test-package' }));
  return { catalog: { entries, tools: {}, resultBindings: compileResultBindings(entries) }, run: async (command, args) => {
    const handler = handlers.get(`${site}.${command}`); let result = await handler(args);
    if (result.__webcli_navigation) { context.location = new URL(result.__webcli_navigation.url); result = await handler(args); }
    return result;
  } };
}
function captured(s, tool, args, raw) {
  const state = newState(1000); beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool, args, raw, exitCode: 0, now: 1000, catalog: s.catalog, roundId: state.activeRound.roundId });
  commitRound(state);
  registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(e => e.entityRef).reverse(), completeness: 'unknown', delivered: true });
  return state;
}
const stationBundle = "var station_names ='@a|Alpha|AAA|alpha|a|1|0|Example@b|Beta|BBB|beta|b|2|0|Example';";
function railway() {
  const requests = [], stops = [{ station_no: '01', station_name: 'Alpha' }, { station_no: '02', station_name: 'Beta' }];
  const s = setup('12306.cn', { fetch: async url => {
    requests.push(url);
    let value;
    if (url.includes('station_name.js')) return { ok: true, text: async () => stationBundle };
    if (url.includes('/leftTicket/queryG')) value = { data: { result: ['24000000G10L', '24000000G20L'].map((id, index) => {
      const fields = Array(33).fill(''); fields[2] = id; fields[3] = `G${index + 1}`; fields[6] = 'AAA'; fields[7] = 'BBB'; return fields.join('|');
    }) } };
    else if (url.includes('queryByTrainNo')) value = { status: true, data: { data: stops } };
    else if (url.includes('queryTicketPrice')) value = { status: true, data: { O: '100.00' } };
    else if (url.includes('initMy12306Api')) value = { status: true, data: { user_name: 'example-user' } };
    else if (url.includes('initQueryUserInfoApi')) value = { status: true, data: { userDTO: { loginUserDTO: { user_name: 'example-user' } } } };
    else if (url.includes('/passengers/query')) value = { status: true, data: { datas: [{ passenger_name: 'Example' }] } };
    else if (url.includes('queryMyOrderNoComplete')) value = { status: true, data: { orderDBList: [{ sequence_no: 'example-order' }] } };
    else throw new Error(`Unexpected URL ${url}`);
    return { ok: true, json: async () => value, text: async () => JSON.stringify(value) };
  }, __webmcpWecliRuntime: { requestPrivileged: async (_action, args) => ({ ok: true, url: args.url, body: stationBundle }) } });
  return { ...s, requests };
}
it.each([['查看第二条', 'train'], ['查看票价第二条', 'price']])('12306 runs actual trains query, %s and %s handler with original date and segment', async (text, target) => {
  const s = railway(), args = { from: 'AAA', to: 'BBB', date: '2026-11-08' }, raw = await s.run('trains', args);
  const state = captured(s, '12306.cn.trains', args, raw), result = await routeContext(state, text, { catalog: s.catalog, now: 1001 });
  expect(result.steps[0].args).toEqual({ 'train-no': '24000000G10L', from: 'AAA', to: 'BBB', date: args.date });
  const output = await s.run(target, result.steps[0].args); expect(output.length).toBeGreaterThan(0);
  expect(s.requests.at(-1)).toContain(target === 'train' ? 'train_no=24000000G10L' : 'train_date=2026-11-08');
});
it('12306 station selection asks only for the missing destination and date, then executes the query', async () => {
  const s = railway(), raw = await s.run('stations', { keyword: 'Example' });
  const state = captured(s, '12306.cn.stations', {}, raw);
  const question = await routeContext(state, '查询出发车次第二条', { catalog: s.catalog, now: 1001 });
  expect(question.missingFields).toEqual(['arguments.to', 'arguments.date']);
  const result = await routeContext(state, '{"to":"BBB","date":"2026-11-08"}', { catalog: s.catalog, now: 1002, replyTo: question.clarificationId });
  expect(result.steps[0].args).toEqual({ from: 'AAA', to: 'BBB', date: '2026-11-08' });
  expect(await s.run('trains', result.steps[0].args)).toHaveLength(2);
});
it('12306 selected stop keeps the original date and asks for a destination before querying departures', async () => {
  const s = railway(), args = { 'train-no': '24000000G10L', from: 'AAA', to: 'BBB', date: '2026-11-08' };
  const state = captured(s, '12306.cn.train', args, await s.run('train', args));
  const question = await routeContext(state, '查询出发车次第二条', { catalog: s.catalog, now: 1001 });
  expect(question.missingFields).toEqual(['arguments.to']);
  const result = await routeContext(state, 'BBB', { catalog: s.catalog, now: 1002, replyTo: question.clarificationId });
  expect(result.steps[0].args).toEqual({ from: 'Alpha', to: 'BBB', date: args.date });
  expect(await s.run('trains', result.steps[0].args)).toHaveLength(2);
});
it.each([['whoami', '查看乘车人第一条', 'passengers'], ['me', '查看订单第一条', 'orders']])('12306 %s offers the declared account follow-up %s', async (source, text, target) => {
  const s = railway(), state = captured(s, `12306.cn.${source}`, {}, await s.run(source, {}));
  const result = await routeContext(state, text, { catalog: s.catalog, now: 1001 });
  expect(result.steps[0].tool).toBe(`12306.cn.${target}`); expect(result.steps[0].args).toEqual({});
  expect(await s.run(target, result.steps[0].args)).toHaveLength(1);
});

function jobs(companyUrl = 'https://jobs.51job.com/all/coCOMPANY_A.html', cards = []) {
  const document = { body: { innerText: '' }, querySelectorAll: selector => selector === 'a[sensorsdata]' ? cards : [], querySelector: selector => {
    if (selector === 'h1') return { innerText: 'Example job' };
    if (selector.includes('.cname a')) return { innerText: 'Example company', href: companyUrl };
    return null;
  } };
  return setup('51job.com', { document, __webmcpWecliRuntime: { requestPrivileged: async () => ({ ok: true, status: 200,
    body: JSON.stringify({ status: '1', resultbody: { job: { items: [100001, 100002].map(jobId => ({ jobId, jobName: `Job ${jobId}`, encCoId: 'COMPANY_A' })) } } }) }) } });
}
it.each(['search', 'hot'])('51job %s runs actual query, display order selection and detail/company handlers', async command => {
  const s = jobs(), args = command === 'search' ? { keyword: 'Example' } : {}, raw = await s.run(command, args);
  const state = captured(s, `51job.com.${command}`, args, raw), result = await routeContext(state, '查看第二条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0].args).toEqual({ jobId: '100001' });
  const detail = await s.run('detail', result.steps[0].args);
  expect(detail[0]).toMatchObject({ jobId: '100001', encCoId: 'COMPANY_A', title: 'Example job' });
  const binding = extractBoundEntities(s.catalog.resultBindings.get('51job.com.detail'), result.steps[0].args, detail);
  expect(binding.entities[0].bindings.company.args).toEqual({ encCoId: 'COMPANY_A' });
  const company = await s.run('company', binding.entities[0].bindings.company.args);
  expect(company[0].extraction_status).toBe('no_job_cards');
  const companyBinding = extractBoundEntities(s.catalog.resultBindings.get('51job.com.company'), {}, company);
  expect(companyBinding.entities[0].bindings.detail.ready).toBe(false);
});
it.each(['https://example.org/all/coCOMPANY_A.html', 'not a URL'])('51job never derives a company ID from an untrusted or malformed link %s', async link => {
  const s = jobs(link), detail = await s.run('detail', { jobId: '100001' });
  expect(detail[0].encCoId).toBe('');
  const binding = extractBoundEntities(s.catalog.resultBindings.get('51job.com.detail'), {}, detail);
  expect(binding.entities[0].bindings.company.ready).toBe(false);
});
it('51job company job cards resolve the displayed second job and execute its detail handler', async () => {
  const cards = [100001, 100002].map(jobId => ({ href: `https://jobs.51job.com/x/${jobId}.html`, innerText: 'Job',
    getAttribute: () => JSON.stringify({ jobId, jobTitle: `Job ${jobId}` }) }));
  const s = jobs(undefined, cards), args = { encCoId: 'COMPANY_A' }, raw = await s.run('company', args);
  const state = captured(s, '51job.com.company', args, raw), result = await routeContext(state, '查看第二条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0].args).toEqual({ jobId: '100001' });
  expect((await s.run('detail', result.steps[0].args))[0].jobId).toBe('100001');
});
