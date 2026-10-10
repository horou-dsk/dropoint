import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatPanel from './ChatPanel';
import type { ChatAttachment, ChatMessage } from '../lib/api';
import { mockUploadRequests, UploadRequestMock } from '../test/UploadRequestMock';

class SocketMock {
  static OPEN = 1;
  static instances: SocketMock[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  close() {}
  constructor() { SocketMock.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

const OriginalURL = URL;
const random = crypto.getRandomValues.bind(crypto);
const fetchMock = vi.fn();
const prepareMock = vi.fn();
const keepAliveMock = vi.fn();
const attachment = (id = 'photo', name = '照片.png', mime = 'image/png'): ChatAttachment => ({
  id, name, mime, size: 10, previewUrl: mime === 'application/octet-stream' ? null : `/api/chat/attachments/${id}/preview`, downloadUrl: `/api/chat/attachments/${id}/download`,
});
const message = (text = 'hello', attachments: ChatAttachment[] = [], id = 1): ChatMessage => ({ id, text, attachments, timestamp: 1000 });
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const file = (name = '照片.png', size = 10, type = 'image/png') => new File(['x'.repeat(size)], name, { type });
const choose = (...files: File[]) => fireEvent.change(screen.getByLabelText('选择聊天附件'), { target: { files } });
const text = (value: string) => fireEvent.change(screen.getByRole('textbox'), { target: { value } });
const send = async () => { await act(async () => fireEvent.click(screen.getByRole('button', { name: '发送' }))); };
function start() { render(<ChatPanel />); act(() => SocketMock.instances[0].open()); return SocketMock.instances[0]; }
async function uploaded(index: number, metadata = attachment()) {
  await act(async () => { UploadRequestMock.requests[index].respond(200, metadata); });
}
function paste(files: File[], items: unknown[] = []) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, items, getData: () => 'plain text' } });
  fireEvent(screen.getByRole('textbox'), event);
  return event;
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
beforeEach(() => {
  SocketMock.instances = [];
  fetchMock.mockReset(); fetchMock.mockResolvedValue(response(message()));
  prepareMock.mockReset(); prepareMock.mockResolvedValue(response({ submissionToken: 'prepared-token' }));
  keepAliveMock.mockReset(); keepAliveMock.mockResolvedValue(response(null, 204));
  vi.stubGlobal('WebSocket', SocketMock);
  vi.stubGlobal('fetch', (url: string, options: unknown) => url.endsWith('/prepare') ? prepareMock(url, options)
    : url.endsWith('/keepalive') ? keepAliveMock(url, options) : fetchMock(url, options));
  vi.stubGlobal('crypto', { getRandomValues: random }); // No randomUUID on LAN HTTP.
  vi.stubGlobal('URL', class extends OriginalURL {
    static createObjectURL = vi.fn(() => `blob:preview-${Math.random()}`);
    static revokeObjectURL = vi.fn();
  });
  mockUploadRequests();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('chat drafts and confirmed submission', () => {
  it('keeps connecting drafts and clears text only after HTTP confirmation', async () => {
    let confirm!: (value: unknown) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => { confirm = resolve; }));
    render(<ChatPanel />); text('keep this text');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    act(() => SocketMock.instances[0].open()); await send();
    expect(screen.getByRole('textbox')).toHaveValue('keep this text');
    expect(screen.getByRole('textbox')).toBeDisabled();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toMatchObject({ text: 'keep this text', attachmentIds: [] });
    expect(payload.clientMessageId).toMatch(/^[a-f0-9]{32}$/);
    await act(async () => confirm(response(message('keep this text'))));
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByText('keep this text')).toBeInTheDocument();
  });

  it('preserves text/files across reconnect and early readyState changes', async () => {
    vi.useFakeTimers(); const socket = start(); text('offline draft'); choose(file());
    socket.readyState = 3; await send();
    expect(fetchMock).not.toHaveBeenCalled(); expect(UploadRequestMock.requests).toHaveLength(0);
    act(() => socket.onclose?.());
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    act(() => vi.advanceTimersByTime(2500)); act(() => SocketMock.instances[1].open());
    expect(screen.getByRole('textbox')).toHaveValue('offline draft');
    expect(screen.getByRole('list', { name: '待发送附件' })).toBeInTheDocument();
    fetchMock.mockResolvedValue(response(message('offline draft', [attachment()])));
    await send(); await uploaded(0); expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('preserves the draft and stable client ID when a response is lost, without reuploading', async () => {
    const socket = start(); text('retry me'); choose(file());
    fetchMock.mockRejectedValueOnce(new TypeError('network interrupted'));
    await send(); await uploaded(0);
    act(() => socket.receive({ type: 'message', message: message('retry me', [attachment()]) }));
    expect(screen.getByRole('textbox')).toHaveValue('retry me');
    expect(screen.getByRole('alert')).toHaveTextContent('network interrupted');
    const original = JSON.parse(fetchMock.mock.calls[0][1].body);
    fetchMock.mockResolvedValue(response(message('retry me', [attachment()])));
    await send();
    expect(UploadRequestMock.requests).toHaveLength(1);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(original);
    expect(screen.getAllByText('retry me')).toHaveLength(1);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('does not submit IME confirmation or Shift+Enter', async () => {
    start(); text('zhongwen'); fireEvent.compositionStart(screen.getByRole('textbox'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    fireEvent.compositionEnd(screen.getByRole('textbox'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled(); text('中文');
    fetchMock.mockResolvedValue(response(message('中文')));
    await act(async () => fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toBe('中文');
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('keeps ordinary text/path paste and stages screenshots without sending', () => {
    start(); text('caption'); expect(paste([]).defaultPrevented).toBe(false);
    expect(screen.getByRole('textbox')).toHaveValue('caption');
    expect(paste([file()]).defaultPrevented).toBe(true);
    expect(within(screen.getByRole('list', { name: '待发送附件' })).getByRole('img', { name: '照片.png' })).toHaveAttribute('src', expect.stringContaining('blob:preview-'));
    expect(fetchMock).not.toHaveBeenCalled(); expect(UploadRequestMock.requests).toHaveLength(0);
  });

  it('accepts file items when FileList is empty and removes/revokes previews', () => {
    start(); paste([], [{ kind: 'file', getAsFile: () => file() }]);
    fireEvent.click(screen.getByRole('button', { name: '移除 照片.png' }));
    expect(screen.queryByRole('list', { name: '待发送附件' })).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });

  it('limits picked and pasted attachments together to ten', () => {
    start(); choose(...Array.from({ length: 8 }, (_, i) => file(`picked-${i}.png`)));
    paste([file('pasted-1.png'), file('pasted-2.png'), file('pasted-3.png')]);
    expect(within(screen.getByRole('list', { name: '待发送附件' })).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByRole('alert')).toHaveTextContent('最多添加 10 个');
  });

  it('uploads attachment-only messages sequentially with weighted progress and blocks repeat sends', async () => {
    start(); const first = attachment('first'); const second = attachment('second', '文件.txt', 'application/octet-stream');
    first.size = 30; second.size = 10; choose(file('照片.png', 30), file('文件.txt', 10, 'text/plain'));
    fetchMock.mockResolvedValue(response(message('', [first, second])));
    await send(); await send(); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(UploadRequestMock.requests).toHaveLength(1);
    expect(screen.getByRole('button', { name: '添加附件' })).toBeDisabled();
    act(() => UploadRequestMock.requests[0].progress(50, 100));
    expect(screen.getByRole('progressbar', { name: '总上传进度' })).toHaveAttribute('aria-valuenow', '37');
    act(() => UploadRequestMock.requests[0].transferred()); expect(fetchMock).not.toHaveBeenCalled();
    await uploaded(0, first); expect(UploadRequestMock.requests).toHaveLength(2);
    expect(screen.getByRole('progressbar', { name: '总上传进度' })).toHaveAttribute('aria-valuenow', '75');
    await uploaded(1, second);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ text: '', attachmentIds: ['first', 'second'] });
    expect(screen.queryByRole('list', { name: '待发送附件' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: '下载' })).toHaveLength(2);
  });

  it('preserves uploads on failure and reuses earlier successes when retrying a mixed message', async () => {
    start(); text('two attachments'); choose(file('first.png'), file('second.png'));
    await send(); await uploaded(0, attachment('first', 'first.png'));
    await act(async () => UploadRequestMock.requests[1].onerror?.());
    expect(fetchMock).not.toHaveBeenCalled(); expect(screen.getByRole('textbox')).toHaveValue('two attachments');
    expect(screen.getByRole('alert')).toHaveTextContent('网络连接中断');
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
    fetchMock.mockResolvedValue(response(message('two attachments', [attachment('first'), attachment('second')])));
    await send(); await uploaded(2, attachment('second', 'second.png'));
    expect(UploadRequestMock.requests).toHaveLength(3);
    const retryForm = UploadRequestMock.requests[2].send.mock.calls[0][0] as FormData;
    expect((retryForm.get('file') as File).name).toBe('second.png');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ text: 'two attachments', attachmentIds: ['first', 'second'] });
  });

  it('invalidates expired uploads and reuploads them on the next retry', async () => {
    start(); choose(file());
    fetchMock.mockResolvedValueOnce(response({ code: 'attachment_unavailable', message: '附件已过期', attachmentIds: ['photo'] }, 410));
    await send(); await uploaded(0); expect(screen.getByRole('alert')).toHaveTextContent('附件已过期');
    expect(screen.queryByText(/已上传/)).not.toBeInTheDocument();
    fetchMock.mockResolvedValue(response(message('', [attachment('fresh')])));
    await send(); await uploaded(1, attachment('fresh'));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).attachmentIds).toEqual(['fresh']);
  });

  it('changes the submission ID after edits but keeps reusable uploads', async () => {
    start(); text('old'); choose(file()); fetchMock.mockRejectedValueOnce(new Error('failed'));
    await send(); await uploaded(0); const oldId = JSON.parse(fetchMock.mock.calls[0][1].body).clientMessageId;
    text('new'); fetchMock.mockResolvedValue(response(message('new', [attachment()])));
    await send();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).clientMessageId).not.toBe(oldId);
    expect(UploadRequestMock.requests).toHaveLength(1);
  });

  it('aborts upload and revokes previews on unmount', async () => {
    start(); choose(file()); await send(); cleanup();
    expect(UploadRequestMock.requests[0].abort).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('retains uploaded files while another file streams and stops renewal after confirmation', async () => {
    vi.useFakeTimers(); start(); choose(file('first.png'), file('second.png'));
    await send(); await uploaded(0, attachment('first', 'first.png'));
    expect(UploadRequestMock.requests).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(11 * 60_000));
    expect(keepAliveMock).toHaveBeenCalledTimes(13); // Initial, first file, eleven heartbeats.
    expect(JSON.parse(keepAliveMock.mock.calls.at(-1)![1].body).attachmentIds).toEqual(['first']);
    fetchMock.mockResolvedValue(response(message('', [attachment('first'), attachment('second')])));
    await uploaded(1, attachment('second', 'second.png'));
    const calls = keepAliveMock.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(20 * 60_000));
    expect(keepAliveMock).toHaveBeenCalledTimes(calls);
    expect(screen.queryByRole('list', { name: '待发送附件' })).not.toBeInTheDocument();
  });

  it('aborts a transfer on renewal failure, retaining the draft for retry', async () => {
    vi.useFakeTimers(); start(); text('keep me'); choose(file()); await send();
    keepAliveMock.mockRejectedValueOnce(new Error('续期连接中断'));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(UploadRequestMock.requests[0].abort).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('续期连接中断');
    expect(screen.getByRole('textbox')).toHaveValue('keep me');
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
    const calls = keepAliveMock.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(20 * 60_000));
    expect(keepAliveMock).toHaveBeenCalledTimes(calls);
  });

  it('renews an abandoned uncommitted reservation and reuploads expired files in the same retry', async () => {
    start(); choose(file('first.png'), file('second.png')); await send();
    await uploaded(0, attachment('first', 'first.png'));
    await act(async () => UploadRequestMock.requests[1].onerror?.());
    keepAliveMock.mockResolvedValueOnce(response({ code: 'submission_expired', message: '凭证失效' }, 410))
      .mockResolvedValueOnce(response({ code: 'attachment_unavailable', message: '附件过期', attachmentIds: ['first'] }, 410));
    await send();
    expect(prepareMock).toHaveBeenCalledTimes(2);
    expect(UploadRequestMock.requests).toHaveLength(3);
    expect((UploadRequestMock.requests[2].send.mock.calls[0][0] as FormData).get('file')).toHaveProperty('name', 'first.png');
    await uploaded(2, attachment('fresh-first', 'first.png'));
    await uploaded(3, attachment('fresh-second', 'second.png'));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).attachmentIds).toEqual(['fresh-first', 'fresh-second']);
  });

  it('bounds stalled renewal requests and unlocks the draft after timeout', async () => {
    vi.useFakeTimers(); start(); choose(file()); await send();
    keepAliveMock.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    await act(async () => vi.advanceTimersByTimeAsync(60_000 + 15_000));
    expect(screen.getByRole('alert')).toHaveTextContent('附件续期超时');
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
    expect(UploadRequestMock.requests[0].abort).toHaveBeenCalledTimes(1);
    await send();
    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(UploadRequestMock.requests).toHaveLength(2);
  });

  it('rejects expired confirmation retries without preparing or sending a duplicate message', async () => {
    start(); text('possibly sent'); fetchMock.mockRejectedValueOnce(new Error('response lost'));
    await send();
    keepAliveMock.mockResolvedValueOnce(response({ code: 'submission_expired', message: '请核对聊天记录' }, 410));
    await send();
    expect(prepareMock).toHaveBeenCalledTimes(1); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox')).toHaveValue('possibly sent');
    expect(screen.getByRole('alert')).toHaveTextContent('请核对聊天记录');
    text('new message'); await send();
    expect(prepareMock).toHaveBeenCalledTimes(2); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves the draft when the reservation cache is full', async () => {
    start(); text('pending'); choose(file());
    prepareMock.mockResolvedValueOnce(response({ code: 'submission_capacity', message: '待发送消息过多' }, 429));
    await send();
    expect(screen.getByRole('alert')).toHaveTextContent('待发送消息过多');
    expect(screen.getByRole('textbox')).toHaveValue('pending');
    expect(UploadRequestMock.requests).toHaveLength(0);
    await send(); expect(UploadRequestMock.requests).toHaveLength(1);
  });
});

describe('chat history and media', () => {
  it('deduplicates HTTP responses and WebSocket history/events in either order', async () => {
    const socket = start(); text('hello'); await send();
    act(() => socket.receive({ type: 'history', messages: [] }));
    expect(screen.getAllByText('hello')).toHaveLength(1);
    act(() => socket.receive({ type: 'message', message: message() }));
    expect(screen.getAllByText('hello')).toHaveLength(1);
  });

  it('shows thumbnails, native video/audio controls, download cards and a full-size image dialog', () => {
    const socket = start();
    const media = [attachment(), attachment('video', 'clip.mp4', 'video/mp4'), attachment('audio', 'recording.mp3', 'audio/mpeg'), attachment('file', 'document.pdf', 'application/octet-stream')];
    act(() => socket.receive({ type: 'history', messages: [message('caption', media)] }));
    expect(screen.getByRole('img', { name: '照片.png' })).toHaveAttribute('src', media[0].previewUrl);
    expect(screen.getByLabelText('clip.mp4')).toHaveAttribute('controls');
    expect(screen.getByLabelText('recording.mp3')).toHaveAttribute('controls');
    expect(screen.getAllByRole('link', { name: '下载' })).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: '预览 照片.png' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('img')).toHaveAttribute('src', media[0].previewUrl);
    expect(within(dialog).getByRole('link', { name: '下载' })).toHaveAttribute('href', media[0].downloadUrl);
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' })); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['image/png', 'video/mp4', 'audio/mpeg'])('offers a download when %s fails to decode', (mime) => {
    const socket = start(); const media = attachment('broken', 'broken-media', mime);
    act(() => socket.receive({ type: 'message', message: message('', [media]) }));
    fireEvent.error(mime.startsWith('image/') ? screen.getByRole('img') : screen.getByLabelText(media.name));
    expect(screen.getByRole('alert')).toHaveTextContent('无法加载或播放');
    expect(screen.getByRole('link', { name: '下载后打开' })).toHaveAttribute('href', media.downloadUrl);
  });

  it('caps live history at 200 and replaces obsolete messages after reconnect', () => {
    vi.useFakeTimers(); const socket = start();
    act(() => socket.receive({ type: 'history', messages: Array.from({ length: 200 }, (_, i) => message(`message-${i}`, [], i + 1)) }));
    act(() => socket.receive({ type: 'message', message: message('newest', [], 201) }));
    expect(screen.queryByText('message-0')).not.toBeInTheDocument(); expect(screen.getByText('newest')).toBeInTheDocument();
    act(() => socket.onclose?.()); act(() => vi.advanceTimersByTime(2500));
    act(() => { SocketMock.instances[1].open(); SocketMock.instances[1].receive({ type: 'history', messages: [] }); });
    expect(screen.queryByText('newest')).not.toBeInTheDocument();
  });
});
