// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { StaffPolicies, suggestVersion } from "./StaffPolicies";
import { useApi } from "../lib/useApi";
import { api } from "../lib/api";
const auth = vi.hoisted(() => ({ user: { roles: ['admin'] } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../lib/useApi', () => ({ useApi: vi.fn() }));
vi.mock('../lib/api', async original => ({ ...await original<typeof import('../lib/api')>(), api: vi.fn() }));
vi.mock('../components/reactbits/HoldButton', () => ({ default: ({ children, onHold, disabled }: { children: ReactNode; onHold: () => void; disabled: boolean }) => <button disabled={disabled} onClick={onHold}>{children}</button> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); auth.user.roles = ['admin']; });

const current = { id: 1, name: 'Safety waiver', version: 'v1', active: true, required: true, effectiveAt: '2020-01-01T00:00:00Z', description: 'Current approved wording.', approvalReference: 'Board approval' };
const upcoming = [
  { ...current, id: 2, version: 'v2', effectiveAt: '2098-01-01T00:00:00Z', description: 'Next scheduled wording.' },
  { ...current, id: 3, version: 'v3', effectiveAt: '2099-01-01T00:00:00Z', description: 'Later scheduled wording.' },
];

test.each([true, false])('each scheduled version can be read and retired independently (current version: %s)', async (hasCurrent) => {
  let policies = hasCurrent ? [current, ...upcoming] : [...upcoming];
  vi.mocked(useApi).mockImplementation((path) => ({ data: path === '/admin/policies' ? policies : { summary: { userCount: 5 }, waiverBreakdown: [] }, loading: false, refreshing: false, error: '', reload: vi.fn() }));
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
  vi.mocked(useApi).mockImplementation(path => ({ data: path === '/admin/policies' ? [current, ...upcoming] : null, loading: false, refreshing: false, error: '', reload: vi.fn() }));
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
  vi.mocked(useApi).mockImplementation(path => ({ data: path === '/admin/policies' ? [] : null, loading: false, refreshing: false, error: '', reload: vi.fn() }));
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
