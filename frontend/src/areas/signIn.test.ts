import { expect, test, vi } from 'vitest';
const { staffLoaded, memberLoaded } = vi.hoisted(() => ({ staffLoaded: vi.fn(), memberLoaded: vi.fn() }));
vi.mock('./StaffArea', () => { staffLoaded(); return { default: () => null }; });
vi.mock('./memberPages', () => { memberLoaded(); return {}; });
import { preloadForSignIn } from './load';

test('starting to sign in fetches only the member site; the staff workspace waits for a confirmed staff role', async () => {
  preloadForSignIn();
  await vi.waitFor(() => expect(memberLoaded).toHaveBeenCalled());
  expect(staffLoaded).not.toHaveBeenCalled();
});

test('sign-in never waits more than a moment for a stalled download', async () => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.doMock('./memberPages', () => new Promise(() => {}));
  const { prepareArrival, ARRIVAL_WAIT_MS } = await import('./load');
  let done = false;
  void prepareArrival('member', '/').then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(ARRIVAL_WAIT_MS - 1);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(done).toBe(true);
  vi.useRealTimers();
});
