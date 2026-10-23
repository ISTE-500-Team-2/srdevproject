import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv,frontendEnv,assertFree,assertNodeVersion } from './dev.mjs';
import { createServer } from 'node:net';
test('demo cannot inherit real sending or shared DB settings',()=>{
 const env=makeEnv({DATABASE_URL:'shared',PGSERVICE:'shared',EMAIL_ENABLED:'true',BREVO_API_KEY:'secret',ENABLE_DEMO_LOGIN:'false'}, {},false);
 assert.equal(env.EMAIL_ENABLED,'false');assert.equal(env.ENABLE_DEMO_LOGIN,'true');assert.equal(env.BREVO_API_KEY,undefined);assert.equal(env.DATABASE_URL,undefined);assert.equal(env.PGSERVICE,undefined);assert.equal(env.PGPORT,'25434');
});
test('email mode needs an explicit local key and isolates its queue',()=>{
 assert.throws(()=>makeEnv({BREVO_API_KEY:'inherited'}, {},true),/root .env.local/);
 const env=makeEnv({}, {BREVO_API_KEY:'local-test-key',PGHOST:'remote',APP_ORIGIN:'http://wrong'},true);
 assert.equal(env.BREVO_API_KEY,'local-test-key');assert.equal(env.EMAIL_ENABLED,'true');assert.equal(env.ENABLE_DEMO_LOGIN,'false');assert.equal(env.PGPORT,'25435');assert.equal(env.PGHOST,'127.0.0.1');assert.equal(env.APP_ORIGIN,'http://localhost:5173');
});
test('frontend does not receive backend secrets',()=>{
 const env=frontendEnv({PATH:'ok',BREVO_API_KEY:'secret',PGPASSWORD:'secret',JWT_SECRET:'secret',DATABASE_URL:'secret'});
 assert.deepEqual(env,{PATH:'ok',NODE_ENV:'development'});
});
test('busy ports fail instead of silently selecting another URL',async()=>{
 const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));
 try{await assert.rejects(assertFree(s.address().port),/already in use/);}finally{await new Promise(r=>s.close(r));}
});

test('launcher enforces the patched Node 24 security floor',()=>{
 for(const version of ['22.18.0','24.0.0','24.14.9','24.21.0','24.22.0','25.0.0','26.0.0','24.22','24.22.NaN','24.22.1-rc.1'])
   assert.throws(()=>assertNodeVersion(version),/24.22.1/);
 for(const version of ['24.22.1','24.22.2','24.23.0'])
   assert.doesNotThrow(()=>assertNodeVersion(version));
});
