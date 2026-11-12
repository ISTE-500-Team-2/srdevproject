// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChangeLog } from "./ChangeLog";
const { useApi } = vi.hoisted(() => ({ useApi: vi.fn() }));
vi.mock("../../lib/useApi", () => ({ useApi }));
vi.mock("../../components/MemberSelect", () => ({ MemberSelect: ({ name }: { name: string }) => <input name={name} /> }));
afterEach(cleanup);
const pages = () => useApi.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/admin/audit?"));
test("offers all recorded actions even with no matching rows and submits exact selections", () => {
  // The filtered page reloads (data briefly null) while the action list stays loaded.
  useApi.mockImplementation((path: string) => path === "/admin/audit/actions"
    ? { data: ["account_mode.closed", "account_mode.opened"], loading: false, error: "", reload: vi.fn() }
    : { data: path.includes("action=") ? null : { items: [], nextOffset: null }, loading: path.includes("action="), error: "", reload: vi.fn() });
  render(<ChangeLog />);
  const action = screen.getByRole("combobox", { name: "Action" }) as HTMLSelectElement;
  expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["All actions", "account_mode.closed", "account_mode.opened"]);
  fireEvent.change(action, { target: { value: "account_mode.opened" } });
  fireEvent.click(screen.getByRole("button", { name: "Search changes" }));
  expect(pages().at(-1)).toBe("/admin/audit?offset=0&action=account_mode.opened");
  expect(action.value).toBe("account_mode.opened");
  fireEvent.change(action, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Search changes" }));
  expect(pages().at(-1)).toBe("/admin/audit?offset=0");
});
