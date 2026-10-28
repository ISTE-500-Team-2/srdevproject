import { waiverAcceptance } from '../helpers/waiver.js';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {before,after,test} from 'node:test';
import {Pool} from 'pg';
import request from 'supertest';
import {createApp} from '../../src/app.js';
import {initializeDemo} from '../../src/scripts/init-demo.js';
import {PassBilling} from '../../src/billing/passes.js';
import {BillingPricing} from '../../src/billing/pricing.js';
import {StudioStripe} from '../../src/studios/stripe.js';

const database='arbor_combined_'+randomBytes(6).toString('hex')+'_mvc_test';
const owner=new Pool(),pool=new Pool({database});
const secret=randomBytes(32).toString('hex'),uid='04A1B2C3D4E5F6';
const provider=new StudioStripe({key:'sk_test_fixture',webhookSecret:'whsec_fixture',origin:'http://localhost'});
const billing=new PassBilling(pool,provider),pricing=new BillingPricing(pool);
let created=false,server:any,staff:any,member:any,room:number,session:any,providerCalls=0;
(provider.sdk.checkout.sessions.create as any)=async(params:any)=>{
  providerCalls++;assert.deepEqual(params.payment_method_types,['card']);
  session={...params,id:'cs_combined',livemode:false,status:'open',url:'https://checkout.stripe.com/test',amount_total:2500,currency:'usd'};
  return session;
};
(provider.sdk.checkout.sessions.retrieve as any)=async()=>session;
(provider.sdk.refunds.list as any)=async()=>({data:[],has_more:false});
before(async()=>{
  if(!process.env.PGHOST||process.env.DATABASE_URL)throw Error('Explicit isolated PostgreSQL required');
  await owner.query(`CREATE DATABASE "${database}"`);created=true;await initializeDemo(pool);
  room=(await pool.query("INSERT INTO room(name,location,status) VALUES('Combined fixture room','Fixture','available') RETURNING roomid")).rows[0].roomid;
  const app=createApp(pool,{jwtKey:randomBytes(32),port:8080,host:'127.0.0.1',secureCookies:false,demoLogin:true,
    allowedOrigins:[],timeZone:'America/New_York',devices:{cardHashKey:randomBytes(32).toString('hex'),readers:[{id:'combined',secret,kind:'room',resourceId:room}]}});
  server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  for(const role of ['admin','member']){
    const r=await request(server).post('/api/auth/demo').send({role});assert.equal(r.status,200);
    if(role==='admin')staff=r.body.data;else member=r.body.data;
  }
  await pool.query("UPDATE user_membership SET status='expired' WHERE userid=$1",[member.user.id]);
});
after(async()=>{
  if(server)await new Promise<void>(resolve=>{server.close(resolve);server.closeAllConnections();});
  await pool.end();if(created)await owner.query(`DROP DATABASE "${database}"`);await owner.end();
});
const get=(path:string,actor=member)=>request(server).get('/api'+path).set('Authorization','Bearer '+actor.accessToken);
const post=(path:string,body:unknown,actor=member)=>request(server).post('/api'+path).set('Authorization','Bearer '+actor.accessToken).set('X-CSRF-Token',actor.csrfToken).send(body);
function scan(){
  const body=JSON.stringify({uid,eventId:randomUUID(),checkIn:true}),stamp=String(Date.now());
  return request(server).post('/api/devices/decision').set('Content-Type','application/json').set('X-Reader-ID','combined')
    .set('X-Reader-Timestamp',stamp).set('X-Reader-Signature',createHmac('sha256',secret).update(stamp+'\n'+body).digest('hex')).send(body);
}
test('combined pricing, TOS, paid passes, bounded NFC decisions and policy replacement share one current eligibility state',async()=>{
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const plans=await pricing.offers(member.user.id,today),pass=plans.find(p=>p.kind==='day_pass')!;
  assert.equal(pass.amountCents,2500);assert.equal(plans.find(p=>p.kind==='membership')!.amountCents,9500);
  const input={planId:pass.id,expectedRevision:pass.revision,pricingRevision:pass.pricingRevision,amountCents:2500,validDate:today};
  await assert.rejects(billing.checkout(member.user.id,input),{code:'WAIVER_REQUIRED'});
  assert.equal(providerCalls,0);
  const waivers=(await get('/me/waivers')).body.data;
  assert.ok(waivers.some((w:any)=>w.name==='Terms of Service'));
  for(const waiver of waivers)assert.equal((await post(`/me/waivers/${waiver.id}/sign`,waiverAcceptance(waiver))).status,200);
  assert.equal((await post('/admin/access/cards',{userId:member.user.id,uid,label:'Combined fixture',reason:'Isolated cross-PR verification'},staff)).status,201);
  await pool.query("INSERT INTO reservation(userid,roomid,location,starttime,endtime,status) VALUES($1,$2,'Combined fixture room',(now()-interval '1 minute') AT TIME ZONE 'UTC',(now()+interval '30 minutes') AT TIME ZONE 'UTC','confirmed')",[member.user.id,room]);
  assert.equal((await scan()).body.data.allowed,false,'A checkout is not a paid entitlement');
  await billing.checkout(member.user.id,input);
  session={...session,status:'complete',payment_status:'paid',payment_intent:'pi_combined'};
  const event={id:'evt_combined',livemode:false,type:'checkout.session.completed',data:{object:session}} as any;
  await billing.webhook(event);await billing.webhook(event);
  const grant=await scan();assert.equal(grant.status,200);assert.equal(grant.body.data.allowed,true);
  assert.ok(grant.body.data.leaseSeconds>0&&grant.body.data.leaseSeconds<=5);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM day_pass WHERE userid=$1',[member.user.id])).rows[0].n,1);
  const replacement=await post('/admin/policies',{name:'Terms of Service',version:'combined-fixture-2',description:'Nonbinding updated test terms.',effectiveAt:new Date(Date.now()-1000).toISOString(),approvalReference:'Isolated fixture, not sponsor approval',reason:'Cross-PR policy lifecycle verification'},staff);
  assert.equal(replacement.status,201,JSON.stringify(replacement.body));
  assert.equal((await scan()).body.data.reason,'WAIVER_REQUIRED');
  await assert.rejects(billing.checkout(member.user.id,input),{code:'WAIVER_REQUIRED'});
  assert.equal(providerCalls,1,'Policy replacement must block before another provider request');
  assert.equal((await post(`/me/waivers/${replacement.body.data.id}/sign`,{accepted:true})).status,200);
  assert.equal((await scan()).body.data.allowed,true);
  const history=(await get('/me/signed-waivers')).body.data;
  assert.ok(history.some((w:any)=>w.waiverId===waivers.find((w:any)=>w.name==='Terms of Service').id));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app_pass_checkout')).rows[0].n,1);
});
