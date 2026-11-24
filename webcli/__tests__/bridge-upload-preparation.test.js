import { it, expect, vi, beforeEach } from 'vitest';
vi.mock('../prepare-upload-files.js', () => ({ prepareUploadFiles: vi.fn() }));
import { prepareUploadFiles } from '../prepare-upload-files.js';
import { WebSocketBridge } from '../bridge.js';

beforeEach(() => vi.resetAllMocks());
const bridge = () => Object.create(WebSocketBridge.prototype);

it('replies only to the requester with prepared metadata and correlation id', async () => {
  const result = { files: [{ name: 'fixture.txt', size: 3 }], preparation: { decrypted: 1 } };
  prepareUploadFiles.mockResolvedValue(result);
  const ws = { readyState: 1, send: vi.fn() };
  await bridge()._handlePrepareUploadFiles({ id: 'fixture-request', paths: ['/fixture.txt'] }, ws);
  expect(prepareUploadFiles).toHaveBeenCalledExactlyOnceWith(['/fixture.txt'], false);
  expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({ type: 'prepare_upload_files_result', id: 'fixture-request', ok: true, result });
});

it('reports preparation failure without retrying', async () => {
  prepareUploadFiles.mockRejectedValue(Object.assign(new Error('fixture failure'), { code: 'UPLOAD_ENCRYPTION_FAILED' }));
  const ws = { readyState: 1, send: vi.fn() };
  await bridge()._handlePrepareUploadFiles({ id: 'fixture-request', paths: ['/fixture.txt'] }, ws);
  expect(prepareUploadFiles).toHaveBeenCalledTimes(1);
  expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({ ok: false, code: 'UPLOAD_ENCRYPTION_FAILED' });
});

it('does not attempt to send after the requester disconnects', async () => {
  const ws = { readyState: 1, send: vi.fn() };
  prepareUploadFiles.mockImplementation(async () => { ws.readyState = 3; return { files: [] }; });
  await bridge()._handlePrepareUploadFiles({ paths: ['/fixture.txt'] }, ws);
  expect(ws.send).not.toHaveBeenCalled();
});
