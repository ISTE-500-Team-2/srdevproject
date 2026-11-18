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
    if (path === '/training/catalog/holders') return [] as never;
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
  // The annual rule is shown as a fact, not a locked field that looks editable.
  expect(within(dialog).getByRole('group', { name: 'Renewal' }).textContent).toContain('1 year from each member’s training date');
  expect(within(dialog).getByText('Training can still be revoked.')).toBeTruthy();
  expect(within(dialog).queryByRole('spinbutton', { name: /Validity/ })).toBeNull();
  fireEvent.change(within(dialog).getByLabelText('Training duration (minutes)'), {target:{value:'60'}});
  fireEvent.change(within(dialog).getByLabelText('One-time training fee ($)'), {target:{value:'20.00'}});
  fireEvent.change(within(dialog).getByLabelText('Policy approval/reference'), { target: { value: 'Approved policy' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save certification' }));
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'This record changed. Review and retry.');
  expect(within(dialog).getByLabelText('Policy approval/reference')).toHaveProperty('value', 'Approved policy');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save certification' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(writes()).toHaveLength(2);
  expect(writes()[1]![1]?.body).toMatchObject({trainingMinutes:60,trainingFeeCents:2000});
  expect(writes()[1]![1]?.body).not.toHaveProperty('validityDays');
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

test('certification drafts survive closing and are discarded only after confirmation', async () => {
  render(<TrainingPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Configure Laser safety' }));
  const editor = screen.getByRole('dialog', { name: 'Edit Laser safety' });
  fireEvent.change(within(editor).getByLabelText('Description'), { target: { value: 'Updated safety instructions' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Close dialog' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(within(editor).getByLabelText('Description')).toHaveProperty('value', 'Updated safety instructions');
  fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(writes()).toHaveLength(0);
});

test('a new certification starts empty, is created without a revision, and cannot take equipment linked elsewhere', async () => {
  failures = 0;
  const equipmentPath = (path: string) => path === '/equipment';
  const base = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, init) => equipmentPath(path)
    ? [{ id: 3, name: 'Laser cutter', location: 'Shop', certification: 'Laser safety' }, { id: 4, name: 'Drill press', location: 'Shop', certification: null }] as never
    : base(path, init));
  render(<TrainingPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'New certification' }));
  const dialog = screen.getByRole('dialog', { name: 'New certification' });
  expect(within(dialog).getByLabelText('Name')).toHaveProperty('value', '');
  expect(within(dialog).getByLabelText('Training duration (minutes)')).toHaveProperty('value', '60');
  expect(within(dialog).getByLabelText('One-time training fee ($)')).toHaveProperty('value', '');
  expect(await within(dialog).findByRole('checkbox', { name: /Laser cutter/ })).toHaveProperty('disabled', true);
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /Drill press/ }));
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Drill safety' } });
  fireEvent.change(within(dialog).getByLabelText('Policy approval/reference'), { target: { value: 'Approved policy' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save certification' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(writes()).toEqual([['/training/catalog', { method: 'POST', body: { name: 'Drill safety', description: '', trainingMinutes: 60, trainingFeeCents: null, equipmentIds: [4], reason: 'Approved policy' } }]]);
  // The catalog reloads after a save, so its own "Loading records…" status can be on screen too.
  expect((await screen.findByText('Training records saved.')).getAttribute('role')).toBe('status');
});

test('editing sends the revision it was based on; first training sends none, a renewal sends the record revision', async () => {
  failures = 0;
  render(<TrainingPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Configure Laser safety' }));
  const editor = screen.getByRole('dialog', { name: 'Edit Laser safety' });
  expect(within(editor).getByLabelText('Name')).toHaveProperty('value', 'Laser safety');
  fireEvent.change(within(editor).getByLabelText('Policy approval/reference'), { target: { value: 'Approved policy' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save certification' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(writes()[0]).toEqual(['/training/catalog/7', expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ expectedRevision: 1 }) })]);

  const second = { ...course, id: 8, name: 'Lathe safety', revision: 4 };
  const base = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, init) => path === '/training/catalog' ? [course, second] as never : base(path, init));
  cleanup();
  render(<TrainingPage />);
  await pickMember();
  const approve = async (button: string) => {
    fireEvent.click(await screen.findByRole('button', { name: button }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Actual training date/time'), { target: { value: '2025-01-01T12:00' } });
    fireEvent.change(within(dialog).getByLabelText('Verification reference'), { target: { value: 'Observed' } });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'In person' } });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve training' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    return writes().at(-1)!;
  };
  const first = await approve('Record Lathe safety training');
  expect(first[0]).toBe('/training/users/12/certifications/8');
  expect(first[1]?.body).not.toHaveProperty('expectedRevision');
  const renewal = await approve('Renew');
  expect(renewal[0]).toBe('/training/users/12/certifications/7');
  expect(renewal[1]?.body).toMatchObject({ expectedRevision: 2 });
});

test('each workflow has its own busy and error state', async () => {
  let fail: (error: unknown) => void = () => {};
  const base = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path, init) => init?.method === 'POST' && path === '/training/users/12/certifications/7'
    ? new Promise((_, reject) => { fail = reject; })
    : base(path, init));
  render(<TrainingPage />);
  await pickMember();
  fireEvent.click(screen.getByRole('button', { name: 'Renew' }));
  const record = screen.getByRole('dialog');
  fireEvent.change(within(record).getByLabelText('Actual training date/time'), { target: { value: '2025-01-01T12:00' } });
  fireEvent.change(within(record).getByLabelText('Verification reference'), { target: { value: 'Observed' } });
  fireEvent.change(within(record).getByLabelText('Reason'), { target: { value: 'In person' } });
  fireEvent.click(within(record).getByRole('checkbox'));
  fireEvent.click(within(record).getByRole('button', { name: 'Approve training' }));
  await waitFor(() => expect(within(record).getByRole('button', { name: 'Approve training' })).toHaveProperty('disabled', true));
  fireEvent.click(within(record).getByRole('button', { name: 'Cancel' }));
  // The approval still running does not hold up revoking, and its failure is not shown there.
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  const revoke = screen.getByRole('dialog', { name: 'Revoke Laser safety?' });
  fireEvent.change(within(revoke).getByLabelText('Revocation/retraining reason'), { target: { value: 'Retraining required' } });
  expect(within(revoke).getByRole('button', { name: 'Hold to revoke Laser safety' })).toHaveProperty('disabled', false);
  fail(new ApiError(409, 'STALE_RECORD', 'This record changed. Review and retry.'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(within(revoke).queryByRole('alert')).toBeNull();
  expect(within(revoke).getByRole('button', { name: 'Hold to revoke Laser safety' })).toHaveProperty('disabled', false);
});

test('certification cards count holders from the real numbers and show the training time and fee once', async () => {
  const base = vi.mocked(api).getMockImplementation()!;
  const lathe = { ...course, id: 8, name: 'Lathe safety', trainingMinutes: 90, trainingFeeCents: 5000 };
  const drill = { ...course, id: 9, name: 'Drill safety' };
  vi.mocked(api).mockImplementation(async (path, init) =>
    path === '/training/catalog' ? [course, lathe, drill] as never
      : path === '/training/catalog/holders' ? [
        { id: 7, current: 4, expiringSoon: 1, expired: 2, revoked: 1 },
        { id: 8, current: 3, expiringSoon: 0, expired: 0, revoked: 0 },
      ] as never
      : base(path, init));
  render(<TrainingPage />);
  const card = (name: string) => screen.getByRole('heading', { name }).closest('article')!;
  await screen.findByText('4 certified');
  // Someone current no longer hides the people whose training lapsed.
  expect(within(card('Laser safety')).getByText('1 expiring soon · 2 expired · 1 revoked')).toBeTruthy();
  expect(within(card('Lathe safety')).getByText('3 certified')).toBeTruthy();
  expect(within(card('Lathe safety')).getByText('All current')).toBeTruthy();
  // Nobody holds it, so it isn't in the counts at all.
  expect(within(card('Drill safety')).getByText('0 certified')).toBeTruthy();
  expect(within(card('Drill safety')).getByText('No one trained yet')).toBeTruthy();
  expect(within(card('Lathe safety')).getAllByText(/90 minutes/)).toHaveLength(1);
  expect(within(card('Lathe safety')).getByText('90 minutes of training · $50.00 one-time fee when registering for training')).toBeTruthy();
});

test('training records word the end date from the date: a revocation replaces it, a future date is never "Expired"', async () => {
  const base = vi.mocked(api).getMockImplementation()!;
  const ended = { ...course, id: 10, name: 'Router safety', endsAt: '2026-01-15T12:00:00Z' };
  vi.mocked(api).mockImplementation(async (path, init) => path === '/training/users/12' ? [
    // Revoking leaves the renewal date as it was, still ahead.
    { ...record, status: 'revoked', valid: false, revokedAt: '2026-11-01T12:00:00Z', expiresAt: '2099-01-01T00:00:00Z' },
    { ...record, id: 10, certificationId: 8, name: 'Lathe safety', valid: false, expiresAt: '2020-06-01T12:00:00Z' },
    { ...record, id: 11, certificationId: 9, name: 'Drill safety', status: 'suspended', valid: false, expiresAt: '2099-06-01T12:00:00Z' },
    { ...record, id: 12, certificationId: 10, name: 'Router safety', valid: false, expiresAt: '2099-07-01T12:00:00Z' },
    { ...record, id: 13, certificationId: 11, name: 'Saw safety', valid: true, expiresAt: '2099-08-01T12:00:00Z' },
  ] as never : path === '/training/catalog' ? [course, ended] as never : base(path, init));
  render(<TrainingPage />);
  const user = userEvent.setup();
  await user.type(screen.getByRole('combobox', { name: 'Member' }), 'Jordan');
  await user.click(await screen.findByRole('option', { name: /Jordan Member/ }));
  const revoked = (await screen.findByText(/^Revoked /)).closest('li')!;
  const records = screen.getByRole('region', { name: 'Member training records' });
  const item = (name: string) => within(records).getByText(name).closest('li')!;
  expect(within(revoked).getByText('Not current · revoked')).toBeTruthy();
  expect(within(revoked).queryByText(/Expire/)).toBeNull();
  expect(within(item('Lathe safety')).getByText(/^Expired .*2020/)).toBeTruthy();
  // Not current with the date still ahead: never "Expires", which reads as good until then.
  expect(within(item('Drill safety')).getByText('Not current · suspended')).toBeTruthy();
  expect(within(item('Drill safety')).getByText(/^Would have renewed .*2099/)).toBeTruthy();
  expect(within(item('Drill safety')).queryByText(/Expire/)).toBeNull();
  // The certification itself ended, so that is the reason given.
  expect(within(item('Router safety')).getByText(/^Certification ended .*2026/)).toBeTruthy();
  expect(within(item('Router safety')).queryByText(/Expire|renewed/)).toBeNull();
  expect(within(item('Saw safety')).getByText(/^Expires .*2099/)).toBeTruthy();
});
