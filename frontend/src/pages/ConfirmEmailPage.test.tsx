// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ConfirmEmailPage } from './ConfirmEmailPage';
const { confirmEmail } = vi.hoisted(() => ({ confirmEmail: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ confirmEmail }) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function mount() { render(<MemoryRouter initialEntries={['/confirm-email#test-token']}><Routes><Route path="/confirm-email" element={<ConfirmEmailPage />} /><Route path="/" element={<h1>Dashboard</h1>} /></Routes></MemoryRouter>); }
test('email link shows only confirmation and opens dashboard after success', async () => {
  confirmEmail.mockResolvedValue('member'); mount();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByText('Need another email?')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm email' }));
  await screen.findByRole('heading', { name: 'Dashboard' });
  expect(confirmEmail).toHaveBeenCalledWith('test-token');
});
test('failure offers recovery without showing forms on the token landing', async () => {
  confirmEmail.mockRejectedValue(new Error('Expired link')); mount();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm email' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(screen.getByRole('link', { name: 'Request a new confirmation email' }).getAttribute('href')).toBe('/confirm-email');
  expect(screen.queryByRole('textbox')).toBeNull();
});
