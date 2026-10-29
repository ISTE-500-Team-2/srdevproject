import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../../src/App';
import { api, setAccessToken, setCsrfToken } from '../../src/lib/api';
import { createBrowserBridge } from '../../../backend/test/helpers/browserBridge';
import { confirmationToken } from '../../../backend/test/helpers/confirmation';
import { equipmentWaiverName, waiverAcceptance } from '../../../backend/test/helpers/waiver';

let bridge: Awaited<ReturnType<typeof createBrowserBridge>>;
beforeAll(async () => { bridge = await createBrowserBridge(); });
afterAll(async () => {
  cleanup(); vi.unstubAllGlobals(); setAccessToken(null); setCsrfToken(null);
  if (bridge) await bridge.close();
});
const mount = () => render(<MemoryRouter initialEntries={['/certifications']}><App /></MemoryRouter>);

test('newly registered unsigned member can fill every blank, correct errors, sign and retrieve the completed document', async () => {
  vi.stubGlobal('fetch', bridge.fetch);
  const email = 'new-waiver-member@example.invalid';
  await api('/auth/register', { method: 'POST', body: { firstName: 'New', lastName: 'Member', username: 'new-waiver-member', email,
    phone: '5550101234', dob: '2000-01-01', password: 'StrongPassword123!', timeZone: 'America/New_York' } });
  await api('/auth/confirm', { method: 'POST', body: { token: await confirmationToken(bridge.pool, email) } });
  const waivers = await api<any[]>('/me/waivers');
  const waiver = waivers.find(w => w.name === equipmentWaiverName)!;
  expect(waiver.signed).toBe(false);
  expect((await api<any[]>('/me/signed-waivers')).length).toBe(0);
  const user = userEvent.setup();
  mount();
  const row = (await screen.findByRole('heading', { name: equipmentWaiverName })).closest('article')!;
  await user.click(within(row).getByRole('button', { name: 'Review and agree' }));
  const dialog = await screen.findByRole('dialog', { name: equipmentWaiverName });
  const form = dialog.querySelector('form')!;
  const electronic = within(dialog).getByRole('checkbox', { name: 'Electronic' }) as HTMLInputElement;
  expect(electronic.checked).toBe(true);
  expect(electronic.matches(':disabled')).toBe(true);
  expect((within(dialog).getByRole('checkbox', { name: 'In Person' }) as HTMLInputElement).checked).toBe(false);
  expect((within(dialog).getByRole('checkbox', { name: 'Other' }) as HTMLInputElement).checked).toBe(false);
  const submit = within(dialog).getByRole('button', { name: 'Record agreement' });
  // Members type only their own details; identity, version and signing time are read-only.
  const memberFields = waiver.formFields.filter((f: any) => f.source === 'member');
  const serverFields = waiver.formFields.filter((f: any) => f.source === 'server');
  expect(memberFields.length + serverFields.length).toBe(19);
  const inputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[name]'));
  expect(inputs).toHaveLength(memberFields.length);
  expect(inputs.every(input => !input.readOnly)).toBe(true);
  expect(form.querySelectorAll('output').length).toBeGreaterThanOrEqual(serverFields.length);
  expect(waiver.signerName).toBe('New Member');
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  await user.click(within(dialog).getByRole('checkbox', { name: /I have read/ }));
  await user.click(submit);
  expect(form.checkValidity()).toBe(false);
  expect((await api<any[]>('/me/signed-waivers')).length).toBe(0);
  const body = waiverAcceptance(waiver);
  const change = (key: string, value: string) => fireEvent.change(form.querySelector(`input[name="${key}"]`)!, { target: { value } });
  for (const field of memberFields) {
    if (field.section !== 'guardian') change(field.key, body.formValues![field.key]!);
  }
  await user.click(within(dialog).getByRole('checkbox', { name: 'Include parent or legal guardian consent' }));
  expect(form.checkValidity()).toBe(false);
  for (const field of memberFields) {
    if (field.section === 'guardian') change(field.key, body.formValues![field.key]!);
  }
  // A signature that isn't the account holder's name is refused.
  const signature = memberFields.find((f: any) => f.section === 'participant' && /signature/i.test(f.label));
  change(signature.key, 'Someone Else');
  await user.click(submit);
  expect((await within(dialog).findByRole('alert')).textContent).toContain('Type your full name, New Member');
  change(signature.key, 'New Member');
  const phone = waiver.formFields.find((f: any) => f.label === 'Emergency Contact Phone');
  change(phone.key, 'invalid');
  await user.click(submit);
  await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('emergency contact phone'));
  expect((form.querySelector(`input[name="${signature.key}"]`) as HTMLInputElement).value).toBe('New Member');
  change(phone.key, '+1 (555) 010-1234');
  await user.click(submit);
  await screen.findByText('Your agreement has been recorded.');
  await waitFor(() => expect(within(screen.getByRole('heading', { name: equipmentWaiverName }).closest('article')!).getByRole('button', { name: 'View policy' })).toBeTruthy());
  const record = (await api<any[]>('/me/signed-waivers')).find(w => w.name === equipmentWaiverName)!;
  const copy = await api<{ content: string }>(`/me/signed-waivers/${record.id}/copy`);
  // The record carries server facts, not anything typed into the form.
  const me = await api<{ user: { id: number } }>('/me/profile');
  expect(copy.content.match(/Participant Name: New Member/g)?.length).toBe(2);
  expect(copy.content).toContain('Participant Signature: New Member');
  expect(copy.content).toContain(`User/Member ID: ${me.user.id}`);
  expect(copy.content).toContain(`Waiver Version: ${waiver.version}`);
  expect(copy.content).toMatch(/Accepted Date\/Time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(/);
  expect(copy.content).toContain('Parent/Guardian Signature: Waiver Test Participant');
  expect(copy.content).toContain('Method of Acceptance: ☑ Electronic ☐ In Person ☐ Other');
  expect(copy.content).not.toMatch(/_{3,}/);
  cleanup(); mount();
  const savedRow = (await screen.findByRole('heading', { name: equipmentWaiverName })).closest('article')!;
  await user.click(within(savedRow).getByRole('button', { name: 'View policy' }));
  expect(await screen.findByText('This version is already signed.')).toBeTruthy();
  expect(screen.getByRole('link', { name: /Download your completed form/ }).getAttribute('href')).toBe('/profile');
});
