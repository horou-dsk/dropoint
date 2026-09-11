import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type MenuItem = { label: string; action: () => void; danger?: boolean; disabled?: boolean };
export type MenuPosition = { x: number; y: number; trigger: HTMLElement };

export default function ContextMenu({ position, items, onClose }: {
  position: MenuPosition; items: MenuItem[]; onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [coordinates, setCoordinates] = useState({ left: position.x, top: position.y });

  useLayoutEffect(() => {
    const element = menu.current!;
    const bounds = element.getBoundingClientRect();
    setCoordinates({
      left: Math.max(8, Math.min(position.x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(position.y, window.innerHeight - bounds.height - 8)),
    });
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [position]);

  useEffect(() => {
    const dismissOutside = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('scroll', dismissOutside, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('scroll', dismissOutside, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label="文件操作"
      style={coordinates}
      className="fixed z-40 max-h-[calc(100dvh-16px)] w-52 max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-line bg-panel p-1.5 text-ink shadow-xl"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        } else if (event.key === 'Escape' || event.key === 'Tab') {
          if (event.key === 'Escape') event.preventDefault();
          onClose();
          position.trigger.focus({ preventScroll: true });
        }
      }}
    >
      {items.map((item) => (
        <button
          key={item.label} type="button" role="menuitem" disabled={item.disabled}
          className={`block w-full rounded-md px-3 py-2 text-left text-xs hover:bg-hover focus:bg-hover disabled:opacity-40 ${item.danger ? 'text-rose-600 dark:text-rose-300' : ''}`}
          onClick={() => { onClose(); position.trigger.focus({ preventScroll: true }); item.action(); }}
        >{item.label}</button>
      ))}
    </div>, document.body,
  );
}
