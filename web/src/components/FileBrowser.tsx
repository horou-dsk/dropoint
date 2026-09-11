import type { FileEntry } from '../lib/api';
import { formatSize } from '../lib/files';
import FileIcon from './FileIcon';

export type FileView = 'list' | 'grid';

type Props = {
  entries: FileEntry[];
  view: FileView;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  onOpen: (entry: FileEntry) => void;
};

export default function FileBrowser({ entries, view, selectedPath, onSelect, onOpen }: Props) {
  return (
    <div
      role="region"
      aria-label="文件内容"
      className="min-h-0 flex-1 overflow-auto overscroll-contain p-2"
      onClick={() => onSelect(null)}
    >
      {entries.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted">这个目录还是空的，拖入文件开始分享吧。</p>
      ) : (
        <>
          {view === 'list' && (
            <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_5rem] gap-3 border-b border-line bg-surface px-3 py-2 text-xs text-muted sm:grid-cols-[minmax(0,1fr)_9rem_5rem]">
              <span>名称</span><span className="hidden sm:block">修改时间</span><span className="text-right">大小</span>
            </div>
          )}
          <ul
            aria-label={view === 'grid' ? '文件图标' : '文件列表'}
            className={view === 'grid' ? 'grid auto-rows-max grid-cols-[repeat(auto-fill,96px)] content-start gap-x-2 gap-y-1' : 'space-y-0.5 pt-1'}
          >
            {entries.map((entry) => {
              const selected = entry.path === selectedPath;
              return (
                <li key={entry.path} className="min-w-0">
                  <button
                    type="button"
                    aria-label={entry.name}
                    aria-pressed={selected}
                    title={entry.name}
                    className={view === 'grid'
                      ? 'group flex h-[108px] w-24 cursor-default select-none flex-col items-center rounded-md px-1 py-1.5 outline-offset-[-2px]'
                      : `grid w-full cursor-default select-none grid-cols-[minmax(0,1fr)_5rem] items-center gap-3 rounded-md px-3 py-1.5 text-left text-[13px] sm:grid-cols-[minmax(0,1fr)_9rem_5rem] ${selected ? 'bg-selected text-selected-ink' : 'text-ink hover:bg-hover'}`}
                    onClick={(event) => { event.stopPropagation(); onSelect(entry.path); }}
                    onDoubleClick={() => onOpen(entry)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || (event.key === ' ' && entry.kind === 'file')) {
                        event.preventDefault();
                        onOpen(entry);
                      }
                    }}
                  >
                    {view === 'grid' ? (
                      <>
                        <span className={`mb-0.5 rounded-lg px-2 py-1 ${selected ? 'bg-selected' : 'group-hover:bg-hover'}`}><FileIcon entry={entry} /></span>
                        <span className={`line-clamp-2 max-w-full rounded px-1 text-xs leading-4 [overflow-wrap:anywhere] ${selected ? 'bg-accent text-white' : 'text-ink'}`}>{entry.name}</span>
                      </>
                    ) : (
                      <>
                        <span className="flex min-w-0 items-center gap-2"><FileIcon entry={entry} className="h-6 w-6" /><span className="truncate">{entry.name}</span></span>
                        <span className="hidden text-xs text-muted sm:block">{entry.modified === null ? '—' : new Date(entry.modified * 1000).toLocaleDateString()}</span>
                        <span className="text-right text-xs text-muted">{entry.kind === 'directory' ? '—' : formatSize(entry.size)}</span>
                      </>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
