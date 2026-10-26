// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProfilePage } from './ProfilePage';
const { api, refresh } = vi.hoisted(() => ({ api: vi.fn(), refresh: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { firstName:'Test',lastName:'Member',email:'test@example.com',phone:'1234567890',role:'member',membership:'Monthly' }, refresh }) }));
vi.mock('../lib/api', () => ({ api, errorMessage: (error: Error) => error.message }));
vi.mock('../components/SignedWaiverRecords', () => ({ SignedWaiverRecords: () => null }));
afterEach(() => {
  cleanup();
  window.localStorage.removeItem('profile-membership-selection');
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
function mount() {
  api.mockImplementation((path: string) => path === '/me/notifications' ? Promise.resolve({enabled:true,timeZone:'America/New_York'}) : Promise.resolve({ address: {}, contactPreferences: {}, studioContact: { name: 'Test studio', email: 'test@example.test' } }));
  refresh.mockResolvedValue(undefined);
  return render(<MemoryRouter><ProfilePage /></MemoryRouter>);
}
test('successful save shows exactly one viewport-level notification; editing clears it', async () => {
  const { container } = mount();
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false));
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
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Unable to save changes.');
  expect(container.querySelector('.form-success')).toBeNull();
  expect(document.querySelector('.toast')).toBeNull();
  expect(refresh).not.toHaveBeenCalled();
});

test('membership uses the real billing route without advertising obsolete local-only prices',async()=>{
  window.localStorage.setItem('profile-membership-selection','premium-yearly');
  mount();
  expect(screen.getByText('Monthly',{exact:true})).toBeTruthy();
  expect(screen.getByRole('link',{name:'Manage membership and passes'}).getAttribute('href')).toBe('/membership');
  expect(screen.getByRole('link',{name:'Manage payments'}).getAttribute('href')).toBe('/membership');
  expect(screen.queryByRole('button',{name:'Change membership option'})).toBeNull();
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.queryByText('$19.99')).toBeNull();
  expect(screen.queryByText('$99.99')).toBeNull();
  expect(window.localStorage.getItem('profile-membership-selection')).toBe('premium-yearly');
});
test('profile contact comes from server configuration rather than a hard-coded address',async()=>{
  mount();
  expect((await screen.findByRole('link',{name:'test@example.test'})).getAttribute('href')).toBe('mailto:test@example.test');
  expect(screen.queryByRole('link',{name:'arborcollaboratory@yahoo.com'})).toBeNull();
});
