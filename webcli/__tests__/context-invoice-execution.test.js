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
const root = resolve(import.meta.dirname, '../../adapters/nnfp.jss.com.cn');
const number = '12345678901234567890';
const body = n => `电子发票 发票号码：${n}\n发票代码：123456789012\n合计金额：12.00\n开票日期：2026-11-01\n销售方：Example seller\n下载PDF 下载OFD 下载XML`;
function setup({ chromeApi = true, direct = true, format = 'pdf', chromeFailure = false, url, onWait } = {}) {
  const pkg = validateV2AdapterDir(root), handlers = new Map(), downloads = [], clicks = [], navigation = [], markers = [];
  let text = body(number), changeOnUrl = false;
  const anchor = { tagName: 'A', textContent: '下载' + format.toUpperCase(), title: '', className: format,
    get href() { if (changeOnUrl) text = body('99999999999999999999'); return url || `https://nnfp.jss.com.cn/files/example.${format}`; },
    getAttribute: () => null, click: () => clicks.push('download'), parentElement: null };
  const area = { querySelectorAll: () => [anchor] };
  const context = { URL, console, Date, location: new URL('https://nnfp.jss.com.cn/invoice/example-document'),
    setTimeout: (fn, ms) => { onWait?.(ms, { setText: value => { text = value; } }); fn(); return 1; }, clearTimeout() {},
    document: { title: 'Example invoice', referrer: '', body: { get textContent() { return text; }, innerHTML: '', querySelectorAll: () => [anchor] },
      querySelector: () => area, querySelectorAll: selector => direct && selector === 'a[href]' ? [anchor] : [] },
    localStorage: { setItem: (_key, value) => markers.push(JSON.parse(value)) },
    close: () => navigation.push('close'), opener: { closed: false, location: { href: 'https://mail.qq.com/' } },
    __webmcpRegister: d => d.tools.forEach(t => handlers.set(t.name, t.handler)),
  };
  context.location.replace = url => navigation.push(url);
  if (chromeApi) context.chrome = { runtime: {}, downloads: { download: (options, done) => {
    downloads.push(options); if (chromeFailure) context.chrome.runtime.lastError = { message: 'Example download failed' }; done(chromeFailure ? undefined : 123);
  } } };
  context.window = context; context.parent = { frames: [] }; vm.createContext(context); vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const f of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', f), 'utf8'), context);
  for (const c of pkg.commands) vm.runInContext(readFileSync(resolve(root, c.module), 'utf8'), context);
  const entries = pkg.commands.map(c => ({ ...c, adapterId: pkg.name, sourceFingerprint: 'test-package' }));
  return { context, downloads, clicks, navigation, markers, entries, catalog: { entries, tools: {}, resultBindings: compileResultBindings(entries) },
    setText: value => { text = value; }, changeIdentityWhenReadingUrl: () => { changeOnUrl = true; },
    run: (name, args = {}) => handlers.get(`nnfp.jss.com.cn.${name}`)(args) };
}
function bindings(s, raw) { return extractBoundEntities(s.catalog.resultBindings.get('nnfp.jss.com.cn.get-invoice-info'), {}, raw).entities[0].bindings; }
function capture(s, raw) {
  const state = newState(1000); beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: 'nnfp.jss.com.cn.get-invoice-info', args: {}, raw, exitCode: 0, now: 1000, catalog: s.catalog, roundId: state.activeRound.roundId });
  commitRound(state); registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(e => e.entityRef), completeness: 'unknown', delivered: true }); return state;
}
it.each(['pdf', 'ofd', 'xml'])('query -> explicit %s decision -> actual mocked download keeps the captured invoice identity', async format => {
  const s = setup({ format }), raw = await s.run('get-invoice-info'); expect(raw.invoiceNumber).toBe(number);
  const state = capture(s, raw), decision = await routeContext(state, `下载${format.toUpperCase()}这条`, { catalog: s.catalog, now: 1001 });
  expect(decision.executionEligibility).toBe('write_allowed');
  expect(decision.steps[0]).toMatchObject({ tool: 'nnfp.jss.com.cn.download-invoice', args: { expectedIdentity: raw.context_identity, format } });
  const result = await s.run('download-invoice', decision.steps[0].args);
  expect(result.status).toBe('downloading'); expect(s.downloads).toHaveLength(1); expect(s.downloads[0].url).toContain('.' + format); expect(s.clicks).toHaveLength(0);
});
it.each(['download-invoice', 'auto-download-and-return', 'return-to-qqmail'])('%s refuses a different invoice before any side effect', async command => {
  const s = setup(), raw = await s.run('get-invoice-info'); s.setText(body('99999999999999999999'));
  const call = () => s.run(command, { expectedIdentity: raw.context_identity, format: 'pdf' });
  if (command === 'return-to-qqmail') await expect(call()).rejects.toThrow('invoice_identity_changed');
  else expect(await call()).toMatchObject({ ...(command === 'download-invoice' ? { error: 'Download failed', message: 'invoice_identity_changed' } : { status: 'download_failed' }) });
  expect(s.downloads).toHaveLength(0); expect(s.clicks).toHaveLength(0); expect(s.navigation).toHaveLength(0);
});
it('identity is checked after waiting for page readiness', async () => {
  const s = setup({ onWait: (ms, page) => { if (ms === 500) page.setText(body('99999999999999999999')); } }), raw = await s.run('get-invoice-info');
  s.setText(''); const result = await s.run('download-invoice', { expectedIdentity: raw.context_identity, format: 'pdf' });
  expect(result.message).toBe('invoice_identity_changed'); expect(s.downloads).toHaveLength(0); expect(s.clicks).toHaveLength(0);
});
it('identity is rechecked immediately before Chrome dispatch, after URL extraction', async () => {
  const s = setup(), raw = await s.run('get-invoice-info'); s.changeIdentityWhenReadingUrl();
  expect(await s.run('download-invoice', { expectedIdentity: raw.context_identity, format: 'pdf' })).toMatchObject({ message: 'invoice_identity_changed' });
  expect(s.downloads).toHaveLength(0); expect(s.clicks).toHaveLength(0);
});
it('missing invoice numbers keep raw information without an executable binding', async () => {
  const s = setup(); s.setText('电子发票 下载PDF ' + 'Example invoice information without an actual number '.repeat(3));
  const raw = await s.run('get-invoice-info'); expect(raw.context_identity).toBeNull();
  for (const b of Object.values(bindings(s, raw))) expect(b.ready).toBe(false);
});
it('a digital invoice number is preserved as a string and used when the traditional number is absent', async () => {
  const s = setup(); s.setText(body(number).replace('发票号码', '数电号码'));
  const raw = await s.run('get-invoice-info'); expect(raw.digitalNumber).toBe(number); expect(raw.invoiceNumber).toBeUndefined();
  expect(bindings(s, raw)['download-pdf'].ready).toBe(true);
});
it('an unavailable OFD format does not silently download a PDF', async () => {
  const s = setup({ format: 'pdf' }), raw = await s.run('get-invoice-info');
  expect(await s.run('download-invoice', { expectedIdentity: raw.context_identity, format: 'ofd' })).toMatchObject({ error: 'Download failed', message: 'Requested invoice format is unavailable' });
  expect(s.downloads).toHaveLength(0); expect(s.clicks).toHaveLength(0);
});
it('Chrome failure is not retried by clicking the same download', async () => {
  const s = setup({ chromeFailure: true }), raw = await s.run('get-invoice-info');
  expect(await s.run('download-invoice', { expectedIdentity: raw.context_identity, format: 'pdf' })).toMatchObject({ error: 'Download failed' });
  expect(s.downloads).toHaveLength(1); expect(s.clicks).toHaveLength(0);
});
it('the existing button fallback checks identity and clicks once when Chrome download is unavailable', async () => {
  const s = setup({ chromeApi: false, direct: false }), raw = await s.run('get-invoice-info');
  expect(await s.run('download-invoice', { expectedIdentity: raw.context_identity, format: 'pdf' })).toMatchObject({ status: 'downloading' });
  expect(s.clicks).toEqual(['download']);
});
it.each(['https://nnfp.jss.com.cn.example.org/invoice.pdf', 'https://example.org/file.pdf?from=nnfp.jss.com.cn', 'http://nnfp.jss.com.cn/file.pdf'])('an untrusted download URL is refused: %s', async url => {
  const s = setup({ url }), raw = await s.run('get-invoice-info');
  expect(await s.run('download-invoice', { expectedIdentity: raw.context_identity, format: 'pdf' })).toMatchObject({ error: 'Download failed' });
  expect(s.downloads).toHaveLength(0); expect(s.clicks).toHaveLength(0);
});
it('automatic return reports only a requested download, never verified file completion', async () => {
  const s = setup(), raw = await s.run('get-invoice-info'), b = bindings(s, raw)['download-return'];
  const result = await s.run('auto-download-and-return', b.args);
  expect(result).toMatchObject({ status: 'download_requested', download: { status: 'downloading' }, navigation: { status: 'closed' } });
  expect(s.downloads).toHaveLength(1); expect(s.navigation).toEqual(['close']);
});
it('changing invoice during the post-download wait prevents closing the new invoice page', async () => {
  const s = setup({ onWait: (ms, page) => { if (ms === 3000) page.setText(body('99999999999999999999')); } }), raw = await s.run('get-invoice-info');
  const result = await s.run('auto-download-and-return', bindings(s, raw)['download-return'].args);
  expect(result).toMatchObject({ status: 'download_requested', navigation: { error: 'invoice_identity_changed' } }); expect(s.navigation).toHaveLength(0);
});
it('return-to-mail is a write and standalone navigation does not claim a completed download', async () => {
  const s = setup(); expect(s.entries.find(c => c.id === 'return-to-qqmail').safety).toBe('write');
  s.context.opener = null; s.context.name = '';
  const result = await s.run('return-to-qqmail'); expect(result.status).toBe('navigating');
  expect(s.markers[0].completed).toBe(false); expect(s.navigation).toEqual(['https://wx.mail.qq.com/']);
});

it('automatic direct format selection reports OFD when no PDF is available', async () => {
  const s = setup({ format: 'ofd' }), raw = await s.run('get-invoice-info');
  const result = await s.run('download-invoice', { expectedIdentity: raw.context_identity, format: 'auto' });
  expect(result.format).toBe('ofd'); expect(s.downloads[0].url).toContain('.ofd');
});
