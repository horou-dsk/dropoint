import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const notes = { name: 'notes.txt', path: 'notes.txt', kind: 'file', size: 12, modified: null, mime: 'text/plain' };
const folder = { name: 'Documents', path: 'Documents', kind: 'directory', size: 0, modified: null, mime: null };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeAll(() => {
  // jsdom has no dialog top layer; real focus trapping and layout are checked in the browser.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  vi.stubGlobal('WebSocket', class { close() {} });
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url === '/api/info') return Promise.resolve(json({ name: 'Shared' }));
    if (url.startsWith('/api/files/preview')) return Promise.resolve(new Response('Preview text'));
    if (url.includes('path=Documents')) return Promise.resolve(json({ path: 'Documents', entries: [] }));
    return Promise.resolve(json({ path: '', entries: [folder, notes] }));
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('file workspace', () => {
  it.each(['列表视图', '图标视图'])('selects on click and previews only on double click in %s', async (view) => {
    render(<App />);
    await screen.findByRole('button', { name: 'notes.txt' });
    fireEvent.click(screen.getByRole('button', { name: view }));
    expect(screen.getByRole('button', { name: view })).toHaveAttribute('aria-pressed', 'true');

    const file = screen.getByRole('button', { name: 'notes.txt' });
    fireEvent.click(file);
    expect(file).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/preview'))).toBe(false);

    fireEvent.doubleClick(file);
    const dialog = await screen.findByRole('dialog', { name: 'notes.txt' });
    expect(await within(dialog).findByText('Preview text')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: '下载' })).toHaveAttribute('href', '/api/files/download?path=notes.txt');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭预览' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['列表视图', '图标视图'])('opens folders only on double click in %s', async (view) => {
    render(<App />);
    await screen.findByRole('button', { name: 'Documents' });
    fireEvent.click(screen.getByRole('button', { name: view }));
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    expect(screen.getByRole('button', { name: '返回上级' })).toBeDisabled();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('path=Documents'))).toBe(false);

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Documents' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '返回上级' })).toBeEnabled());
    expect(screen.getByText('这个目录还是空的，拖入文件开始分享吧。')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回上级' }));
    expect(await screen.findByRole('button', { name: 'notes.txt' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('preserves selection across views and clears it on blank space', async () => {
    render(<App />);
    const file = await screen.findByRole('button', { name: 'notes.txt' });
    fireEvent.click(file);
    fireEvent.click(screen.getByRole('button', { name: '图标视图' }));
    expect(screen.getByRole('button', { name: 'notes.txt' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('region', { name: '文件内容' }));
    expect(screen.getByRole('button', { name: 'notes.txt' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps a closed preview closed when its request finishes later', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, options) => String(url).includes('/preview') ? pending : original(url, options));

    render(<App />);
    fireEvent.doubleClick(await screen.findByRole('button', { name: 'notes.txt' }));
    expect(screen.getByText('正在加载预览…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }));
    await act(async () => { finish(new Response('late response')); await pending; });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('theme', () => {
  it('uses the system theme initially and remembers an explicit change', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    const { unmount } = render(<App />);
    await screen.findByRole('button', { name: 'notes.txt' });
    expect(document.documentElement).toHaveClass('dark');
    fireEvent.click(screen.getByRole('button', { name: '切换到浅色模式' }));
    expect(document.documentElement).not.toHaveClass('dark');
    expect(localStorage.getItem('dropoint-theme')).toBe('light');

    unmount();
    render(<App />);
    await screen.findByRole('button', { name: 'notes.txt' });
    expect(document.documentElement).not.toHaveClass('dark');
    fireEvent.click(screen.getByRole('button', { name: '切换到深色模式' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('dropoint-theme')).toBe('dark');
  });
});
