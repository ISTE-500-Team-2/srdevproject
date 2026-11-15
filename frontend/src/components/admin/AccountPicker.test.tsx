// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AccountPicker } from "./AccountPicker";

const { openAccount } = vi.hoisted(() => ({ openAccount: vi.fn() }));
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, firstName: "Sam", lastName: "Staff", roles: ["staff"] }, actor: null, openAccount }),
}));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("collaboratory.recentAccounts", JSON.stringify([{ id: 7, firstName: "Dana", lastName: "Tester" }]));
  openAccount.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mount = (onClose: () => void) =>
  render(
    <MemoryRouter initialEntries={["/start"]}>
      <Routes>
        <Route path="/start" element={<AccountPicker onClose={onClose} destination="/account" />} />
        <Route path="/account" element={<p>Their account</p>} />
      </Routes>
    </MemoryRouter>,
  );

test("an opened account is still closed over and navigated to when storage cannot be written", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
  const onClose = vi.fn();
  mount(onClose);
  fireEvent.click(screen.getByRole("button", { name: /Dana Tester/ }));
  expect(await screen.findByText("Their account")).toBeTruthy();
  expect(openAccount).toHaveBeenCalledWith(7);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("an opened account is remembered when storage works", async () => {
  const onClose = vi.fn();
  mount(onClose);
  fireEvent.click(screen.getByRole("button", { name: /Dana Tester/ }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(JSON.parse(localStorage.getItem("collaboratory.recentAccounts")!)).toEqual([{ id: 7, firstName: "Dana", lastName: "Tester" }]);
});

test("a failed switch still shows its error and stays open", async () => {
  openAccount.mockRejectedValue(new Error("Account mode failed"));
  const onClose = vi.fn();
  mount(onClose);
  fireEvent.click(screen.getByRole("button", { name: /Dana Tester/ }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByText("Their account")).toBeNull();
});
