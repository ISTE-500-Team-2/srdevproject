// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { browser, isChunkLoadError, PageErrorBoundary, reloadForRelease } from './ErrorBoundary';

let go: (to: string) => void = () => {};
function Navigator() {
  go = useNavigate();
  return null;
}
function Broken({ error }: { error: Error }): never {
  throw error;
}
const missingChunk = () => new TypeError('Failed to fetch dynamically imported module: https://example.invalid/assets/SplitText-old.js');

function site(error: Error, standalone = false) {
  return render(
    <MemoryRouter initialEntries={['/broken']}>
      <Navigator />
      <PageErrorBoundary standalone={standalone}>
        <Routes>
          <Route path="/broken" element={<Broken error={error} />} />
          <Route path="/fine" element={<h1>Fine page</h1>} />
        </Routes>
      </PageErrorBoundary>
    </MemoryRouter>,
  );
}

let reload: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  reload = vi.spyOn(browser, 'reload').mockImplementation(() => {});
  // React reports caught errors to the console; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('a page that throws shows a message with Reload instead of a blank screen, and another page still works', async () => {
  site(new Error('Cannot read properties of undefined'));
  expect(screen.getByRole('heading', { name: 'This page didn’t load' })).toBeTruthy();
  expect(screen.getByRole('alert')).toBeTruthy();
  // An ordinary error does not reload by itself.
  expect(reload).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(reload).toHaveBeenCalledTimes(1);

  act(() => go('/fine'));
  expect(screen.getByRole('heading', { name: 'Fine page' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('standalone, the message brings its own main landmark and logo', () => {
  site(new Error('boom'), true);
  expect(screen.getByRole('main').querySelector('.server-unreachable')).not.toBeNull();
  expect(screen.getByRole('img', { name: 'The Collaboratory' })).toBeTruthy();
});

test('code missing after a release reloads once on its own; a repeat shows the message instead of looping', () => {
  site(missingChunk());
  expect(reload).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('heading', { name: 'Reload for the latest version' })).toBeTruthy();
  expect((screen.getByRole('button', { name: /Reloading/ }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();

  // The same tab right after that reload: the code is still missing.
  site(missingChunk());
  expect(reload).toHaveBeenCalledTimes(1);
  expect((screen.getByRole('button', { name: 'Reload' }) as HTMLButtonElement).disabled).toBe(false);
});

test('a later release, minutes on, may reload again', () => {
  const start = Date.now();
  expect(reloadForRelease(start)).toBe(true);
  expect(reloadForRelease(start + 30_000)).toBe(false);
  expect(reloadForRelease(start + 61_000)).toBe(true);
  expect(reload).toHaveBeenCalledTimes(2);
});

test('with site storage blocked it never reloads on its own, since it could not stop a loop', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
  site(missingChunk());
  expect(reload).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
});

test('recognizes failed dynamic imports across browsers', () => {
  expect(isChunkLoadError(missingChunk())).toBe(true);
  expect(isChunkLoadError(new TypeError('error loading dynamically imported module: /assets/Lanyard.js'))).toBe(true);
  expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
  expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/page.css'))).toBe(true);
  expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
});
