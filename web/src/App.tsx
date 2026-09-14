import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ConflictMode,
  type DirectoryListing,
  type FileEntry,
  UploadConflictError,
  checkUploadConflict,
  getDirectoryInfo,
  listFiles,
  uploadFile,
  createArchive,
  deleteFiles,
  fileUrl,
  startDownload,
} from './lib/api';
import { useTheme } from './lib/useTheme';
import { collectDroppedFiles, filesForUpload, type UploadItem } from './lib/uploads';
import ChatPanel from './components/ChatPanel';
import FileBrowser, { type FileView } from './components/FileBrowser';
import PreviewDialog from './components/PreviewDialog';
import ContextMenu, { type MenuItem, type MenuPosition } from './components/ContextMenu';
import DeleteDialog from './components/DeleteDialog';
import UploadProgress, { type UploadStatus } from './components/UploadProgress';
import { useFileSelection } from './lib/useFileSelection';

type ConflictChoice = ConflictMode | 'cancel';
type ConflictPrompt = { path: string; resolve: (choice: ConflictChoice) => void };
type DirectoryHistoryState = { dropointPath?: string };

export default function App() {
  const [directoryName, setDirectoryName] = useState('共享目录');
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<UploadStatus | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);
  const [fileView, setFileView] = useState<FileView>(() => (
    localStorage.getItem('dropoint-file-view') === 'list' ? 'list' : 'grid'
  ));
  const selection = useFileSelection();
  const { reconcile } = selection;
  const [sort, setSort] = useState('name-asc');
  const [menu, setMenu] = useState<{ position: MenuPosition; entries: FileEntry[] } | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<FileEntry[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [packing, setPacking] = useState(false);
  const [operation, setOperation] = useState<{ error: boolean; text: string } | null>(null);
  const [mobilePanel, setMobilePanel] = useState<'files' | 'chat'>('files');
  const { theme, toggleTheme } = useTheme();
  const fileInput = useRef<HTMLInputElement>(null);
  const currentPath = useRef('');
  const directoryRequest = useRef(0);
  const directoryLoading = useRef(false);
  const directoryRefreshPending = useRef(false);
  const deletePending = useRef(false);
  const uploadPending = useRef(false);

  useEffect(() => {
    localStorage.setItem('dropoint-file-view', fileView);
  }, [fileView]);

  const loadDirectory = useCallback(async function loadDirectory(nextPath: string, historyMode: 'push' | 'none' = 'none'): Promise<void> {
    const request = ++directoryRequest.current;
    directoryLoading.current = true;
    // A request started after an upload already covers its refresh requirement.
    directoryRefreshPending.current = false;
    const previousPath = currentPath.current;
    setLoading(true);
    setError(null);
    try {
      const result = await listFiles(nextPath);
      if (request !== directoryRequest.current) return;
      setListing(result);
      setPath(result.path);
      currentPath.current = result.path;
      if (historyMode === 'push' && result.path !== previousPath) {
        window.history.pushState(
          { ...(window.history.state as DirectoryHistoryState | null), dropointPath: result.path },
          '',
          window.location.href,
        );
      }
      reconcile(result.path, result.entries);
      setMenu(null);
    } catch (cause) {
      if (request === directoryRequest.current) setError(cause instanceof Error ? cause.message : '读取目录失败');
    } finally {
      if (request === directoryRequest.current) {
        directoryLoading.current = false;
        if (directoryRefreshPending.current) {
          void loadDirectory(currentPath.current);
        } else {
          setLoading(false);
        }
      }
    }
  }, [reconcile]);

  const entries = useMemo(() => [...(listing?.entries ?? [])].sort((left, right) => {
    const directoryFirst = Number(left.kind === 'file') - Number(right.kind === 'file');
    if (directoryFirst !== 0) return directoryFirst;
    const byName = left.name.localeCompare(right.name, undefined, { numeric: true });
    if (sort === 'name-desc') return -byName;
    if (sort === 'modified-desc') return (right.modified ?? 0) - (left.modified ?? 0) || byName;
    if (sort === 'size-desc') return right.size - left.size || byName;
    return byName;
  }), [listing, sort]);
  const selectedEntries = entries.filter((entry) => selection.paths.has(entry.path));
  const closeMenu = useCallback(() => setMenu(null), []);
  const selectAll = () => selection.replace(entries.map((entry) => entry.path));

  const downloadEntries = async (targets: FileEntry[]) => {
    if (!targets.length || packing) return;
    setOperation(null);
    if (targets.length === 1 && targets[0].kind === 'file') {
      startDownload(fileUrl(targets[0].path, 'download'), targets[0].name);
      setOperation({ error: false, text: '已开始下载' });
      return;
    }
    setPacking(true);
    try {
      const archive = await createArchive(targets.map((entry) => entry.path));
      startDownload(archive.url, archive.filename);
      setOperation({ error: false, text: 'ZIP 已开始下载' });
    } catch (cause) {
      setOperation({ error: true, text: cause instanceof Error ? cause.message : '打包失败，请重试' });
    } finally { setPacking(false); }
  };

  const confirmDelete = async () => {
    if (!deleteTargets || deletePending.current) return;
    deletePending.current = true;
    setDeleting(true);
    setOperation(null);
    try {
      const result = await deleteFiles(deleteTargets.map((entry) => entry.path));
      selection.remove(result.deleted);
      setPreview((entry) => entry && result.deleted.some((deleted) => entry.path === deleted || entry.path.startsWith(`${deleted}/`)) ? null : entry);
      await loadDirectory(currentPath.current);
      setOperation({
        error: result.failed.length > 0,
        text: result.failed.length
          ? `已删除 ${result.deleted.length} 项，${result.failed.length} 项失败：${result.failed.map((item) => `${item.path}：${item.message}`).join('；')}`
          : `已删除 ${result.deleted.length} 个项目`,
      });
    } catch (cause) {
      setOperation({ error: true, text: cause instanceof Error ? cause.message : '删除失败，请重试' });
    } finally {
      deletePending.current = false;
      setDeleting(false);
      setDeleteTargets(null);
    }
  };

  useEffect(() => {
    void getDirectoryInfo().then((info) => setDirectoryName(info.name)).catch(() => undefined);
    const state = window.history.state as DirectoryHistoryState | null;
    const initialPath = typeof state?.dropointPath === 'string' ? state.dropointPath : '';
    if (typeof state?.dropointPath !== 'string') {
      window.history.replaceState({ ...(state ?? {}), dropointPath: initialPath }, '', window.location.href);
    }
    const handlePopState = (event: PopStateEvent) => {
      const nextState = event.state as DirectoryHistoryState | null;
      if (typeof nextState?.dropointPath === 'string') {
        void loadDirectory(nextState.dropointPath);
      }
    };
    window.addEventListener('popstate', handlePopState);
    void loadDirectory(initialPath);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [loadDirectory]);

  const openEntry = (entry: FileEntry) => {
    if (entry.kind === 'directory') {
      setPreview(null);
      void loadDirectory(entry.path, 'push');
    } else {
      setPreview(entry);
    }
  };

  const askConflict = (conflictingPath: string) => new Promise<ConflictChoice>((resolve) => setConflict({ path: conflictingPath, resolve }));

  const uploadFiles = async (source: UploadItem[] | Promise<UploadItem[]>) => {
    if (uploadPending.current) return;
    uploadPending.current = true;
    setUploadBusy(true);
    setOperation(null);
    const destination = currentPath.current;
    let completedFiles = 0;
    let completedBytes = 0;
    const failures: string[] = [];
    let cancelled = false;
    try {
      const files = await source;
      if (!files.length) return;
      const totalBytes = files.reduce((total, item) => total + item.file.size, 0);
      uploadBatch: for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        let mode: ConflictMode | 'fail' = 'fail';
        while (true) {
          try {
            if (mode === 'fail') {
              const check = await checkUploadConflict(file, destination);
              if (check.exists) {
                setUploading({
                  fileName: file.relativePath, fileIndex: index + 1, fileCount: files.length,
                  completedFiles, completedBytes, totalBytes,
                  progress: { loaded: 0, total: file.file.size, phase: 'uploading' },
                  awaitingConflict: true,
                });
                const choice = await askConflict(check.path);
                if (choice === 'cancel') { cancelled = true; break uploadBatch; }
                mode = choice;
              }
            }
            await uploadFile(file, destination, mode, (progress) => setUploading({
              fileName: file.relativePath, fileIndex: index + 1, fileCount: files.length,
              completedFiles, completedBytes, totalBytes, progress, awaitingConflict: false,
            }));
            completedFiles += 1;
            completedBytes += file.file.size;
            break;
          } catch (cause) {
            if (!(cause instanceof UploadConflictError)) {
              failures.push(`${file.relativePath}：${cause instanceof Error ? cause.message : '上传失败'}`);
              break;
            }
            setUploading((previous) => previous && { ...previous, awaitingConflict: true });
            const choice = await askConflict(cause.path);
            if (choice === 'cancel') { cancelled = true; break uploadBatch; }
            mode = choice;
          }
        }
      }
      setOperation({
        error: failures.length > 0,
        text: [
          cancelled ? `已取消剩余上传，已完成 ${completedFiles}/${files.length} 个文件` : `上传结束：成功 ${completedFiles}/${files.length} 个文件`,
          failures.length ? `失败 ${failures.length} 个：${failures.join('；')}` : '',
        ].filter(Boolean).join('；'),
      });
    } catch (cause) {
      setOperation({ error: true, text: cause instanceof Error ? cause.message : '无法读取上传文件' });
    } finally {
      setUploading(null);
      setUploadBusy(false);
      uploadPending.current = false;
      if (completedFiles > 0) {
        // Finish navigation first, then refresh its resulting directory once.
        if (directoryLoading.current) directoryRefreshPending.current = true;
        else void loadDirectory(currentPath.current);
      }
    }
  };

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault(); setDragging(false);
    if (uploadPending.current) return;
    try {
      await uploadFiles(collectDroppedFiles(event.dataTransfer));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取拖入的文件');
    }
  };

  const breadcrumbs = path ? path.split('/').filter(Boolean) : [];
  const menuItems: MenuItem[] = menu?.entries.length ? [
    ...(menu.entries.length === 1 ? [{ label: menu.entries[0].kind === 'directory' ? '打开' : '预览', action: () => openEntry(menu.entries[0]) }] : []),
    { label: menu.entries.length === 1 ? '下载' : '下载所选项目', action: () => void downloadEntries(menu.entries), disabled: packing || deleting },
    { label: menu.entries.length === 1 ? '删除' : '删除所选项目', action: () => setDeleteTargets(menu.entries), danger: true, disabled: packing || deleting },
  ] : [
    { label: '刷新', action: () => void loadDirectory(path) },
    { label: '全选', action: selectAll, disabled: entries.length === 0 },
    { label: '取消选择', action: selection.clear, disabled: selection.paths.size === 0 },
  ];
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
            <button className="primary-button" disabled={uploadBusy} onClick={() => fileInput.current?.click()}>上传文件</button>
            <input
              ref={fileInput}
              className="hidden"
              type="file"
              aria-label="上传文件"
              multiple
              disabled={uploadBusy}
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
              <button className="icon-button" aria-label="返回上级" disabled={!path} onClick={() => window.history.back()}>‹</button>
              <nav aria-label="目录路径" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap text-xs text-muted">
                <button className="rounded px-1 py-1 hover:bg-hover hover:text-ink" onClick={() => void loadDirectory('', 'push')}>{directoryName}</button>
                {breadcrumbs.map((part, index) => (
                  <span key={index} className="flex items-center gap-1">
                    <span aria-hidden="true">/</span>
                    <button className="rounded px-1 py-1 hover:bg-hover hover:text-ink" onClick={() => void loadDirectory(breadcrumbs.slice(0, index + 1).join('/'), 'push')}>{part}</button>
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
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
              <span className="mr-auto text-xs text-muted">已选中 {selectedEntries.length} 项</span>
              <select aria-label="文件排序" value={sort} onChange={(event) => setSort(event.target.value)} className="min-w-0 rounded-md border border-line bg-panel px-2 py-1.5 text-xs text-ink">
                <option value="name-asc">名称 ↑</option><option value="name-desc">名称 ↓</option>
                <option value="modified-desc">最近修改</option><option value="size-desc">大小 ↓</option>
              </select>
              <button className="secondary-button" disabled={!selectedEntries.length || packing || deleting || loading} onClick={() => void downloadEntries(selectedEntries)}>{packing ? '正在打包…' : '下载所选项目'}</button>
              <button className="secondary-button text-rose-600 dark:text-rose-300" disabled={!selectedEntries.length || packing || deleting || loading} onClick={() => setDeleteTargets(selectedEntries)}>删除所选项目</button>
            </div>
            {operation && <p role={operation.error ? 'alert' : 'status'} className={`max-h-24 shrink-0 overflow-y-auto break-all border-b border-line px-3 py-2 text-xs ${operation.error ? 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-200' : 'bg-surface text-muted'}`}>{operation.text}</p>}
            {uploadBusy && !uploading && <p role="status" className="shrink-0 border-b border-line bg-surface px-3 py-2 text-xs text-muted">正在读取上传文件…</p>}
            {uploading && <UploadProgress status={uploading} />}
            {error && <p role="alert" className="shrink-0 border-b border-line bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-200">{error}</p>}
            {loading ? (
              <div role="status" className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted">正在打开目录…</div>
            ) : (
              <FileBrowser
                entries={entries} view={fileView} selectedPaths={selection.paths}
                onSelect={(selected, modifiers) => selection.select(selected, entries, modifiers)}
                onClear={selection.clear} onSelectAll={selectAll} onOpen={openEntry}
                onContextMenu={(entry, position) => {
                  const targets = entry ? selection.paths.has(entry.path) ? selectedEntries : [entry] : [];
                  if (entry && !selection.paths.has(entry.path)) selection.replace([entry.path]);
                  setMenu({ position, entries: targets });
                }}
              />
            )}
            <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-line bg-surface px-3 py-2 text-[11px] text-muted">
              <span>{listing?.entries.length ?? 0} 个项目</span>
              <span className="hidden sm:inline">双击打开 · Ctrl/⌘ 多选 · Shift 连选</span>
            </footer>
            {dragging && <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-panel/95 p-4 text-center text-sm text-accent">松开鼠标，上传文件或文件夹</div>}
          </section>

          <div className={`${mobilePanel === 'chat' ? 'block' : 'hidden'} min-h-0 min-w-0 lg:block`}><ChatPanel /></div>
        </div>
      </div>

      {preview && <PreviewDialog key={preview.path} entry={preview} onClose={() => setPreview(null)} />}
      {menu && <ContextMenu position={menu.position} items={menuItems} onClose={closeMenu} />}
      {deleteTargets && <DeleteDialog entries={deleteTargets} busy={deleting} onCancel={() => setDeleteTargets(null)} onConfirm={() => void confirmDelete()} />}
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
