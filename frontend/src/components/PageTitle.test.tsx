// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ANNOUNCE_DELAY_MS, PageTitle } from './PageTitle';

const announcer = () => document.querySelector<HTMLElement>('[data-route-announcer]')!;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('names the tab after the page, and falls back to the site name', () => {
  const { rerender } = render(<PageTitle title="Membership" />);
  expect(document.title).toBe('Membership · The Collaboratory');
  // The browser announces the first page itself.
  vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
  expect(announcer().textContent).toBe('');
  rerender(<PageTitle />);
  expect(document.title).toBe('The Collaboratory');
});

test('screen readers hear each new page once whatever led there has closed, but not a change that keeps the title', () => {
  const { rerender } = render(<PageTitle title="Classes" />);
  vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
  expect(announcer().getAttribute('aria-live')).toBe('polite');

  rerender(<PageTitle title="Equipment" />);
  expect(announcer().textContent).not.toBe('Equipment · The Collaboratory');
  vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
  expect(announcer().textContent).toBe('Equipment · The Collaboratory');

  // Another record on the same page (a new path, same title) has nothing new to say.
  announcer().textContent = '';
  cleanup();
  render(<PageTitle title="Equipment" />);
  vi.advanceTimersByTime(ANNOUNCE_DELAY_MS);
  expect(announcer().textContent).toBe('');
});
