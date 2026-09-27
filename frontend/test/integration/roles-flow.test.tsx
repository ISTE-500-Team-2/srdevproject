import { confirmationToken } from '../../../backend/test/helpers/confirmation';
// @vitest-environment jsdom
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { setAccessToken, setCsrfToken } from "../../src/lib/api";
import App from "../../src/App";
import { createBrowserBridge } from "../../../backend/test/helpers/browserBridge";

let bridge: Awaited<ReturnType<typeof createBrowserBridge>>;
beforeAll(async () => {
  bridge = await createBrowserBridge();
}, 120000);
afterAll(async () => {
  cleanup();
  vi.unstubAllGlobals();
  if (bridge) await bridge.close();
}, 30000);
function mount(path = "/admin") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
async function direct(path: string, body: unknown, csrf?: string) {
  return bridge.fetch("/api" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("administrator changes primary/additional roles and student modifier through the real form", async () => {
  vi.stubGlobal("fetch",bridge.fetch);
  expect((await direct("/auth/demo",{role:"admin"})).status).toBe(200);
  const user=userEvent.setup(); mount("/admin");
  await user.click(await screen.findByRole("button",{name:/Jordan Demo/}));
  await user.click(await screen.findByText("Change account role"));
  const form=await screen.findByRole("form",{name:"Account role"});
  await user.click(within(form).getByRole("checkbox",{name:"Instructor"}));
  await user.click(within(form).getByRole("checkbox",{name:"Student classification"}));
  await user.selectOptions(within(form).getByRole("combobox"),"instructor");
  await user.type(within(form).getByLabelText("Reason for change"),"Assign instructor and preserve customer role");
  await user.click(within(form).getByRole("button",{name:"Save account role"}));
  await screen.findByText("Account role updated.");
  const row=(await bridge.pool.query(`SELECT primary_role,is_student FROM "user" WHERE email='demo.member@collaboratory.invalid'`)).rows[0];
  expect(row).toEqual({primary_role:"instructor",is_student:true});
  const roles=(await bridge.pool.query(`SELECT r.role FROM user_role ur JOIN role r USING(roleid) JOIN "user" u USING(userid) WHERE u.email='demo.member@collaboratory.invalid' ORDER BY r.role`)).rows.map(r=>r.role);
  expect(roles).toEqual(["instructor","member"]);
},30000);
