import { useEffect, useRef } from 'react';
import type { FileEntry } from '../lib/api';

export default function DeleteDialog({ entries, busy, onCancel, onConfirm }: {
  entries: FileEntry[]; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  return (
    <dialog
      ref={dialog} aria-labelledby="delete-title"
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-line bg-panel p-6 text-ink shadow-2xl backdrop:bg-black/45 backdrop:backdrop-blur-sm"
      onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}
    >
      <h2 id="delete-title" className="text-lg font-semibold">永久删除 {entries.length} 个项目？</h2>
      <p className="mt-2 text-sm text-muted">文件夹及其中的所有内容将一并永久删除，此操作无法撤销。</p>
      <ul className="mt-4 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line bg-surface p-3 text-sm">
        {entries.map((entry) => <li key={entry.path} className="break-all">{entry.name}{entry.kind === 'directory' ? ' /' : ''}</li>)}
      </ul>
      <div className="mt-6 flex justify-end gap-2">
        <button autoFocus className="secondary-button" disabled={busy} onClick={onCancel}>取消</button>
        <button className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-40" disabled={busy} onClick={onConfirm}>{busy ? '正在删除…' : '永久删除'}</button>
      </div>
    </dialog>
  );
}
