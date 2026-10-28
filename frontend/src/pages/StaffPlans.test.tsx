// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StaffPlans } from "./StaffPlans";

const { api, auth } = vi.hoisted(() => ({
  api: vi.fn(),
  auth: { user: { roles: ["admin"] } as unknown },
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("../lib/api", () => ({ api, errorMessage: (error: Error) => error.message }));
vi.mock("../components/MemberSelect", () => ({ MemberSelect: () => null }));

const monthly = {
  id: 1, name: "Monthly", kind: "membership", price: "95.00", months: 1,
  benefits: "Shop access\nOne guest visit", active: true, revision: 3,
};
const dayPass = {
  id: 2, name: "Day pass", kind: "day_pass", price: "25.00", months: null,
  benefits: "", active: true, revision: 1,
};
const summer = { ...monthly, id: 3, name: "Summer intro", price: "60.00", active: false };

beforeEach(() => {
  auth.user = { roles: ["admin"] };
  api.mockImplementation((path: string, options?: { method?: string }) => {
    if (options?.method) return Promise.resolve({ ...monthly, price: "99.00", revision: 4 });
    if (path === "/admin/plans") return Promise.resolve([monthly, dayPass, summer]);
    if (path === "/billing-management/pricing")
      return Promise.resolve([{ tierid: 1, student_cents: 6500, partner_free: true, revision: 2 }]);
    return Promise.resolve([]);
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const writes = () => api.mock.calls.filter(([, options]) => options?.method);

test("lists plans by type, with discounts and off-sale plans tucked away", async () => {
  render(<StaffPlans />);
  const memberships = await screen.findByRole("region", { name: "Memberships" });
  expect(within(memberships).getByRole("heading", { name: "Monthly" })).toBeTruthy();
  expect(within(memberships).getByText("Students $65.00")).toBeTruthy();
  expect(within(memberships).getByText("Partners free")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Day passes" })).getByText("No discounts")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Summer intro" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /Off sale/ }));
  expect(screen.getByRole("heading", { name: "Summer intro" })).toBeTruthy();
});

test("one save updates the plan and its discounts with a single reason", async () => {
  render(<StaffPlans />);
  await userEvent.click(await screen.findByRole("button", { name: "Monthly" }));
  const form = screen.getByRole("form", { name: "Edit Monthly" });
  fireEvent.change(within(form).getByLabelText("Price (USD)"), { target: { value: "99.00" } });
  fireEvent.change(within(form).getByLabelText("Student price (USD)"), { target: { value: "70" } });
  await userEvent.type(within(form).getByLabelText("Reason for change"), "Fall pricing");
  await userEvent.click(within(form).getByRole("button", { name: "Save plan" }));
  await screen.findByText("Saved Monthly.");
  expect(writes()).toEqual([
    ["/admin/plans/1", expect.objectContaining({
      method: "PATCH",
      body: expect.objectContaining({ price: "99.00", months: 1, active: true, revision: 3, reason: "Fall pricing" }),
    })],
    ["/billing-management/pricing/1", {
      method: "PATCH",
      body: { studentCents: 7000, partnerFree: true, revision: 2, reason: "Fall pricing" },
    }],
  ]);
});

test("saving without changes sends nothing", async () => {
  render(<StaffPlans />);
  await userEvent.click(await screen.findByRole("button", { name: "Monthly" }));
  const form = screen.getByRole("form", { name: "Edit Monthly" });
  await userEvent.type(within(form).getByLabelText("Reason for change"), "No-op");
  await userEvent.click(within(form).getByRole("button", { name: "Save plan" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Nothing has changed.");
  expect(writes()).toEqual([]);
});

test("a discount failure after the plan saved keeps the editor open and says so", async () => {
  api.mockImplementation((path: string, options?: { method?: string }) => {
    if (path.startsWith("/billing-management/pricing/")) return Promise.reject(new Error("Refresh pricing before saving."));
    if (options?.method) return Promise.resolve({ ...monthly, price: "99.00", revision: 4 });
    if (path === "/admin/plans") return Promise.resolve([monthly, dayPass]);
    return Promise.resolve([]);
  });
  render(<StaffPlans />);
  await userEvent.click(await screen.findByRole("button", { name: "Monthly" }));
  const form = screen.getByRole("form", { name: "Edit Monthly" });
  fireEvent.change(within(form).getByLabelText("Price (USD)"), { target: { value: "99.00" } });
  fireEvent.change(within(form).getByLabelText("Student price (USD)"), { target: { value: "70" } });
  await userEvent.type(within(form).getByLabelText("Reason for change"), "Fall pricing");
  await userEvent.click(within(form).getByRole("button", { name: "Save plan" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(
      "Monthly was saved, but its discounts weren't: Refresh pricing before saving.",
    ),
  );
  expect(screen.getByRole("form", { name: "Edit Monthly" })).toBeTruthy();
});

test("staff manage plans without the admin-only discount controls", async () => {
  auth.user = { roles: ["staff"] };
  render(<StaffPlans />);
  await userEvent.click(await screen.findByRole("button", { name: "Monthly" }));
  expect(api.mock.calls.some(([path]) => path === "/billing-management/pricing")).toBe(false);
  expect(screen.queryByText("No discounts")).toBeNull();
  expect(screen.queryByLabelText("Student price (USD)")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("new plans pick their type with a toggle, and day passes have no length", async () => {
  render(<StaffPlans />);
  await userEvent.click(await screen.findByRole("button", { name: "New plan" }));
  const form = screen.getByRole("form", { name: "Create a plan" });
  expect(within(form).getByLabelText("Length (calendar months)")).toBeTruthy();
  await userEvent.click(within(form).getByRole("radio", { name: "Day pass" }));
  expect(within(form).queryByLabelText("Length (calendar months)")).toBeNull();
  expect(within(form).getByText("One calendar day")).toBeTruthy();
});
