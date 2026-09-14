import { vi } from 'vitest';

export class UploadRequestMock {
  static requests: UploadRequestMock[] = [];
  upload: {
    onprogress: ((event: ProgressEvent) => void) | null;
    onload: (() => void) | null;
  } = { onprogress: null, onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  status = 0;
  response: unknown = null;
  responseType = '';
  open = vi.fn();
  send = vi.fn();

  constructor() { UploadRequestMock.requests.push(this); }

  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.(new ProgressEvent('progress', { loaded, total, lengthComputable }));
  }

  transferred() { this.upload.onload?.(); }

  respond(status: number, body: unknown) {
    this.status = status;
    this.response = body;
    this.onload?.();
  }
}

export function mockUploadRequests() {
  UploadRequestMock.requests = [];
  vi.stubGlobal('XMLHttpRequest', UploadRequestMock);
}
