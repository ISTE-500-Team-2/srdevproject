// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { StaffPolicies } from "./StaffPolicies";
import { useApi } from "../lib/useApi";
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { roles: ['admin'] } }) }));
vi.mock('../lib/useApi', () => ({ useApi: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const base = { name: 'Safety waiver', active: true, required: true, scope: 'facility' as const, description: null, approvalReference: null };
function show(policies: unknown[]) {
  vi.mocked(useApi).mockImplementation((path) => ({ data: path === '/admin/policies' ? policies : null, loading: false, refreshing: false, error: '', reload: vi.fn() }));
  render(<StaffPolicies />);
  return screen.getByRole('heading', { name: 'Safety waiver' }).closest('article')!;
}

test('an active version with no start date is in effect, not retired (the backend accepts it)', () => {
  const card = show([{ ...base, id: 7, version: 'v1', effectiveAt: null }]);
  expect(within(card).queryByText('Retired')).toBeNull();
  expect(within(card).getByText('Required')).toBeTruthy();
  expect(card.textContent).toContain('In effect · No start date');
  expect(card.textContent).toContain('No approval reference');
  expect(within(card).getByRole('button', { name: 'Retire Safety waiver v1' })).toBeTruthy();
});

test('a dated version already in effect is current ahead of an undated one; a future one stays scheduled', () => {
  const card = show([
    { ...base, id: 9, version: 'v3', effectiveAt: '2099-01-01T00:00:00Z' },
    { ...base, id: 8, version: 'v2', effectiveAt: null },
    { ...base, id: 7, version: 'v1', effectiveAt: '2020-01-01T00:00:00Z' },
  ]);
  expect(card.querySelector('.cw-waiver__meta')!.textContent).toContain('Version v1');
  expect(card.textContent).toMatch(/In effect since/);
  expect(card.textContent).toContain('Version v3 starts');
  // The undated version is listed as earlier, without an invented date.
  expect(card.querySelector('.cw-older')!.textContent).toContain('Version v2 · Active · No start date');
});

test('undated versions keep the server order among themselves', () => {
  const card = show([
    { ...base, id: 12, version: 'v12', effectiveAt: null },
    { ...base, id: 11, version: 'v11', effectiveAt: null },
  ]);
  expect(card.querySelector('.cw-waiver__meta')!.textContent).toContain('Version v12');
  expect(card.querySelector('.cw-older')!.textContent).toContain('Version v11');
});
