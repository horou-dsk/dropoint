import { useEffect, useState } from 'react';

export default function MediaContent({ name, mime, previewUrl, downloadUrl, onImageOpen, compact = false }: {
  name: string; mime: string; previewUrl: string; downloadUrl: string; onImageOpen?: () => void; compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [previewUrl]);
  if (failed) return <p role="alert" className="rounded-lg bg-panel p-3 text-sm text-muted">
    无法加载或播放此媒体。<a className="ml-2 text-accent underline" href={downloadUrl}>下载后打开</a>
  </p>;
  if (mime.startsWith('image/')) {
    const image = <img className={`${compact ? 'max-h-56' : 'max-h-full'} max-w-full rounded object-contain`} src={previewUrl} alt={name} loading="lazy" onError={() => setFailed(true)} />;
    return onImageOpen ? <button aria-label={`预览 ${name}`} className="flex max-h-56 max-w-full items-center justify-center overflow-hidden rounded" onClick={onImageOpen}>{image}</button>
      : <div className="flex h-full items-center justify-center">{image}</div>;
  }
  if (mime.startsWith('video/')) return <div className="flex h-full items-center justify-center">
    <video aria-label={name} className={`${compact ? 'max-h-56' : 'max-h-full'} w-full max-w-full rounded object-contain`} src={previewUrl} controls preload={compact ? 'none' : 'metadata'} onError={() => setFailed(true)} />
  </div>;
  return <div className="flex h-full items-center justify-center">
    <audio aria-label={name} className="w-full max-w-full" src={previewUrl} controls preload={compact ? 'none' : 'metadata'} onError={() => setFailed(true)} />
  </div>;
}
