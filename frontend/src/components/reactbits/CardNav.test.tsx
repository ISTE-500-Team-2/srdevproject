// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import CardNav from './CardNav';

// jsdom has no layout: the menu content measures contentHeight px tall until capped, and the bar sits at the top of
// the screen.
const CONTENT = 380;
let contentHeight = CONTENT;
const content = () => document.querySelector<HTMLElement>('.card-nav__content')!;
const panel = () => document.querySelector<HTMLElement>('.card-nav__panel')!;
const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
const setScreenHeight = (height: number) => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
};

// jsdom has no ResizeObserver either: this one records what each observer watches so a test can report a resize.
type Watcher = { callback: ResizeObserverCallback; targets: Element[] };
let watchers: Watcher[] = [];
class FakeResizeObserver {
  private watcher: Watcher;
  constructor(callback: ResizeObserverCallback) {
    this.watcher = { callback, targets: [] };
    watchers.push(this.watcher);
  }
  observe(target: Element) {
    this.watcher.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.watcher.targets = [];
  }
}
// The content changes size on its own, with no CardNav render (a late web font, a footer control resizing itself).
const growContent = (height: number) => {
  contentHeight = height;
  act(() => {
    for (const watcher of watchers.filter((w) => w.targets.includes(content()))) {
      watcher.callback([], watcher as unknown as ResizeObserver);
    }
  });
};

beforeEach(() => {
  contentHeight = CONTENT;
  watchers = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  // Reduced motion: no intro animation, and the menu opens in one frame.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('reduced-motion'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const height = (el: HTMLElement) =>
    el.classList.contains('card-nav__content') ? parseFloat(el.style.maxHeight) || contentHeight : 0;
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return height(this);
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('card-nav__content') ? contentHeight : 0;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const items = [{ label: 'Book', links: [{ label: 'Equipment', href: '/equipment' }] }];

test('on a short screen the open menu stops at the bottom edge and its content scrolls', async () => {
  setScreenHeight(340); // a phone held sideways
  render(<CardNav items={items} footer={<button type="button">Dark</button>} />);
  await userEvent.click(screen.getByRole('button', { name: /menu/i }));

  // 340 - 60 (bar) - 10 (gap under the panel) leaves 270px for the 380px of content.
  expect(content().style.maxHeight).toBe('270px');
  expect(content().style.overflowY).toBe('auto');
  await nextFrame();
  expect(panel().style.height).toBe('330px');

  // Turned upright, the whole menu fits again and the cap comes off.
  setScreenHeight(800);
  expect(content().style.maxHeight).toBe('');
  expect(content().style.overflowY).toBe('');
});

test('content that grows on its own while the menu is open is still capped to the screen', async () => {
  setScreenHeight(340);
  contentHeight = 200; // fits in the 270px under the bar
  render(<CardNav items={items} footer={<button type="button">Dark</button>} />);
  await userEvent.click(screen.getByRole('button', { name: /menu/i }));
  await nextFrame();
  expect(content().style.maxHeight).toBe('');
  expect(panel().style.height).toBe('260px');

  growContent(CONTENT);
  expect(content().style.maxHeight).toBe('270px');
  expect(content().style.overflowY).toBe('auto');
  expect(panel().style.height).toBe('330px');

  // Shrinking back below the room lifts the cap again.
  growContent(200);
  expect(content().style.maxHeight).toBe('');
  expect(content().style.overflowY).toBe('');
  expect(panel().style.height).toBe('260px');
});

test('a menu that fits is left as it was', async () => {
  setScreenHeight(800);
  render(<CardNav items={items} />);
  await userEvent.click(screen.getByRole('button', { name: /menu/i }));
  expect(content().style.maxHeight).toBe('');
  expect(content().style.overflowY).toBe('');
});
