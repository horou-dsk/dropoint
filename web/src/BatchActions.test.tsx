import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { FileEntry } from './lib/api';

const files: FileEntry[] = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((name, index) => ({
  name, path: name, kind: 'file', size: index + 1, modified: index, mime: 'text/plain',
}));
const folder: FileEntry = { name: 'Folder', path: 'Folder', kind: 'directory', size: 0, modified: null, mime: null };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const item = (name: string) => screen.getByRole('button', { name });
const selected = (name: string) => expect(item(name)).toHaveAttribute('aria-pressed', 'true');
const unselected = (name: string) => expect(item(name)).toHaveAttribute('aria-pressed', 'false');
const actionCalls = (action: string) => vi.mocked(fetch).mock.calls.filter(([url]) => url === `/api/files/${action}`);

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  vi.stubGlobal('WebSocket', class { close() {} });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
    if (url === '/api/info') return json({ name: 'Shared' });
    if (url === '/api/files/archive') return json({ url: '/api/files/archive/test-id', filename: 'selection.zip' });
    if (url.includes('path=Folder')) return json({ path: 'Folder', entries: [] });
    return json({ path: '', entries: [...files, folder] });
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('Finder selection', () => {
  it.each(['列表视图', '图标视图'])('supports toggle, range and additive range selection in %s', async (view) => {
    render(<App />);
    await screen.findByRole('button', { name: 'a.txt' });
    fireEvent.click(item(view));
    fireEvent.click(item('b.txt'), { shiftKey: true });
    selected('b.txt');
    unselected('a.txt');
    fireEvent.click(item('d.txt'), { ctrlKey: true });
    selected('b.txt'); selected('d.txt');
    fireEvent.click(item('b.txt'), { metaKey: true });
    unselected('b.txt'); selected('d.txt');
    fireEvent.click(item('a.txt'));
    fireEvent.click(item('c.txt'), { shiftKey: true });
    selected('a.txt'); selected('b.txt'); selected('c.txt'); unselected('d.txt');
    fireEvent.click(item('d.txt'), { ctrlKey: true, shiftKey: true });
    files.forEach((file) => selected(file.name));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('uses the displayed sort order and preserves selection across refresh and view changes', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'a.txt' });
    fireEvent.click(item('a.txt'));
    fireEvent.change(screen.getByRole('combobox', { name: '文件排序' }), { target: { value: 'name-desc' } });
    fireEvent.click(item('c.txt'), { shiftKey: true });
    selected('a.txt'); selected('b.txt'); selected('c.txt'); unselected('d.txt');
    fireEvent.click(item('图标视图'));
    fireEvent.click(item('刷新'));
    await screen.findByRole('button', { name: 'a.txt' });
    selected('a.txt'); selected('b.txt'); selected('c.txt');
    fireEvent.doubleClick(item('Folder'));
    await screen.findByText('这个目录还是空的，拖入文件开始分享吧。');
    fireEvent.click(item('返回上级'));
    await screen.findByRole('button', { name: 'a.txt' });
    files.forEach((file) => unselected(file.name));
  });

  it('limits select-all to the file panel and keeps chat shortcuts local', async () => {
    render(<App />);
    await screen.findByRole('button', { name: 'a.txt' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'a', ctrlKey: true });
    files.forEach((file) => unselected(file.name));
    fireEvent.keyDown(screen.getByRole('region', { name: '文件内容' }), { key: 'a', metaKey: true });
    files.forEach((file) => selected(file.name));
    selected('Folder');
    fireEvent.keyDown(item('a.txt'), { key: 'Escape' });
    files.forEach((file) => unselected(file.name));
  });
});

describe('context menu and downloads', () => {
  it.each(['列表视图', '图标视图'])('keeps selected groups on right click and replaces them for another item in %s', async (view) => {
    render(<App />);
    await screen.findByRole('button', { name: 'a.txt' });
    fireEvent.click(item(view));
    fireEvent.click(item('a.txt'));
    fireEvent.click(item('b.txt'), { ctrlKey: true });
    fireEvent.contextMenu(item('a.txt'));
    selected('a.txt'); selected('b.txt');
    expect(screen.getByRole('menuitem', { name: '下载所选项目' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '预览' })).not.toBeInTheDocument();
    fireEvent.contextMenu(item('c.txt'));
    unselected('a.txt'); unselected('b.txt'); selected('c.txt');
    expect(screen.getByRole('menuitem', { name: '预览' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(item('c.txt')).toHaveFocus();
  });

  it('provides a blank-area menu without altering selection, and dismisses on scroll or outside click', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }));
    const region = screen.getByRole('region', { name: '文件内容' });
    fireEvent.contextMenu(region);
    selected('a.txt');
    fireEvent.click(screen.getByRole('menuitem', { name: '全选' }));
    files.forEach((file) => selected(file.name));
    fireEvent.contextMenu(region);
    fireEvent.scroll(region);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.contextMenu(region);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.contextMenu(region);
    fireEvent.click(screen.getByRole('menuitem', { name: '取消选择' }));
    files.forEach((file) => unselected(file.name));
  });

  it('opens the menu by keyboard and supports arrow navigation', async () => {
    render(<App />);
    const file = await screen.findByRole('button', { name: 'a.txt' });
    fireEvent.keyDown(file, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menuitem', { name: '预览' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: '下载' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' });
    expect(screen.getByRole('menuitem', { name: '删除' })).toHaveFocus();
  });

  it('downloads one file directly and folders or groups as a ZIP', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }));
    fireEvent.click(item('下载所选项目'));
    expect(actionCalls('archive')).toHaveLength(0);
    const clicks = vi.mocked(HTMLAnchorElement.prototype.click);
    expect((clicks.mock.instances[0] as HTMLAnchorElement).getAttribute('href')).toBe('/api/files/download?path=a.txt');
    fireEvent.click(item('Folder'));
    fireEvent.click(item('下载所选项目'));
    await screen.findByText('ZIP 已开始下载');
    expect(JSON.parse(actionCalls('archive')[0][1]!.body as string)).toEqual({ paths: ['Folder'] });
    expect((clicks.mock.instances[1] as HTMLAnchorElement).getAttribute('href')).toBe('/api/files/archive/test-id');
    fireEvent.click(item('a.txt'));
    fireEvent.click(item('b.txt'), { metaKey: true });
    fireEvent.contextMenu(item('a.txt'));
    // The menu must keep its original action targets, even if the selection changes before activation.
    fireEvent.click(item('c.txt'));
    fireEvent.click(screen.getByRole('menuitem', { name: '下载所选项目' }));
    await waitFor(() => expect(actionCalls('archive')).toHaveLength(2));
    expect(JSON.parse(actionCalls('archive')[1][1]!.body as string)).toEqual({ paths: ['a.txt', 'b.txt'] });
    await screen.findByText('ZIP 已开始下载');
  });

  it('disables duplicate packing and allows retry after an archive failure', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => url === '/api/files/archive' ? pending : original(url, options));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Folder' }));
    fireEvent.click(item('下载所选项目'));
    expect(item('正在打包…')).toBeDisabled();
    await act(async () => { finish(json({ message: '无法打包链接：Folder/link' }, 400)); await pending; });
    expect(await screen.findByRole('alert')).toHaveTextContent('Folder/link');
    expect(item('下载所选项目')).toBeEnabled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });
});

describe('permanent deletion', () => {
  it('clears successfully deleted selections even if directory refresh fails', async () => {
    let deleted = false;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => {
      if (url === '/api/files/delete') {
        deleted = true;
        return Promise.resolve(json({ deleted: ['a.txt'], failed: [] }));
      }
      if (url === '/api/files' && deleted) return Promise.resolve(json({ message: '读取失败' }, 500));
      return original(url, options);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }));
    fireEvent.click(item('删除所选项目'));
    fireEvent.click(item('永久删除'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('读取目录失败');
    unselected('a.txt');
    expect(item('删除所选项目')).toBeDisabled();
  });

  it('requires confirmation and sends no request when cancelled', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Folder' }));
    fireEvent.contextMenu(item('Folder'));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    const dialog = screen.getByRole('dialog', { name: '永久删除 1 个项目？' });
    expect(within(dialog).getByText(/所有内容将一并永久删除/)).toBeInTheDocument();
    expect(actionCalls('delete')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(actionCalls('delete')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    selected('Folder');
  });

  it('freezes the confirmed targets, prevents repeat submission, and retains failed selections after refresh', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    let refreshed = false;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => {
      if (url === '/api/files/delete') return pending;
      if (url === '/api/files' && refreshed) return Promise.resolve(json({ path: '', entries: [...files.slice(1), folder] }));
      return original(url, options);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'a.txt' }));
    fireEvent.click(item('b.txt'), { ctrlKey: true });
    fireEvent.click(item('删除所选项目'));
    fireEvent.click(item('永久删除'));
    expect(item('正在删除…')).toBeDisabled();
    expect(item('取消')).toBeDisabled();
    fireEvent.click(item('正在删除…'));
    expect(actionCalls('delete')).toHaveLength(1);
    expect(JSON.parse(actionCalls('delete')[0][1]!.body as string)).toEqual({ paths: ['a.txt', 'b.txt'] });
    refreshed = true;
    await act(async () => { finish(json({ deleted: ['a.txt'], failed: [{ path: 'b.txt', message: '文件被占用' }] })); await pending; });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('b.txt：文件被占用');
    expect(screen.queryByRole('button', { name: 'a.txt' })).not.toBeInTheDocument();
    selected('b.txt');
  });
});
