// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { StudiosPage } from "./StudiosPage";
import type { Studio } from "../lib/studioContracts";

const { api, auth } = vi.hoisted(() => ({
  api: vi.fn(),
  auth: { user: { roles: ["member"], membership: "Monthly" } as unknown },
}));
vi.mock("../context/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: Error) => error.message,
}));

const studio = (id: number, name: string, availability: Studio["availability"] = []): Studio => ({
  id,
  name,
  size: "small",
  monthly_cents: 35000,
  cancellation_policy: "full_before_start",
  policy_confirmed: true,
  revision: 1,
  availability,
});
let studios: Studio[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-10T15:00:00Z"));
  studios = [studio(1, "Harkonnen"), studio(2, "Atreides")];
  api.mockImplementation((path: string) => {
    if (path === "/studios")
      return Promise.resolve({ studios, cardTestEnabled: false, timeZone: "UTC" });
    return Promise.resolve([]);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  auth.user = { roles: ["member"], membership: "Monthly" };
});

function mount() {
  return render(
    <MemoryRouter>
      <StudiosPage />
    </MemoryRouter>,
  );
}
async function openSmall() {
  fireEvent.click(await screen.findByRole("button", { name: /^Small studios/ }));
  return screen.getByRole("dialog", { name: "Reserve a small studio" });
}
const calls = (path: string) =>
  api.mock.calls.filter(([p]) => p === path).length;

test("the member page never loads the staff studio desk", async () => {
  auth.user = { roles: ["staff"], membership: "None" };
  mount();
  await screen.findByRole("button", { name: /^Small studios/ });
  expect(calls("/studio-management/rentals")).toBe(0);
  expect(screen.queryByRole("heading", { name: /Studio desk|Payments to record/ })).toBeNull();
});

test("a changed booking gets a new request key; an identical retry reuses it", async () => {
  mount();
  const dialog = await openSmall();
  const keys: string[] = [];
  api.mockImplementation((path: string, init?: { body?: { requestKey: string } }) => {
    if (path === "/studio-rentals" && init?.body) {
      keys.push(init.body.requestKey);
      return Promise.reject(new Error("Network error"));
    }
    if (path === "/studios")
      return Promise.resolve({ studios, cardTestEnabled: false, timeZone: "UTC" });
    return Promise.resolve([]);
  });
  const hold = within(dialog).getByRole("button", { name: "Hold studio" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Sun, Jan 20, 2030" }));
  fireEvent.click(hold);
  await within(dialog).findByText("Network error");
  fireEvent.click(hold);
  await waitFor(() => expect(keys).toHaveLength(2));
  fireEvent.click(within(dialog).getByRole("button", { name: "Mon, Jan 21, 2030" }));
  fireEvent.click(hold);
  await waitFor(() => expect(keys).toHaveLength(3));
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
});

test("a studio taken while the pop-up is open can't be submitted", async () => {
  mount();
  const dialog = await openSmall();
  fireEvent.click(within(dialog).getByRole("button", { name: "Sun, Jan 20, 2030" }));
  const hold = within(dialog).getByRole("button", { name: "Hold studio" });
  expect((hold as HTMLButtonElement).disabled).toBe(false);
  // Someone else books Harkonnen; the next background refresh picks it up.
  studios = [
    studio(1, "Harkonnen", [
      { starts_on: "2030-01-15", ends_on: "2030-02-15", status: "confirmed", hold_until: "" },
    ]),
    studio(2, "Atreides"),
  ];
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await within(dialog).findByText(
    "Harkonnen was just taken for these dates. Pick another studio.",
  );
  expect((hold as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole("radio", { name: /Atreides/ }));
  expect((hold as HTMLButtonElement).disabled).toBe(false);
});
