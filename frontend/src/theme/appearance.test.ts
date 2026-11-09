// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, THEME_COLOR, applyTheme, readAppearance, resolveTheme, setAppearance } from './appearance';

const initScript = readFileSync(join(__dirname, '../../public/theme-init.js'), 'utf8');

function mockSystem(dark: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: dark && query.includes('dark'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
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
