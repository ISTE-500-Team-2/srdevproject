import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { MemoryRouter } from "react-router-dom";
import App from "../../src/App";
import { loadStaffArea } from "../../src/areas/load";
import { createBrowserBridge } from "../../../backend/test/helpers/browserBridge";

let bridge: Awaited<ReturnType<typeof createBrowserBridge>>;
const gatewaySecret = "g".repeat(64),
  deviceId = "usb-" + "a".repeat(24);
beforeAll(async () => {
  // Compile the staff workspace here, under the hook's long timeout, so the first
  // page wait below measures the app and API rather than on-demand compilation.
  await loadStaffArea();
  bridge = await createBrowserBridge({
    devices: {
      cardHashKey: randomBytes(32).toString("hex"),
      readers: [],
      setupGateways: [{ id: "pi", name: "Orange Pi", secret: gatewaySecret }],
    },
  });
}, 120000);
afterAll(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await bridge?.close();
}, 30000);
async function signed(
  path: string,
  id: string,
  key: string,
  payload: Record<string, unknown>,
  prefix = "Gateway",
) {
  const stamp = String(Date.now()),
    body = JSON.stringify({ eventId: randomUUID(), ...payload });
  const r = await bridge.fetch("/api" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [`X-${prefix}-ID`]: id,
      [`X-${prefix}-Timestamp`]: stamp,
      [`X-${prefix}-Signature`]: createHmac("sha256", key)
        .update(stamp + "\n" + body)
        .digest("hex"),
    },
    body,
  });
  expect(r.status).toBe(200);
  return (await r.json()).data;
}
test("real React → Express → PostgreSQL onboarding: USB detection, generated credentials, verified completion, no card/check-in mutation", async () => {
  vi.stubGlobal("fetch", bridge.fetch);
  await bridge.fetch("/api/auth/demo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "admin" }),
  });
  const devices = [
    {
      id: deviceId,
      model: "ESP32-C3 mini",
      firmware: "1.7.1-c3-checkin",
      transport: "usb",
    },
  ];
  await signed("/devices/setup/poll", "pi", gatewaySecret, {
    devices,
    updates: [],
  });
  const before = (
    await bridge.pool.query(
      "SELECT (SELECT count(*) FROM app_access_card) cards,(SELECT count(*) FROM check_in) visits",
    )
  ).rows[0];
  render(
    <MemoryRouter initialEntries={["/admin/access?view=readers"]}>
      <App />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  // Uses the suite-wide wait from setup.ts: on a busy machine the session check and
  // the reader reads behind this page can take longer than 10 seconds.
  const add = await screen.findByRole("button", { name: "Add reader" });
  await user.click(add);
  await user.click(
    await screen.findByRole("button", { name: "Set up ESP32-C3 mini" }),
  );
  let dialog = within(screen.getByRole("dialog"));
  await user.type(dialog.getByLabelText("Reader name"), "Workshop mini");
  const resource = (
    await bridge.pool.query(
      "SELECT buildingid FROM building ORDER BY buildingid LIMIT 1",
    )
  ).rows[0].buildingid;
  await user.selectOptions(
    dialog.getByLabelText("Reader location"),
    "building:" + resource,
  );
  await user.click(dialog.getByLabelText("Use saved Wi-Fi"));
  await user.type(
    dialog.getByLabelText("Reason for change"),
    "Install additional workshop reader",
  );
  // Setup needs the device seen in the last 12 seconds. A real Pi reports every few
  // seconds; report again here, since filling in the form on a busy machine can take
  // longer than that after the first report.
  await signed("/devices/setup/poll", "pi", gatewaySecret, {
    devices,
    updates: [],
  });
  fireEvent.submit(
    dialog.getByRole("button", { name: "Connect reader" }).closest("form")!,
  );
  expect(
    await dialog.findByRole("heading", { name: "Waiting for the Pi" }),
  ).toBeTruthy();
  const poll = await signed("/devices/setup/poll", "pi", gatewaySecret, {
    devices,
    updates: [],
  });
  const job = poll.jobs.find((j: any) => j.deviceId === deviceId);
  expect(job.reuseWifi).toBe(true);
  expect(job.readerSecret.length).toBe(64);
  const heartbeat = await signed(
    "/devices/decision",
    job.readerId,
    job.readerSecret,
    { action: "heartbeat" },
    "Reader",
  );
  expect(heartbeat.mode).toBe("disabled");
  expect(heartbeat.allowed).toBe(false);
  await signed("/devices/setup/poll", "pi", gatewaySecret, {
    devices,
    updates: [{ id: job.id, status: "complete", readerReady: true }],
  });
  expect(
    await dialog.findByRole(
      "heading",
      { name: "Reader connected" },
      { timeout: 5000 },
    ),
  ).toBeTruthy();
  expect(document.body.textContent).not.toContain(job.readerSecret);
  await user.click(dialog.getByRole("button", { name: "Done" }));
  expect(
    await screen.findByRole("heading", { name: "Workshop mini" }),
  ).toBeTruthy();
  expect(
    (
      await signed(
        "/devices/decision",
        job.readerId,
        job.readerSecret,
        { action: "heartbeat" },
        "Reader",
      )
    ).mode,
  ).toBe("access");
  expect(
    (
      await bridge.pool.query(
        "SELECT (SELECT count(*) FROM app_access_card) cards,(SELECT count(*) FROM check_in) visits",
      )
    ).rows[0],
  ).toEqual(before);
});
