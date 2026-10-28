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

test("failed discounts retain their draft and retry only pricing with its refreshed revision", async () => {
  let persisted = monthly;
  let attempts = 0;
  api.mockImplementation((path: string, options?: { method?: string }) => {
    if (path === "/admin/plans/1" && options?.method === "PATCH") {
      persisted = { ...monthly, name: "Monthly revised", price: "99.00", revision: 4 };
      return Promise.resolve(persisted);
    }
    if (path === "/billing-management/pricing/1") {
      attempts++;
      return attempts < 3 ? Promise.reject(new Error(attempts === 1 ? "Refresh pricing before saving." : "Refresh pricing again.")) : Promise.resolve({});
    }
    if (path === "/admin/plans") return Promise.resolve([persisted, dayPass]);
    if (path === "/billing-management/pricing") return Promise.resolve([{ tierid: 1, student_cents: 6500, partner_free: true, revision: attempts + 2 }]);
    return Promise.resolve([]);
  });
  render(<StaffPlans />);
  await userEvent.click(await screen.findByRole("button", { name: "Monthly" }));
  const form = screen.getByRole("form", { name: "Edit Monthly" });
  fireEvent.change(within(form).getByLabelText("Plan name"), { target: { value: "Monthly revised" } });
  fireEvent.change(within(form).getByLabelText("Price (USD)"), { target: { value: "99.00" } });
  fireEvent.change(within(form).getByLabelText("Student price (USD)"), { target: { value: "70" } });
  await userEvent.type(within(form).getByLabelText("Reason for change"), "Fall pricing");
  await userEvent.click(within(form).getByRole("button", { name: "Save plan" }));
  await screen.findByText("Monthly revised was saved, but its discounts weren't: Refresh pricing before saving.");
  await waitFor(() => expect(api.mock.calls.filter(([path]) => path === "/billing-management/pricing")).toHaveLength(2));
  const reloaded = await screen.findByRole("form", { name: "Edit Monthly revised" });
  expect((within(reloaded).getByLabelText("Student price (USD)") as HTMLInputElement).value).toBe("70");
  expect((within(reloaded).getByLabelText("Reason for change") as HTMLInputElement).value).toBe("Fall pricing");
  await userEvent.click(within(reloaded).getByRole("button", { name: "Save plan" }));
  await screen.findByText("Refresh pricing again.");
  await waitFor(() => expect(api.mock.calls.filter(([path]) => path === "/billing-management/pricing")).toHaveLength(3));
  expect((within(reloaded).getByLabelText("Student price (USD)") as HTMLInputElement).value).toBe("70");
  await userEvent.click(within(reloaded).getByRole("button", { name: "Save plan" }));
  await screen.findByText("Saved Monthly revised.");
  expect(writes().filter(([path]) => path === "/admin/plans/1")).toHaveLength(1);
  expect(writes().filter(([path]) => path === "/billing-management/pricing/1")).toHaveLength(3);
  expect(writes().at(-1)).toEqual(["/billing-management/pricing/1", {
    method: "PATCH", body: { studentCents: 7000, partnerFree: true, revision: 4, reason: "Fall pricing" },
  }]);
});

test("a new plan is not created twice when its discount save is retried", async () => {
  const created = { ...monthly, id: 9, name: "New membership", price: "80.00", benefits: "", revision: 0 };
  let attempts = 0;
  api.mockImplementation((path: string, options?: { method?: string }) => {
    if (path === "/admin/plans" && options?.method === "POST") return Promise.resolve(created);
    if (path === "/billing-management/pricing/9") {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error("Temporary pricing failure")) : Promise.resolve({});
    }
    if (path === "/admin/plans") return Promise.resolve([monthly, dayPass]);
    if (path === "/billing-management/pricing") return Promise.resolve(attempts ? [{ tierid: 9, student_cents: 6000, partner_free: false, revision: 3 }] : []);
    return Promise.resolve([]);
  });
  render(<StaffPlans />);
  await userEvent.click(await screen.findByRole("button", { name: "New plan" }));
  const form = screen.getByRole("form", { name: "Create a plan" });
  fireEvent.change(within(form).getByLabelText("Plan name"), { target: { value: created.name } });
  fireEvent.change(within(form).getByLabelText("Price (USD)"), { target: { value: created.price } });
  fireEvent.change(within(form).getByLabelText("Student price (USD)"), { target: { value: "50" } });
  await userEvent.click(within(form).getByLabelText("Free for verified school partners"));
  await userEvent.type(within(form).getByLabelText("Reason for change"), "New offer");
  await userEvent.click(within(form).getByRole("button", { name: "Create plan" }));
  await screen.findByText("New membership was saved, but its discounts weren't: Temporary pricing failure");
  await waitFor(() => expect(api.mock.calls.filter(([path]) => path === "/billing-management/pricing")).toHaveLength(2));
  const retry = await screen.findByRole("form", { name: "Edit New membership" });
  expect((within(retry).getByLabelText("Student price (USD)") as HTMLInputElement).value).toBe("50");
  expect((within(retry).getByLabelText("Free for verified school partners") as HTMLInputElement).checked).toBe(true);
  await userEvent.click(within(retry).getByRole("button", { name: "Save plan" }));
  await screen.findByText("Saved New membership.");
  expect(writes().filter(([path, options]) => path === "/admin/plans" && options.method === "POST")).toHaveLength(1);
  expect(writes().filter(([path]) => path === "/billing-management/pricing/9")).toHaveLength(2);
  expect(writes().filter(([path]) => path === "/admin/plans/9")).toHaveLength(0);
  expect(writes().at(-1)).toEqual(["/billing-management/pricing/9", {
    method: "PATCH", body: { studentCents: 5000, partnerFree: true, revision: 3, reason: "New offer" },
  }]);
});
