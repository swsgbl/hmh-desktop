/**
 * UI 主题(2026-10-11 对标 DSH 的 theme 能力;Desktop 本地偏好,与 runtime
 * 的 web 主题互不干涉)。system 跟随 prefers-color-scheme 并监听变化。
 * v4 DSH 设计语言:无本地偏好时默认浅色(resolve 的 system 判定不变,仍可跟随 OS)。
 */
import { useEffect, useState } from 'react';
import { bridge } from './bridge.ts';

export type Theme = 'system' | 'dark' | 'light';

function resolve(theme: Theme): 'dark' | 'light' {
  if (theme !== 'system') return theme;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

export function getTheme(): Theme {
  try {
    const v = window.localStorage.getItem('hmh.theme');
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch { /* 私有模式 */ }
  return 'light'; // v4 DSH:默认浅色,深色 OS 下首屏也呈现明亮分层
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
    const mq = window.matchMedia('(prefers-color-scheme: light)');
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
