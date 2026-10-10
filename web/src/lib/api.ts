import type { UploadItem } from './uploads';

export type HealthResponse = {
  status: 'ok';
};

export type FileEntry = {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size: number;
  modified: number | null;
  mime: string | null;
};

export type DirectoryListing = {
  path: string;
  entries: FileEntry[];
};

export type DirectoryInfo = { name: string };

export type ArchiveResponse = { url: string; filename: string };
export type DeleteResult = { deleted: string[]; failed: { path: string; message: string }[] };

async function postPaths<T>(action: 'archive' | 'delete', paths: string[]): Promise<T> {
  const response = await fetch(`/api/files/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message || `操作失败：HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const createArchive = (paths: string[]) => postPaths<ArchiveResponse>('archive', paths);
export const deleteFiles = (paths: string[]) => postPaths<DeleteResult>('delete', paths);

export function startDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

export type ConflictMode = 'rename' | 'overwrite';

export type UploadConflictCheck = {
  exists: boolean;
  path: string;
};

export type ChatMessage = {
  id: number;
  text: string;
  timestamp: number;
  attachments: ChatAttachment[];
};

export type ChatAttachment = {
  id: string;
  name: string;
  size: number;
  mime: string;
  previewUrl: string | null;
  downloadUrl: string;
};

function withPath(path: string): string {
  const query = new URLSearchParams();
  if (path) query.set('path', path);
  const suffix = query.toString();
  return suffix ? `?${suffix}` : '';
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch('/api/health', { signal });

  if (!response.ok) {
    throw new Error(`健康检查失败：HTTP ${response.status}`);
  }

  return response.json() as Promise<HealthResponse>;
}

export async function getDirectoryInfo(): Promise<DirectoryInfo> {
  const response = await fetch('/api/info');
  if (!response.ok) throw new Error('无法读取共享目录信息');
  return response.json() as Promise<DirectoryInfo>;
}

export async function listFiles(path: string, signal?: AbortSignal): Promise<DirectoryListing> {
  const response = await fetch(`/api/files${withPath(path)}`, { signal });
  if (!response.ok) throw new Error(`读取目录失败：HTTP ${response.status}`);
  return response.json() as Promise<DirectoryListing>;
}

export function fileUrl(path: string, kind: 'preview' | 'download' = 'preview'): string {
  return `/api/files/${kind}${withPath(path)}`;
}

export class UploadConflictError extends Error {
  constructor(public readonly path: string) {
    super(`文件已存在：${path}`);
  }
}

export async function checkUploadConflict(item: UploadItem, destination: string): Promise<UploadConflictCheck> {
  const query = new URLSearchParams({ relative_path: item.relativePath });
  if (destination) query.set('path', destination);
  const response = await fetch(`/api/files/conflict?${query.toString()}`);
  if (!response.ok) throw new Error(`检查同名文件失败：HTTP ${response.status}`);
  return response.json() as Promise<UploadConflictCheck>;
}

export type UploadProgress = {
  loaded: number | null;
  total: number;
  phase: 'uploading' | 'saving';
};

export function uploadFile(
  { file, relativePath }: UploadItem,
  destination: string,
  conflict: ConflictMode | 'fail' = 'fail',
  onProgress?: (progress: UploadProgress) => void,
): Promise<{ path: string; size: number }> {
  const query = new URLSearchParams();
  if (destination) query.set('path', destination);
  if (conflict !== 'fail') query.set('conflict', conflict);
  const form = new FormData();
  form.append('relative_path', relativePath);
  form.append('file', file, file.name);
  const suffix = query.toString();
  return uploadMultipart(file, `/api/files${suffix ? `?${suffix}` : ''}`, form, (status, body) => {
    if (status === 409) throw new UploadConflictError(body?.message || relativePath);
    if (status < 200 || status >= 300) throw new Error(body?.message || `上传失败：HTTP ${status}`);
    if (typeof body?.path !== 'string' || !Number.isFinite(body?.size) || body.size < 0) throw new Error('上传失败：服务端返回了无效响应');
    return { path: body.path as string, size: body.size as number };
  }, onProgress);
}

// File-workspace and chat uploads share transport progress and cancellation handling.
function uploadMultipart<T>(file: File, url: string, form: FormData, decode: (status: number, body: any) => T,
  onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', url);
    request.responseType = 'json';
    const abort = () => request.abort();
    const finish = (result: T | Error) => {
      signal?.removeEventListener('abort', abort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    request.upload.onprogress = (event) => {
      // XHR counts the multipart envelope too; scale its ratio to file bytes.
      const loaded = event.lengthComputable && event.total > 0
        ? Math.floor(file.size * Math.min(1, Math.max(0, event.loaded / event.total)))
        : null;
      onProgress?.({ loaded, total: file.size, phase: 'uploading' });
    };
    request.upload.onload = () => onProgress?.({ loaded: file.size, total: file.size, phase: 'saving' });
    request.onload = () => {
      try { finish(decode(request.status, request.response)); }
      catch (error) { finish(error instanceof Error ? error : new Error('上传失败')); }
    };
    request.onerror = () => finish(new Error('上传失败：网络连接中断，请重试'));
    request.onabort = () => finish(new Error('上传已中止'));
    request.ontimeout = () => finish(new Error('上传超时，请重试'));
    if (signal?.aborted) { finish(new Error('上传已中止')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    onProgress?.({ loaded: 0, total: file.size, phase: 'uploading' });
    request.send(form);
  });
}

export function uploadChatAttachment(file: File, onProgress?: (progress: UploadProgress) => void, signal?: AbortSignal): Promise<ChatAttachment> {
  const form = new FormData();
  form.append('file', file, file.name);
  return uploadMultipart(file, '/api/chat/attachments', form, (status, body) => {
    if (status < 200 || status >= 300) throw new Error(body?.message || `上传失败：HTTP ${status}`);
    if (typeof body?.id !== 'string' || typeof body.name !== 'string' || !Number.isFinite(body.size) || body.size < 0 ||
      typeof body.mime !== 'string' || (body.previewUrl !== null && typeof body.previewUrl !== 'string') || typeof body.downloadUrl !== 'string') {
      throw new Error('上传失败：服务端返回了无效响应');
    }
    return body as ChatAttachment;
  }, onProgress, signal);
}

export class ChatApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly attachmentIds: string[]) { super(message); }
}

export type ChatSubmission = { clientMessageId: string; submissionToken: string };

async function chatRequest(path: string, payload: unknown, signal?: AbortSignal) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ChatApiError(body?.message || `发送失败：HTTP ${response.status}`, body?.code || '', body?.attachmentIds || []);
  return body;
}

export async function prepareChatMessage(clientMessageId: string, signal?: AbortSignal): Promise<ChatSubmission> {
  const body = await chatRequest('/api/chat/messages/prepare', { clientMessageId }, signal);
  if (typeof body?.submissionToken !== 'string' || !body.submissionToken) throw new Error('发送失败：服务端返回了无效确认标识');
  return { clientMessageId, submissionToken: body.submissionToken };
}

export async function keepChatMessageAlive(submission: ChatSubmission, attachmentIds: string[], signal?: AbortSignal): Promise<void> {
  // A stalled renewal must fail before the ten-minute reservation can expire unnoticed.
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
  try {
    await chatRequest('/api/chat/messages/keepalive', { ...submission, attachmentIds }, controller.signal);
    if (controller.signal.aborted) throw new Error('附件续期已中止');
  } catch (error) {
    if (timedOut) throw new Error('附件续期超时，请重试');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function submitChatMessage(submission: ChatSubmission, text: string, attachmentIds: string[], signal?: AbortSignal): Promise<ChatMessage> {
  const body = await chatRequest('/api/chat/messages', { ...submission, text, attachmentIds }, signal);
  if (!body || !Number.isSafeInteger(body.id) || typeof body.text !== 'string' || !Number.isFinite(body.timestamp) || !Array.isArray(body.attachments)) {
    throw new Error('发送失败：服务端返回了无效响应');
  }
  return body as ChatMessage;
}
