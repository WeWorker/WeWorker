import { files } from './files.js';
import { readDraftEntries, normalizeDraftRecord, encodeDraftKey } from './upstream/draft-utils.js';
import { ArgumentError, CommandExecutionError, CliError } from './errors.js';

// Uses only images preloaded and bounded by the current publish invocation.
// No debugger attach/detach, file-property override or post-dispatch fallback.
export async function uploadPreloadedImages(page, paths, selector) {
  const images = paths.map(path => {
    const file = files.get(path);
    if (!file) throw new ArgumentError('Image was not preloaded');
    const name = path.split(/[\\/]/).pop();
    const ext = name.split('.').pop().toLowerCase();
    const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext];
    return { name, type, size: file.size, content: file.content };
  });
  const result = await page.evaluate(`(${assignImageFiles.toString()})(${JSON.stringify({ selector, images })})`);
  if (!result?.verified || result.count !== images.length) throw new CommandExecutionError('Image input verification failed; inspect the editor before retrying');
  return result;
}

export function assignImageFiles({ selector, images }) {
  const inputs = Array.from(document.querySelectorAll(selector));
  if (inputs.length !== 1) throw new Error('Expected exactly one image file input');
  const input = inputs[0];
  if (input.disabled || (!input.multiple && images.length > 1)) throw new Error('Image input does not accept the requested files');
  const transfer = new DataTransfer();
  for (const image of images) {
    const binary = atob(image.content);
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    if (bytes.byteLength !== image.size) throw new Error('Preloaded image size mismatch');
    transfer.items.add(new File([bytes], image.name, { type: image.type }));
  }
  input.files = transfer.files;
  const selected = Array.from(input.files || []);
  if (selected.length !== images.length || selected.some((file, i) => file.name !== images[i].name || file.size !== images[i].size)) throw new Error('Image selection mismatch');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { verified: true, count: selected.length };
}

export function replaceBodyParagraphs({ selectors, text }) {
  let editor;
  for (const selector of selectors) {
    const visible = Array.from(document.querySelectorAll(selector)).filter(el => el.isContentEditable && el.offsetParent !== null);
    if (visible.length > 1) throw new Error('Ambiguous body editor');
    if (visible.length === 1) { editor = visible[0]; break; }
  }
  if (!editor) throw new Error('Body editor not found');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = lines.map(line => '<p>' + (line ? escape(line) : '<br>') + '</p>').join('');
  editor.focus();
  const range = document.createRange(); range.selectNodeContents(editor);
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  if (!document.execCommand('insertHTML', false, html)) throw new Error('Editor rejected paragraph insertion');
  const actual = Array.from(editor.children).map(node => node.textContent || '');
  if (actual.length !== lines.length || actual.some((line, i) => line !== lines[i])) throw new Error('Body paragraph verification failed');
  editor.blur();
  return { verified: true, paragraphs: actual.length };
}

export async function fillBody(page, selectors, text) {
  const result = await page.evaluate(`(${replaceBodyParagraphs.toString()})(${JSON.stringify({ selectors, text })})`);
  if (!result?.verified) throw new CommandExecutionError('Body paragraph verification failed');
}

export function declarationStep({ phase }) {
  const label = phase === 'open' ? '添加内容类型声明' : '笔记含AI合成内容';
  const visible = el => el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  if (phase === 'open') {
    const selected = Array.from(document.querySelectorAll('.d-select')).find(el => visible(el) && el.textContent.includes('笔记含AI合成内容'));
    if (selected) return { selected: true };
  }
  const matches = Array.from(document.querySelectorAll(phase === 'open' ? '.d-select-placeholder' : '.d-option-name')).filter(el => visible(el) && el.textContent.trim() === label);
  if (matches.length !== 1) throw new Error('Content declaration control not found or ambiguous');
  if (phase === 'open') {
    const wrapper = matches[0].closest('.d-select-wrapper');
    if (!wrapper) throw new Error('Content declaration focus target missing');
    wrapper.scrollIntoView({ block: 'center' }); wrapper.focus();
    return { focused: document.activeElement === wrapper };
  }
  matches[0].click();
  return { clicked: true };
}

export async function selectDeclaration(page, value) {
  if (!value || value === 'none') return;
  if (value !== 'ai') throw new ArgumentError('content-declaration must be none or ai');
  const opened = await page.evaluate(`(${declarationStep.toString()})({phase:'open'})`);
  if (opened?.selected) return;
  if (!opened?.focused) throw new CommandExecutionError('Content declaration focus failed');
  await page.pressKey('Enter');
  await page.wait(0.3);
  await page.evaluate(`(${declarationStep.toString()})({phase:'select'})`);
  const verified = await page.evaluate(`() => Array.from(document.querySelectorAll('.d-select')).some(el => el.getClientRects().length && el.textContent.includes('笔记含AI合成内容'))`);
  if (!verified) throw new CommandExecutionError('AI content declaration was not retained');
}

export function normalizePosted(body) {
  if (body.success !== true || !Array.isArray(body.data?.notes)) throw new CommandExecutionError('Malformed creator notes response');
  return body.data.notes.map(n => {
    if (!/^[a-f0-9]{24}$/i.test(n.id || '') || typeof n.display_title !== 'string' || !Array.isArray(n.images_list)) throw new CommandExecutionError('Malformed creator note');
    return { id: n.id, title: n.display_title, image_count: n.images_list.length, published_at: n.time, tab_status: n.tab_status, type: n.type };
  });
}
export async function routeCreator(page, path) {
  await page.evaluate(`() => { history.pushState({}, '', ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent('popstate')); }`);
  await page.wait(0.5);
}
export async function readPosted(page, { navigate = true, installed = false } = {}) {
  if (!installed) await page.installInterceptor('/api/galaxy/v2/creator/note/user/posted');
  if (navigate) {
    if (location.pathname === '/new/note-manager') await routeCreator(page, '/new/home');
    await routeCreator(page, '/new/note-manager');
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    const captures = await page.getInterceptedRequests();
    if (captures.length) return normalizePosted(captures[captures.length - 1]);
    await page.wait(0.5);
  }
  throw new CommandExecutionError('Creator notes response was not observed. Inspect login and the manager page.');
}
export function publishReceipt(row) {
  return { note_id: row.id, title: row.title, image_count: row.image_count, published_at: row.published_at,
    status: row.tab_status === 2 ? 'reviewing' : row.tab_status === 1 ? 'published' : 'submitted', platform_status: row.tab_status,
    verification: 'creator_notes_api', manager_url: 'https://creator.xiaohongshu.com/new/note-manager' };
}
export async function beginPublish(page, expected) {
  page.publishExpected = expected;
  const occupied = await page.evaluate(`() => Array.from(document.querySelectorAll('input[placeholder*="标题"], input[placeholder*="赞"]')).some(el => el.offsetParent !== null && el.value.trim())`);
  if (occupied) throw new CommandExecutionError('An existing editor is populated. Inspect it before starting another publish call.');
  if (expected.draft) {
    const entries = await readDraftEntries(page, 'image');
    page.publishBaseline = new Set(entries.map(entry => encodeDraftKey(entry.key)));
    return;
  }
  const rows = await readPosted(page);
  page.publishBaseline = new Set(rows.map(row => row.id));
  await routeCreator(page, '/publish/publish?from=menu_left&target=image');
}
export async function prepareSubmit(page) {
  await selectDeclaration(page, page.args['content-declaration']);
}
export async function finishPublish(page, { draft }) {
  if (draft) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const entries = await readDraftEntries(page, 'image');
      const rows = entries.map(entry => normalizeDraftRecord(entry.row, entry.key, 'image', 0));
      const matches = rows.filter(row => !page.publishBaseline.has(row.id) && row.title === page.publishExpected.title && row.images === page.publishExpected.imageCount);
      if (matches.length === 1) return { status: 'draft_saved', draft_id: matches[0].id, title: matches[0].title, image_count: matches[0].images, verification: 'local_draft_database' };
      if (matches.length > 1) break;
      await page.wait(0.5);
    }
    throw new CliError('OUTCOME_UNKNOWN', 'Draft submission was dispatched but saving could not be verified. Inspect the draft box; do not automatically retry.');
  }
  const rows = await readPosted(page);
  const matches = rows.filter(row => !page.publishBaseline.has(row.id) && row.title === page.publishExpected.title && row.image_count === page.publishExpected.imageCount);
  if (matches.length === 1) return publishReceipt(matches[0]);
  throw new CliError('OUTCOME_UNKNOWN', 'Submission was dispatched but no unique new note was verified. Check publish-status or the manager; do not automatically republish.');
}
export async function getPublishStatus(page, args) {
  const id = args['note-id'];
  if (!/^[a-f0-9]{24}$/i.test(id || '')) throw new ArgumentError('note-id must be a 24 character hexadecimal ID');
  await page.installInterceptor('/api/galaxy/v2/creator/note/user/posted');
  await page.goto('https://creator.xiaohongshu.com/new/note-manager');
  let rows;
  try { rows = await readPosted(page, { navigate: false, installed: true }); }
  catch { rows = await readPosted(page); }
  const row = rows.find(row => row.id === id);
  if (!row) return { note_id: id, status: 'not_in_recent_page', verified: false, scope: 'recent_creator_notes_page' };
  return { ...publishReceipt(row), verified: true };
}
