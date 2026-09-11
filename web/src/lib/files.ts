import type { FileEntry } from './api';

export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function isTextFile(entry: FileEntry): boolean {
  return ['text/', 'application/json', 'application/javascript', 'application/xml']
    .some((prefix) => entry.mime?.startsWith(prefix));
}
