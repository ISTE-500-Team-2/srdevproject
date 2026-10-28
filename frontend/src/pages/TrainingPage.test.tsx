// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { TrainingPage } from './TrainingPage';
import { api, ApiError } from '../lib/api';
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { roles: ['admin'] } }) }));
vi.mock('../lib/api', async original => ({ ...await original<typeof import('../lib/api')>(), api: vi.fn() }));
vi.mock('../components/reactbits/HoldButton', () => ({ default: ({ children, onHold, disabled }: { children: ReactNode; onHold: () => void; disabled: boolean }) => <button disabled={disabled} onClick={onHold}>{children}</button> }));
const course = { id: 7, name: 'Laser safety', description: 'Safe operation', validityDays: 365, equipmentIds: [], revision: 1 };
const record = { id: 9, certificationId: 7, name: 'Laser safety', status: 'active', valid: true, revision: 2, expiresAt: '2099-01-01T00:00:00Z', trainedAt: '2025-01-01T12:00:00Z', instructorName: 'Instructor' };
let failures: number;
beforeEach(() => {
  failures = 1;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method && init.method !== 'GET') {
      if (failures-- > 0) throw new ApiError(409, 'STALE_RECORD', 'This record changed. Review and retry.');
      return {} as never;
    }
    if (path === '/training/catalog') return [course] as never;
    if (path === '/training/users/12') return [record] as never;
    if (path.startsWith('/training/members?')) return { items: [{ id: 12, name: 'Jordan Member', email: 'jordan@example.invalid' }], hasMore: false } as never;
    if (path.startsWith('/admin/compliance')) return { certificationBreakdown: [] } as never;
    return [] as never;
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const writes = () => vi.mocked(api).mock.calls.filter(([, options]) => options?.method && options.method !== 'GET');
async function pickMember() {
  const user = userEvent.setup();
  await user.type(screen.getByRole('combobox', { name: 'Member' }), 'Jordan');
  await user.click(await screen.findByRole('option', { name: /Jordan Member/ }));
  await screen.findByRole('button', { name: 'Renew' });
}

test('catalog errors stay inside the editor with its draft and allow retry', async () => {
  render(<TrainingPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Configure Laser safety' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Policy approval/reference'), { target: { value: 'Approved policy' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save certification' }));
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'This record changed. Review and retry.');
  expect(within(dialog).getByLabelText('Policy approval/reference')).toHaveProperty('value', 'Approved policy');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save certification' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(writes()).toHaveLength(2);
});

test('training approval errors stay inside the dialog without clearing entered evidence', async () => {
  render(<TrainingPage />);
  await pickMember();
  fireEvent.click(screen.getByRole('button', { name: 'Renew' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Actual training date/time'), { target: { value: '2025-01-01T12:00' } });
  fireEvent.change(within(dialog).getByLabelText('Verification reference'), { target: { value: 'Observed demonstration' } });
  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Annual renewal' } });
  fireEvent.click(within(dialog).getByRole('checkbox'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Approve training' }));
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'This record changed. Review and retry.');
  expect(within(dialog).getByLabelText('Verification reference')).toHaveProperty('value', 'Observed demonstration');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Approve training' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(writes()).toHaveLength(2);
});

test('failed revocation keeps the dialog and reason until a successful retry', async () => {
  render(<TrainingPage />);
  await pickMember();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Revocation/retraining reason'), { target: { value: 'Retraining required' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Hold to revoke Laser safety' }));
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'This record changed. Review and retry.');
  expect(within(dialog).getByLabelText('Revocation/retraining reason')).toHaveProperty('value', 'Retraining required');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Hold to revoke Laser safety' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(writes()).toHaveLength(2);
});
