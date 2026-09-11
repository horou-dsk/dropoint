export type UploadItem = { file: File; relativePath: string };

export function filesForUpload(files: ArrayLike<File>): UploadItem[] {
  return Array.from(files, (file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
}

async function collectEntry(entry: FileSystemEntry, prefix = ''): Promise<UploadItem[]> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
    return [{ file, relativePath: `${prefix}${file.name}` }];
  }

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const files: UploadItem[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return files;
    const children = await Promise.all(batch.map((child) => collectEntry(child, `${prefix}${entry.name}/`)));
    files.push(...children.flat());
  }
}

export async function collectDroppedFiles(transfer: DataTransfer): Promise<UploadItem[]> {
  // The drag data store becomes protected after the drop handler yields.
  const sources = Array.from(transfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
  const fallback = filesForUpload(transfer.files);
  if (!sources.length) return fallback;
  const files = await Promise.all(sources.map(({ entry, file }) => {
    if (entry) return collectEntry(entry);
    return file ? filesForUpload([file]) : [];
  }));
  return files.flat();
}
