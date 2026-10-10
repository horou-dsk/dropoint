import { useEffect, useRef, useState } from 'react';
import { ChatApiError, keepChatMessageAlive, prepareChatMessage, submitChatMessage, uploadChatAttachment,
  type ChatAttachment, type ChatMessage, type ChatSubmission } from './api';
import type { UploadStatus } from '../components/UploadProgress';

export type DraftAttachment = { key: string; file: File; preview: string | null; uploaded?: ChatAttachment };
export const MAX_CHAT_ATTACHMENTS = 10;
const KEEP_ALIVE_INTERVAL = 60_000;

export function newClientMessageId(): string {
  // getRandomValues works on LAN HTTP as well as HTTPS; randomUUID requires a secure context.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function imagePreview(file: File): string | null {
  return /^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(file.type) ? URL.createObjectURL(file) : null;
}

export function useChatDraft(confirm: (message: ChatMessage) => void) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const files = useRef<DraftAttachment[]>([]);
  const clientId = useRef<string | null>(null);
  const prepared = useRef<ChatSubmission | null>(null);
  const commitAttempted = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<UploadStatus | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
      for (const item of files.current) if (item.preview) URL.revokeObjectURL(item.preview);
    };
  }, []);

  const updateFiles = (next: DraftAttachment[]) => { files.current = next; setAttachments(next); };
  const newSubmission = () => { clientId.current = null; prepared.current = null; commitAttempted.current = false; };
  const changeText = (value: string) => {
    if (pending.current) return;
    setText(value); newSubmission(); setError('');
  };
  const addFiles = (incoming: File[]) => {
    if (pending.current || incoming.length === 0) return;
    const available = MAX_CHAT_ATTACHMENTS - files.current.length;
    const selected = incoming.slice(0, available).map((file) => ({ key: newClientMessageId(), file, preview: imagePreview(file) }));
    if (selected.length) { updateFiles([...files.current, ...selected]); newSubmission(); }
    setError(incoming.length > available ? '每条消息最多添加 10 个附件' : '');
  };
  const remove = (key: string) => {
    if (pending.current) return;
    const item = files.current.find((file) => file.key === key);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    updateFiles(files.current.filter((file) => file.key !== key)); newSubmission(); setError('');
  };

  const submit = async () => {
    if (pending.current || (!text.trim() && files.current.length === 0)) return;
    if (Array.from(text.trim()).length > 10_000) { setError('文字最多 10,000 个字符'); return; }
    const controller = new AbortController();
    pending.current = controller; setBusy(true); setError('');
    clientId.current ??= newClientMessageId();
    const current = files.current;
    const totalBytes = current.reduce((sum, item) => sum + item.file.size, 0);
    let heartbeat: number | undefined;
    let heartbeatError: unknown;
    let stopped = false;
    const uploadedIds = () => current.flatMap((item) => item.uploaded ? [item.uploaded.id] : []);
    const invalidate = (ids: string[]) => {
      for (const item of current) if (item.uploaded && ids.includes(item.uploaded.id)) item.uploaded = undefined;
      if (mounted.current) setAttachments([...current]);
    };
    try {
      prepared.current ??= await prepareChatMessage(clientId.current, controller.signal);
      let submission = prepared.current;
      let refreshed = false;
      let invalidated = false;
      while (true) {
        try {
          await keepChatMessageAlive(submission, uploadedIds(), controller.signal);
          break;
        } catch (error) {
          if (error instanceof ChatApiError && error.code === 'submission_expired' && !commitAttempted.current && !refreshed) {
            // No commit was attempted, so renewing an abandoned reservation cannot duplicate a message.
            submission = await prepareChatMessage(clientId.current, controller.signal);
            prepared.current = submission; refreshed = true;
          } else if (error instanceof ChatApiError && error.code === 'attachment_unavailable' && !invalidated) {
            invalidate(error.attachmentIds); invalidated = true;
          } else throw error;
        }
      }
      // Serialize periodic and per-file renewals so an older attachment snapshot cannot undo a newer one.
      let renewal = Promise.resolve();
      const renew = () => {
        renewal = renewal.then(() => keepChatMessageAlive(submission, uploadedIds(), controller.signal));
        return renewal;
      };
      const scheduleHeartbeat = () => {
        heartbeat = window.setTimeout(async () => {
          try {
            await renew();
            if (!stopped) scheduleHeartbeat();
          } catch (error) {
            if (!stopped) { heartbeatError = error; controller.abort(); }
          }
        }, KEEP_ALIVE_INTERVAL);
      };
      scheduleHeartbeat();
      let completedBytes = current.filter((item) => item.uploaded).reduce((sum, item) => sum + item.file.size, 0);
      let completedFiles = current.filter((item) => item.uploaded).length;
      for (const [index, item] of current.entries()) {
        if (item.uploaded) continue;
        const uploaded = await uploadChatAttachment(item.file, (progress) => {
          if (mounted.current) setProgress({ fileName: item.file.name, fileIndex: index + 1, fileCount: current.length, completedFiles,
            completedBytes, totalBytes, progress, awaitingConflict: false });
        }, controller.signal);
        item.uploaded = uploaded;
        if (!mounted.current) return;
        setAttachments([...current]);
        await renew();
        completedBytes += item.file.size; completedFiles += 1;
      }
      setProgress(null);
      commitAttempted.current = true;
      const message = await submitChatMessage(submission, text.trim(), current.map((item) => item.uploaded!.id), controller.signal);
      if (!mounted.current) return;
      confirm(message);
      for (const item of current) if (item.preview) URL.revokeObjectURL(item.preview);
      updateFiles([]); setText(''); newSubmission();
    } catch (cause) {
      if (!mounted.current) return;
      const error = heartbeatError ?? cause;
      if (error instanceof ChatApiError && error.code === 'attachment_unavailable') {
        invalidate(error.attachmentIds);
        commitAttempted.current = false;
      }
      setError(error instanceof Error ? error.message : '发送失败，请重试');
    } finally {
      stopped = true;
      if (heartbeat !== undefined) window.clearTimeout(heartbeat);
      controller.abort();
      pending.current = null;
      if (mounted.current) { setBusy(false); setProgress(null); }
    }
  };
  return { text, attachments, busy, progress, error, changeText, addFiles, remove, submit };
}
