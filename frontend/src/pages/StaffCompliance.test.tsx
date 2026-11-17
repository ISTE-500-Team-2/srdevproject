// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StaffCompliance } from "./StaffCompliance";
import type { ComplianceReport } from "../lib/staffContracts";

const { useApi } = vi.hoisted(() => ({ useApi: vi.fn() }));
vi.mock("../lib/useApi", () => ({ useApi }));
vi.mock("../components/staff/record/MemberRecord", () => ({ MemberRecord: () => null }));
afterEach(() => {
  cleanup();
  useApi.mockReset();
});

const report = {
  summary: { userCount: 3, compliantUsers: 2, waiverCompliantUsers: 2, certificationCompliantUsers: 3, attentionUsers: 1, allAttentionUsers: 1, complianceRate: 66, waiverComplianceRate: 66, certificationComplianceRate: 100 },
  users: { items: [{ id: 4, firstName: "Casey", lastName: "Demo", email: "casey@example.invalid", accessStatus: "active", issues: [] }], nextOffset: 50 },
  waiverBreakdown: [{ id: 1, name: "Shop safety", total: 3, compliant: 2, expiring: 0 }],
  certificationBreakdown: [],
  nextOffset: null,
} as unknown as ComplianceReport;

test("another view or page keeps the report on screen, out of reach, while its filters and pager stay usable", () => {
  useApi.mockImplementation((path: string | null) => ({
    data: path?.includes("compliance") ? report : null,
    loading: false,
    refreshing: false,
    stale: !!path?.includes("compliance"),
    error: "",
    reload: vi.fn(),
  }));
  render(<StaffCompliance />);
  expect(useApi.mock.calls.find(([path]) => path?.includes("compliance"))?.[1]).toMatchObject({ retainOnChange: true });
  const kept = [...document.querySelectorAll(".kept-results")];
  expect(kept).toHaveLength(2);
  expect(kept.every((box) => box.hasAttribute("inert"))).toBe(true);
  expect(kept[1].contains(screen.getByRole("button", { name: "Open record for Casey Demo" }))).toBe(true);
  // Before, the chips and select unmounted on every change, taking focus with them.
  for (const control of [screen.getByRole("radio", { name: /Needs attention/ }), screen.getByLabelText("Account status"), screen.getByLabelText("Search members"), screen.getByRole("button", { name: "Next page" })])
    expect(kept.some((box) => box.contains(control))).toBe(false);
  expect(screen.getByRole("button", { name: "Next page" }).getAttribute("aria-disabled")).toBe("true");
});

test("“show everyone” hands focus to the Everyone chip before the list waits on the change", () => {
  useApi.mockImplementation((path: string | null) => ({
    data: path?.includes("compliance") ? report : null,
    loading: false,
    refreshing: false,
    stale: false,
    error: "",
    reload: vi.fn(),
  }));
  render(<StaffCompliance />);
  const all = screen.getByRole("button", { name: /all set · show everyone/ });
  all.focus();
  fireEvent.click(all);
  expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Everyone" }));
  // Everyone: no longer only those needing attention.
  const reports = useApi.mock.calls.map(([path]) => path as string | null).filter((path) => path?.includes("compliance"));
  expect(reports[0]).toContain("attention=true");
  expect(reports.at(-1)).not.toContain("attention=true");
});

test("the Needs attention count stays the same on “Expiring in 30 days”", () => {
  // The window's own attention count is smaller; the chip counts everyone, whichever view is open.
  const summary = (attentionUsers: number) => ({ ...report.summary, attentionUsers, allAttentionUsers: 5 });
  useApi.mockImplementation((path: string | null) => ({
    data: path?.includes("compliance")
      ? { ...report, summary: summary(path.includes("expiresWithinDays") ? 2 : 5) }
      : null,
    loading: false,
    refreshing: false,
    stale: false,
    error: "",
    reload: vi.fn(),
  }));
  render(<StaffCompliance />);
  expect(screen.getByRole("radio", { name: "Needs attention · 5" })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Expiring in 30 days" }));
  const reports = useApi.mock.calls.map(([path]) => path as string | null).filter((path) => path?.includes("compliance"));
  expect(reports.at(-1)).toContain("expiresWithinDays=30");
  expect(screen.getByRole("radio", { name: "Needs attention · 5" })).toBeTruthy();
});

test("revoked training reads as revoked, and a certification nobody holds yet still gets a card", () => {
  const issues = [{ kind: "certification", name: "Laser cutting", state: "revoked", expiresAt: null }];
  useApi.mockImplementation((path: string | null) => ({
    data: path?.includes("compliance")
      ? {
          ...report,
          users: { items: [{ ...report.users.items[0], issues }], nextOffset: null },
          certificationBreakdown: [{ id: 9, name: "Router table", total: 0, compliant: 0, expiring: 0 }],
        }
      : null,
    loading: false,
    refreshing: false,
    stale: false,
    error: "",
    reload: vi.fn(),
  }));
  render(<StaffCompliance />);
  expect(screen.getByText("Revoked · Laser cutting")).toBeTruthy();
  expect(screen.queryByText(/Not trained/)).toBeNull();
  expect(screen.getByText("Router table")).toBeTruthy();
  expect(screen.getByText("No holders in this view")).toBeTruthy();
});
