import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../lib/api';

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

function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let retry: number | undefined;
    const connect = () => {
      if (stopped) return;
      setStatus('connecting');
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${scheme}://${window.location.host}/api/chat`);
      socketRef.current = socket;
      socket.onopen = () => setStatus('connected');
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data) as { type: 'history'; messages: ChatMessage[] } | { type: 'message'; message: ChatMessage };
        if (data.type === 'history') setMessages(data.messages);
        else setMessages((current) => current.some((message) => message.id === data.message.id) ? current : [...current, data.message]);
      };
      socket.onclose = () => {
        if (!stopped) {
          setStatus('offline');
          retry = window.setTimeout(connect, 2500);
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) window.clearTimeout(retry);
      socketRef.current?.close();
    };
  }, []);

  const send = useCallback((text: string) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify({ type: 'send', text }));
      return true;
    } catch {
      return false;
    }
  }, []);
  return { messages, status, send };
}


export default function ChatPanel() {
  const { messages, status, send } = useChat();
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState<number | null>(null);
  const composing = useRef(false);

  const submit = () => {
    const text = draft.trim();
    if (text && send(text)) setDraft('');
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
        {messages.length === 0 && <p className="rounded-lg bg-surface p-3 text-xs leading-6 text-muted">把想在多台设备之间传递的文字放在这里吧。</p>}
        {messages.map((message) => (
          <div key={message.id} className="rounded-lg bg-surface p-3 text-[13px] text-ink">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 whitespace-pre-wrap leading-6 [overflow-wrap:anywhere]">{message.text}</p>
              <button className="shrink-0 rounded px-1 py-1 text-xs text-accent hover:bg-hover" onClick={() => void copy(message)}>
                {copied === message.id ? '已复制' : '复制'}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-muted">{new Date(message.timestamp).toLocaleTimeString()}</p>
          </div>
        ))}
      </div>
      <div className="m-3 mt-0 shrink-0 rounded-lg border border-line bg-panel p-2 focus-within:border-accent">
        <textarea
          aria-label="聊天内容"
          className="h-14 w-full resize-none bg-transparent px-1 text-sm text-ink outline-none placeholder:text-muted"
          placeholder="写点什么，回车发送…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
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
          <span className="text-[10px] text-muted">Shift + Enter 换行</span>
          <button className="primary-button" onClick={submit} disabled={!draft.trim() || status !== 'connected'}>发送</button>
        </div>
      </div>
    </aside>
  );
}
