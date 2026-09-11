import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ConflictMode,
  type DirectoryListing,
  type FileEntry,
  UploadConflictError,
  getDirectoryInfo,
  listFiles,
  uploadFile,
} from './lib/api';
import { useTheme } from './lib/useTheme';
import { collectDroppedFiles, filesForUpload, type UploadItem } from './lib/uploads';
import ChatPanel from './components/ChatPanel';
import FileBrowser, { type FileView } from './components/FileBrowser';
import PreviewDialog from './components/PreviewDialog';

type ConflictChoice = ConflictMode | 'cancel';
type ConflictPrompt = { path: string; resolve: (choice: ConflictChoice) => void };

export default function App() {
  const [directoryName, setDirectoryName] = useState('共享目录');
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);
  const [fileView, setFileView] = useState<FileView>('list');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<'files' | 'chat'>('files');
  const { theme, toggleTheme } = useTheme();
  const fileInput = useRef<HTMLInputElement>(null);

  const loadDirectory = useCallback(async (nextPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await listFiles(nextPath);
      setListing(result);
      setPath(result.path);
      setSelectedPath(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取目录失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void getDirectoryInfo().then((info) => setDirectoryName(info.name)).catch(() => undefined);
    void loadDirectory('');
  }, [loadDirectory]);

  const openEntry = (entry: FileEntry) => {
    if (entry.kind === 'directory') {
      setPreview(null);
      void loadDirectory(entry.path);
    } else {
      setPreview(entry);
    }
  };

  const askConflict = (conflictingPath: string) => new Promise<ConflictChoice>((resolve) => setConflict({ path: conflictingPath, resolve }));

  const uploadFiles = async (files: UploadItem[]) => {
    if (!files.length) return;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]; let mode: ConflictMode | 'fail' = 'fail';
      setUploading(`正在上传 ${index + 1}/${files.length}：${file.relativePath}`);
      while (true) {
        try { await uploadFile(file, path, mode); break; } catch (cause) {
          if (!(cause instanceof UploadConflictError)) { setError(cause instanceof Error ? cause.message : '上传失败'); break; }
          const choice = await askConflict(cause.path);
          if (choice === 'cancel') { setUploading(null); return; }
          mode = choice;
        }
      }
    }
    setUploading(null); await loadDirectory(path);
  };

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault(); setDragging(false);
    try {
      await uploadFiles(await collectDroppedFiles(event.dataTransfer));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取拖入的文件');
    }
  };

  const breadcrumbs = path ? path.split('/').filter(Boolean) : [];
  return (
    <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-canvas p-3 text-ink sm:p-5">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-col">
        <header className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Dropoint<span className="ml-1 text-accent">.</span></h1>
            <p className="mt-0.5 max-w-[50vw] truncate text-xs text-muted">{directoryName} · 局域网工作台</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="icon-button"
              aria-label={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}
              title={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}
              onClick={toggleTheme}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                {theme === 'light' ? <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" /> : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>}
              </svg>
            </button>
            <button className="secondary-button" onClick={() => void loadDirectory(path)}>刷新</button>
            <button className="primary-button" onClick={() => fileInput.current?.click()}>上传文件</button>
            <input
              ref={fileInput}
              className="hidden"
              type="file"
              aria-label="上传文件"
              multiple
              onChange={(event) => {
                if (event.target.files) void uploadFiles(filesForUpload(event.target.files));
                event.target.value = '';
              }}
            />
          </div>
        </header>

        <div className="mb-3 flex shrink-0 gap-1 rounded-lg border border-line bg-surface p-1 lg:hidden" aria-label="工作面板">
          <button className={`flex-1 rounded-md py-1.5 text-xs ${mobilePanel === 'files' ? 'bg-panel font-semibold text-ink shadow-sm' : 'text-muted'}`} aria-pressed={mobilePanel === 'files'} onClick={() => setMobilePanel('files')}>文件</button>
          <button className={`flex-1 rounded-md py-1.5 text-xs ${mobilePanel === 'chat' ? 'bg-panel font-semibold text-ink shadow-sm' : 'text-muted'}`} aria-pressed={mobilePanel === 'chat'} onClick={() => setMobilePanel('chat')}>共享对话</button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section
            aria-label="共享文件"
            className={`${mobilePanel === 'files' ? 'flex' : 'hidden'} relative min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-sm lg:flex`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
            onDrop={(event) => void handleDrop(event)}
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-2">
              <button className="icon-button" aria-label="返回上级" disabled={!path} onClick={() => void loadDirectory(breadcrumbs.slice(0, -1).join('/'))}>‹</button>
              <nav aria-label="目录路径" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap text-xs text-muted">
                <button className="rounded px-1 py-1 hover:bg-hover hover:text-ink" onClick={() => void loadDirectory('')}>{directoryName}</button>
                {breadcrumbs.map((part, index) => (
                  <span key={index} className="flex items-center gap-1">
                    <span aria-hidden="true">/</span>
                    <button className="rounded px-1 py-1 hover:bg-hover hover:text-ink" onClick={() => void loadDirectory(breadcrumbs.slice(0, index + 1).join('/'))}>{part}</button>
                  </span>
                ))}
              </nav>
              <div className="flex shrink-0 rounded-md border border-line bg-canvas p-0.5" aria-label="文件视图">
                <button
                  type="button"
                  title="列表视图"
                  aria-label="列表视图"
                  aria-pressed={fileView === 'list'}
                  className={`rounded px-2 py-1.5 ${fileView === 'list' ? 'bg-panel text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
                  onClick={() => setFileView('list')}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M5 4h9M5 8h9M5 12h9M1 4h1M1 8h1M1 12h1" /></svg>
                </button>
                <button
                  type="button"
                  title="图标视图"
                  aria-label="图标视图"
                  aria-pressed={fileView === 'grid'}
                  className={`rounded px-2 py-1.5 ${fileView === 'grid' ? 'bg-panel text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
                  onClick={() => setFileView('grid')}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="2" y="2" width="4" height="4" rx=".5" /><rect x="10" y="2" width="4" height="4" rx=".5" /><rect x="2" y="10" width="4" height="4" rx=".5" /><rect x="10" y="10" width="4" height="4" rx=".5" /></svg>
                </button>
              </div>
            </div>
            {uploading && <p role="status" className="shrink-0 truncate border-b border-line bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">{uploading}</p>}
            {error && <p role="alert" className="shrink-0 border-b border-line bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-200">{error}</p>}
            {loading ? (
              <div role="status" className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted">正在打开目录…</div>
            ) : (
              <FileBrowser entries={listing?.entries ?? []} view={fileView} selectedPath={selectedPath} onSelect={setSelectedPath} onOpen={openEntry} />
            )}
            <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-line bg-surface px-3 py-2 text-[11px] text-muted">
              <span>{listing?.entries.length ?? 0} 个项目{selectedPath ? ' · 已选中 1 项' : ''}</span>
              <span className="hidden sm:inline">双击打开 · 拖入文件上传</span>
            </footer>
            {dragging && <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-panel/95 p-4 text-center text-sm text-accent">松开鼠标，上传文件或文件夹</div>}
          </section>

          <div className={`${mobilePanel === 'chat' ? 'block' : 'hidden'} min-h-0 min-w-0 lg:block`}><ChatPanel /></div>
        </div>
      </div>

      {preview && <PreviewDialog key={preview.path} entry={preview} onClose={() => setPreview(null)} />}
      {conflict && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-labelledby="conflict-title" className="w-full max-w-md rounded-2xl border border-line bg-panel p-6 text-ink shadow-2xl">
            <h2 id="conflict-title" className="text-lg font-semibold">发现同名文件</h2>
            <p className="mt-2 break-all text-sm">{conflict.path}</p>
            <p className="mt-2 text-sm text-muted">请选择如何处理这个文件。</p>
            <div className="mt-6 flex justify-end gap-2">
              <button className="secondary-button" onClick={() => { conflict.resolve('cancel'); setConflict(null); }}>取消</button>
              <button className="secondary-button" onClick={() => { conflict.resolve('rename'); setConflict(null); }}>重命名</button>
              <button className="primary-button" onClick={() => { conflict.resolve('overwrite'); setConflict(null); }}>覆盖</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
