// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { onArrowKeys } from './rovingFocus';

afterEach(cleanup);

function Periods({ disabled = '' }: { disabled?: string }) {
  const [period, setPeriod] = useState('daily');
  return <div role="radiogroup" aria-label="Group by" onKeyDown={onArrowKeys}>
    {['daily', 'weekly', 'monthly'].map(p => (
      <button key={p} type="button" role="radio" aria-checked={period === p} tabIndex={period === p ? 0 : -1}
        disabled={p === disabled} onClick={() => setPeriod(p)}>{p}</button>
    ))}
  </div>;
}

test('arrow keys move to the next or previous option and choose it, wrapping at the ends', () => {
  render(<Periods />);
  const daily = screen.getByRole('radio', { name: 'daily' });
  daily.focus();
  fireEvent.keyDown(daily, { key: 'ArrowRight' });
  const weekly = screen.getByRole('radio', { name: 'weekly' });
  expect(document.activeElement).toBe(weekly);
  expect(weekly.getAttribute('aria-checked')).toBe('true');
  expect([weekly.tabIndex, daily.tabIndex]).toEqual([0, -1]);
  fireEvent.keyDown(weekly, { key: 'ArrowLeft' });
  fireEvent.keyDown(daily, { key: 'ArrowUp' });
  expect(screen.getByRole('radio', { name: 'monthly' }).getAttribute('aria-checked')).toBe('true');
  // Other keys are left alone.
  const enter = fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
  expect(enter).toBe(true);
});

test('disabled options are skipped', () => {
  render(<Periods disabled="weekly" />);
  const daily = screen.getByRole('radio', { name: 'daily' });
  daily.focus();
  fireEvent.keyDown(daily, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'monthly' }));
});

test('in a menu the keys only move focus; choosing stays with Enter or a click', () => {
  const chosen = vi.fn();
  render(<div role="menu" onKeyDown={event => onArrowKeys(event, { choose: false })}>
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => chosen('again')}>Schedule again</button>
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => chosen('cancel')}>Cancel class</button>
  </div>);
  const first = screen.getByRole('menuitem', { name: 'Schedule again' });
  first.focus();
  fireEvent.keyDown(first, { key: 'End' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Cancel class' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Home' });
  expect(document.activeElement).toBe(first);
  expect(chosen).not.toHaveBeenCalled();
});
