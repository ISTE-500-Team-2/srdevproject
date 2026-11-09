import { useSyncExternalStore } from 'react';

/** What the person picked. `system` follows the device setting, including changes while the site is open. */
export type Appearance = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

// public/theme-init.js applies the same preference before first paint; keep these in step (see appearance.test.ts).
export const APPEARANCE_KEY = 'collaboratory:appearance';
export const DEFAULT_APPEARANCE: Appearance = 'system';
export const THEME_COLOR: Record<Theme, string> = { light: '#211006', dark: '#120d0a' };

const DARK_QUERY = '(prefers-color-scheme: dark)';
const isAppearance = (value: unknown): value is Appearance => value === 'light' || value === 'dark' || value === 'system';

export function readAppearance(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Appearance {
  try {
    const stored = storage?.getItem(APPEARANCE_KEY);
    return isAppearance(stored) ? stored : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function resolveTheme(appearance: Appearance, prefersDark: boolean): Theme {
  if (appearance === 'system') return prefersDark ? 'dark' : 'light';
  return appearance;
}

export function applyTheme(theme: Theme, doc: Document = document) {
  const root = doc.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

const prefersDark = () => typeof window !== 'undefined' && !!window.matchMedia?.(DARK_QUERY).matches;

// A tiny store so every control (account menu, staff sidebar, mobile nav) stays in sync.
let current: Appearance = readAppearance();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export function setAppearance(next: Appearance) {
  current = next;
  try {
    safeStorage()?.setItem(APPEARANCE_KEY, next);
  } catch {
    // Private mode or blocked storage: the choice still applies for this visit.
  }
  applyTheme(resolveTheme(next, prefersDark()));
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const media = typeof window !== 'undefined' ? window.matchMedia?.(DARK_QUERY) : undefined;
  const onSystemChange = () => {
    if (current === 'system') applyTheme(resolveTheme('system', prefersDark()));
    notify();
  };
  // Another tab changed the setting.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== APPEARANCE_KEY) return;
    current = readAppearance();
    applyTheme(resolveTheme(current, prefersDark()));
    notify();
  };
  media?.addEventListener?.('change', onSystemChange);
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    media?.removeEventListener?.('change', onSystemChange);
    window.removeEventListener('storage', onStorage);
  };
}

export function useAppearance() {
  const appearance = useSyncExternalStore(subscribe, () => current, () => DEFAULT_APPEARANCE);
  const theme = useSyncExternalStore(subscribe, () => resolveTheme(current, prefersDark()), () => 'light' as Theme);
  return { appearance, theme, setAppearance };
}
