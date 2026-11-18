// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AccessReader } from "../../lib/nfc";
import { ReaderManager } from "./ReaderManager";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api")>()),
  api,
}));

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
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

async function manage() {
  render(
    <ReaderManager
      setup={{ configured: true, timeZone: "America/New_York", readers: [reader] }}
      reload={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Manage Front door" }));
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
