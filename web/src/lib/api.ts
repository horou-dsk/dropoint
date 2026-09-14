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
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/files${suffix ? `?${suffix}` : ''}`);
    request.responseType = 'json';
    request.upload.onprogress = (event) => {
      // XHR counts the multipart envelope too; scale its ratio to file bytes.
      const loaded = event.lengthComputable && event.total > 0
        ? Math.floor(file.size * Math.min(1, Math.max(0, event.loaded / event.total)))
        : null;
      onProgress?.({ loaded, total: file.size, phase: 'uploading' });
    };
    request.upload.onload = () => onProgress?.({ loaded: file.size, total: file.size, phase: 'saving' });
    request.onload = () => {
      const body = request.response;
      if (request.status === 409) {
        reject(new UploadConflictError(body?.message || relativePath));
      } else if (request.status < 200 || request.status >= 300) {
        reject(new Error(body?.message || `上传失败：HTTP ${request.status}`));
      } else if (typeof body?.path !== 'string' || !Number.isFinite(body?.size) || body.size < 0) {
        reject(new Error('上传失败：服务端返回了无效响应'));
      } else {
        resolve({ path: body.path, size: body.size });
      }
    };
    request.onerror = () => reject(new Error('上传失败：网络连接中断，请重试'));
    request.onabort = () => reject(new Error('上传已中止'));
    request.ontimeout = () => reject(new Error('上传超时，请重试'));
    onProgress?.({ loaded: 0, total: file.size, phase: 'uploading' });
    request.send(form);
  });
}
