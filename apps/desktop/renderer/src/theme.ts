/**
 * Desktop theme preferences. "system" is the default so appearance follows the
 * operating system; explicit light/dark choices remain persistent overrides.
 */
import { useEffect, useState } from 'react';
import { bridge } from './bridge.ts';

export type Theme = 'system' | 'dark' | 'light';

function resolve(theme: Theme): 'dark' | 'light' {
  if (theme !== 'system') return theme;
  if (typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function getTheme(): Theme {
  try {
    const v = window.localStorage.getItem('hmh.theme');
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch { /* 私有模式 */ }
  return 'system'; // First run follows the OS appearance; users can override in settings.
}

export function useTheme(): { theme: Theme; resolved: 'dark' | 'light'; setTheme: (t: Theme) => void } {
  const [theme, set] = useState<Theme>(getTheme);
  const [resolved, setResolved] = useState<'dark' | 'light'>(() => resolve(getTheme()));
  useEffect(() => {
    const apply = (): void => {
      const r = resolve(theme);
      setResolved(r);
      document.documentElement.dataset.theme = r;
      // 原生标题栏 overlay 同步(浅色模式不再有黑条)
      void bridge?.chromeTheme(r === 'dark');
    };
    apply();
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  return {
    theme,
    resolved,
    setTheme: (t: Theme): void => {
      try { window.localStorage.setItem('hmh.theme', t); } catch { /* 私有模式 */ }
      set(t);
    },
  };
}
