// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AppearanceControl } from './AppearanceControl';
import { APPEARANCE_KEY } from '../theme/appearance';

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

test('offers Light, Dark and System as one labelled group', () => {
  render(<AppearanceControl />);
  const group = screen.getByRole('group', { name: 'Appearance' });
  expect(group).toBeTruthy();
  expect(screen.getAllByRole('radio').map((r) => (r.closest('label') as HTMLElement).textContent)).toEqual(['Light', 'Dark', 'System']);
});

test('choosing Dark switches the page and remembers it', async () => {
  render(<AppearanceControl />);
  await userEvent.click(screen.getByRole('radio', { name: 'Dark' }));
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(localStorage.getItem(APPEARANCE_KEY)).toBe('dark');
  expect((screen.getByRole('radio', { name: 'Dark' }) as HTMLInputElement).checked).toBe(true);
});

test('the compact version keeps its labels for assistive tech', () => {
  render(<AppearanceControl compact />);
  expect(screen.getByRole('radio', { name: 'System' })).toBeTruthy();
});
