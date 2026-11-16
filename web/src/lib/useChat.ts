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
  const [historyRevision, setHistoryRevision] = useState(0);
  const [clearing, setClearing] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const clearingRef = useRef(false);
  const clearedThroughId = useRef(0);
  const sessionId = useRef<string | undefined>(undefined);
  // A confirmed HTTP response can arrive before an older history snapshot.
  const confirmations = useRef<ChatMessage[]>([]);
  const confirm = useCallback((message: ChatMessage) => {
    if (message.id <= clearedThroughId.current) return;
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
        const data = JSON.parse(event.data) as
          | { type: 'history'; messages: ChatMessage[]; sessionId: string }
          | { type: 'message'; message: ChatMessage }
          | { type: 'cleared'; throughId: number; sessionId: string };
        if (data.type === 'history') {
          if (sessionId.current !== data.sessionId) {
            sessionId.current = data.sessionId;
            clearedThroughId.current = 0;
          }
          setMessages(mergeMessages([...data.messages, ...confirmations.current]
            .filter((message) => message.id > clearedThroughId.current)));
          confirmations.current = [];
          setHistoryRevision((revision) => revision + 1);
        } else if (data.type === 'message') {
          if (data.message.id > clearedThroughId.current) {
            setMessages((current) => mergeMessages([...current, data.message]));
          }
        } else if (data.type === 'cleared') {
          if (sessionId.current !== data.sessionId) {
            sessionId.current = data.sessionId;
            clearedThroughId.current = data.throughId;
          } else {
            clearedThroughId.current = Math.max(clearedThroughId.current, data.throughId);
          }
          confirmations.current = confirmations.current.filter((message) => message.id > clearedThroughId.current);
          setMessages([]);
          clearingRef.current = false;
          setClearing(false);
        }
      };
      socket.onclose = () => {
        if (!stopped && socket === socketRef.current) {
          setStatus('offline');
          clearingRef.current = false;
          setClearing(false);
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
  const clearMessages = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || clearingRef.current) return false;
    try {
      socket.send(JSON.stringify({ type: 'clear' }));
      clearingRef.current = true;
      setClearing(true);
      return true;
    } catch {
      return false;
    }
  }, []);

  return { messages, status, confirm, isConnected, historyRevision, clearMessages, clearing };
}
