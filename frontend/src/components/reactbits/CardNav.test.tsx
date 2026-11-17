// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import CardNav from './CardNav';

// jsdom has no layout: the menu content measures CONTENT px tall until capped, and the bar sits at the top of the screen.
const CONTENT = 380;
const content = () => document.querySelector<HTMLElement>('.card-nav__content')!;
const setScreenHeight = (height: number) => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
};

beforeEach(() => {
  // Reduced motion: no intro animation, and the menu opens in one frame.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('reduced-motion'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  const height = (el: HTMLElement) => (el.classList.contains('card-nav__content') ? parseFloat(el.style.maxHeight) || CONTENT : 0);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return height(this);
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('card-nav__content') ? CONTENT : 0;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const items = [{ label: 'Book', links: [{ label: 'Equipment', href: '/equipment' }] }];

test('on a short screen the open menu stops at the bottom edge and its content scrolls', async () => {
  setScreenHeight(340); // a phone held sideways
  render(<CardNav items={items} footer={<button type="button">Dark</button>} />);
  await userEvent.click(screen.getByRole('button', { name: /menu/i }));

  // 340 - 60 (bar) - 10 (gap under the panel) leaves 270px for the 380px of content.
  expect(content().style.maxHeight).toBe('270px');
  expect(content().style.overflowY).toBe('auto');
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(document.querySelector<HTMLElement>('.card-nav__panel')!.style.height).toBe('330px');

  // Turned upright, the whole menu fits again and the cap comes off.
  setScreenHeight(800);
  expect(content().style.maxHeight).toBe('');
  expect(content().style.overflowY).toBe('');
});

test('a menu that fits is left as it was', async () => {
  setScreenHeight(800);
  render(<CardNav items={items} />);
  await userEvent.click(screen.getByRole('button', { name: /menu/i }));
  expect(content().style.maxHeight).toBe('');
  expect(content().style.overflowY).toBe('');
});
