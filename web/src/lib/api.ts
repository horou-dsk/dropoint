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

export type ConflictMode = 'rename' | 'overwrite';

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

export async function uploadFile({ file, relativePath }: UploadItem, destination: string, conflict: ConflictMode | 'fail' = 'fail'): Promise<{ path: string; size: number }> {
  const query = new URLSearchParams();
  if (destination) query.set('path', destination);
  if (conflict !== 'fail') query.set('conflict', conflict);
  const form = new FormData();
  form.append('relative_path', relativePath);
  form.append('file', file, file.name);
  const suffix = query.toString();
  const response = await fetch(`/api/files${suffix ? `?${suffix}` : ''}`, { method: 'POST', body: form });
  if (response.status === 409) {
    const body = (await response.json()) as { message?: string };
    throw new UploadConflictError(body.message || file.name);
  }
  if (!response.ok) throw new Error(`上传失败：HTTP ${response.status}`);
  return response.json() as Promise<{ path: string; size: number }>;
}
