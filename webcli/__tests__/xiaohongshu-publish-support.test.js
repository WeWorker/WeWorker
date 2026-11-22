import { it, expect, vi, afterEach } from 'vitest';
import { normalizePosted, publishReceipt, finishPublish, selectDeclaration } from '../scripts/opencli-xiaohongshu/publish-support.js';
afterEach(() => vi.unstubAllGlobals());
const oldId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const note = id => ({ id, display_title: '示例标题', images_list: [{}], tab_status: 2 });
const pageFor = notes => ({ publishBaseline: new Set([oldId]), publishExpected: { title: '示例标题', imageCount: 1 }, installInterceptor: vi.fn(), evaluate: vi.fn(), wait: vi.fn(), getInterceptedRequests: vi.fn(async () => [{ success: true, data: { notes } }]) });
it('rejects malformed creator responses', () => {
  expect(() => normalizePosted({ success: true, data: {} })).toThrow();
  expect(() => normalizePosted({ success: true, data: { notes: [{ id: 'bad' }] } })).toThrow();
});
it('does not accept a stale note or ambiguous new matches', async () => {
  vi.stubGlobal('location', { pathname: '/publish/publish' });
  for (const notes of [[note(oldId)], [note('bbbbbbbbbbbbbbbbbbbbbbbb'), note('cccccccccccccccccccccccc')]]) {
    const page = pageFor(notes);
    await expect(finishPublish(page, { draft: false })).rejects.toThrow(/do not automatically republish/);
    expect(page.getInterceptedRequests).toHaveBeenCalledTimes(1);
  }
});
it('identifies the unique new note and preserves unknown platform states', async () => {
  vi.stubGlobal('location', { pathname: '/publish/publish' });
  expect(await finishPublish(pageFor([note(oldId), note('bbbbbbbbbbbbbbbbbbbbbbbb')]), { draft: false })).toMatchObject({ note_id: 'bbbbbbbbbbbbbbbbbbbbbbbb', status: 'reviewing', image_count: 1 });
  expect(publishReceipt({ tab_status: 99 })).toMatchObject({ status: 'submitted', platform_status: 99 });
});
it('rejects unsupported declarations before touching the page', async () => {
  const page = { evaluate: vi.fn() };
  await expect(selectDeclaration(page, 'invalid')).rejects.toThrow();
  expect(page.evaluate).not.toHaveBeenCalled();
});
