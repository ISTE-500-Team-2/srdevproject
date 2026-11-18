// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccessReadiness } from "./AccessReadiness";
import { api, ApiError } from "../../lib/api";
import type { AccessReadinessResult } from "../../lib/accessReadiness";
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const readers: AccessReadinessResult["readers"] = [
  { id: "front", name: "Front door", kind: "building", resourceId: 1 },
  { id: "lathe", name: "Lathe", kind: "equipment", resourceId: 4 },
];
const result = (readerId: string, list = readers) =>
  ({
    userId: 12,
    readerId,
    readers: list,
    allowed: false,
    reason: "WAIVER_REQUIRED",
    cardAssigned: true,
    checkedAt: new Date().toISOString(),
    expiresAt: null,
  }) satisfies AccessReadinessResult;
const picker = () => screen.getByRole("combobox", { name: "Check access at" }) as HTMLSelectElement;

test("the reader picker stays in place while another reader is checked", async () => {
  let finish!: (value: AccessReadinessResult) => void;
  vi.mocked(api).mockImplementation(((path: string) =>
    path.endsWith("?readerId=lathe")
      ? new Promise<AccessReadinessResult>((resolve) => { finish = resolve; })
      : Promise.resolve(result("front"))) as typeof api);
  await act(async () => { render(<AccessReadiness userId={12} />); });
  const select = picker();
  select.focus();
  await act(async () => { fireEvent.change(select, { target: { value: "lathe" } }); });
  expect(api).toHaveBeenLastCalledWith("/admin/users/12/access-readiness?readerId=lathe", expect.anything());
  // Still the same control, still focused, showing the reader being checked.
  expect(picker()).toBe(select);
  expect(document.activeElement).toBe(select);
  expect(select.value).toBe("lathe");
  await act(async () => { finish(result("lathe")); });
  expect(screen.getByText("Required waivers have not been signed or have expired.")).toBeTruthy();
});

test("a chosen reader that is no longer available falls back to the default reader", async () => {
  let latheGone = false;
  vi.mocked(api).mockImplementation(((path: string) => {
    if (path.endsWith("?readerId=lathe"))
      return latheGone
        ? Promise.reject(new ApiError(404, "READER_NOT_FOUND", "Reader not found."))
        : Promise.resolve(result("lathe"));
    return Promise.resolve(result("front", latheGone ? readers.slice(0, 1) : readers));
  }) as typeof api);
  await act(async () => { render(<AccessReadiness userId={12} />); });
  await act(async () => { fireEvent.change(picker(), { target: { value: "lathe" } }); });
  // Another admin turns the lathe reader off, then staff refresh the check.
  latheGone = true;
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh access check" })); });
  await waitFor(() => expect(api).toHaveBeenLastCalledWith("/admin/users/12/access-readiness", expect.anything()));
  expect(await screen.findByText(/The reader you chose is no longer available/)).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(picker().value).toBe("front");
  expect(screen.queryByRole("option", { name: /Lathe/ })).toBeNull();
  expect(screen.getByText("Blocked")).toBeTruthy();
});
