// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfilePage } from './ProfilePage';
const { api, refresh } = vi.hoisted(() => ({ api: vi.fn(), refresh: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { firstName:'Test',lastName:'Member',email:'test@example.com',phone:'1234567890',role:'member' }, refresh }) }));
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
  return render(<ProfilePage />);
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

test('membership tiers offer monthly and yearly billing options', async () => {
  mount();

  const basicGroup = screen.getByRole('group', { name: 'Basic' });
  const basicMonthly = basicGroup.querySelector('input[value="basic-monthly"]') as HTMLInputElement;
  expect(basicMonthly.checked).toBe(true);

  for (const tier of ['Basic', 'Premium', 'Student']) {
    const group = screen.getByRole('group', { name: tier });
    expect(group.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    expect(group.textContent).toContain('Monthly');
    expect(group.textContent).toContain('$19.99');
    expect(group.textContent).toContain('Yearly');
    expect(group.textContent).toContain('$99.99');
  }

  const studentGroup = screen.getByRole('group', { name: 'Student' });
  expect(studentGroup.querySelectorAll('input:disabled')).toHaveLength(2);
  const changeButton = screen.getByRole('button', { name: 'Change membership option' });
  expect(changeButton.classList.contains('button')).toBe(true);
  expect(changeButton.classList.contains('button--primary')).toBe(true);
});

test('selecting a plan saves it before reloading the page', () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  mount();

  const premiumYearly = screen.getByRole('group', { name: 'Premium' }).querySelector('input[value="premium-yearly"]') as HTMLInputElement;
  fireEvent.click(premiumYearly);
  expect(screen.getByRole('group', { name: 'Premium' }).getAttribute('data-selected')).toBe('true');
  expect(screen.getByRole('group', { name: 'Basic' }).getAttribute('data-selected')).toBe('false');

  fireEvent.click(screen.getByRole('button', { name: 'Change membership option' }));
  expect(window.localStorage.getItem('profile-membership-selection')).toBe('premium-yearly');
  expect(reload).toHaveBeenCalledOnce();
});
