import type { ChatAttachment } from '../lib/api';
import { formatSize } from '../lib/files';
import FileIcon from './FileIcon';
import MediaContent from './MediaContent';

export default function ChatAttachmentCard({ attachment, onPreview }: { attachment: ChatAttachment; onPreview: () => void }) {
  return <div className="min-w-0 space-y-2 rounded-lg border border-line bg-panel p-2">
    {attachment.previewUrl ? <div className="max-h-56 overflow-hidden">
      <MediaContent {...attachment} previewUrl={attachment.previewUrl} onImageOpen={onPreview} compact />
    </div> : <FileIcon entry={{ kind: 'file', mime: attachment.mime }} className="h-8 w-8" />}
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <div className="min-w-0 flex-1">
        <p className="truncate text-ink" title={attachment.name}>{attachment.name}</p>
        <p className="mt-1 text-[11px] text-muted">{formatSize(attachment.size)}</p>
      </div>
      {attachment.previewUrl && !attachment.mime.startsWith('image/') && <button className="text-accent hover:underline" onClick={onPreview}>预览</button>}
      <a className="shrink-0 text-accent hover:underline" href={attachment.downloadUrl} download={attachment.name}>下载</a>
    </div>
  </div>;
}
