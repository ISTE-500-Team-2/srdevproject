import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrevoTransport, NotificationTransportError } from '../src/notifications/transport.js';

const config = {apiKey:'fake-test-key',senderEmail:'studio@example.com',senderName:'Studio',replyToEmail:'reply@example.com'};
const message = {recipientEmail:'member@example.com',subject:'Account created',htmlContent:'<p>Hello</p>',textContent:'Hello'};
const fake = (fn: (url: unknown, init?: RequestInit) => Promise<Response>) => fn as typeof fetch;

test('Brevo sends required API payload and returns provider acceptance ID, without following redirects', async () => {
  const transport = new BrevoTransport(config, fake(async (url,init) => {
    assert.equal(url,'https://api.brevo.com/v3/smtp/email');
    assert.equal(init?.redirect,'error');
    assert.equal(new Headers(init?.headers).get('api-key'),'fake-test-key');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.replyTo,{email:'reply@example.com',name:'Studio'});
    assert.deepEqual(body.to,[{email:'member@example.com'}]);
    return Response.json({messageId:'<accepted@test>'},{status:201});
  }));
  assert.deepEqual(await transport.send(message),{messageId:'<accepted@test>'});
});

test('provider errors classify retry safety and never expose response bodies or fetch errors', async () => {
  for (const [status, classification] of [[400,'permanent'],[401,'permanent'],[429,'transient'],[500,'ambiguous'],[408,'ambiguous']] as const) {
    const transport = new BrevoTransport(config,fake(async () => new Response('secret echoed by provider', {status,headers:{'retry-after':'60'}})));
    await assert.rejects(transport.send(message), (error: unknown) => {
      assert.ok(error instanceof NotificationTransportError);
      assert.equal(error.classification,classification);
      assert.ok(!error.message.includes('secret'));
      if(status===429) assert.equal(error.retryAfterMs,60_000);
      return true;
    });
  }
  for (const fn of [async () => {throw new Error('private-key')}, async () => Response.json({})]) {
    await assert.rejects(new BrevoTransport(config,fake(fn)).send(message), (e:unknown) =>
      e instanceof NotificationTransportError && e.classification==='ambiguous' && !e.message.includes('private-key'));
  }
});

test('timeout is bounded even if injected fetch ignores abort; incomplete config never sends', async () => {
  await assert.rejects(new BrevoTransport({...config,timeoutMs:5},fake(() => new Promise(() => {}))).send(message),
    (e:unknown) => e instanceof NotificationTransportError && e.classification==='ambiguous');
  let called = false;
  await assert.rejects(new BrevoTransport({...config,apiKey:''},fake(async () => {called=true;return Response.json({})})).send(message));
  assert.equal(called,false);
});
