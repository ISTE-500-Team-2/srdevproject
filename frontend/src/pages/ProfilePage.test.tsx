// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfilePage } from './ProfilePage';
const { api, refresh } = vi.hoisted(() => ({ api: vi.fn(), refresh: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { firstName:'Test',lastName:'Member',email:'test@example.com',phone:'1234567890',role:'member' }, refresh }) }));
vi.mock('../lib/api', () => ({ api, errorMessage: (error: Error) => error.message }));
vi.mock('../components/SignedWaiverRecords', () => ({ SignedWaiverRecords: () => null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function mount() {
  api.mockImplementation((path: string) => path === '/me/notifications' ? Promise.resolve({enabled:true,timeZone:'America/New_York'}) : Promise.resolve({}));
  refresh.mockResolvedValue(undefined);
  return render(<ProfilePage />);
}
test('successful save shows exactly one viewport-level notification; editing clears it', async () => {
  const { container } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(screen.getAllByText('Changes saved.')).toHaveLength(1));
  expect(document.querySelector('.toast')?.parentElement).toBe(document.body);
  expect(refresh).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText('First name'), { target: { value:'Updated' } });
  expect(container.querySelector('.form-success')).toBeNull();
  expect(document.querySelector('.toast')).toBeNull();
});
test('failed save shows an error and does not claim success', async () => {
  const { container } = mount();
  api.mockImplementation((path: string) => path === '/me/profile' ? Promise.reject(new Error('Unable to save changes.')) : Promise.resolve({enabled:true,timeZone:'America/New_York'}));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Unable to save changes.');
  expect(container.querySelector('.form-success')).toBeNull();
  expect(document.querySelector('.toast')).toBeNull();
  expect(refresh).not.toHaveBeenCalled();
});
