// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { StaffPolicies, suggestVersion } from "./StaffPolicies";
import { useApi } from "../lib/useApi";
import { api, ApiError } from "../lib/api";
import { documentText } from "../lib/documentText";
import { localInput } from "../lib/display";
const auth = vi.hoisted(() => ({ user: { roles: ['admin'] } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../lib/useApi', () => ({ useApi: vi.fn() }));
vi.mock('../lib/api', async original => ({ ...await original<typeof import('../lib/api')>(), api: vi.fn() }));
vi.mock('../lib/documentText', () => ({ documentText: vi.fn() }));
vi.mock('../components/reactbits/HoldButton', () => ({ default: ({ children, onHold, disabled }: { children: ReactNode; onHold: () => void; disabled: boolean }) => <button disabled={disabled} onClick={onHold}>{children}</button> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); auth.user.roles = ['admin']; });

const current = { id: 1, name: 'Safety waiver', version: 'v1', active: true, required: true, effectiveAt: '2020-01-01T00:00:00Z', description: 'Current approved wording.', approvalReference: 'Board approval' };
const upcoming = [
  { ...current, id: 2, version: 'v2', effectiveAt: '2098-01-01T00:00:00Z', description: 'Next scheduled wording.' },
  { ...current, id: 3, version: 'v3', effectiveAt: '2099-01-01T00:00:00Z', description: 'Later scheduled wording.' },
];

test.each([true, false])('each scheduled version can be read and retired independently (current version: %s)', async (hasCurrent) => {
  let policies = hasCurrent ? [current, ...upcoming] : [...upcoming];
  vi.mocked(useApi).mockImplementation((path) => ({ data: path === '/admin/policies' ? policies : { summary: { userCount: 5 }, waiverBreakdown: [] }, loading: false, refreshing: false, stale: false, error: '', reload: vi.fn() }));
  vi.mocked(api).mockImplementation(async (path) => {
    expect(path).toBe('/admin/policies/2/retire');
    policies = policies.map(p => p.id === 2 ? { ...p, active: false } : p);
    return { ...upcoming[0], active: false } as never;
  });
  render(<StaffPolicies />);
  expect(screen.getAllByRole('button', { name: /^Retire Safety waiver/ })).toHaveLength(hasCurrent ? 3 : 2);
  fireEvent.click(screen.getByRole('button', { name: 'View Safety waiver v2' }));
  expect(within(screen.getByRole('dialog')).getByText('Next scheduled wording.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  fireEvent.click(screen.getByRole('button', { name: 'Retire Safety waiver v2' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Reason for the change log'), { target: { value: 'Withdraw scheduled wording' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Hold to retire' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api).toHaveBeenCalledWith('/admin/policies/2/retire', { method: 'POST', body: { reason: 'Withdraw scheduled wording' } });
  expect(screen.queryByRole('button', { name: 'Retire Safety waiver v2' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Retire Safety waiver v3' })).toBeTruthy();
  if (hasCurrent) expect(screen.getByRole('button', { name: 'Retire Safety waiver v1' })).toBeTruthy();
});

test('staff can inspect scheduled wording but cannot retire it', () => {
  auth.user.roles = ['staff'];
  vi.mocked(useApi).mockImplementation(path => ({ data: path === '/admin/policies' ? [current, ...upcoming] : null, loading: false, refreshing: false, stale: false, error: '', reload: vi.fn() }));
  render(<StaffPolicies />);
  expect(screen.getByRole('button', { name: 'View Safety waiver v2' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Retire/ })).toBeNull();
});

test("next version: dated versions take the start date, numbered ones count up", () => {
  expect(suggestVersion("2026-09-28", "2026-10-30")).toBe("2026-10-30");
  expect(suggestVersion("DEMO-1", "2026-10-30")).toBe("DEMO-2");
  expect(suggestVersion("v9", "2026-10-30")).toBe("v10");
  expect(suggestVersion("Spring edition", "2026-10-30")).toBe("2026-10-30");
  expect(suggestVersion(undefined, "2026-10-30")).toBe("2026-10-30");
});

test('waiver text and approval evidence survive accidental closing until discard is confirmed', () => {
  vi.mocked(useApi).mockImplementation(path => ({ data: path === '/admin/policies' ? [] : null, loading: false, refreshing: false, stale: false, error: '', reload: vi.fn() }));
  render(<StaffPolicies />);
  fireEvent.click(screen.getByRole('button', { name: 'New waiver' }));
  const editor = screen.getByRole('dialog', { name: 'New waiver' });
  fireEvent.change(within(editor).getByLabelText('Text members will read'), { target: { value: 'Approved wording that has not yet been published.' } });
  fireEvent.change(within(editor).getByLabelText('Approval reference'), { target: { value: 'Board approval' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(within(editor).getByLabelText('Text members will read')).toHaveProperty('value', 'Approved wording that has not yet been published.');
  expect(within(editor).getByLabelText('Approval reference')).toHaveProperty('value', 'Board approval');
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api).not.toHaveBeenCalled();
});

const publish = async () => {
  vi.mocked(useApi).mockImplementation(path => ({ data: path === '/admin/policies' ? [current] : { summary: { userCount: 5 }, waiverBreakdown: [] }, loading: false, refreshing: false, stale: false, error: '', reload: vi.fn() }));
  vi.mocked(api).mockResolvedValue({} as never);
  render(<StaffPolicies />);
  fireEvent.click(screen.getByRole('button', { name: 'Publish new version' }));
  const dialog = screen.getByRole('dialog');
  // The annual rule is shown as a fact, not a locked field that looks editable.
  expect(within(dialog).getByRole('group', { name: 'Renewal' }).textContent).toContain('each signature lasts 365 days from the day the member signs');
  expect(within(dialog).queryByRole('spinbutton', { name: /Valid/ })).toBeNull();
  fireEvent.change(within(dialog).getByLabelText(/Approval/), { target: { value: 'Board vote' } });
  fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Annual update' } });
  fireEvent.submit(within(dialog).getByLabelText(/Reason/).closest('form')!);
  await waitFor(() => expect(api).toHaveBeenCalled());
  return vi.mocked(api).mock.calls[0]![1] as { body: Record<string, unknown> };
};

test('B-015: publishing leaves the annual signature period to the server', async () => {
  const { body } = await publish();
  expect('validityDays' in body).toBe(false);
});

test('administrators can publish an equipment waiver without making it a day-pass prerequisite', async () => {
  vi.mocked(useApi).mockImplementation(path => ({ data: path === '/admin/policies' ? [] : null, loading: false, refreshing: false, stale: false, error: '', reload: vi.fn() }));
  vi.mocked(api).mockResolvedValue({} as never);
  render(<StaffPolicies />);
  fireEvent.click(screen.getByRole('button', { name: 'New waiver' }));
  const editor = screen.getByRole('dialog', { name: 'New waiver' });
  fireEvent.change(within(editor).getByLabelText('Waiver'), { target: { value: 'Equipment safety' } });
  fireEvent.change(within(editor).getByLabelText('Required for'), { target: { value: 'equipment' } });
  fireEvent.change(within(editor).getByLabelText('Text members will read'), { target: { value: 'Approved equipment agreement wording for this test.' } });
  fireEvent.change(within(editor).getByLabelText('Approval reference'), { target: { value: 'Board vote' } });
  fireEvent.change(within(editor).getByLabelText('Reason for the change log'), { target: { value: 'Separate equipment requirements' } });
  expect(within(editor).getByText(/Until they do, they can't book or use equipment/)).toBeTruthy();
  fireEvent.submit(within(editor).getByRole('button', { name: 'Publish version' }).closest('form')!);
  await waitFor(() => expect(api).toHaveBeenCalledWith('/admin/policies', expect.objectContaining({ body: expect.objectContaining({ scope: 'equipment' }) })));
});

test('a new version cannot start before the version in force, and the server saying so keeps the form', async () => {
  vi.mocked(useApi).mockImplementation(path => ({ data: path === '/admin/policies' ? [current] : null, loading: false, refreshing: false, stale: false, error: '', reload: vi.fn() }));
  vi.mocked(api).mockRejectedValue(new ApiError(409, 'POLICY_STARTS_TOO_EARLY', 'The version now in force started Jan 1, 2020. Choose a start at or after that time.', 'effectiveAt'));
  render(<StaffPolicies />);
  fireEvent.click(screen.getByRole('button', { name: 'Publish new version' }));
  const dialog = screen.getByRole('dialog');
  const startsAt = within(dialog).getByLabelText('Takes effect') as HTMLInputElement;
  expect(startsAt.min).toBe(localInput(new Date(current.effectiveAt)));
  fireEvent.change(within(dialog).getByLabelText(/Approval/), { target: { value: 'Board vote' } });
  fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Correct the wording' } });
  fireEvent.submit(startsAt.closest('form')!);
  expect((await within(dialog).findByRole('alert')).textContent).toContain('The version now in force started Jan 1, 2020.');
  expect(screen.getByRole('dialog')).toBe(dialog);
});

test('publishing a new equipment version retains its applicability', () => {
  vi.mocked(useApi).mockImplementation(path => ({ data: path === '/admin/policies' ? [{ ...current, scope: 'equipment' }] : null, loading: false, refreshing: false, stale: false, error: '', reload: vi.fn() }));
  render(<StaffPolicies />);
  fireEvent.click(screen.getByRole('button', { name: 'Publish new version' }));
  expect(screen.getByLabelText('Required for')).toHaveProperty('value', 'equipment');
});

const openNewWaiver = () => {
  vi.mocked(useApi).mockImplementation(path => ({ data: path === '/admin/policies' ? [] : null, loading: false, refreshing: false, stale: false, error: '', reload: vi.fn() }));
  render(<StaffPolicies />);
  fireEvent.click(screen.getByRole('button', { name: 'New waiver' }));
  return screen.getByRole('dialog', { name: 'New waiver' });
};
const fileDrag = (file?: File) => ({ dataTransfer: { types: ['Files'], files: file ? [file] : [], dropEffect: '' } });

test('a document dropped anywhere on the form fills the waiver text, even from the preview', async () => {
  vi.mocked(documentText).mockResolvedValue('Wording imported from the approved document.');
  const editor = openNewWaiver();
  fireEvent.click(within(editor).getByRole('tab', { name: 'Preview' }));
  const preview = within(editor).getByText('Nothing to preview yet.');
  const file = new File(['wording'], 'waiver.txt', { type: 'text/plain' });
  // false: the browser's own drop (opening the file in place of the app) was cancelled.
  const over = fileDrag();
  expect(fireEvent.dragOver(preview, over)).toBe(false);
  // The copy cursor and the highlighted pane show the drop will be taken.
  expect(over.dataTransfer.dropEffect).toBe('copy');
  expect(preview.closest('.cw-preview')!.classList.contains('is-dragging')).toBe(true);
  expect(fireEvent.drop(preview, fileDrag(file))).toBe(false);
  await waitFor(() => expect(within(editor).getByLabelText('Text members will read')).toHaveProperty('value', 'Wording imported from the approved document.'));
  expect(documentText).toHaveBeenCalledWith(file);
});

test('a document dropped beside the form is ignored instead of replacing the page and the draft', () => {
  const editor = openNewWaiver();
  const file = new File(['wording'], 'waiver.pdf', { type: 'application/pdf' });
  // Outside the form the browser shows the no-drop cursor rather than promising a copy.
  for (const target of [within(editor).getByRole('heading', { name: 'New waiver' }), document.body]) {
    const over = fileDrag();
    expect(fireEvent.dragOver(target, over)).toBe(false);
    expect(over.dataTransfer.dropEffect).toBe('none');
  }
  expect(fireEvent.drop(within(editor).getByRole('heading', { name: 'New waiver' }), fileDrag(file))).toBe(false);
  expect(fireEvent.drop(document.body, fileDrag(file))).toBe(false);
  expect(documentText).not.toHaveBeenCalled();
  // Text dragged between fields still drops normally.
  expect(fireEvent.dragOver(within(editor).getByLabelText('Text members will read'), { dataTransfer: { types: ['text/plain'], files: [] } })).toBe(true);
  fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(fireEvent.drop(document.body, fileDrag(file))).toBe(true);
});

test('the approval reference is required up front, as the server requires it', () => {
  const editor = openNewWaiver();
  const reference = within(editor).getByLabelText('Approval reference') as HTMLInputElement;
  expect(reference.required).toBe(true);
  expect(reference.minLength).toBe(3);
  expect(reference.validity.valueMissing).toBe(true);
});

test.each([
  ['Approval reference', '  a ', 'Approval reference needs at least 3 characters besides spaces.'],
  ['Reason for the change log', ' b  ', 'Reason for the change log needs at least 3 characters besides spaces.'],
])('a %s of spaces is caught before publishing, as the server trims it', (label, value, message) => {
  const editor = openNewWaiver();
  fireEvent.change(within(editor).getByLabelText('Waiver'), { target: { value: 'Laser room rules' } });
  fireEvent.change(within(editor).getByLabelText('Text members will read'), { target: { value: 'Approved laser room wording for this test.' } });
  fireEvent.change(within(editor).getByLabelText('Approval reference'), { target: { value: 'Board vote' } });
  fireEvent.change(within(editor).getByLabelText('Reason for the change log'), { target: { value: 'New room rules' } });
  const field = within(editor).getByLabelText(label);
  fireEvent.change(field, { target: { value } });
  fireEvent.submit(field.closest('form')!);
  expect(within(editor).getByRole('alert').textContent).toBe(message);
  expect(document.activeElement).toBe(field);
  expect(api).not.toHaveBeenCalled();
});
