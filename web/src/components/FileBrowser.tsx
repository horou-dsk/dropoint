import type { FileEntry } from '../lib/api';
import { formatSize } from '../lib/files';
import FileIcon from './FileIcon';
import type { SelectionModifiers } from '../lib/useFileSelection';
import type { MenuPosition } from './ContextMenu';

export type FileView = 'list' | 'grid';

type Props = {
  entries: FileEntry[];
  view: FileView;
  selectedPaths: Set<string>;
  onSelect: (path: string, modifiers: SelectionModifiers) => void;
  onClear: () => void;
  onSelectAll: () => void;
  onContextMenu: (entry: FileEntry | null, position: MenuPosition) => void;
  onOpen: (entry: FileEntry) => void;
};

export default function FileBrowser({ entries, view, selectedPaths, onSelect, onClear, onSelectAll, onContextMenu, onOpen }: Props) {
  const showMenu = (event: React.MouseEvent<HTMLElement>, entry: FileEntry | null) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    onContextMenu(entry, { x: event.clientX || bounds.left + 16, y: event.clientY || bounds.top + 16, trigger: event.currentTarget });
  };
  const keyboardMenu = (event: React.KeyboardEvent<HTMLElement>, entry: FileEntry | null) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    onContextMenu(entry, { x: bounds.left + 16, y: bounds.top + 16, trigger: event.currentTarget });
  };
  return (
    <div
      role="region"
      aria-label="文件内容"
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto overscroll-contain p-2"
      onClick={(event) => { onClear(); event.currentTarget.focus({ preventScroll: true }); }}
      onContextMenu={(event) => showMenu(event, null)}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault(); onSelectAll();
        } else if (event.key === 'Escape') { onClear(); }
        else keyboardMenu(event, null);
      }}
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
              const selected = selectedPaths.has(entry.path);
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
                    onClick={(event) => { event.stopPropagation(); onSelect(entry.path, event); }}
                    onDoubleClick={(event) => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey) onOpen(entry); }}
                    onContextMenu={(event) => showMenu(event, entry)}
                    onKeyDown={(event) => {
                      keyboardMenu(event, entry);
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
