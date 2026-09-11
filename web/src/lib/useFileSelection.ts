import { useCallback, useState } from 'react';
import type { FileEntry } from './api';

type Selection = { directory: string; paths: Set<string>; anchor: string | null };
export type SelectionModifiers = { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };

export function useFileSelection() {
  const [selection, setSelection] = useState<Selection>({ directory: '', paths: new Set(), anchor: null });

  const reconcile = useCallback((directory: string, entries: FileEntry[]) => {
    setSelection((previous) => {
      if (previous.directory !== directory) return { directory, paths: new Set(), anchor: null };
      const available = new Set(entries.map((entry) => entry.path));
      return {
        directory,
        paths: new Set([...previous.paths].filter((path) => available.has(path))),
        anchor: previous.anchor && available.has(previous.anchor) ? previous.anchor : null,
      };
    });
  }, []);

  const clear = useCallback(() => setSelection((previous) => ({ ...previous, paths: new Set(), anchor: null })), []);
  const replace = useCallback((paths: string[]) => setSelection((previous) => ({
    ...previous, paths: new Set(paths), anchor: paths[0] ?? null,
  })), []);
  const remove = useCallback((paths: string[]) => setSelection((previous) => {
    const removed = (path: string) => paths.some((parent) => path === parent || path.startsWith(`${parent}/`));
    return {
      ...previous,
      paths: new Set([...previous.paths].filter((path) => !removed(path))),
      anchor: previous.anchor && !removed(previous.anchor) ? previous.anchor : null,
    };
  }), []);

  const select = useCallback((path: string, entries: FileEntry[], modifiers: SelectionModifiers) => {
    setSelection((previous) => {
      const additive = modifiers.ctrlKey || modifiers.metaKey;
      const anchorIndex = entries.findIndex((entry) => entry.path === previous.anchor);
      const targetIndex = entries.findIndex((entry) => entry.path === path);
      if (modifiers.shiftKey && anchorIndex >= 0 && targetIndex >= 0) {
        const paths = additive ? new Set(previous.paths) : new Set<string>();
        entries.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
          .forEach((entry) => paths.add(entry.path));
        return { ...previous, paths };
      }
      const paths = additive ? new Set(previous.paths) : new Set<string>();
      if (additive && paths.has(path)) paths.delete(path);
      else paths.add(path);
      return { ...previous, paths, anchor: path };
    });
  }, []);

  return { paths: selection.paths, select, clear, replace, remove, reconcile };
}
