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

test('semantic ids and line kinds decide behaviour when the server sends them', () => {
  // Labels reworded so none of the legacy label patterns match.
  const reworded: WaiverFormField[] = [
    { key: 'name', label: 'Nom du participant', line: 0, type: 'text', section: 'participant', semantic: 'participant-name', source: 'server', required: true, maxLength: 200 },
    { key: 'born', label: 'Né le', line: 1, type: 'date', section: 'participant', semantic: 'date-of-birth', source: 'member', required: true, maxLength: 200 },
    { key: 'sign', label: 'Paraphe', line: 2, type: 'text', section: 'participant', semantic: 'signature', source: 'member', required: true, maxLength: 200 },
    { key: 'sos', label: 'Téléphone', line: 3, type: 'tel', section: 'participant', semantic: 'emergency-contact-phone', source: 'member', required: true, maxLength: 40 },
    { key: 'id', label: 'Identifiant', line: 5, type: 'text', section: 'administrative', semantic: 'member-id', source: 'server', required: true, maxLength: 200 },
    // A label that looks like a signature but is not one.
    { key: 'note', label: 'Signature notes', line: 6, type: 'text', section: 'participant', semantic: 'other', source: 'member', required: true, maxLength: 200 },
  ];
  const description = ['Nom du participant: ____', 'Né le: ____', 'Paraphe: ____', 'Téléphone: ____', 'Section A', 'Identifiant: ____', 'Signature notes: ____', 'Acceptation'].join('\n');
  const { container } = render(<WaiverDocumentForm user={user} busy={false} onSubmit={vi.fn()}
    waiver={{ ...waiver, description, formFields: reworded, formLines: ['text', 'text', 'text', 'text', 'heading', 'text', 'text', 'acceptance-method'] }}>
    <button>Record agreement</button>
  </WaiverDocumentForm>);
  const outputs = [...container.querySelectorAll('output')].map(output => output.textContent);
  expect(outputs).toEqual(['Jordan Demo', '1']);
  const born = screen.getByLabelText('Né le (required)') as HTMLInputElement;
  expect([born.value, born.autocomplete, born.max]).toEqual(['', 'bday', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)]);
  expect((screen.getByLabelText('Paraphe (required)') as HTMLInputElement).placeholder).toBe('Jordan Demo');
  expect((screen.getByLabelText('Téléphone (required)') as HTMLInputElement).autocomplete).toBe('off');
  expect((screen.getByLabelText('Signature notes (required)') as HTMLInputElement).placeholder).toBe('');
  expect(screen.getByRole('heading', { name: 'Section A' })).toBeTruthy();
  expect(screen.getByRole('group', { name: 'Method of Acceptance' })).toBeTruthy();
});

test('without line kinds, headings and the acceptance method are recognised from the text as before', () => {
  const description = ['1. Purpose', 'Plain terms.', 'Administrative Record', 'Method of Acceptance: ☐ Electronic ☐ In Person ☐ Other'].join('\n');
  render(<WaiverDocumentForm user={user} busy={false} onSubmit={vi.fn()} waiver={{ ...waiver, description, formFields: [] }}>
    <button>Record agreement</button>
  </WaiverDocumentForm>);
  expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['Review and complete your agreement', '1. Purpose', 'Administrative Record']);
  expect(screen.getByText('Plain terms.')).toBeTruthy();
  expect(screen.getByRole('group', { name: 'Method of Acceptance' })).toBeTruthy();
});
