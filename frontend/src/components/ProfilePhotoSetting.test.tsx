// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../lib/api';
import { forgetPhotos, PhotoError } from '../lib/profilePhoto';
import { ProfilePhotoSetting } from './ProfilePhotoSetting';

const { api, refresh, auth, photo } = vi.hoisted(() => ({
  api: vi.fn(),
  refresh: vi.fn(),
  auth: {
    user: { id: 42, firstName: 'Test', lastName: 'Member', email: 'test@example.com', phone: '', role: 'member', roles: ['member'], membership: 'None', photoVersion: null as string | null },
    actor: null as null | { id: number },
  },
  photo: { readPhotoFile: vi.fn(), encodePhoto: vi.fn() },
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: auth.user, actor: auth.actor, refresh }) }));
vi.mock('../lib/api', async (original) => ({ ...(await original<typeof import('../lib/api')>()), api }));
// Decoding and encoding need a real canvas; the editor's interaction is what's under test here.
vi.mock('../lib/profilePhoto', async (original) => ({
  ...(await original<typeof import('../lib/profilePhoto')>()),
  readPhotoFile: photo.readPhotoFile,
  encodePhoto: photo.encodePhoto,
}));

const source = { image: {} as CanvasImageSource, width: 400, height: 300 };
const encoded = 'data:image/webp;base64,UklGRg==';
const file = new File(['photo'], 'me.jpg', { type: 'image/jpeg' });

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  refresh.mockResolvedValue(undefined);
  auth.user.photoVersion = null;
  auth.actor = null;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  forgetPhotos();
});

test('a member chooses a photo, positions it and saves it', async () => {
  const user = userEvent.setup();
  const notify = vi.fn();
  photo.readPhotoFile.mockResolvedValue(source);
  photo.encodePhoto.mockReturnValue(encoded);
  api.mockResolvedValue({ version: 'v2' });
  render(<ProfilePhotoSetting notify={notify} />);
  expect(screen.getByRole('button', { name: 'Add photo' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();

  await user.upload(screen.getByLabelText('Choose a profile photo'), file);
  expect(photo.readPhotoFile).toHaveBeenCalledWith(file);
  const dialog = await screen.findByRole('dialog', { name: 'Position your photo' });
  fireEvent.change(within(dialog).getByLabelText('Zoom'), { target: { value: '2' } });
  fireEvent.keyDown(within(dialog).getByRole('group', { name: /Photo position/ }), { key: 'ArrowRight' });
  await user.click(within(dialog).getByRole('button', { name: 'Save photo' }));

  await waitFor(() => expect(notify).toHaveBeenCalledWith('Photo saved.'));
  const [, crop] = photo.encodePhoto.mock.calls[0]!;
  expect(photo.encodePhoto.mock.calls[0]![0]).toBe(source);
  expect(crop.zoom).toBe(2);
  expect(crop.x).toBeCloseTo(0.02);
  expect(api).toHaveBeenCalledWith('/me/photo', { method: 'PUT', body: { image: encoded } });
  expect(refresh).toHaveBeenCalledWith(false, { fresh: true });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a refused save keeps the editor open with the reason', async () => {
  const user = userEvent.setup();
  photo.readPhotoFile.mockResolvedValue(source);
  photo.encodePhoto.mockReturnValue(encoded);
  api.mockRejectedValue(new ApiError(400, 'INVALID_PHOTO', 'Upload a JPEG or WebP photo.', 'image'));
  render(<ProfilePhotoSetting notify={vi.fn()} />);
  await user.upload(screen.getByLabelText('Choose a profile photo'), file);
  const dialog = await screen.findByRole('dialog', { name: 'Position your photo' });
  await user.click(within(dialog).getByRole('button', { name: 'Save photo' }));
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Upload a JPEG or WebP photo.');
  expect(within(dialog).getByRole('button', { name: 'Save photo' })).toHaveProperty('disabled', false);
  expect(refresh).not.toHaveBeenCalled();
});

test('a file the browser cannot open says so without opening the editor', async () => {
  const user = userEvent.setup();
  photo.readPhotoFile.mockRejectedValue(new PhotoError("That image couldn't be opened. Try a JPEG, PNG or WebP photo."));
  render(<ProfilePhotoSetting notify={vi.fn()} />);
  await user.upload(screen.getByLabelText('Choose a profile photo'), file);
  expect((await screen.findByRole('alert')).textContent).toMatch(/couldn't be opened/);
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a member with a photo sees it and can remove it', async () => {
  const user = userEvent.setup();
  const notify = vi.fn();
  auth.user.photoVersion = 'v1';
  api.mockImplementation((path: string, init?: { method?: string }) =>
    Promise.resolve(path === '/me/photo' && !init ? { version: 'v1', image: 'data:image/jpeg;base64,AAAA' } : { version: null }));
  const { container } = render(<ProfilePhotoSetting notify={notify} />);
  await waitFor(() => expect(container.querySelector('img.avatar-photo')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA'));
  expect(screen.getByRole('button', { name: 'Change photo' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(notify).toHaveBeenCalledWith('Photo removed.'));
  expect(api).toHaveBeenCalledWith('/me/photo', { method: 'DELETE' });
  expect(refresh).toHaveBeenCalledWith(false, { fresh: true });
});

test("staff in a member's account see the photo setting but cannot change it", () => {
  auth.actor = { id: 7 };
  render(<ProfilePhotoSetting notify={vi.fn()} />);
  expect(screen.getByText('Members change their own photo.')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByLabelText('Choose a profile photo')).toBeNull();
});
