// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FamilyAccess } from "./FamilyAccess";
import type { SupervisionSummary } from "../../lib/contracts";

const { api, reload, state } = vi.hoisted(() => ({
  api: vi.fn(),
  reload: vi.fn(),
  state: { data: null as unknown as SupervisionSummary },
}));
vi.mock("../../lib/api", () => ({ api, errorMessage: (e: Error) => e.message }));
vi.mock("../../lib/useApi", () => ({
  // The real MemberSelect searches through useApi; answer it with one adult.
  useApi: (path: string | null) =>
    path?.startsWith("/training/members")
      ? { data: { items: [{ id: 8, name: "James Lin", email: "james@example.com" }], hasMore: false }, loading: false, error: "", reload }
      : path === null
        ? { data: null, loading: false, error: "", reload }
        : { data: state.data, loading: false, error: "", reload },
}));

const base = (): SupervisionSummary => ({
  isMinor: true,
  marker: "Under 18",
  sponsor: { id: 5, name: "Dana Reyes", revision: 3 },
  visit: null,
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const panel = () => screen.getByRole("region", { name: "Visit & supervision" });

test("heading pills and facts say what is true now", () => {
  state.data = { ...base(), visit: { id: 1, buildingId: 1, buildingName: "Main shop", checkedInAt: "2026-11-02T19:14:00Z", sponsorId: 5 } };
  render(<FamilyAccess userId={42} memberName="Emma Lin" />);
  const region = panel();
  expect(within(region).getByText("Under 18").className).toContain("status-pill--warn");
  expect(within(region).getByText("Checked in").className).toContain("status-pill--ok");
  expect(within(region).getByText("Main shop")).toBeTruthy();
  expect(within(region).getByText(/^Since /)).toBeTruthy();
  expect(within(region).getByText("Dana Reyes")).toBeTruthy();
  expect(within(region).getByText("Dana must stay checked in while Emma is here. Checking Dana out ends Emma’s visit too.")).toBeTruthy();
});

test("checked out: the sponsor picker is open up front with the current adult chosen", async () => {
  state.data = base();
  api.mockResolvedValue({});
  render(<FamilyAccess userId={42} memberName="Emma Lin" />);
  const form = screen.getByRole("form", { name: "Sponsoring adult" });
  expect((form.closest("details") as HTMLDetailsElement).open).toBe(true);
  // MemberSelect's chosen state with its Change button, no search box yet.
  const chosen = within(form).getByRole("group", { name: "Adult account" });
  expect(within(chosen).getByText("Dana Reyes")).toBeTruthy();
  const save = within(form).getByRole("button", { name: "Save sponsoring adult" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.click(within(form).getByRole("button", { name: "Change adult account" }));
  fireEvent.change(within(form).getByRole("combobox"), { target: { value: "Ja" } });
  fireEvent.mouseDown(await within(form).findByRole("option", { name: /James Lin/ }));
  expect(within(form).getByText("James Lin")).toBeTruthy();
  const consent = within(form).getByRole("checkbox", { name: /verified in person/ }) as HTMLInputElement;
  expect(consent.required).toBe(true);
  expect(consent.closest("label")?.className).toBe("management-checkbox");
  fireEvent.click(consent);
  fireEvent.change(within(form).getByLabelText("Reason for change"), { target: { value: "Parent swap, ID verified at desk" } });
  expect(save.disabled).toBe(false);
  fireEvent.submit(form);
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/admin/users/42/supervision", {
      method: "POST",
      body: { adultId: 8, revision: 3, consent: true, reason: "Parent swap, ID verified at desk" },
    }),
  );
  expect(reload).toHaveBeenCalled();
  // Visit actions stay secondary and collapsed until opened.
  const checkIn = screen.getByRole("form", { name: "Start facility visit" }).closest("details") as HTMLDetailsElement;
  expect(checkIn.open).toBe(false);
});

test("checked in: checkout is open with its reason, sponsor change is locked", async () => {
  state.data = { ...base(), visit: { id: 1, buildingId: 1, buildingName: "Main shop", checkedInAt: "2026-11-02T19:14:00Z", sponsorId: 5 } };
  api.mockResolvedValue({});
  render(<FamilyAccess userId={42} memberName="Emma Lin" />);
  expect(screen.queryByRole("form", { name: "Sponsoring adult" })).toBeNull();
  expect(screen.getByText("Check out first")).toBeTruthy();
  const out = screen.getByRole("form", { name: "End facility visit" });
  expect((out.closest("details") as HTMLDetailsElement).open).toBe(true);
  fireEvent.change(within(out).getByLabelText("Reason for change"), { target: { value: "Left with sponsor" } });
  fireEvent.submit(out);
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/admin/users/42/supervision/check-out", { method: "POST", body: { reason: "Left with sponsor" } }),
  );
});

test("a minor with no sponsor can be linked but not checked in yet", () => {
  state.data = { ...base(), sponsor: null };
  render(<FamilyAccess userId={42} />);
  expect(screen.getByText("Not linked")).toBeTruthy();
  expect(screen.getByText("Link sponsoring adult")).toBeTruthy();
  expect(screen.getByRole("combobox")).toBeTruthy();
  const checkIn = screen.getByRole("form", { name: "Start facility visit" });
  expect((within(checkIn).getByRole("button", { name: "Check in" }) as HTMLButtonElement).disabled).toBe(true);
});

test("adult accounts only see the visit and the cascade note", () => {
  state.data = { isMinor: false, marker: null, sponsor: null, visit: null };
  render(<FamilyAccess userId={7} />);
  expect(screen.queryByText("Under 18")).toBeNull();
  expect(screen.queryByRole("form", { name: "Sponsoring adult" })).toBeNull();
  expect(screen.getByText("Checking this adult out also ends visits for any minors they supervise.")).toBeTruthy();
});

test("protected staff targets disable both sponsor and visit mutations", () => {
  state.data = base();
  render(<FamilyAccess userId={42} disabled />);
  for (const name of ["Save sponsoring adult", "Check in"])
    expect((screen.getByRole("button", { name }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
  fireEvent.submit(screen.getByRole("form", { name: "Start facility visit" }));
  expect(api).not.toHaveBeenCalled();
});
