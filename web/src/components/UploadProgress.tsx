import type { UploadProgress as FileProgress } from '../lib/api';
import { formatSize } from '../lib/files';

export type UploadStatus = {
  fileName: string;
  fileIndex: number;
  fileCount: number;
  completedFiles: number;
  completedBytes: number;
  totalBytes: number;
  progress: FileProgress;
  awaitingConflict: boolean;
};

function ProgressBar({ label, percent }: { label: string; percent: number | null }) {
  return (
    <div
      role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? '正在传输，进度暂不可用' : `${percent}%`}
      className="h-1.5 overflow-hidden rounded-full bg-line"
    >
      <div className={`h-full rounded-full bg-accent ${percent === null ? 'w-1/3 motion-safe:animate-pulse' : ''}`} style={percent === null ? undefined : { width: `${percent}%` }} />
    </div>
  );
}

export default function UploadProgress({ status }: { status: UploadStatus }) {
  const { fileName, fileIndex, fileCount, completedFiles, completedBytes, totalBytes, progress, awaitingConflict } = status;
  const filePercent = progress.loaded === null ? null : progress.total > 0
    ? Math.floor(progress.loaded / progress.total * 100)
    : progress.phase === 'saving' ? 100 : 0;
  const totalLoaded = progress.loaded === null ? null : completedBytes + progress.loaded;
  const totalPercent = totalLoaded === null ? null : totalBytes > 0
    ? Math.floor(totalLoaded / totalBytes * 100)
    : Math.floor((completedFiles + (progress.phase === 'saving' ? 1 : 0)) / fileCount * 100);
  const phase = awaitingConflict ? '等待处理同名文件' : progress.phase === 'saving' ? '等待服务端保存' : '正在上传';

  return (
    <section aria-label="上传进度" className="shrink-0 space-y-2 border-b border-line bg-surface px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span role="status" className="shrink-0 text-accent">{phase} {fileIndex}/{fileCount}</span>
        <span className="min-w-0 flex-1 truncate text-ink" title={fileName}>{fileName}</span>
      </div>
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-muted">
        <span>当前文件 {filePercent === null ? '进度暂不可用' : `${filePercent}%`}</span>
        <span>{progress.loaded === null ? '已传输大小未知' : formatSize(progress.loaded)} / {formatSize(progress.total)}</span>
      </div>
      <ProgressBar label="当前文件上传进度" percent={filePercent} />
      {fileCount > 1 && <>
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-muted">
          <span>总进度 {totalPercent === null ? '计算中' : `${totalPercent}%`} · 已完成 {completedFiles}/{fileCount} 个文件</span>
          <span>{totalLoaded === null ? '已传输大小未知' : formatSize(totalLoaded)} / {formatSize(totalBytes)}</span>
        </div>
        <ProgressBar label="总上传进度" percent={totalPercent} />
      </>}
    </section>
  );
}
