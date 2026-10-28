// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../../src/App';
import { api, setAccessToken, setCsrfToken } from '../../src/lib/api';
import { createBrowserBridge } from '../../../backend/test/helpers/browserBridge';
import { confirmationToken } from '../../../backend/test/helpers/confirmation';

let bridge: Awaited<ReturnType<typeof createBrowserBridge>>;
beforeAll(async () => {
  bridge = await createBrowserBridge();
}, 120000);
afterEach(() => {
  cleanup();
  setAccessToken(null);
  setCsrfToken(null);
  vi.unstubAllGlobals();
});
afterAll(async () => {
  cleanup();
  vi.unstubAllGlobals();
  if (bridge) await bridge.close();
}, 30000);
function mount(path = '/login') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

test('signup form creates an account with DOB and the new password policy', async () => {
  vi.stubGlobal('fetch', bridge.fetch);
  const user = userEvent.setup();
  const email = randomUUID() + '@example.invalid';
  mount();

  await user.click(
    await screen.findByRole(
      'button',
      { name: 'Sign up' },
      { timeout: 20000 },
    ),
  );

  const dialog = screen.getByRole('dialog', { name: 'Create your account' });

  expect(
    within(dialog).getByText(
      /8–128 characters with at least one uppercase letter and one special character/i,
    ),
  ).toBeTruthy();

  await user.type(within(dialog).getByLabelText('First name'), 'Signup');
  await user.type(within(dialog).getByLabelText('Last name'), 'Test');
  const username = 'signup_' + email.slice(0, 16);
  await user.type(within(dialog).getByLabelText('Username'), username);
  await user.type(
    within(dialog).getByLabelText('Email'),
    email,
  );
  await user.type(within(dialog).getByLabelText('Phone'), '0000000000');

  fireEvent.change(within(dialog).getByLabelText('Date of birth'), {
    target: { value: '2000-01-01' },
  });

  await user.type(
    within(dialog).getByLabelText('Password', { exact: false }),
    'ValidPassword!',
  );

  const create = within(dialog).getByRole('button', { name: 'Create account' });
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false), {timeout:20000});
  await user.click(create);

  await screen.findByRole(
    'heading',
    { name: 'Email unavailable' },
    { timeout: 20000 },
  );
  const token = await confirmationToken(bridge.pool, email);
  cleanup();
  mount('/confirm-email#' + token);
  await user.click(
    await screen.findByRole('button', { name: 'Confirm email' }),
  );
  await screen.findByRole(
    'heading',
    { name: /Welcome back/ },
    { timeout: 20000 },
  );
  const saved = (await bridge.pool.query('SELECT firstname FROM "user" WHERE email=$1',[email])).rows[0];
  expect(saved.firstname).toBe('Signup');
  await screen.findByText(
    /Signup, welcome to The Crafty Studio - your account is ready/,
    {},
    { timeout: 20000 },
  );

  const account = await bridge.pool.query(
    `SELECT email, username, dob::text AS dob FROM "user" WHERE email=$1`,
    [email],
  );

  expect(account.rowCount).toBe(1);
  expect(account.rows[0].email).toBe(email);
  expect(account.rows[0].username).toBe(username);
  expect(account.rows[0].dob).toBe('2000-01-01');

  cleanup();
  for(const identifier of [username.toUpperCase(),email]) {
    await api('/auth/logout',{method:'POST'});
    setAccessToken(null);setCsrfToken(null);
    mount();
    await user.type(await screen.findByLabelText('Email or username'),identifier);
    await user.type(screen.getByPlaceholderText('Enter your password…'),'ValidPassword!');
    await user.click(screen.getByRole('button',{name:'Login',exact:true}));
    await screen.findByRole('heading',{name:/Welcome back, Signup/});
    cleanup();
  }
}, 120000);

test('duplicate username error stays in signup dialog and user can correct it without retyping other fields',async()=>{
  vi.stubGlobal('fetch',bridge.fetch);
  const email=randomUUID()+'@example.invalid',taken='taken_'+email.slice(0,16);
  const response=await bridge.fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({firstName:'Existing',lastName:'Test',username:taken,email,password:'ValidPassword!',phone:'0000000000',dob:'2000-01-01'})});
  expect(response.status).toBe(202);
  mount();const user=userEvent.setup();await user.click(await screen.findByRole('button',{name:'Sign up'}));
  const dialog=screen.getByRole('dialog',{name:'Create your account'});
  for(const [label,value] of [['First name','Retry'],['Last name','Test'],['Username',taken],['Email','retry_'+email],['Phone','0000000000']])await user.type(within(dialog).getByLabelText(label),value);
  fireEvent.change(within(dialog).getByLabelText('Date of birth'),{target:{value:'2000-01-01'}});
  await user.type(within(dialog).getByLabelText('Password',{exact:false}),'ValidPassword!');
  await user.click(within(dialog).getByRole('button',{name:'Create account'}));
  expect((await within(dialog).findByRole('alert')).textContent).toContain('That username is unavailable');
  expect((within(dialog).getByLabelText('First name') as HTMLInputElement).value).toBe('Retry');
  await user.clear(within(dialog).getByLabelText('Username'));
  await user.type(within(dialog).getByLabelText('Username'),'new_'+email.slice(0,16));
  await user.click(within(dialog).getByRole('button',{name:'Create account'}));
  expect(await screen.findByRole('heading',{name:'Email unavailable'})).toBeTruthy();
});

test('React → Express controllers/models → PostgreSQL: login, save, refresh, cancel, waive and check in', async () => {
  vi.stubGlobal('fetch', bridge.fetch);
  const config = await fetch('/api/config');
  expect(config.status).toBe(200);
  expect((await config.json()).data.demoLogin).toBe(true);
  expect((await api<{ demoLogin: boolean }>('/config')).demoLogin).toBe(true);
  const user = userEvent.setup();
  mount();
  const demo = await screen.findByRole(
    'button',
    { name: 'Member demo' },
    { timeout: 20000 },
  );
  await waitFor(
    () => expect((demo as HTMLButtonElement).disabled).toBe(false),
    { timeout: 20000 },
  );
  await user.click(demo);
  await screen.findByRole(
    'heading',
    { name: /Welcome back/ },
    { timeout: 20000 },
  );
  await user.click(
    within(
      screen.getByRole('navigation', { name: 'Primary navigation' }),
    ).getByRole('link', { name: 'Equipment', exact: true }),
  );
  await user.click(
    await screen.findByRole(
      'button',
      { name: /3D Printer/ },
      { timeout: 20000 },
    ),
  );
  const dialog = screen.getByRole('dialog');
  const start = new Date(Date.now() + 2 * 86_400_000);
  start.setHours(14, 0, 0, 0);
  const local =
    [
      start.getFullYear(),
      String(start.getMonth() + 1).padStart(2, '0'),
      String(start.getDate()).padStart(2, '0'),
    ].join('-') + 'T14:00';
  void local;
  // Day button, then start time, in the reservation picker.
  fireEvent.click(
    within(dialog).getByRole('radio', {
      name: start.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
    }),
  );
  fireEvent.change(within(dialog).getByLabelText('Start time'), {
    target: { value: "14:00" },
  });
  await user.click(
    within(dialog).getByRole('button', { name: 'Confirm reservation' }),
  );
  await screen.findByText(
    'Reservation saved for 3D Printer.',
    {},
    { timeout: 20000 },
  );
  await waitFor(
    async () => {
      const result = await bridge.pool.query(
        "SELECT COUNT(*)::int AS count FROM reservation WHERE status='confirmed'",
      );
      expect(result.rows[0].count).toBe(1);
    },
    { timeout: 20000 },
  );
  cleanup();
  mount('/reservations');
  await screen.findByRole(
    'button',
    { name: 'Cancel reservation' },
    { timeout: 20000 },
  );
  await user.click(screen.getByRole('button', { name: 'Cancel reservation' }));
  await screen.findByText('Reservation cancelled.', {}, { timeout: 20000 });
  const cancelled = await bridge.pool.query(
    "SELECT COUNT(*)::int AS count FROM reservation WHERE status='cancelled'",
  );
  expect(cancelled.rows[0].count).toBe(1);
  await user.click(
    within(
      screen.getByRole('navigation', { name: 'Primary navigation' }),
    ).getByRole('link', { name: 'Certifications & Waivers', exact: true }),
  );
  // Check-in requires both policies; select each table row by its policy name because
  // unsigned policies share the same review button label.
  for (const policy of [
    {
      name: 'Demo makerspace policy',
      submit: 'Record agreement',
      confirmation: 'Your agreement has been recorded.',
    },
    {
      name: 'Terms of Service',
      submit: 'Submit acceptance',
      confirmation: 'Terms of Service completed.',
    },
  ]) {
    const name = await screen.findByText(policy.name, {exact:true});
    const card = name.closest('tr')!;
    await user.click(
      within(card).getByRole('button', { name: 'Review and agree' }),
    );
    const policyDialog = await screen.findByRole('dialog', { name: policy.name });
    await user.click(within(policyDialog).getByRole('checkbox'));
    await user.click(
      within(policyDialog).getByRole('button', { name: policy.submit }),
    );
    await screen.findByText(policy.confirmation, {}, { timeout: 20000 });
    // A success toast precedes useApi's asynchronous refresh. Wait for its
    // persisted signed row before retaining/clicking another row; otherwise
    // user-event can target an element removed during that refresh.
    await waitFor(() => {
      const signedRow=screen.getByText(policy.name,{exact:true}).closest('tr')!;
      expect(within(signedRow).getByRole('button',{name:'View policy'})).toBeTruthy();
    },{timeout:20000});
  }
  const signedPolicies = await bridge.pool.query(
    `SELECT w.name FROM user_waiver uw
      JOIN waiver w USING (waiverid)
      JOIN "user" u USING (userid)
      WHERE u.email=$1 AND uw.approval=true ORDER BY w.name`,
    ['demo.member@collaboratory.invalid'],
  );
  expect(signedPolicies.rows).toEqual([
    { name: 'Demo makerspace policy' },
    { name: 'Terms of Service' },
  ]);
  const accessRoom = (await bridge.pool.query("INSERT INTO room(name,location) VALUES('Browser check-in','Test') RETURNING roomid")).rows[0].roomid;
  await bridge.pool.query(`INSERT INTO reservation(userid,roomid,location,starttime,endtime,status)
    SELECT userid,$1,'Browser check-in',(NOW()-INTERVAL '1 minute') AT TIME ZONE 'UTC',(NOW()+INTERVAL '30 minutes') AT TIME ZONE 'UTC','confirmed'
    FROM "user" WHERE email='demo.member@collaboratory.invalid'`,[accessRoom]);
  await user.click(
    within(
      screen.getByRole('navigation', { name: 'Primary navigation' }),
    ).getByRole('link', { name: 'Home', exact: true }),
  );
  // The slider only appears once check-in is allowed; End completes it.
  const checkin = await screen.findByRole(
    'slider',
    { name: 'Slide to check in' },
    { timeout: 20000 },
  );
  fireEvent.keyDown(checkin, { key: 'End' });
  await screen.findByText(
    'Check-in saved. Welcome to the Collaboratory!',
    {},
    { timeout: 20000 },
  );
  expect(
    (await bridge.pool.query('SELECT COUNT(*)::int AS count FROM check_in'))
      .rows[0].count,
  ).toBe(1);
}, 120000);
