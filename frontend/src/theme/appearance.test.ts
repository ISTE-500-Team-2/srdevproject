// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, THEME_COLOR, applyTheme, readAppearance, resolveTheme, setAppearance, startAppearanceSync } from './appearance';

const initScript = readFileSync(join(__dirname, '../../public/theme-init.js'), 'utf8');

function mockSystem(dark: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: dark && query.includes('dark'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

// A device setting the test can flip, delivering 'change' like a real MediaQueryList.
function controllableSystem(initiallyDark: boolean) {
  let dark = initiallyDark;
  const handlers = new Set<() => void>();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() { return dark && query.includes('dark'); },
    media: query,
    addEventListener: (_type: string, handler: () => void) => handlers.add(handler),
    removeEventListener: (_type: string, handler: () => void) => handlers.delete(handler),
  }));
  return { set(next: boolean) { dark = next; handlers.forEach((handler) => handler()); } };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.head.innerHTML = '<meta name="theme-color" content="#211006" />';
});
afterEach(() => vi.restoreAllMocks());

describe('appearance preference', () => {
  test('defaults to following the device, and ignores unknown stored values', () => {
    expect(DEFAULT_APPEARANCE).toBe('system');
    expect(readAppearance(localStorage)).toBe('system');
    localStorage.setItem(APPEARANCE_KEY, 'sepia');
    expect(readAppearance(localStorage)).toBe('system');
    localStorage.setItem(APPEARANCE_KEY, 'dark');
    expect(readAppearance(localStorage)).toBe('dark');
  });

  test('survives storage that throws (private mode)', () => {
    const broken = { getItem: () => { throw new Error('blocked'); } };
    expect(readAppearance(broken)).toBe('system');
  });

  test('system follows the device; explicit choices override it', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  test('applying a theme sets the attribute, native color scheme and browser chrome color', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(THEME_COLOR.dark);
  });

  test('choosing an appearance saves it and applies it immediately', () => {
    mockSystem(false);
    setAppearance('dark');
    expect(localStorage.getItem(APPEARANCE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    setAppearance('system');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('app-root sync', () => {
  test('system mode follows device changes with no appearance control mounted', () => {
    const device = controllableSystem(false);
    setAppearance('system');
    const stop = startAppearanceSync();
    expect(document.documentElement.dataset.theme).toBe('light');
    device.set(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(THEME_COLOR.dark);
    device.set(false);
    expect(document.documentElement.dataset.theme).toBe('light');
    stop();
    device.set(true);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  test('an explicit choice ignores device changes', () => {
    const device = controllableSystem(false);
    setAppearance('light');
    const stop = startAppearanceSync();
    device.set(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    stop();
  });

  test('a choice made in another tab applies with no control mounted', () => {
    controllableSystem(false);
    setAppearance('light');
    const stop = startAppearanceSync();
    localStorage.setItem(APPEARANCE_KEY, 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: APPEARANCE_KEY, newValue: 'dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    stop();
  });
});

describe('pre-paint script', () => {
  const run = () => new Function(initScript)();

  test('uses the same key, default and colors as the app', () => {
    expect(initScript).toContain(`'${APPEARANCE_KEY}'`);
    expect(initScript).toContain(`appearance = '${DEFAULT_APPEARANCE}'`);
    expect(initScript).toContain(`light: '${THEME_COLOR.light}'`);
    expect(initScript).toContain(`dark: '${THEME_COLOR.dark}'`);
  });

  test('applies a saved choice before React loads', () => {
    mockSystem(false);
    localStorage.setItem(APPEARANCE_KEY, 'dark');
    run();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(THEME_COLOR.dark);
  });

  test('follows the device when nothing is saved', () => {
    mockSystem(true);
    run();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    mockSystem(false);
    run();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
