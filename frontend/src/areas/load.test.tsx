// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ComponentType } from 'react';
import { fromArea } from '../App';
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

test('an area page waits in place, then renders, and keeps its state from then on', async () => {
  let arrive!: (m: { Page: ComponentType }) => void;
  const area = retryable(() => new Promise<{ Page: ComponentType }>((r) => { arrive = r; }));
  function Draft() { const [text, setText] = useState(''); return <input aria-label="Draft" value={text} onChange={(e) => setText(e.target.value)} />; }
  const Page = fromArea(area, (m) => m.Page);
  document.title = 'Equipment · The Collaboratory';
  const view = render(<Page />);
  expect(screen.getByRole('status').textContent).toBe('Loading…');
  expect(document.title).toBe('Equipment · The Collaboratory');
  await act(async () => { arrive({ Page: Draft }); });
  fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'unsaved' } });
  view.rerender(<Page />);
  expect((screen.getByLabelText('Draft') as HTMLInputElement).value).toBe('unsaved');
  cleanup();
  // Once arrived, later mounts render on the first frame.
  render(<Page />);
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByLabelText('Draft')).toBeTruthy();
});

test('a failed download shows a reload screen in that spot only', async () => {
  const reload = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
  const Broken = fromArea(retryable<{ P: ComponentType }>(() => Promise.reject(new Error('Failed to fetch dynamically imported module'))), (m) => m.P);
  render(<><Broken /><p>Rest of the app</p></>);
  expect((await screen.findByRole('alert')).textContent).toContain('couldn’t load');
  // The title is set in an effect that can run after the alert is on screen.
  await waitFor(() => expect(document.title).toBe('Page couldn’t load · The Collaboratory'));
  expect(screen.getByText('Rest of the app')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(reload).toHaveBeenCalled();
});


test('after sign-in, staff landing in the workspace load it first; everyone else loads the member site', () => {
  expect(arrivalArea('admin', '/')).toBe('staff');
  expect(arrivalArea('staff', '/admin/payments?tab=open')).toBe('staff');
  expect(arrivalArea('admin', '/membership')).toBe('member');
  expect(arrivalArea('member', '/')).toBe('member');
  expect(arrivalArea('member', '/admin')).toBe('member');
  // Routes match case-insensitively and decoded, as React Router does.
  expect(arrivalArea('admin', '/ADMIN/payments?x=1#top')).toBe('staff');
  expect(arrivalArea('staff', '/%61dmin')).toBe('staff');
});
