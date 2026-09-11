import { useEffect, useRef, useState } from 'react';
import { fileUrl, type FileEntry } from '../lib/api';
import { formatSize, isTextFile } from '../lib/files';
import FileIcon from './FileIcon';

type TextPreview = { kind: 'loading' } | { kind: 'ready'; text: string } | { kind: 'error' };

export default function PreviewDialog({ entry, onClose }: { entry: FileEntry; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState<TextPreview>({ kind: 'loading' });

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    if (!isTextFile(entry)) return;
    const controller = new AbortController();
    async function loadText() {
      try {
        const response = await fetch(fileUrl(entry.path), { signal: controller.signal });
        if (!response.ok) throw new Error('Preview request failed');
        const content = await response.text();
        if (!controller.signal.aborted) setText({ kind: 'ready', text: content });
      } catch {
        if (!controller.signal.aborted) setText({ kind: 'error' });
      }
    }
    void loadText();
    return () => controller.abort();
  }, [entry]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="preview-title"
      className="m-auto h-[min(75dvh,44rem)] max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-4xl overflow-hidden rounded-2xl border border-line bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/45 backdrop:backdrop-blur-sm"
      onCancel={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-3">
          <FileIcon entry={entry} className="h-7 w-7" />
          <h2 id="preview-title" className="min-w-0 flex-1 truncate text-sm font-semibold" title={entry.name}>{entry.name}</h2>
          <a className="primary-button" href={fileUrl(entry.path, 'download')}>下载</a>
          <button className="icon-button" aria-label="关闭预览" onClick={onClose}>×</button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain bg-panel p-4">
          {isTextFile(entry) ? (
            text.kind === 'ready' ? <pre className="text-[13px] leading-6 text-ink">{text.text}</pre> :
              <p role="status" className="p-6 text-center text-sm text-muted">{text.kind === 'error' ? '无法读取此文件的预览内容' : '正在加载预览…'}</p>
          ) : entry.mime?.startsWith('image/') ? (
            <div className="flex h-full items-center justify-center"><img className="max-h-full max-w-full object-contain" src={fileUrl(entry.path)} alt={entry.name} /></div>
          ) : entry.mime?.startsWith('video/') ? (
            <div className="flex h-full items-center justify-center"><video className="max-h-full max-w-full" src={fileUrl(entry.path)} controls /></div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <FileIcon entry={entry} className="h-16 w-16" />
              <p className="text-sm text-muted">{formatSize(entry.size)} · {entry.mime || '未知类型'}</p>
              <p className="text-sm text-muted">此文件暂不支持预览，可下载后打开。</p>
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}
