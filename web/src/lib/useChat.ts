import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from './api';

const MAX_MESSAGES = 200;

function mergeMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...new Map(messages.map((message) => [message.id, message])).values()]
    .sort((a, b) => a.id - b.id).slice(-MAX_MESSAGES);
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  // A confirmed HTTP response can arrive before an older history snapshot.
  const confirmations = useRef<ChatMessage[]>([]);
  const confirm = useCallback((message: ChatMessage) => {
    confirmations.current = mergeMessages([...confirmations.current, message]);
    setMessages((current) => mergeMessages([...current, message]));
  }, []);

  useEffect(() => {
    let stopped = false;
    let retry: number | undefined;
    const connect = () => {
      if (stopped) return;
      setStatus('connecting');
      // Reconnect history is authoritative. Only merge confirmations made during this connection.
      confirmations.current = [];
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${scheme}://${window.location.host}/api/chat`);
      socketRef.current = socket;
      socket.onopen = () => { if (!stopped) setStatus('connected'); };
      socket.onmessage = (event) => {
        if (stopped || socket !== socketRef.current) return;
        const data = JSON.parse(event.data) as { type: 'history'; messages: ChatMessage[] } | { type: 'message'; message: ChatMessage };
        if (data.type === 'history') {
          setMessages(mergeMessages([...data.messages, ...confirmations.current]));
          confirmations.current = [];
        } else if (data.type === 'message') setMessages((current) => mergeMessages([...current, data.message]));
      };
      socket.onclose = () => {
        if (!stopped && socket === socketRef.current) {
          setStatus('offline');
          retry = window.setTimeout(connect, 2500);
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry !== undefined) window.clearTimeout(retry);
      socketRef.current?.close();
    };
  }, []);

  const isConnected = () => socketRef.current?.readyState === WebSocket.OPEN;
  return { messages, status, confirm, isConnected };
}
