// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ReaderManager } from "./ReaderManager";
import type { ReaderDiscovery } from "./ReaderSetupWizard";
import type { ReaderSetup } from "../../lib/nfc";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), api }));
import { ApiError } from "../../lib/api";

const front = {
  id: "front", name: "Front door", kind: "building", resourceId: 1, resourceName: "Main building",
  enabled: true, online: true, revision: 2, lastSeenAt: "2026-10-01T12:00:00Z",
} satisfies ReaderSetup["readers"][number];
const setup = { configured: true, timeZone: "America/New_York", readers: [front] } satisfies ReaderSetup;
let discovery: ReaderDiscovery;
let save: (path: string, body: unknown) => Promise<unknown>;
beforeEach(() => {
  discovery = { configured: true, gateways: [{ id: "pi", name: "Orange Pi", online: true }], devices: [], jobs: [] };
  save = () => Promise.resolve({});
  api.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    if (options?.method) return save(path, options.body);
    if (path === "/admin/access/resources") return Promise.resolve([{ id: 1, kind: "building", name: "Main building" }]);
    if (path === "/admin/access/reader-setup") return Promise.resolve(structuredClone(discovery));
    return Promise.reject(new Error(`Unexpected endpoint: ${path}`));
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

async function openManualAdd() {
  fireEvent.click(screen.getByRole("button", { name: "Add reader" }));
  fireEvent.click(await screen.findByRole("button", { name: "Advanced manual setup" }));
  const dialog = screen.getByRole("dialog", { name: "Add reader" });
  await within(dialog).findByRole("option", { name: "Main building · building" });
  return dialog;
}
const field = (dialog: HTMLElement, label: string | RegExp) => within(dialog).getByLabelText(label) as HTMLInputElement;

test("a reader ID that is already taken keeps the Add reader form open, with what was typed", async () => {
  save = () => Promise.reject(new ApiError(409, "ALREADY_EXISTS", "A record with those details already exists."));
  const reload = vi.fn();
  render(<ReaderManager setup={setup} reload={reload} />);
  const dialog = await openManualAdd();
  fireEvent.change(field(dialog, "Reader name"), { target: { value: "Back door" } });
  fireEvent.change(field(dialog, /^Reader ID/), { target: { value: "front" } });
  fireEvent.change(within(dialog).getByLabelText("Reader location"), { target: { value: "building:1" } });
  fireEvent.change(field(dialog, "Reason for change"), { target: { value: "New entrance" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create reader" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "A reader with the ID “front” already exists. Choose a different reader ID.",
  );
  expect(screen.getByRole("dialog", { name: "Add reader" })).toBe(dialog);
  expect(field(dialog, "Reader name").value).toBe("Back door");
  expect(field(dialog, /^Reader ID/).value).toBe("front");
  expect(field(dialog, "Reason for change").value).toBe("New entrance");
});

test("only a stale edit closes the Manage reader form", async () => {
  const reload = vi.fn();
  save = () => Promise.reject(new ApiError(409, "SETUP_INCOMPLETE", "Finish guided setup before enabling this reader."));
  render(<ReaderManager setup={setup} reload={reload} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage Front door" }));
  let dialog = screen.getByRole("dialog", { name: "Manage reader" });
  fireEvent.change(field(dialog, "Reason for change"), { target: { value: "Turn it on" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save reader" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe("Finish guided setup before enabling this reader.");
  expect(field(dialog, "Reason for change").value).toBe("Turn it on");
  save = () => Promise.reject(new ApiError(409, "STALE_RECORD", "This reader changed. Refresh and try again."));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save reader" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Manage reader" })).toBeNull());
  expect(screen.getByRole("alert").textContent).toBe("This reader changed. Refresh and try again.");
  expect(reload).toHaveBeenCalledTimes(2);
  // Reopening starts from the latest settings.
  fireEvent.click(screen.getByRole("button", { name: "Manage Front door" }));
  dialog = screen.getByRole("dialog", { name: "Manage reader" });
  expect(field(dialog, "Reason for change").value).toBe("");
});

test("closing the setup dialog with the X refreshes the readers list", async () => {
  const reload = vi.fn();
  render(<ReaderManager setup={setup} reload={reload} />);
  fireEvent.click(screen.getByRole("button", { name: "Add reader" }));
  const dialog = await screen.findByRole("dialog", { name: "Add reader" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add reader" })).toBeNull());
  expect(reload).toHaveBeenCalledOnce();
});

test("a guided setup that finishes after the dialog closed brings its reader into the list", async () => {
  vi.useFakeTimers();
  const job = { id: "job", readerId: "back", deviceId: "usb", gatewayId: "pi", name: "Back door", status: "verifying", errorCode: null };
  discovery.jobs = [job];
  const reload = vi.fn();
  render(<ReaderManager setup={setup} reload={reload} />);
  await act(async () => {});
  // Polling alone, with nothing finished, leaves the list alone.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(api.mock.calls.filter(([path]) => path === "/admin/access/reader-setup").length).toBeGreaterThan(1);
  expect(reload).not.toHaveBeenCalled();
  discovery.jobs = [{ ...job, status: "complete" }];
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(reload).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(reload).toHaveBeenCalledOnce();
});
