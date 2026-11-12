import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { completePageUpload } from '../host-page.js';

describe('page upload continuations', () => {
  for (const serialized of [false, true]) {
    const complete = serialized ? vm.runInNewContext(`(${completePageUpload.toString()})`, { setTimeout }) : completePageUpload;
    const action = { __cdp_action: 'set_file_input', selector: '#upload', files: ['C:\\fixture.txt'] };
    it(`uploads once then invokes the existing same-Adapter callback (serialized=${serialized})`, async () => {
      const helper = vi.fn(async () => ({ success: true }));
      const after = vi.fn(async () => ({ verified: true }));
      const handlers = new Map([['example.com.finish', after]]);
      expect(await complete({ ...action, __after: { toolName: 'example.com.finish', delay: 1 } }, handlers, 'example.com', helper)).toEqual({ verified: true });
      expect(helper).toHaveBeenCalledExactlyOnceWith('set_file_input', { selector: '#upload', files: action.files });
      expect(after).toHaveBeenCalledExactlyOnceWith({});
      expect(helper.mock.invocationCallOrder[0]).toBeLessThan(after.mock.invocationCallOrder[0]);
    });
    it(`rejects malformed or foreign callbacks before uploading (serialized=${serialized})`, async () => {
      const helper = vi.fn();
      const handlers = new Map([['other.com.finish', () => {}]]);
      for (const after of [{ toolName: 'other.com.finish' }, { toolName: 'example.com.missing' }, null]) {
        await expect(complete({ ...action, __after: after }, handlers, 'example.com', helper)).rejects.toMatchObject({ code: 'HOST_INVALID_CONTINUATION' });
      }
      expect(helper).not.toHaveBeenCalled();
    });
    it(`does not retry uploads, failed callbacks or nested continuations (serialized=${serialized})`, async () => {
      const after = vi.fn(async () => { throw new Error('verification failed'); });
      const handlers = new Map([['example.com.finish', after]]);
      const helper = vi.fn(async () => ({ success: true }));
      const input = { ...action, __after: { toolName: 'example.com.finish' } };
      await expect(complete(input, handlers, 'example.com', helper)).rejects.toThrow('verification failed');
      expect(helper).toHaveBeenCalledTimes(1);
      expect(after).toHaveBeenCalledTimes(1);
      helper.mockRejectedValueOnce(new Error('upload failed'));
      await expect(complete(input, handlers, 'example.com', helper)).rejects.toThrow('upload failed');
      expect(helper).toHaveBeenCalledTimes(2);
      expect(after).toHaveBeenCalledTimes(1);
      after.mockResolvedValueOnce(action);
      await expect(complete(input, handlers, 'example.com', helper)).rejects.toMatchObject({ code: 'HOST_INVALID_CONTINUATION' });
      expect(helper).toHaveBeenCalledTimes(3);
    });
  }
});
