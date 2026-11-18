// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RecordDialogHost, type DialogState } from "./RecordDialogs";
import type { Payment, Person } from "../../../lib/staffContracts";
import type { ReaderSetup } from "../../../lib/nfc";

const { api, useApi } = vi.hoisted(() => ({ api: vi.fn(), useApi: vi.fn() }));
vi.mock("../../../lib/api", async (original) => ({ ...(await original<typeof import("../../../lib/api")>()), api }));
vi.mock("../../../lib/useApi", () => ({ useApi }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const payment: Payment = {
  id: 7, userId: 3, memberName: "Ada Lovelace", membershipId: 2, dayPassId: null, amount: "50.00", status: "paid",
  method: "card", reference: "", revision: 1, recordedAt: "2026-11-01T12:00:00Z", updatedAt: "2026-11-01T12:00:00Z",
  planName: "Monthly", invoiceId: "in_test", refundStatus: null,
};

function host(dialog: DialogState, onClose = vi.fn()) {
  render(
    <RecordDialogHost
      dialog={dialog}
      person={{ id: 3, firstName: "Ada", lastName: "Lovelace", revision: 1 } as Person}
      plans={[]}
      timeZone="America/New_York"
      supervision={null}
      onClose={onClose}
      onDone={vi.fn()}
      onPerson={vi.fn()}
      onConflict={vi.fn()}
    />,
  );
  return onClose;
}

/** Selectors of the rules that drop the page form's top margin, padding and rule inside a dialog. */
function dialogFormResets() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const css = ["../../../management.css", "memberRecord.css"]
    .map((file) => readFileSync(path.join(here, file), "utf8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => ["margin-top", "padding-top", "border-top"].every((p) => new RegExp(`${p}:\\s*0\\s*(;|$)`).test(body)))
    .flatMap(([, selectors]) => selectors.split(",").map((s) => s.trim()));
}

test.each([
  ["payment", "Payment #7"],
  ["refund", "Refund $50.00"],
] as const)("the %s dialog's form keeps the dialog form reset, with no page-form band on top", (kind, title) => {
  useApi.mockReturnValue({ data: null, loading: false, refreshing: false, error: "", reload: vi.fn() });
  host({ kind, payment });
  const form = screen.getByRole("dialog", { name: title }).querySelector("form.management-form")!;
  const resets = dialogFormResets();
  expect(resets.length).toBeGreaterThan(0);
  expect(resets.some((selector) => form.matches(selector))).toBe(true);
});

test("a card captured with the default reader asks before a stray click throws the scan away", async () => {
  const setup: ReaderSetup = {
    configured: true,
    timeZone: "America/New_York",
    readers: [{ id: "front", name: "Front door", kind: "building", resourceId: 1, resourceName: "Building", enabled: true, online: true, lastSeenAt: null, revision: 1 }],
  };
  useApi.mockReturnValue({ data: setup, loading: false, refreshing: false, error: "", reload: vi.fn() });
  api.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/admin/access/enrollments"
        ? { id: "scan-1", readerId: "front", userId: 3, purpose: "assign", status: "captured", last4: "1A2B", assignments: [], expiresAt: new Date(Date.now() + 60_000).toISOString() }
        : {},
    ),
  );
  const onClose = host({ kind: "assign" });
  const backdrop = screen.getByRole("dialog", { name: "Assign an NFC card" }).parentElement!;
  // Nothing to lose yet: a stray click just closes.
  fireEvent.mouseDown(backdrop);
  expect(onClose).toHaveBeenCalledTimes(1);

  // Staff keep the default reader, so no change event fires, and tap a card.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Start card scan" }));
  });
  expect(screen.getByText("Card captured · ending 1A2B").getAttribute("role")).toBe("status");
  fireEvent.mouseDown(backdrop);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByText("Card captured · ending 1A2B")).toBeTruthy();
});
