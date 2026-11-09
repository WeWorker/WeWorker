import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
import { validateV2AdapterDir } from '../adapter-package-validation.js';
import { buildV2Bootstrap } from '../../extension/background/v2-loader.js';
import { compileResultBindings, extractBoundEntities } from '../result-bindings.js';
import { captureResult } from '../context-profile.js';
import { newState, beginRound, commitRound, registerDisplay } from '../context-model.js';
import { routeContext } from '../context-router.js';
import { runContextCall } from '../context-command.js';

const sites = ['mail.qq.com', 'mail.163.com', 'mail.google.com'];
function setup(site, subjects = ['First', 'Second'], ids = ['mail-1', 'mail-2'], modern = true) {
  const root = resolve(import.meta.dirname, '../../adapters', site), pkg = validateV2AdapterDir(root), handlers = new Map(), clicks = [];
  let opened = null;
  const text = value => ({ textContent: value, getAttribute: () => value });
  const rows = subjects.map((subject, index) => {
    const click = () => { clicks.push(ids[index]); opened = subject; };
    const row = { id: ids[index], click, previousElementSibling: null, classList: { contains: () => true },
      getAttribute: () => ids[index], closest: () => row, querySelectorAll: () => [],
      querySelector: selector => {
        if (selector === 'input[name="mailid"]') return { value: ids[index] };
        if (selector === '.gt.sall .tt, .gt .tt') return text(subject);
        if (selector === '[data-legacy-thread-id]') return { getAttribute: () => ids[index], closest: () => row };
        if (/mail-text|mail-subject|span.da0|\.bog|\.lh0/.test(selector)) return { ...text(subject), click };
        if (/unread/.test(selector)) return {};
        if (/sender|nui-user|\.yP/.test(selector)) return text('sender@example.com');
        return null;
      },
    };
    return row;
  });
  const readModule = { style: {}, textContent: 'Email', querySelectorAll: () => [], querySelector: selector => selector.includes('h1Subject') ? text(opened) : null };
  const document = { title: 'Mailbox', readyState: 'complete',
    getElementById: id => rows.find(row => row.id === id) || null,
    querySelectorAll: selector => {
      if (selector === '[data-legacy-thread-id]') return rows.map(row => row.querySelector('[data-legacy-thread-id]'));
      if (selector.includes('read.ReadModule')) return opened ? [readModule] : [];
      if (!modern && selector === 'table.i.M, table.i') return rows;
      if (selector.includes('sign="letter"') || selector.includes('mail-list-page-item') || selector === 'tr.zA') return rows;
      return [];
    },
    querySelector: selector => {
      if (selector === '[gh="tl"]') return { querySelectorAll: () => rows };
      if (selector.includes('xmail-page-root') || selector === '.mail-list-page') return site === 'mail.qq.com' && modern ? {} : null;
      if (selector.startsWith('[data-legacy-thread-id=')) return rows.find(row => selector.includes(`"${row.id}"`))?.querySelector('[data-legacy-thread-id]') || null;
      if (opened && (selector === 'h2.hP' || selector.includes('mail-detail-subject'))) return text(opened);
      if (opened && /a3s.aiL|mail-detail-content/.test(selector)) return text('Body');
      return null;
    },
  };
  const context = { URL, URLSearchParams, console, document, location: new URL(`https://${site}/${site === 'mail.google.com' ? 'mail/u/0/' : 'home/index'}#inbox`),
    setTimeout: callback => { callback(); return 1; }, clearTimeout,
    __webmcpRegister: definition => definition.tools.forEach(tool => handlers.set(tool.name, tool.handler)),
  };
  context.window = context; vm.createContext(context); vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const file of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', file), 'utf8'), context);
  for (const command of pkg.commands) vm.runInContext(readFileSync(resolve(root, command.module), 'utf8'), context);
  const entries = pkg.commands.map(command => ({ ...command, adapterId: pkg.name, sourceFingerprint: 'test-package' }));
  return { clicks, catalog: { entries, tools: {}, resultBindings: compileResultBindings(entries) }, run: (name, args = {}) => handlers.get(`${site}.${name}`)(args) };
}

it.each(sites)('%s runs unread query, display selection and the actual open-email handler', async site => {
  const s = setup(site), raw = await s.run('get-unread-emails', { limit: 2 }), state = newState(1000);
  expect(raw.emails.map(email => email.id)).toEqual(['mail-1', 'mail-2']);
  beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: `${site}.get-unread-emails`, args: {}, raw, exitCode: 0, now: 1000, catalog: s.catalog, roundId: state.activeRound.roundId });
  commitRound(state);
  registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: ['e2', 'e1'], completeness: 'unknown', delivered: true });
  const result = await routeContext(state, '查看第二条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0]).toMatchObject({ tool: `${site}.open-email`, args: { emailId: 'mail-1' } });
  const detail = await s.run('open-email', result.steps[0].args);
  expect(detail).toMatchObject({ status: 'opened', emailId: 'mail-1', detail: { subject: 'First' } });
  expect(s.clicks).toEqual(['mail-1']);
});

it.each(sites)('%s search uses the same exact ID contract and attachment downloads preserve their arguments', async site => {
  const s = setup(site);
  const found = extractBoundEntities(s.catalog.resultBindings.get(`${site}.search-emails`), { keyword: 'Example' }, { emails: [{ id: 'mail-1', subject: 'Example' }] });
  expect(found.entities[0].bindings.detail.args).toEqual({ emailId: 'mail-1' });
  const extracted = extractBoundEntities(s.catalog.resultBindings.get(`${site}.open-email`), { emailId: 'mail-1' }, { detail: { attachments: [{ name: 'example.pdf', size: '1 KB' }] } });
  const action = extracted.entities[0].bindings.download;
  expect(action).toMatchObject({ safety: 'write', args: { attachmentName: 'example.pdf', emailId: 'mail-1' } });
  const state = newState(1000);
  const store = { now: () => 1001, transaction: async (_id, fn) => fn(state, { persist: async () => {} }) };
  const invoke = vi.fn(async () => ({ raw: { ok: true }, exitCode: 0 }));
  const result = await runContextCall({ id: 'example', tool: action.tool, args: action.args, invoke }, { catalog: s.catalog, store });
  expect(result.receipt.toolOutcome).toBe('acknowledged');
  expect(invoke.mock.calls[0].slice(0, 2)).toEqual([action.tool, action.args]);
});

it('QQ exact ID takes precedence over another email subject containing that ID', async () => {
  const s = setup('mail.qq.com', ['Text mail-2 here', 'Second']);
  const result = await s.run('open-email', { emailId: 'mail-2' });
  expect(result.detail.subject).toBe('Second'); expect(s.clicks).toEqual(['mail-2']);
});
it('Gmail treats selector-like email IDs as literal values and rejects duplicate IDs before clicking', async () => {
  const id = 'mail-1\"] , tr.zA';
  const s = setup('mail.google.com', ['First', 'Second'], [id, 'mail-2']);
  expect(await s.run('open-email', { emailId: id })).toMatchObject({ status: 'opened', emailId: id });
  expect(s.clicks).toEqual([id]);
  const duplicate = setup('mail.google.com', ['First', 'Second'], ['same', 'same']);
  expect(await duplicate.run('open-email', { emailId: 'same' })).toMatchObject({ error: 'Ambiguous email ID' });
  expect(duplicate.clicks).toEqual([]);
});
it('QQ rejects duplicate subject fragments and never invents a list ID from the subject', async () => {
  const s = setup('mail.qq.com', ['Same subject', 'Same subject'], ['', '']);
  const raw = await s.run('get-unread-emails', { limit: 2 });
  expect(raw.emails.every(email => email.id === '')).toBe(true);
  await expect(s.run('open-email', { emailId: 'Same' })).rejects.toThrow('Ambiguous email selection');
  expect(s.clicks).toEqual([]);
});
it('QQ classic also searches all exact IDs before considering subject fragments', async () => {
  const s = setup('mail.qq.com', ['Text mail-2 here', 'Second'], ['mail-1', 'mail-2'], false);
  const result = await s.run('open-email', { emailId: 'mail-2' });
  expect(result.emailId).toBe('mail-2');
  expect(s.clicks).toEqual(['mail-2']);
});
it('QQ classic refuses an ambiguous subject before clicking', async () => {
  const s = setup('mail.qq.com', ['Same subject', 'Same subject'], ['mail-1', 'mail-2'], false);
  const result = await s.run('open-email', { emailId: 'Same' });
  expect(result.message).toContain('Ambiguous email selection'); expect(s.clicks).toEqual([]);
});
it.each(sites)('%s attachment wrapper opens its source email before dispatching the download', async site => {
  let handler;
  const invoke = vi.fn(async name => name.endsWith('.open_email') ? { status: 'opened' } : { status: 'downloaded' });
  const context = { window: { [`__${site.replaceAll('.', '_')}_internal`]: { invoke } },
    __webcliRegisterCommand: (_name, callback) => { handler = callback; } };
  vm.runInNewContext(readFileSync(resolve(import.meta.dirname, '../../adapters', site, 'extension/commands/download-attachment.js'), 'utf8'), context);
  expect(await handler({ emailId: 'mail-1', attachmentName: 'example.pdf' })).toMatchObject({ status: 'downloaded' });
  expect(invoke.mock.calls).toEqual([
    [`${site}.open_email`, { emailId: 'mail-1' }],
    [`${site}.download_attachment`, { emailId: 'mail-1', attachmentName: 'example.pdf' }],
  ]);
});
it.each(sites)('%s attachment wrapper never downloads when the selected email cannot be opened', async site => {
  let handler;
  const invoke = vi.fn(async () => ({ status: 'clicked', warning: 'Detail unavailable' }));
  const context = { window: { [`__${site.replaceAll('.', '_')}_internal`]: { invoke } },
    __webcliRegisterCommand: (_name, callback) => { handler = callback; } };
  vm.runInNewContext(readFileSync(resolve(import.meta.dirname, '../../adapters', site, 'extension/commands/download-attachment.js'), 'utf8'), context);
  expect(await handler({ emailId: 'mail-1', attachmentName: 'example.pdf' })).toHaveProperty('error');
  expect(invoke).toHaveBeenCalledOnce();
});
it.each(sites)('%s preserves ordinary attachment calls without a contextual email ID', async site => {
  let handler;
  const invoke = vi.fn(async () => ({ status: 'downloaded' }));
  const context = { window: { [`__${site.replaceAll('.', '_')}_internal`]: { invoke } },
    __webcliRegisterCommand: (_name, callback) => { handler = callback; } };
  vm.runInNewContext(readFileSync(resolve(import.meta.dirname, '../../adapters', site, 'extension/commands/download-attachment.js'), 'utf8'), context);
  await handler({ attachmentName: 'example.pdf' });
  expect(invoke.mock.calls).toEqual([[`${site}.download_attachment`, { attachmentName: 'example.pdf' }]]);
});
