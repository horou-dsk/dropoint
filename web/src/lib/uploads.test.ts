import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectDroppedFiles, filesForUpload } from './uploads';
import { uploadFile } from './api';

function fileEntry(file: File): FileSystemEntry {
  return {
    name: file.name, isFile: true, isDirectory: false,
    file: (resolve: (value: File) => void) => queueMicrotask(() => resolve(file)),
  } as unknown as FileSystemFileEntry;
}

function directoryEntry(name: string, batches: FileSystemEntry[][]): FileSystemEntry {
  return {
    name, isFile: false, isDirectory: true,
    createReader: () => {
      let index = 0;
      return { readEntries: (resolve: (entries: FileSystemEntry[]) => void) => queueMicrotask(() => resolve(batches[index++] ?? [])) };
    },
  } as unknown as FileSystemDirectoryEntry;
}

afterEach(() => vi.unstubAllGlobals());

describe('dropped files', () => {
  it('keeps native File objects intact and preserves nested paths across directory batches', async () => {
    const photo = new File(['image'], 'photo.png');
    const notes = new File(['notes'], 'notes.txt');
    Object.defineProperty(photo, 'webkitRelativePath', { get: () => '' });
    const directory = directoryEntry('Album', [
      [directoryEntry('Trip', [[fileEntry(photo)]])],
      [fileEntry(notes)],
    ]);
    const transfer = {
      items: [{ kind: 'file', webkitGetAsEntry: () => directory, getAsFile: () => null }], files: [],
    } as unknown as DataTransfer;
    const files = await collectDroppedFiles(transfer);
    expect(files.map((item) => item.relativePath)).toEqual(['Album/Trip/photo.png', 'Album/notes.txt']);
    expect(files[0].file).toBe(photo);
    expect(photo.webkitRelativePath).toBe('');
  });

  it('captures every top-level item before the drop event becomes protected', async () => {
    const one = new File(['one'], 'one.txt');
    const two = new File(['two'], 'two.txt');
    let protectedStore = false;
    const transfer = {
      items: [one, two].map((file) => ({
        kind: 'file',
        webkitGetAsEntry: () => protectedStore ? null : fileEntry(file),
        getAsFile: () => protectedStore ? null : file,
      })),
      files: [],
    } as unknown as DataTransfer;
    const result = collectDroppedFiles(transfer);
    protectedStore = true;
    expect((await result).map((item) => item.file)).toEqual([one, two]);
  });

  it('supports file selection and browsers without entry APIs', async () => {
    const file = new File(['data'], 'file.txt');
    const files = await collectDroppedFiles({ items: [], files: [file] } as unknown as DataTransfer);
    expect(files).toEqual([{ file, relativePath: 'file.txt' }]);
    Object.defineProperty(file, 'webkitRelativePath', { get: () => 'folder/file.txt' });
    expect(filesForUpload([file])).toEqual([{ file, relativePath: 'folder/file.txt' }]);
  });

  it('propagates file read errors to the upload UI', async () => {
    const entry = {
      isFile: true,
      file: (_resolve: unknown, reject: (error: DOMException) => void) => reject(new DOMException('Cannot read file')),
    } as unknown as FileSystemEntry;
    const transfer = {
      items: [{ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null }], files: [],
    } as unknown as DataTransfer;
    await expect(collectDroppedFiles(transfer)).rejects.toThrow('Cannot read file');
  });

  it('sends the separate relative path in the multipart API', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ path: 'folder/file.txt', size: 4 })));
    vi.stubGlobal('fetch', request);
    await uploadFile({ file: new File(['data'], 'file.txt'), relativePath: 'folder/file.txt' }, 'destination');
    const [url, options] = request.mock.calls[0];
    expect(url).toBe('/api/files?path=destination');
    expect((options.body as FormData).get('relative_path')).toBe('folder/file.txt');
    expect(((options.body as FormData).get('file') as File).name).toBe('file.txt');
  });
});
