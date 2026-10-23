// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AdminDashboardPage } from "./AdminDashboardPage";

vi.mock("../lib/useApi", () => ({
  useApi: () => ({ data: null, loading: false, error: null, reload: vi.fn() }),
}));
vi.mock("./StaffUsers", () => ({
  StaffUsers: () => <h2>Members workspace</h2>,
}));
vi.mock("./StaffPlans", () => ({ StaffPlans: () => <h2>Plans workspace</h2> }));
vi.mock("./StaffReservations", () => ({
  StaffReservations: () => <h2>Reservations workspace</h2>,
}));
vi.mock("./StaffPayments", () => ({
  StaffPayments: () => <h2>Payments workspace</h2>,
}));
vi.mock("./StaffCompliance", () => ({
  StaffCompliance: () => <h2>Compliance workspace</h2>,
}));
vi.mock("./StaffPolicies", () => ({
  StaffPolicies: () => <h2>Policies workspace</h2>,
}));
vi.mock("./TrainingPage", () => ({
  TrainingPage: () => <h2>Training workspace</h2>,
}));
vi.mock("./ReportsPage", () => ({
  ReportsPage: () => <h2>Reports workspace</h2>,
}));
vi.mock("./AccessManagementPage", () => ({
  AccessManagementPage: () => <h2>Reader workspace</h2>,
}));
vi.mock("./AnalyticsDashboardPage", () => ({
  AnalyticsDashboardPage: () => <h2>Analytics workspace</h2>,
}));
vi.mock("./AdminCertificationsPage", () => ({
  AdminCertificationsPage: () => <h2>Certifications workspace</h2>,
}));
afterEach(cleanup);

test.each([
  ["analytics", "Analytics workspace"],
  ["adminCertWaiver", "Certifications workspace"],
  ["members", "Members workspace"],
  ["plans", "Plans workspace"],
  ["reservations", "Reservations workspace"],
  ["payments", "Payments workspace"],
  ["compliance", "Compliance workspace"],
  ["policies", "Policies workspace"],
  ["training", "Training workspace"],
  ["audit", "Staff change log"],
  ["reports", "Reports workspace"],
  ["access", "Reader workspace"],
])("combined staff workspace retains the %s section", (tab, heading) => {
  render(
    <MemoryRouter initialEntries={[`/admin?tab=${tab}`]}>
      <AdminDashboardPage />
    </MemoryRouter>,
  );
  const navigation = screen.getByRole("navigation", { name: "Staff sections" });
  for (const label of [
    "Members",
    "Plans",
    "Reservations",
    "Payment history",
    "Compliance",
    "Policies",
    "Training",
    "Change log",
    "Reports",
    "Reader access",
  ])
    expect(
      within(navigation).getByRole("button", { name: label }),
    ).toBeTruthy();
  expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
});
