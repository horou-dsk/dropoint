import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('dropoint-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return undefined;
    const updateFromSystem = (event: MediaQueryListEvent) => {
      if (!localStorage.getItem('dropoint-theme')) {
        setTheme(event.matches ? 'dark' : 'light');
      }
    };
    media.addEventListener?.('change', updateFromSystem);
    return () => media.removeEventListener?.('change', updateFromSystem);
  }, []);

  const toggleTheme = () => setTheme((current) => {
    const next = current === 'light' ? 'dark' : 'light';
    localStorage.setItem('dropoint-theme', next);
    return next;
  });

  return { theme, toggleTheme };
}
