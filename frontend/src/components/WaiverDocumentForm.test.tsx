// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { User, Waiver, WaiverFormField } from '../lib/contracts';
import { WaiverDocumentForm } from './WaiverDocumentForm';

const descriptions = ['Participant Name', 'Date of Birth', 'Email', 'Emergency Contact Name', 'Emergency Contact Phone', 'Participant Signature', 'Parent/Guardian Name', 'Parent/Guardian Signature', 'Phone', 'Email'];
const fields: WaiverFormField[] = descriptions.map((label, index) => ({
  key: `field_${index}`, label, line: index, section: index >= 6 ? 'guardian' : 'participant',
  source: index === 0 ? 'server' : 'member', required: true, maxLength: 200,
  type: label === 'Date of Birth' ? 'date' : /email/i.test(label) ? 'email' : /phone/i.test(label) ? 'tel' : 'text',
}));
const waiver = { id: 1, name: 'Equipment agreement', version: '1', signerName: 'Jordan Demo',
  description: descriptions.map(label => `${label}: ____`).join('\n'), formFields: fields } as Waiver;
const user = { id: 1, firstName: 'Jordan', lastName: 'Demo', email: 'jordan@example.invalid' } as User;
afterEach(cleanup);
function mount() {
  const submit = vi.fn();
  const result = render(<WaiverDocumentForm waiver={waiver} user={user} busy={false} onSubmit={submit}>
    <button>Record agreement</button>
  </WaiverDocumentForm>);
  return { ...result, submit };
}
test('distinguishes recorded account facts from editable fields and explains each input', () => {
  const { container } = mount();
  expect(container.querySelector('output')!.textContent).toBe('Jordan Demo');
  expect(screen.queryByRole('textbox', { name: /Participant Name/ })).toBeNull();
  const email = screen.getByRole('textbox', { name: /^Email/ }) as HTMLInputElement;
  expect(email.value).toBe(user.email);
  expect(email.autocomplete).toBe('section-participant email');
  const dob = screen.getByLabelText('Date of Birth (required)') as HTMLInputElement;
  expect(dob.value).toBe('');
  expect(document.getElementById(dob.getAttribute('aria-describedby')!)!.textContent).toContain('not today');
  expect(screen.getByText(/Who should we contact in an emergency/)).toBeTruthy();
  const signature = screen.getByRole('textbox', { name: 'Participant Signature (required)' }) as HTMLInputElement;
  expect(signature.placeholder).toBe('Jordan Demo');
  expect(signature.value).toBe('');
  expect(document.getElementById(signature.getAttribute('aria-describedby')!)!.textContent).toContain('not initials');
});
test('guardian fields appear and become required only when consent is selected', () => {
  const { container } = mount();
  const guardian = container.querySelector('input[name="field_6"]') as HTMLInputElement;
  expect(guardian.closest('[hidden]')).not.toBeNull();
  expect(guardian.disabled).toBe(true);
  expect(guardian.required).toBe(false);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include parent or legal guardian consent' }));
  expect(guardian.closest('[hidden]')).toBeNull();
  expect(guardian.disabled).toBe(false);
  expect(guardian.required).toBe(true);
  expect(screen.getByRole('textbox', { name: 'Parent/guardian email (required)' })).toBeTruthy();
  fireEvent.change(guardian, { target: { value: 'Taylor Guardian' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include parent or legal guardian consent' }));
  expect(guardian.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include parent or legal guardian consent' }));
  expect(guardian.value).toBe('Taylor Guardian');
});
