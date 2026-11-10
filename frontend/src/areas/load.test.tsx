// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AreaBoundary } from '../App';
const { staffLoaded, memberLoaded } = vi.hoisted(() => ({ staffLoaded: vi.fn(), memberLoaded: vi.fn() }));
vi.mock('./StaffArea', () => { staffLoaded(); return { default: () => null }; });
vi.mock('./memberPages', () => { memberLoaded(); return {}; });
import { arrivalArea, preloadAreaFor, retryable } from './load';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('a failed download is retried on the next call; a successful one is shared', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('area');
  const area = retryable(load);
  await expect(area()).rejects.toThrow('offline');
  await expect(area()).resolves.toBe('area');
  await expect(area()).resolves.toBe('area');
  expect(load).toHaveBeenCalledTimes(2);
});

test('the URL decides which area starts downloading; public pages start none', async () => {
  for (const path of ['/login', '/reset-password', '/confirm-email', '/loading', '/nope']) preloadAreaFor(path);
  await new Promise((r) => setTimeout(r, 0));
  expect(staffLoaded).not.toHaveBeenCalled();
  expect(memberLoaded).not.toHaveBeenCalled();
  preloadAreaFor('/admin/payments');
  preloadAreaFor('/membership');
  await vi.waitFor(() => { expect(staffLoaded).toHaveBeenCalled(); expect(memberLoaded).toHaveBeenCalled(); });
});

test('if a page’s code cannot be downloaded, the app offers a reload instead of going blank', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const reload = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
  function Broken(): never { throw new Error('Failed to fetch dynamically imported module'); }
  render(<AreaBoundary><Broken /></AreaBoundary>);
  expect(screen.getByRole('alert').textContent).toContain('couldn’t load');
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(reload).toHaveBeenCalled();
});

test('after sign-in, staff landing in the workspace load it first; everyone else loads the member site', () => {
  expect(arrivalArea('admin', '/')).toBe('staff');
  expect(arrivalArea('staff', '/admin/payments?tab=open')).toBe('staff');
  expect(arrivalArea('admin', '/membership')).toBe('member');
  expect(arrivalArea('member', '/')).toBe('member');
  expect(arrivalArea('member', '/admin')).toBe('member');
});
