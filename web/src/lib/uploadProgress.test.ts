import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadConflictError, uploadFile } from './api';
import { mockUploadRequests, UploadRequestMock } from '../test/UploadRequestMock';

beforeEach(mockUploadRequests);
afterEach(() => vi.unstubAllGlobals());

const item = () => ({ file: new File(['0123456789'], 'file.txt'), relativePath: 'folder/file.txt' });

describe('upload transport', () => {
  it('reports file byte progress and waits for the server after sending the request', async () => {
    const progress = vi.fn();
    const settled = vi.fn();
    const pending = uploadFile(item(), 'shared folder', 'overwrite', progress).then(settled);
    const request = UploadRequestMock.requests[0];
    expect(request.open).toHaveBeenCalledWith('POST', '/api/files?path=shared+folder&conflict=overwrite');
    expect(progress).toHaveBeenLastCalledWith({ loaded: 0, total: 10, phase: 'uploading' });
    request.progress(100, 200);
    expect(progress).toHaveBeenLastCalledWith({ loaded: 5, total: 10, phase: 'uploading' });
    request.transferred();
    expect(progress).toHaveBeenLastCalledWith({ loaded: 10, total: 10, phase: 'saving' });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    request.respond(200, { path: 'shared folder/folder/file.txt', size: 10 });
    await pending;
    expect(settled).toHaveBeenCalledWith({ path: 'shared folder/folder/file.txt', size: 10 });
  });

  it('uses indeterminate progress when the request length is unavailable', async () => {
    const progress = vi.fn();
    const pending = uploadFile(item(), '', 'fail', progress);
    const request = UploadRequestMock.requests[0];
    request.progress(100, 0, false);
    expect(progress).toHaveBeenLastCalledWith({ loaded: null, total: 10, phase: 'uploading' });
    request.transferred();
    expect(progress).toHaveBeenLastCalledWith({ loaded: 10, total: 10, phase: 'saving' });
    request.respond(200, { path: 'folder/file.txt', size: 10 });
    await pending;
  });

  it('handles empty files without NaN progress', async () => {
    const progress = vi.fn();
    const pending = uploadFile({ file: new File([], 'empty'), relativePath: 'empty' }, '', 'fail', progress);
    const request = UploadRequestMock.requests[0];
    request.progress(20, 40);
    expect(progress).toHaveBeenLastCalledWith({ loaded: 0, total: 0, phase: 'uploading' });
    request.transferred();
    expect(progress).toHaveBeenLastCalledWith({ loaded: 0, total: 0, phase: 'saving' });
    request.respond(200, { path: 'empty', size: 0 });
    await pending;
  });

  it('preserves the conflict error for the rename and overwrite dialog', async () => {
    const pending = uploadFile(item(), '');
    const rejected = expect(pending).rejects.toBeInstanceOf(UploadConflictError);
    UploadRequestMock.requests[0].respond(409, { message: 'folder/file.txt' });
    await rejected;
  });

  it.each([
    [413, null, '上传失败：HTTP 413'],
    [500, { message: '磁盘空间不足' }, '磁盘空间不足'],
    [200, null, '无效响应'],
  ])('rejects HTTP %s without reporting success', async (status, response, message) => {
    const pending = uploadFile(item(), '');
    const rejected = expect(pending).rejects.toThrow(message);
    UploadRequestMock.requests[0].respond(status, response);
    await rejected;
  });

  it.each(['onerror', 'onabort', 'ontimeout'] as const)('settles the request on %s', async (event) => {
    const pending = uploadFile(item(), '');
    const rejected = expect(pending).rejects.toBeInstanceOf(Error);
    UploadRequestMock.requests[0][event]?.();
    await rejected;
  });
});
