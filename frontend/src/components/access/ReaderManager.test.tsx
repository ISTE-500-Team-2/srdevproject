// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render as renderInto, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { ReaderManager } from "./ReaderManager";
import type { ReaderDiscovery } from "./ReaderSetupWizard";
import type { AccessReader, ReaderSetup } from "../../lib/nfc";

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
// The live health board is not mocked here, so Manage is reached from the plain reader list
// shown when health is unavailable.
const render = (ui: ReactElement) => renderInto(<MemoryRouter>{ui}</MemoryRouter>);
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
  fireEvent.click(await screen.findByRole("button", { name: "Manage Front door" }));
  let dialog = screen.getByRole("dialog", { name: "Manage reader" });
  fireEvent.change(field(dialog, "Reason for change"), { target: { value: "Turn it on" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save reader" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe("Finish guided setup before enabling this reader.");
  expect(field(dialog, "Reason for change").value).toBe("Turn it on");
  save = () => Promise.reject(new ApiError(409, "STALE_RECORD", "This reader changed. Refresh and try again."));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save reader" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Manage reader" })).toBeNull());
  expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toContain("This reader changed. Refresh and try again.");
  expect(reload).toHaveBeenCalledTimes(2);
  // Reopening starts from the latest settings.
  fireEvent.click(await screen.findByRole("button", { name: "Manage Front door" }));
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

// Moving a reader from Manage, with a device still plugged into the Pi after its setup.
describe("moving a reader", () => {
  const reader: AccessReader = {
    id: "reader-1",
    name: "Front door",
    kind: "building",
    resourceId: 1,
    resourceName: "Collaboratory",
    enabled: true,
    online: true,
    lastSeenAt: null,
    revision: 4,
  };
  beforeEach(() => {
    api.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === "/admin/access/resources")
        return Promise.resolve([
          { id: 1, kind: "building", name: "Collaboratory" },
          { id: 3, kind: "room", name: "Wood shop" },
        ]);
      if (path === "/admin/access/reader-setup")
        return Promise.resolve({
          configured: true,
          gateways: [{ id: "pi", name: "Orange Pi", online: true }],
          // Still plugged into the Pi after setup: not a new reader.
          devices: [
            {
              id: "usb-device",
              gatewayId: "pi",
              model: "ESP32-C3 mini",
              firmware: "1.7.1-c3-checkin",
              transport: "usb",
              connected: true,
              readerName: "Front door",
            },
          ],
          jobs: [],
        });
      if (options?.method === "PATCH") return Promise.resolve({});
      return Promise.reject(new Error(`Unexpected endpoint: ${path}`));
    });
  });

  async function manage() {
    render(
      <ReaderManager
        setup={{ configured: true, timeZone: "America/New_York", readers: [reader] }}
        reload={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Manage Front door" }));
    const dialog = screen.getByRole("dialog", { name: "Manage reader" });
    await within(dialog).findByRole("option", { name: "Wood shop · room" });
    fireEvent.change(within(dialog).getByLabelText("Reason for change"), {
      target: { value: "Reader change" },
    });
    return dialog;
  }
  const patches = () =>
    api.mock.calls.filter(([, options]) => options?.method === "PATCH");

  test("a reader can be moved to another location from Manage", async () => {
    const dialog = await manage();
    const location = within(dialog).getByLabelText("Reader location") as HTMLSelectElement;
    expect(location.value).toBe("building:1");
    fireEvent.change(location, { target: { value: "room:3" } });
    fireEvent.submit(location.closest("form")!);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual([
      "/admin/access/readers/reader-1",
      {
        method: "PATCH",
        body: {
          name: "Front door",
          enabled: true,
          kind: "room",
          resourceId: 3,
          expectedRevision: 4,
          reason: "Reader change",
        },
      },
    ]);
    // A device that already finished setup is not announced as a new reader.
    expect(screen.queryByText(/new reader is connected/i)).toBeNull();
  });

  test("renaming a reader leaves its location out of the change", async () => {
    const dialog = await manage();
    fireEvent.change(within(dialog).getByLabelText("Reader name"), {
      target: { value: "Main entrance" },
    });
    fireEvent.submit(within(dialog).getByLabelText("Reader name").closest("form")!);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]![1].body).toEqual({
      name: "Main entrance",
      enabled: true,
      expectedRevision: 4,
      reason: "Reader change",
    });
  });
});
