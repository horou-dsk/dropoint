import type { FileEntry } from '../lib/api';

export default function FileIcon({ entry, className = 'h-12 w-12' }: { entry: FileEntry; className?: string }) {
  if (entry.kind === 'directory') {
    return (
      <svg className={`${className} shrink-0 drop-shadow-sm`} viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <path d="M4 12a4 4 0 0 1 4-4h11l5 5h16a4 4 0 0 1 4 4v21H4V12Z" className="fill-sky-500 dark:fill-sky-600" />
        <path d="M4 19a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v18a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V19Z" className="fill-sky-300 dark:fill-sky-400" />
        <path d="M7 17h34" stroke="white" strokeOpacity=".5" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg className={`${className} shrink-0 drop-shadow-sm`} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M12 4h16l10 10v26a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4Z" className="fill-white stroke-slate-300 dark:fill-slate-700 dark:stroke-slate-500" />
      <path d="M28 4v10h10" className="fill-slate-100 stroke-slate-300 dark:fill-slate-600 dark:stroke-slate-500" />
      {entry.mime?.startsWith('image/') ? (
        <g className="text-emerald-500 dark:text-emerald-400">
          <rect x="14" y="22" width="18" height="14" rx="2" fill="currentColor" fillOpacity=".15" />
          <path d="m15 34 6-6 4 4 3-3 4 5" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <circle cx="28" cy="25" r="2" fill="currentColor" />
        </g>
      ) : entry.mime?.startsWith('video/') ? (
        <path d="m19 23 12 7-12 7V23Z" className="fill-violet-400" />
      ) : (
        <path d="M15 24h16M15 29h16M15 34h10" className="stroke-slate-400" strokeWidth="2" strokeLinecap="round" />
      )}
    </svg>
  );
}
