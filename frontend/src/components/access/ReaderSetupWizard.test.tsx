// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ReaderSetupWizard, type ReaderDiscovery } from "./ReaderSetupWizard";
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../lib/api", () => ({
  api,
  errorMessage: (e: Error) => e.message,
}));
let data: ReaderDiscovery;
beforeEach(() => {
  data = {
    configured: true,
    gateways: [{ id: "pi", name: "Orange Pi", online: true }],
    devices: [
      {
        id: "usb-device",
        gatewayId: "pi",
        model: "ESP32-C3 mini",
        firmware: "1.7.1-c3-checkin",
        transport: "usb",
        connected: true,
      },
    ],
    jobs: [],
  };
  api.mockImplementation((path: string, options?: { method?: string }) => {
    if (path === "/admin/access/resources")
      return Promise.resolve([{ id: 3, kind: "equipment", name: "Rachel" }]);
    if (options?.method === "POST" && path === "/admin/access/reader-setup") {
      data.jobs = [
        {
          id: "job",
          readerId: "auto-reader",
          deviceId: "usb-device",
          gatewayId: "pi",
          name: "Mini reader",
          status: "verifying",
          errorCode: null,
        },
      ];
      return Promise.resolve({ id: "job" });
    }
    if (path.endsWith("/cancel")) {
      data.jobs[0]!.status = "cancelled";
      return Promise.resolve({ cancelled: true });
    }
    return Promise.resolve(structuredClone(data));
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});
const mount = () =>
  render(
    <ReaderSetupWizard
      open
      onClose={vi.fn()}
      onDone={vi.fn()}
      onManual={vi.fn()}
    />,
  );
async function choose() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Set up ESP32-C3 mini" }),
  );
}
function details() {
  fireEvent.change(screen.getByLabelText("Reader name"), {
    target: { value: "Mini reader" },
  });
  fireEvent.change(screen.getByLabelText("Reader location"), {
    target: { value: "equipment:3" },
  });
  fireEvent.change(screen.getByLabelText("Wi-Fi network"), {
    target: { value: "Workshop" },
  });
  fireEvent.change(screen.getByLabelText(/Wi-Fi password/), {
    target: { value: "private-preview-password" },
  });
  fireEvent.change(screen.getByLabelText("Reason for change"), {
    target: { value: "Install additional reader" },
  });
}
test("detected reader replaces manual ID/secret entry and keeps network advertisements USB-bound", async () => {
  mount();
  await choose();
  expect(screen.queryByLabelText("Reader ID")).toBeNull();
  expect(screen.queryByLabelText("Reader secret")).toBeNull();
  expect(screen.getByLabelText("Reader location")).toBeTruthy();
  cleanup();
  data.devices[0]!.transport = "network";
  mount();
  await choose();
  expect(
    (
      screen.getByRole("button", {
        name: "Connect reader",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText(/Connect this reader to the Pi by USB/)).toBeTruthy();
});
test("offline/uninstalled discovery states are honest, not simulated scanning or connected status", async () => {
  data.configured = false;
  data.gateways = [];
  data.devices = [];
  mount();
  expect(
    await screen.findByText(/Reader discovery is not installed/),
  ).toBeTruthy();
  expect(screen.queryByText("Detected")).toBeNull();
  cleanup();
  data.configured = true;
  data.gateways = [{ id: "pi", name: "Orange Pi", online: false }];
  mount();
  expect(await screen.findByText(/Waiting for the Pi/)).toBeTruthy();
});
test("posts one admin-approved job, clears the password and waits for authoritative completion", async () => {
  mount();
  await choose();
  details();
  fireEvent.submit(
    screen.getByRole("button", { name: "Connect reader" }).closest("form")!,
  );
  expect(
    await screen.findByRole("heading", {
      name: "Checking the reader and server",
    }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "Reader connected" }),
  ).toBeNull();
  expect(screen.queryByDisplayValue("private-preview-password")).toBeNull();
  const call = api.mock.calls.find(
    ([path, options]) =>
      path === "/admin/access/reader-setup" && options?.method === "POST",
  );
  expect(call?.[1].body).toEqual({
    gatewayId: "pi",
    deviceId: "usb-device",
    name: "Mini reader",
    kind: "equipment",
    resourceId: 3,
    ssid: "Workshop",
    password: "private-preview-password",
    reuseWifi: false,
    reason: "Install additional reader",
  });
  data.jobs[0]!.status = "complete";
  expect(
    await screen.findByRole(
      "heading",
      { name: "Reader connected" },
      { timeout: 3500 },
    ),
  ).toBeTruthy();
  expect(screen.getByText(/Next, tap a card/)).toBeTruthy();
});
test("double submit/Enter cannot enqueue a second registration; errors preserve the form", async () => {
  let reject!: (e: Error) => void;
  const original = api.getMockImplementation()!;
  api.mockImplementation((path: string, options?: { method?: string }) =>
    path === "/admin/access/reader-setup" && options?.method === "POST"
      ? new Promise((_resolve, r) => {
          reject = r;
        })
      : original(path, options),
  );
  mount();
  await choose();
  details();
  const form = screen
    .getByRole("button", { name: "Connect reader" })
    .closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(
    api.mock.calls.filter(
      ([p, o]) => p === "/admin/access/reader-setup" && o?.method === "POST",
    ),
  ).toHaveLength(1);
  await act(async () =>
    reject(
      new Error("Reader disconnected. Reconnect it to the Pi and try again."),
    ),
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect((screen.getByLabelText("Reader name") as HTMLInputElement).value).toBe(
    "Mini reader",
  );
});
test("cancel is explicit and a failed setup never displays a connected success", async () => {
  data.jobs = [
    {
      id: "job",
      readerId: "auto-reader",
      deviceId: "usb-device",
      gatewayId: "pi",
      name: "Mini reader",
      status: "connecting",
      errorCode: null,
    },
  ];
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Continue setup: Mini reader" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel setup" }));
  expect(
    await screen.findByRole("heading", { name: "Setup cancelled" }),
  ).toBeTruthy();
  expect(
    api.mock.calls.some(
      ([p, o]) =>
        p === "/admin/access/reader-setup/job/cancel" && o?.method === "POST",
    ),
  ).toBe(true);
  expect(
    screen.queryByRole("heading", { name: "Reader connected" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    await screen.findByRole("button", { name: "Set up ESP32-C3 mini" }),
  ).toBeTruthy();
});
test("discovery refresh preserves an edited form and stale disconnected reports cannot enable network setup", async () => {
  mount();
  await choose();
  details();
  await waitFor(
    () =>
      expect(
        api.mock.calls.filter(([p]) => p === "/admin/access/reader-setup")
          .length,
      ).toBeGreaterThan(1),
    { timeout: 3500 },
  );
  expect((screen.getByLabelText("Reader name") as HTMLInputElement).value).toBe(
    "Mini reader",
  );
  expect(
    (screen.getByLabelText("Wi-Fi network") as HTMLInputElement).value,
  ).toBe("Workshop");
});
