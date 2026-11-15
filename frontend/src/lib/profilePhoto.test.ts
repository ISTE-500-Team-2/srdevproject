// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import {
  clampCrop,
  dataUrlBytes,
  forgetPhotos,
  loadMemberPhoto,
  loadPhoto,
  placement,
  rememberPhoto,
  useProfilePhoto,
  zoomCrop,
} from './profilePhoto';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', async (original) => ({ ...(await original<typeof import('./api')>()), api }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  forgetPhotos();
});

describe('cropping', () => {
  test('a photo fills the frame at zoom 1 and cannot be dragged off it', () => {
    // A 2:1 landscape photo fills the frame's height and overflows its width by one frame.
    expect(placement(400, 200, 100, { zoom: 1, x: 0, y: 0 })).toEqual({ x: -50, y: 0, width: 200, height: 100 });
    const dragged = clampCrop(400, 200, { zoom: 1, x: 3, y: 0.4 });
    expect(dragged.x).toBe(0.5);
    expect(Math.abs(dragged.y)).toBe(0);
    // Dragged fully right, its left edge sits on the frame's left edge.
    expect(placement(400, 200, 100, { zoom: 1, x: 3, y: 0 }).x).toBe(0);
  });

  test('zoom stays in range and keeps the middle of the frame in place', () => {
    expect(clampCrop(300, 300, { zoom: 0.2, x: 0, y: 0 }).zoom).toBe(1);
    expect(clampCrop(300, 300, { zoom: 9, x: 0, y: 0 }).zoom).toBe(4);
    const zoomed = zoomCrop(300, 300, { zoom: 2, x: 0.25, y: -0.1 }, 4);
    expect(zoomed.zoom).toBe(4);
    expect(zoomed.x).toBeCloseTo(0.5);
    expect(zoomed.y).toBeCloseTo(-0.2);
    // Zooming back out pulls the photo back over the whole frame.
    const out = zoomCrop(300, 300, zoomed, 1);
    expect([out.zoom, Math.abs(out.x), Math.abs(out.y)]).toEqual([1, 0, 0]);
  });

  test('data URL sizes count decoded bytes', () => {
    for (const text of ['abc', 'abcd', 'abcde']) expect(dataUrlBytes(`data:image/jpeg;base64,${btoa(text)}`)).toBe(text.length);
  });
});

const Probe = ({ version, account = 1 }: { version?: string | null; account?: number }) =>
  createElement('span', null, useProfilePhoto(version, account) ?? 'initials');

describe('loading photos', () => {
  test('each version is fetched once, and another account\'s photo never stands in for it', async () => {
    api.mockResolvedValue({ version: 'v1', image: 'data:image/webp;base64,AAAA' });
    const [first, second] = await Promise.all([loadPhoto('v1', 1), loadPhoto('v1', 1)]);
    expect(first).toBe('data:image/webp;base64,AAAA');
    expect(second).toBe(first);
    expect(await loadPhoto('v1', 1)).toBe(first);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/me/photo');
    // In account mode /me/photo is the open member's: the staff member's version gets initials,
    // and is asked for again later rather than remembered as missing.
    expect(await loadPhoto('staff-photo', 1)).toBeNull();
    expect(await loadPhoto('staff-photo', 1)).toBeNull();
    expect(api).toHaveBeenCalledTimes(3);
  });

  test('avatars show a just-saved photo at once and load others', async () => {
    rememberPhoto({ version: 'saved', image: 'data:saved' });
    const { rerender } = render(createElement(Probe, { version: 'saved' }));
    expect(screen.getByText('data:saved')).toBeTruthy();
    expect(api).not.toHaveBeenCalled();

    api.mockResolvedValue({ version: 'next', image: 'data:next' });
    rerender(createElement(Probe, { version: 'next' }));
    expect(screen.getByText('initials')).toBeTruthy();
    expect(await screen.findByText('data:next')).toBeTruthy();
    rerender(createElement(Probe, { version: null }));
    expect(screen.getByText('initials')).toBeTruthy();

    // Signing out forgets them.
    forgetPhotos();
    api.mockResolvedValue(null);
    expect(await loadPhoto('saved', 1)).toBeNull();
  });

  // Entering the workspace closes an open member account after the staff avatar has mounted.
  test('a version answered by another account\'s photo is asked for again once the session shows its account', async () => {
    api.mockResolvedValueOnce({ version: 'member-photo', image: 'data:member' });
    const { rerender } = render(createElement(Probe, { version: 'staff-photo', account: 9 }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect(screen.getByText('initials')).toBeTruthy();

    api.mockResolvedValueOnce({ version: 'staff-photo', image: 'data:staff' });
    rerender(createElement(Probe, { version: 'staff-photo', account: 2 }));
    expect(await screen.findByText('data:staff')).toBeTruthy();
    expect(api).toHaveBeenCalledTimes(2);
  });
});

describe('member photos on staff screens', () => {
  test('photos asked for together load in one request per 50 members', async () => {
    api.mockImplementation((path: string) => {
      const ids = new URLSearchParams(path.split('?')[1]).get('ids')!.split(',');
      return Promise.resolve(Object.fromEntries(ids.filter((id) => id !== '3').map((id) => [id, { version: `v${id}`, image: `data:${id}` }])));
    });
    const first = await Promise.all([loadMemberPhoto(1, 'v1'), loadMemberPhoto(2, 'v2'), loadMemberPhoto(3, 'v3'), loadMemberPhoto(1, 'v1')]);
    expect(first).toEqual(['data:1', 'data:2', null, 'data:1']);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/admin/photos?ids=1,2,3');
    // Already loaded: no request. A list read before the member changed photos gets initials.
    expect(await loadMemberPhoto(2, 'v2')).toBe('data:2');
    expect(await loadMemberPhoto(2, 'older')).toBeNull();
    expect(api).toHaveBeenCalledTimes(2);

    api.mockClear();
    const many = Array.from({ length: 60 }, (_, i) => i + 10);
    await Promise.all(many.map((id) => loadMemberPhoto(id, `v${id}`)));
    expect(api.mock.calls.map(([path]) => (path as string).split('=')[1]!.split(',').length)).toEqual([50, 10]);
  });

  test('a failed request shows initials and is tried again next time', async () => {
    api.mockRejectedValueOnce(new Error('offline'));
    expect(await loadMemberPhoto(5, 'v5')).toBeNull();
    api.mockResolvedValueOnce({ 5: { version: 'v5', image: 'data:5' } });
    expect(await loadMemberPhoto(5, 'v5')).toBe('data:5');
  });
});

describe('signing out while photos load', () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
  };

  test('a staff photo that arrives after sign-out is shown as initials and not kept', async () => {
    const answer = deferred<Record<string, { version: string; image: string }>>();
    api.mockReturnValueOnce(answer.promise);
    const loading = loadMemberPhoto(7, 'v7');
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    forgetPhotos();
    answer.resolve({ 7: { version: 'v7', image: 'data:private' } });
    expect(await loading).toBeNull();
    api.mockResolvedValueOnce({});
    expect(await loadMemberPhoto(7, 'v7')).toBeNull();
    expect(api).toHaveBeenCalledTimes(2); // asked again: nothing was kept
  });

  test('a staff photo still queued at sign-out settles at once and is never sent', async () => {
    const loading = loadMemberPhoto(8, 'v8');
    forgetPhotos();
    expect(await loading).toBeNull();
    await new Promise((done) => setTimeout(done, 5));
    expect(api).not.toHaveBeenCalled();
  });

  test("the session's own photo that arrives after sign-out is not kept", async () => {
    const answer = deferred<{ version: string; image: string }>();
    api.mockReturnValueOnce(answer.promise);
    const loading = loadPhoto('mine', 1);
    forgetPhotos();
    answer.resolve({ version: 'mine', image: 'data:mine' });
    expect(await loading).toBeNull();
    api.mockResolvedValueOnce(null);
    expect(await loadPhoto('mine', 1)).toBeNull();
    expect(api).toHaveBeenCalledTimes(2);
  });
});
