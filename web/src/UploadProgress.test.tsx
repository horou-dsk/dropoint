import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { mockUploadRequests, UploadRequestMock } from './test/UploadRequestMock';

const folder = { name: 'Folder', path: 'Folder', kind: 'directory', size: 0, modified: null, mime: null };
const json = (value: unknown) => new Response(JSON.stringify(value));
const file = (name: string, size: number) => new File([new Uint8Array(size)], name);
const currentBar = () => screen.getByRole('progressbar', { name: '当前文件上传进度' });
const totalBar = () => screen.getByRole('progressbar', { name: '总上传进度' });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  vi.stubGlobal('WebSocket', class { close() {} });
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url === '/api/info') return Promise.resolve(json({ name: 'Shared' }));
    return Promise.resolve(json({ path: url.includes('path=Folder') ? 'Folder' : '', entries: url.includes('path=Folder') ? [] : [folder] }));
  }));
  mockUploadRequests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function start(files: File[]) {
  render(<App />);
  await screen.findByRole('button', { name: 'Folder' });
  fireEvent.change(screen.getByLabelText('上传文件', { selector: 'input' }), { target: { files } });
  await waitFor(() => expect(UploadRequestMock.requests).toHaveLength(1));
  return UploadRequestMock.requests[0];
}

describe('upload progress UI', () => {
  it('shows byte-weighted total progress and only finishes after server confirmation', async () => {
    const first = await start([file('one.txt', 100), file('two.txt', 300)]);
    act(() => first.progress(50, 100));
    expect(currentBar()).toHaveAttribute('aria-valuenow', '50');
    expect(totalBar()).toHaveAttribute('aria-valuenow', '12');
    expect(screen.getByText('50 B / 100 B')).toBeInTheDocument();
    act(() => first.transferred());
    expect(screen.getByText('等待服务端保存 1/2')).toBeInTheDocument();
    expect(UploadRequestMock.requests).toHaveLength(1);
    await act(async () => first.respond(200, { path: 'one.txt', size: 100 }));
    const second = UploadRequestMock.requests[1];
    expect(currentBar()).toHaveAttribute('aria-valuenow', '0');
    expect(totalBar()).toHaveAttribute('aria-valuenow', '25');
    act(() => second.progress(50, 100));
    expect(totalBar()).toHaveAttribute('aria-valuenow', '62');
    act(() => second.transferred());
    expect(totalBar()).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('等待服务端保存 2/2')).toBeInTheDocument();
    expect(screen.queryByText(/上传结束/)).not.toBeInTheDocument();
    await act(async () => second.respond(200, { path: 'two.txt', size: 300 }));
    expect(screen.getByText('上传结束：成功 2/2 个文件')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传文件' })).toBeEnabled();
  });

  it('asks about a known conflict before sending the file', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => {
      if (String(url).startsWith('/api/files/conflict')) {
        return Promise.resolve(json({ exists: true, path: 'one.txt' }));
      }
      return original(url, options);
    });

    render(<App />);
    await screen.findByRole('button', { name: 'Folder' });
    fireEvent.change(screen.getByLabelText('上传文件', { selector: 'input' }), { target: { files: [file('one.txt', 100)] } });
    expect(await screen.findByRole('dialog', { name: '发现同名文件' })).toBeInTheDocument();
    expect(UploadRequestMock.requests).toHaveLength(0);

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '覆盖' }));
    await waitFor(() => expect(UploadRequestMock.requests).toHaveLength(1));
    expect(UploadRequestMock.requests[0].open).toHaveBeenCalledWith('POST', '/api/files?conflict=overwrite');
  });

  it.each(['重命名', '覆盖'])('resets only the current file when choosing %s', async (choice) => {
    const first = await start([file('one.txt', 100), file('two.txt', 100)]);
    await act(async () => first.respond(200, { path: 'one.txt', size: 100 }));
    const second = UploadRequestMock.requests[1];
    act(() => second.transferred());
    await act(async () => second.respond(409, { message: 'two.txt' }));
    expect(screen.getByText('等待处理同名文件 2/2')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: '发现同名文件' });
    fireEvent.click(within(dialog).getByRole('button', { name: choice }));
    await waitFor(() => expect(UploadRequestMock.requests).toHaveLength(3));
    const retry = UploadRequestMock.requests[2];
    expect(retry.open).toHaveBeenCalledWith('POST', `/api/files?conflict=${choice === '重命名' ? 'rename' : 'overwrite'}`);
    expect(currentBar()).toHaveAttribute('aria-valuenow', '0');
    expect(totalBar()).toHaveAttribute('aria-valuenow', '50');
    await act(async () => retry.respond(200, { path: 'two.txt', size: 100 }));
    expect(screen.getByText('上传结束：成功 2/2 个文件')).toBeInTheDocument();
  });

  it('keeps failures visible after directory refresh and does not count them as completed', async () => {
    const first = await start([file('one.txt', 100), file('two.txt', 300)]);
    act(() => first.progress(50, 100));
    await act(async () => first.onerror?.());
    expect(totalBar()).toHaveAttribute('aria-valuenow', '0');
    const second = UploadRequestMock.requests[1];
    await act(async () => second.respond(200, { path: 'two.txt', size: 300 }));
    expect(screen.getByRole('alert')).toHaveTextContent('上传结束：成功 1/2 个文件；失败 1 个：one.txt');
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByRole('button', { name: 'Folder' });
    expect(screen.getByRole('alert')).toHaveTextContent('网络连接中断');
  });

  it('refreshes completed files and stops the batch when a conflict is cancelled', async () => {
    const first = await start([file('one.txt', 100), file('two.txt', 100), file('three.txt', 100)]);
    await act(async () => first.respond(200, { path: 'one.txt', size: 100 }));
    await act(async () => UploadRequestMock.requests[1].respond(409, { message: 'two.txt' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
    await screen.findByText('已取消剩余上传，已完成 1/3 个文件');
    expect(UploadRequestMock.requests).toHaveLength(2);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/files')).toHaveLength(2);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('prevents overlapping batches and keeps the original destination while browsing', async () => {
    const first = await start([file('one.txt', 100), file('two.txt', 100)]);
    expect(screen.getByRole('button', { name: '上传文件' })).toBeDisabled();
    fireEvent.drop(screen.getByRole('region', { name: '共享文件' }), { dataTransfer: { items: [], files: [file('extra.txt', 100)] } });
    expect(UploadRequestMock.requests).toHaveLength(1);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Folder' }));
    await screen.findByText('这个目录还是空的，拖入文件开始分享吧。');
    await act(async () => first.respond(200, { path: 'one.txt', size: 100 }));
    const second = UploadRequestMock.requests[1];
    expect(second.open).toHaveBeenCalledWith('POST', '/api/files');
    await act(async () => second.respond(200, { path: 'two.txt', size: 100 }));
    expect(screen.getByText('这个目录还是空的，拖入文件开始分享吧。')).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe('/api/files?path=Folder');
  });

  it('renders indeterminate progress and empty-file progress without invalid percentages', async () => {
    const request = await start([file('empty', 0)]);
    expect(currentBar()).toHaveAttribute('aria-valuenow', '0');
    act(() => request.progress(20, 0, false));
    expect(currentBar()).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByText('当前文件 进度暂不可用')).toBeInTheDocument();
    act(() => request.transferred());
    expect(currentBar()).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('等待服务端保存 1/1')).toBeInTheDocument();
    await act(async () => request.respond(200, { path: 'empty', size: 0 }));
    expect(screen.getByText('上传结束：成功 1/1 个文件')).toBeInTheDocument();
  });

  it('shows a save failure even after the file has been fully transmitted', async () => {
    const request = await start([file('one.txt', 100)]);
    act(() => request.transferred());
    expect(currentBar()).toHaveAttribute('aria-valuenow', '100');
    await act(async () => request.respond(500, { message: '磁盘空间不足' }));
    expect(screen.getByRole('alert')).toHaveTextContent('上传结束：成功 0/1 个文件；失败 1 个：one.txt：磁盘空间不足');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传文件' })).toBeEnabled();
  });

  it('does not cancel an in-flight navigation when an upload completes', async () => {
    const request = await start([file('one.txt', 100)]);
    let finishNavigation!: (value: Response) => void;
    const navigation = new Promise<Response>((resolve) => { finishNavigation = resolve; });
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => String(url).includes('path=Folder') ? navigation : original(url, options));
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Folder' }));
    await act(async () => request.respond(200, { path: 'one.txt', size: 100 }));
    expect(screen.getByText('上传结束：成功 1/1 个文件')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    await act(async () => finishNavigation(json({ path: 'Folder', entries: [] })));
    expect(screen.getByText('这个目录还是空的，拖入文件开始分享吧。')).toBeInTheDocument();
    expect(window.history.state).toEqual(expect.objectContaining({ dropointPath: 'Folder' }));
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/files?path=Folder')).toHaveLength(2);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/files')).toHaveLength(1);
  });

  it.each(['success', 'failure'])('refreshes after an older directory request ends with %s', async (outcome) => {
    const upload = await start([file('one.txt', 100)]);
    const uploaded = { name: 'one.txt', path: 'one.txt', kind: 'file', size: 100, modified: null, mime: 'text/plain' };
    let finishRefresh!: (value: Response) => void;
    const oldRefresh = new Promise<Response>((resolve) => { finishRefresh = resolve; });
    let refreshCalls = 0;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => {
      if (url !== '/api/files') return original(url, options);
      refreshCalls += 1;
      return refreshCalls === 1 ? oldRefresh : Promise.resolve(json({ path: '', entries: [folder, uploaded] }));
    });

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await act(async () => upload.respond(200, { path: 'one.txt', size: 100 }));
    expect(screen.getByText('上传结束：成功 1/1 个文件')).toBeInTheDocument();
    expect(refreshCalls).toBe(1);
    await act(async () => finishRefresh(outcome === 'success'
      ? json({ path: '', entries: [folder] })
      : new Response(null, { status: 500 })));

    expect(await screen.findByRole('button', { name: 'one.txt' })).toBeInTheDocument();
    expect(refreshCalls).toBe(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('coalesces multiple completed batches into one refresh after the current request', async () => {
    const upload = await start([file('one.txt', 100)]);
    let finishRefresh!: (value: Response) => void;
    const oldRefresh = new Promise<Response>((resolve) => { finishRefresh = resolve; });
    let refreshCalls = 0;
    const uploaded = ['one.txt', 'two.txt'].map((name) => ({ name, path: name, kind: 'file', size: 100, modified: null, mime: 'text/plain' }));
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => {
      if (url !== '/api/files') return original(url, options);
      refreshCalls += 1;
      return refreshCalls === 1 ? oldRefresh : Promise.resolve(json({ path: '', entries: uploaded }));
    });

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await act(async () => upload.respond(200, { path: 'one.txt', size: 100 }));
    fireEvent.change(screen.getByLabelText('上传文件', { selector: 'input' }), { target: { files: [file('two.txt', 100)] } });
    await waitFor(() => expect(UploadRequestMock.requests).toHaveLength(2));
    await act(async () => UploadRequestMock.requests[1].respond(200, { path: 'two.txt', size: 100 }));
    expect(refreshCalls).toBe(1);
    await act(async () => finishRefresh(json({ path: '', entries: [folder] })));
    expect(await screen.findByRole('button', { name: 'two.txt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'one.txt' })).toBeInTheDocument();
    expect(refreshCalls).toBe(2);
  });

  it('lets a newer request satisfy the pending refresh and ignores the older response', async () => {
    const upload = await start([file('one.txt', 100)]);
    let finishOldRefresh!: (value: Response) => void;
    const oldRefresh = new Promise<Response>((resolve) => { finishOldRefresh = resolve; });
    let finishNewRefresh!: (value: Response) => void;
    const newRefresh = new Promise<Response>((resolve) => { finishNewRefresh = resolve; });
    let refreshCalls = 0;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => {
      if (url !== '/api/files') return original(url, options);
      refreshCalls += 1;
      return refreshCalls === 1 ? oldRefresh : newRefresh;
    });

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await act(async () => upload.respond(200, { path: 'one.txt', size: 100 }));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await act(async () => finishOldRefresh(json({ path: '', entries: [] })));
    expect(refreshCalls).toBe(2);
    expect(screen.getByText('正在打开目录…')).toBeInTheDocument();
    await act(async () => finishNewRefresh(json({ path: '', entries: [{ name: 'one.txt', path: 'one.txt', kind: 'file', size: 100, modified: null, mime: 'text/plain' }] })));
    expect(screen.getByRole('button', { name: 'one.txt' })).toBeInTheDocument();
    expect(refreshCalls).toBe(2);
  });

  it('reports a failed follow-up refresh without retrying indefinitely', async () => {
    const upload = await start([file('one.txt', 100)]);
    let finishRefresh!: (value: Response) => void;
    const oldRefresh = new Promise<Response>((resolve) => { finishRefresh = resolve; });
    let refreshCalls = 0;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => {
      if (url !== '/api/files') return original(url, options);
      refreshCalls += 1;
      return refreshCalls === 1 ? oldRefresh : Promise.resolve(new Response(null, { status: 500 }));
    });

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await act(async () => upload.respond(200, { path: 'one.txt', size: 100 }));
    await act(async () => finishRefresh(json({ path: '', entries: [folder] })));
    expect(await screen.findByRole('alert')).toHaveTextContent('读取目录失败：HTTP 500');
    expect(screen.getByText('上传结束：成功 1/1 个文件')).toBeInTheDocument();
    expect(refreshCalls).toBe(2);
  });
});
