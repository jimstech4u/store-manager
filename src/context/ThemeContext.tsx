'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Theme, with an explicit "follow the system" state.
 *
 * Three stored values rather than a boolean, because "follow my phone" is a real preference and
 * collapsing it into light/dark silently overrides a device-wide accessibility setting the user
 * already chose deliberately.
 */
export type StoredTheme = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'sm.theme';

interface ThemeContextValue {
  /** The theme actually in effect right now. */
  theme: Theme;
  /** What the user chose, which may be 'system'. */
  storedTheme: StoredTheme;
  setTheme: (t: StoredTheme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

function systemTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Always starts at 'system' on the server so server and client markup agree; the real stored
  // preference is read in an effect. Reading localStorage during render would hydrate-mismatch.
  const [storedTheme, setStoredTheme] = useState<StoredTheme>('system');
  const [resolved, setResolved] = useState<Theme>('light');

  useEffect(() => {
    let initial: StoredTheme = 'system';
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as StoredTheme | null;
      if (saved === 'light' || saved === 'dark' || saved === 'system') initial = saved;
    } catch {
      /* private mode, or storage blocked — 'system' is a fine default */
    }
    setStoredTheme(initial);
    setResolved(initial === 'system' ? systemTheme() : initial);
  }, []);

  // Track the OS setting while the user is on 'system'. Someone whose phone flips to dark at
  // sunset expects this to follow without reopening the app.
  useEffect(() => {
    if (storedTheme !== 'system' || typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [storedTheme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);

  const setTheme = useCallback((t: StoredTheme) => {
    setStoredTheme(t);
    setResolved(t === 'system' ? systemTheme() : t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* not fatal: the choice simply will not survive a reload */
    }
  }, []);

  const value = useMemo(
    () => ({ theme: resolved, storedTheme, setTheme }),
    [resolved, storedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
