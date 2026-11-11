// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChangeLog } from "./ChangeLog";
const { useApi } = vi.hoisted(() => ({ useApi: vi.fn() }));
vi.mock("../../lib/useApi", () => ({ useApi }));
vi.mock("../../components/MemberSelect", () => ({ MemberSelect: ({ name }: { name: string }) => <input name={name} /> }));
afterEach(cleanup);
test("offers all recorded actions even with no matching rows and submits exact selections", () => {
  useApi.mockReturnValue({ data: { items: [], nextOffset: null, actions: ["account_mode.closed", "account_mode.opened"] }, loading: false, error: "", reload: vi.fn() });
  render(<ChangeLog />);
  const action = screen.getByRole("combobox", { name: "Action" });
  expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["All actions", "account_mode.closed", "account_mode.opened"]);
  fireEvent.change(action, { target: { value: "account_mode.opened" } });
  fireEvent.click(screen.getByRole("button", { name: "Search changes" }));
  expect(useApi).toHaveBeenLastCalledWith("/admin/audit?offset=0&action=account_mode.opened");
  fireEvent.change(action, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Search changes" }));
  expect(useApi).toHaveBeenLastCalledWith("/admin/audit?offset=0");
});
