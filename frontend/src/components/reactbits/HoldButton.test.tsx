// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import HoldButton from './HoldButton';

beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

function mount() {
  const onHold = vi.fn();
  render(<HoldButton holdTime={1200} onHold={onHold}>Hold to cancel rental</HoldButton>);
  const button = screen.getByRole('button', { name: /Hold to cancel rental/ });
  return { onHold, button };
}

// A press with nothing held behind it, as a screen reader, voice control or switch sends (detail 0).
const assistiveClick = (button: HTMLElement) => fireEvent.click(button, { detail: 0 });

function tap(button: HTMLElement) {
  fireEvent.pointerDown(button, { button: 0, isPrimary: true, pointerId: 1 });
  wait(80);
  fireEvent.pointerUp(button, { pointerId: 1 });
  fireEvent.click(button, { detail: 1 });
}

test('a click from assistive technology asks for a second press, and the second press confirms', () => {
  const { onHold, button } = mount();
  expect(button.textContent).toContain('or press twice, to confirm');
  assistiveClick(button);
  expect(onHold).not.toHaveBeenCalled();
  expect(button.textContent).toContain('Press again to confirm');
  expect(screen.getByRole('status').textContent).toBe('Press again to confirm');

  wait(800);
  assistiveClick(button);
  expect(onHold).toHaveBeenCalledTimes(1);
});

test('a double click is not a confirmation', () => {
  const { onHold, button } = mount();
  assistiveClick(button);
  wait(120);
  assistiveClick(button);
  expect(onHold).not.toHaveBeenCalled();
  expect(button.textContent).toContain('Press again to confirm');
});

// Firefox's accessibility click (NVDA or JAWS in browse mode) reports detail 1, like a mouse, with no press first.
test('a click with no press behind it counts whatever its detail', () => {
  const { onHold, button } = mount();
  fireEvent.click(button, { detail: 1 });
  expect(button.textContent).toContain('Press again to confirm');
  wait(800);
  fireEvent.click(button, { detail: 1 });
  expect(onHold).toHaveBeenCalledTimes(1);
});

test('the click that ends a long hold is not taken as a new first press', () => {
  const { onHold, button } = mount();
  fireEvent.pointerDown(button, { button: 0, isPrimary: true, pointerId: 1 });
  wait(4000);
  expect(onHold).toHaveBeenCalledTimes(1);
  fireEvent.pointerUp(button, { pointerId: 1 });
  fireEvent.click(button, { detail: 1 });
  expect(button.textContent).not.toContain('Press again to confirm');
  expect(onHold).toHaveBeenCalledTimes(1);
});

test('the second press has time to come, and the button says when the question lapses', () => {
  const { onHold, button } = mount();
  assistiveClick(button);
  // Long enough for someone scanning with a switch to get back to the button.
  wait(20000);
  expect(button.textContent).toContain('Press again to confirm');
  wait(10000);
  expect(button.textContent).not.toContain('Press again to confirm');
  expect(screen.getByRole('status').textContent).toBe('Not confirmed in time. Nothing was changed.');
  assistiveClick(button);
  expect(onHold).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toBe('Press again to confirm');
});

test('Escape or leaving the button takes the question back', () => {
  const { onHold, button } = mount();
  assistiveClick(button);

  fireEvent.keyDown(button, { key: 'Escape' });
  expect(button.textContent).not.toContain('Press again to confirm');
  act(() => button.focus());
  assistiveClick(button);
  act(() => button.blur());
  expect(button.textContent).not.toContain('Press again to confirm');
  wait(800);
  assistiveClick(button);
  expect(onHold).not.toHaveBeenCalled();
});

test('a quick tap asks for a second tap; the click it ends with is not counted again', () => {
  const { onHold, button } = mount();
  tap(button);
  expect(onHold).not.toHaveBeenCalled();
  expect(button.textContent).toContain('Press again to confirm');
  wait(800);
  tap(button);
  expect(onHold).toHaveBeenCalledTimes(1);
});

test('holding still confirms in one go', () => {
  const { onHold, button } = mount();
  fireEvent.keyDown(button, { key: ' ' });
  wait(600);
  expect(onHold).not.toHaveBeenCalled();
  wait(800);
  expect(onHold).toHaveBeenCalledTimes(1);
});

test('a disabled button never confirms', () => {
  const onHold = vi.fn();
  render(<HoldButton holdTime={1200} onHold={onHold} disabled>Hold to retire</HoldButton>);
  const button = screen.getByRole('button', { name: /Hold to retire/ });
  assistiveClick(button);
  wait(800);
  assistiveClick(button);
  expect(onHold).not.toHaveBeenCalled();
});
