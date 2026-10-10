import { useRef, useState } from 'react';
import type { ChatAttachment, ChatMessage } from '../lib/api';
import { useChat } from '../lib/useChat';
import { useChatDraft } from '../lib/useChatDraft';
import { formatSize } from '../lib/files';
import ChatAttachmentCard from './ChatAttachmentCard';
import FileIcon from './FileIcon';
import PreviewDialog from './PreviewDialog';
import UploadProgress from './UploadProgress';

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export default function ChatPanel() {
  const { messages, status, confirm, isConnected } = useChat();
  const draft = useChatDraft(confirm);
  const picker = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ChatAttachment | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const composing = useRef(false);

  const submit = () => {
    if (isConnected()) void draft.submit();
  };

  const copy = async (message: ChatMessage) => {
    await copyText(message.text);
    setCopied(message.id);
    window.setTimeout(() => setCopied((current) => current === message.id ? null : current), 1600);
  };

  return (
    <aside aria-label="共享对话" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-sm">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-surface px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">共享对话</h2>
        <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${status === 'connected' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'}`}>
          {status === 'connected' ? '已连接' : status === 'connecting' ? '连接中' : '等待重连'}
        </span>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
        {messages.length === 0 && <p className="rounded-lg bg-surface p-3 text-xs leading-6 text-muted">在这里传递文字、图片和文件。可直接粘贴截图或选择附件。</p>}
        {messages.map((message) => (
          <div key={message.id} className="rounded-lg bg-surface p-3 text-[13px] text-ink">
            {message.text && <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 whitespace-pre-wrap leading-6 [overflow-wrap:anywhere]">{message.text}</p>
              <button className="shrink-0 rounded px-1 py-1 text-xs text-accent hover:bg-hover" onClick={() => void copy(message)}>
                {copied === message.id ? '已复制' : '复制'}
              </button>
            </div>}
            {message.attachments.length > 0 && <div className="mt-2 space-y-2">
              {message.attachments.map((attachment) => <ChatAttachmentCard key={attachment.id} attachment={attachment} onPreview={() => setPreview(attachment)} />)}
            </div>}
            <p className="mt-2 text-[11px] text-muted">{new Date(message.timestamp).toLocaleTimeString()}</p>
          </div>
        ))}
      </div>
      <div className="m-3 mt-0 shrink-0 rounded-lg border border-line bg-panel p-2 focus-within:border-accent">
        {draft.attachments.length > 0 && <ul aria-label="待发送附件" className="mb-2 max-h-48 space-y-2 overflow-y-auto">
          {draft.attachments.map((item) => <li key={item.key} className="flex min-w-0 items-center gap-2 rounded bg-surface p-2">
            {item.preview ? <img className="h-10 w-10 shrink-0 rounded object-cover" src={item.preview} alt={item.file.name} />
              : <FileIcon entry={{ kind: 'file', mime: item.file.type }} className="h-8 w-8" />}
            <div className="min-w-0 flex-1 text-xs"><p className="truncate" title={item.file.name}>{item.file.name}</p>
              <p className="mt-1 text-[11px] text-muted">{formatSize(item.file.size)}{item.uploaded ? ' · 已上传' : ''}</p></div>
            <button className="icon-button shrink-0" aria-label={`移除 ${item.file.name}`} disabled={draft.busy} onClick={() => draft.remove(item.key)}>×</button>
          </li>)}
        </ul>}
        {draft.progress && <UploadProgress status={draft.progress} />}
        {draft.busy && !draft.progress && <p role="status" className="mb-2 text-xs text-accent">正在发送，等待服务端确认…</p>}
        {draft.error && <p role="alert" className="mb-2 text-xs text-red-600 dark:text-red-400">{draft.error}</p>}
        <textarea
          aria-label="聊天内容"
          className="h-14 w-full resize-none bg-transparent px-1 text-sm text-ink outline-none placeholder:text-muted"
          placeholder="写点什么，或粘贴图片和文件…"
          value={draft.text}
          disabled={draft.busy}
          onChange={(event) => draft.changeText(event.target.value)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length === 0) {
              for (const item of Array.from(event.clipboardData.items || [])) {
                if (item.kind === 'file') { const file = item.getAsFile(); if (file) files.push(file); }
              }
            }
            if (files.length) { event.preventDefault(); draft.addFiles(files); }
          }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <input ref={picker} className="hidden" aria-label="选择聊天附件" type="file" multiple disabled={draft.busy} onChange={(event) => {
              draft.addFiles(Array.from(event.target.files || [])); event.target.value = '';
            }} />
            <button className="icon-button text-xs" aria-label="添加附件" title="添加附件（最多 10 个）" disabled={draft.busy} onClick={() => picker.current?.click()}>＋</button>
            <span className="text-[10px] text-muted">{draft.attachments.length ? `${draft.attachments.length}/10 个附件` : 'Shift + Enter 换行'}</span>
          </div>
          <button className="primary-button" onClick={submit} disabled={draft.busy || (!draft.text.trim() && draft.attachments.length === 0) || status !== 'connected'}>发送</button>
        </div>
      </div>
      {preview && <PreviewDialog key={preview.id} entry={{ name: preview.name, path: preview.id, kind: 'file', size: preview.size, modified: null, mime: preview.mime }}
        previewUrl={preview.previewUrl} downloadUrl={preview.downloadUrl} onClose={() => setPreview(null)} />}
    </aside>
  );
}
