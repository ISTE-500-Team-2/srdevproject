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
