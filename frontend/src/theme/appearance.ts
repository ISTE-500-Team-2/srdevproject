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
const applyCurrent = () => applyTheme(resolveTheme(current, prefersDark()));

export function setAppearance(next: Appearance) {
  current = next;
  try {
    safeStorage()?.setItem(APPEARANCE_KEY, next);
  } catch {
    // Private mode or blocked storage: the choice still applies for this visit.
  }
  applyCurrent();
  notify();
}

/**
 * Keeps the page in step with the device setting and with other tabs for the
 * whole visit, whether or not any appearance control is on screen. Called once
 * at the app root (main.tsx); returns a function that stops listening.
 */
export function startAppearanceSync(): () => void {
  if (typeof window === 'undefined') return () => {};
  const media = window.matchMedia?.(DARK_QUERY);
  const onSystemChange = () => {
    if (current === 'system') applyCurrent();
    notify();
  };
  // Another tab changed the setting.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== APPEARANCE_KEY) return;
    current = readAppearance();
    applyCurrent();
    notify();
  };
  media?.addEventListener?.('change', onSystemChange);
  window.addEventListener('storage', onStorage);
  // The device may have switched between the pre-paint script and now.
  applyCurrent();
  return () => {
    media?.removeEventListener?.('change', onSystemChange);
    window.removeEventListener('storage', onStorage);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAppearance() {
  const appearance = useSyncExternalStore(subscribe, () => current, () => DEFAULT_APPEARANCE);
  const theme = useSyncExternalStore(subscribe, () => resolveTheme(current, prefersDark()), () => 'light' as Theme);
  return { appearance, theme, setAppearance };
}
