// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { forgetRecentAccounts, recentAccounts, rememberAccount } from "./recentAccounts";
import * as people from "../components/admin/people";

const key = "collaboratory.recentAccounts";
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("remembers the five most recent accounts, newest first, names only", () => {
  for (let id = 1; id <= 6; id++) rememberAccount({ id, firstName: `First${id}`, lastName: `Last${id}` });
  rememberAccount({ id: 3, firstName: "First3", lastName: "Last3", email: "x@example.test" } as never);
  expect(recentAccounts().map((account) => account.id)).toEqual([3, 6, 5, 4, 2]);
  expect(JSON.parse(localStorage.getItem(key)!)[0]).toEqual({ id: 3, firstName: "First3", lastName: "Last3" });
  forgetRecentAccounts();
  expect(localStorage.getItem(key)).toBeNull();
});

test("a storage failure never throws from remembering or forgetting", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
  expect(() => rememberAccount({ id: 1, firstName: "Dana", lastName: "Tester" })).not.toThrow();
  expect(() => forgetRecentAccounts()).not.toThrow();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
  expect(recentAccounts()).toEqual([]);
});

test("the admin people module still re-exports the storage helpers", () => {
  expect(people.rememberAccount).toBe(rememberAccount);
  expect(people.recentAccounts).toBe(recentAccounts);
  expect(people.forgetRecentAccounts).toBe(forgetRecentAccounts);
});
