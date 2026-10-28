import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import App from "../../src/App";
import { createBrowserBridge } from "../../../backend/test/helpers/browserBridge";
let bridge: Awaited<ReturnType<typeof createBrowserBridge>>;
beforeAll(async () => {
  bridge = await createBrowserBridge({
    devices: {
      cardHashKey: "browser-test-card-hash-key-isolated",
      readers: [
        {
          id: "test",
          secret: "browser-test-reader-secret-isolated",
          kind: "building",
        },
      ],
    },
  });
}, 120000);
afterAll(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await bridge?.close();
}, 30000);
test("staff training UI configures approved expiry, records actual instructor training and revokes safely", async () => {
  vi.stubGlobal("fetch", bridge.fetch);
  let login = await bridge.fetch("/api/auth/demo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "admin" }),
  });
  expect(login.status).toBe(200);
  const member = (
    await bridge.pool.query(
      `SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`,
    )
  ).rows[0].userid;
  render(
    <MemoryRouter initialEntries={["/training"]}>
      <App />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "New certification" }));
  await user.type(await screen.findByLabelText("Name"), "UI printer safety");
  await user.type(screen.getByLabelText("Approved validity in days"), "90");
  await user.type(screen.getByLabelText('Find equipment'), 'Darth');
  await user.click(await screen.findByRole('checkbox',{name:/Darth Vader/}));
  await user.type(
    screen.getByLabelText("Policy approval/reference"),
    "Sponsor-approved training policy",
  );
  await user.click(screen.getByRole("button", { name: "Save certification" }));
  await screen.findByRole("heading", { name: "UI printer safety" });
  await user.type(
    await screen.findByRole("combobox", { name: "Member" }),
    "Jordan",
  );
  await user.click(await screen.findByRole("option", { name: /Jordan Demo/ }));
  void member;
  // Picking a member loads their records; untrained certifications offer
  // "Record training", which opens the approval form.
  await user.click(await screen.findByRole("button", { name: "Record training" }));
  const cert = (
    await bridge.pool.query(
      "SELECT certid FROM certifications WHERE name='UI printer safety'",
    )
  ).rows[0].certid;
  expect((await bridge.pool.query("SELECT certid FROM equipment WHERE name='Darth Vader'")).rows[0].certid).toBe(cert);
  expect((document.querySelector('input[name="certId"]') as HTMLInputElement).value).toBe(String(cert));
  const t = new Date(Date.now() - 86400000),
    local = new Date(t.getTime() - t.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  fireEvent.change(screen.getByLabelText("Actual training date/time"), {
    target: { value: local },
  });
  await user.type(
    screen.getByLabelText("Verification reference"),
    "Observed successful safety demonstration",
  );
  await user.type(screen.getByLabelText("Reason"), "Completed in person");
  await user.click(screen.getByLabelText(/I conducted or verified/));
  await user.click(screen.getByRole("button", { name: "Approve training" }));
  await screen.findByText("Current · active");
  const saved = (
    await bridge.pool.query(
      "SELECT * FROM user_certifications WHERE userid=$1 AND certid=$2",
      [member, cert],
    )
  ).rows[0];
  expect(saved.approved_by).toBeTruthy();
  expect(saved.verified_in_person).toBe(true);
  expect(saved.trained_at).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Revoke" }));
  await user.type(
    screen.getByLabelText("Revocation/retraining reason"),
    "Retraining required after incident",
  );
  fireEvent.keyDown(
    screen.getByRole("button", { name: /Hold to revoke UI printer safety/ }),
    { key: " " },
  );
  await screen.findByText("Not current · revoked", {}, { timeout: 5000 });
  cleanup();
});
test("staff reports UI reads actual ledger instead of sample charts", async () => {
  vi.stubGlobal("fetch", bridge.fetch);
  await bridge.pool.query(
    `INSERT INTO payment(userid,price,paymentstatus,paymentdate,method) SELECT userid,125.50,'paid',NOW() AT TIME ZONE 'UTC','cash' FROM "user" WHERE email='demo.member@collaboratory.invalid'`,
  );
  render(
    <MemoryRouter initialEntries={["/admin"]}>
      <App />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("link", { name: "Reports" }));
  await screen.findByRole("heading", { name: "Recorded revenue" });
  expect(await screen.findByRole('heading',{name:'Membership trends'})).toBeTruthy();
  expect(await screen.findByRole('heading',{name:'Notification delivery evidence'})).toBeTruthy();
  expect(screen.getByRole('rowheader',{name:'Waiver & training expiration'})).toBeTruthy();
  const table = screen.getAllByRole("table")[0];
  expect(within(table).getByText("cash")).toBeTruthy();
  expect(within(table).getAllByText("$125.50")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Export PDF" })).toBeTruthy();
  expect(screen.queryByText(/Design preview: all charts/)).toBeNull();
  cleanup();
});

test('staff schedules a class using named certification, instructor and room selectors',async()=>{
  vi.stubGlobal('fetch',bridge.fetch);
  const admin=(await bridge.pool.query(`SELECT userid FROM "user" WHERE email='demo.admin@collaboratory.invalid'`)).rows[0].userid;
  await bridge.pool.query("INSERT INTO user_role(userid,roleid) SELECT $1,roleid FROM role WHERE role='instructor' ON CONFLICT DO NOTHING",[admin]);
  const cert=(await bridge.pool.query("SELECT certid FROM certifications WHERE name='UI printer safety'")).rows[0].certid;
  const room=(await bridge.pool.query("SELECT roomid FROM room WHERE status='available' ORDER BY roomid LIMIT 1")).rows[0].roomid;
  render(<MemoryRouter initialEntries={['/classes']}><App /></MemoryRouter>);
  const user=userEvent.setup();
  await user.click(await screen.findByRole('button',{name:'Schedule class'}));
  await user.type(await screen.findByLabelText('Title'),'Named selector orientation');
  await screen.findByRole('option',{name:'UI printer safety'});
  await user.selectOptions(screen.getByLabelText(/^Counts toward/),String(cert));
  await user.type(screen.getByRole('combobox',{name:'Instructor'}),'Alex');
  await user.click(await screen.findByRole('option',{name:/Alex Demo/}));
  void admin;
  await user.selectOptions(screen.getByLabelText(/^Room/),String(room));
  const seats=screen.getByRole('spinbutton');await user.clear(seats);await user.type(seats,'3');
  const start=new Date(Date.now()+2*86400000);start.setHours(10,0,0,0);
  const day=new Date(start.getTime()-start.getTimezoneOffset()*60000).toISOString().slice(0,10);
  fireEvent.change(screen.getByLabelText('Date'),{target:{value:day}});
  fireEvent.change(screen.getByLabelText('Starts'),{target:{value:'10:00'}});
  fireEvent.change(screen.getByLabelText('Ends'),{target:{value:'11:00'}});
  await user.type(screen.getByLabelText(/^Reason/),'Approved orientation');
  await user.click(screen.getByRole('button',{name:'Publish class'}));
  await screen.findByRole('heading',{name:'Named selector orientation'});
  const saved=(await bridge.pool.query("SELECT c.instructor_id,c.certification_id,v.roomid FROM app_training_class c JOIN reservation v ON v.reservationid=c.reservation_id WHERE c.title='Named selector orientation'")).rows[0];
  expect(saved).toEqual({instructor_id:admin,certification_id:cert,roomid:room});
  cleanup();
});

test("staff card assignment, revocation and timed override UI save audited records", async () => {
  vi.stubGlobal("fetch", bridge.fetch);
  render(
    <MemoryRouter initialEntries={["/admin"]}>
      <App />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("link", { name: "Reader access" }),
  );
  const member = (
    await bridge.pool.query(
      `SELECT userid FROM "user" WHERE email='demo.member@collaboratory.invalid'`,
    )
  ).rows[0].userid;
  await user.type(
    await screen.findByRole("combobox", { name: "Member" }),
    "Jordan",
  );
  await user.click(await screen.findByRole("option", { name: /Jordan Demo/ }));
  void member;
  await user.click(await screen.findByRole("button", { name: "Enter a card ID manually" }));
  await user.type(screen.getByLabelText("NFC card ID"), "04:A1:B2:C3:D4:E5:F6");
  await user.type(screen.getByLabelText("Card label"), "UI test card");
  await user.type(
    screen.getByLabelText("Assignment reason"),
    "Verified identity",
  );
  await user.click(screen.getByRole("button", { name: "Assign card" }));
  await screen.findByRole("heading", { name: "UI test card" });
  await user.click(screen.getByRole("button", { name: "Revoke UI test card" }));
  const revokeDialog = screen.getByRole("dialog");
  await user.type(within(revokeDialog).getByLabelText("Reason"), "Lost card");
  await user.click(within(revokeDialog).getByRole("button", { name: "Confirm revocation" }));
  await screen.findByRole("button", {name:"Reactivate UI test card"});
  const equipment = (
    await bridge.pool.query(
      "SELECT equipmentid FROM equipment ORDER BY equipmentid LIMIT 1",
    )
  ).rows[0].equipmentid;
  await user.click(screen.getByRole("link", {name:"Jordan’s member record"}));
  const form = await screen.findByRole("form", {name:"Create supervised access"});
  await waitFor(()=>expect(within(form).getByLabelText("Equipment or room").querySelector(`option[value="equipment:${equipment}"]`)).toBeTruthy());
  await user.selectOptions(within(form).getByLabelText("Equipment or room"), `equipment:${equipment}`);
  await user.selectOptions(within(form).getByLabelText("Duration"), "10");
  await user.type(within(form).getByLabelText("Reason"), "Supervised operation");
  await user.click(within(form).getByRole("button", {name:"Create supervised access"}));
  await screen.findByText(/Supervised access created for Jordan/);
  const card = (
    await bridge.pool.query(
      "SELECT active FROM app_access_card WHERE label='UI test card'",
    )
  ).rows[0];
  expect(card.active).toBe(false);
  expect(
    (
      await bridge.pool.query(
        "SELECT COUNT(*)::int AS n FROM app_access_override",
      )
    ).rows[0].n,
  ).toBe(1);
  cleanup();
});
